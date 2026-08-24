use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;

use crate::grok::acp::{AcpAgent, WakeHandle};

/// Per-session turn bookkeeping. The session itself lives in the Grok leader,
/// which owns the model state and outlives this process, so there is nothing
/// here to keep warm or evict.
pub struct LiveSession {
    pub cwd: String,
    /// JSON-RPC ids of the prompts still in flight. A prompt reply carries no
    /// session id, so this is the only route from a reply back to its session —
    /// and the queue can leave more than one outstanding at a time.
    pub in_flight: HashSet<u64>,
}

/// One `grok agent --leader stdio` child multiplexes every session Korg holds.
/// The child is a proxy onto the shared leader, so sessions cost a `session/load`
/// rather than a process, and the leader keeps them alive across reattach.
pub struct AgentLink {
    agent: Option<AcpAgent>,
    sessions: HashMap<String, LiveSession>,
    detached: VecDeque<(Option<String>, bool)>,
    wake: WakeHandle,
}

pub enum LinkEvent {
    /// A line from the agent. Routed by the `sessionId` in the payload.
    Msg(Value),
    /// `session_id: None` is the link itself rather than one session.
    /// `no_reconnect` marks a session we should let go of instead of reattaching.
    Gone {
        session_id: Option<String>,
        no_reconnect: bool,
    },
}

impl AgentLink {
    pub fn new() -> Self {
        Self {
            agent: None,
            sessions: HashMap::new(),
            detached: VecDeque::new(),
            wake: WakeHandle::new(),
        }
    }

    pub fn wake(&self) -> WakeHandle {
        self.wake.clone()
    }

    /// Adopting a child must not inherit the previous one's session map: those
    /// sessions were never loaded on this proxy, so `contains` would claim them
    /// while every prompt went to a child that has never heard of them.
    pub fn attach(&mut self, agent: AcpAgent) {
        self.strand_sessions();
        self.agent = Some(agent);
    }

    pub fn has_live(&mut self) -> bool {
        match self.agent.as_mut() {
            Some(agent) => !agent.dead(),
            None => false,
        }
    }

    pub fn agent_mut(&mut self) -> Option<&mut AcpAgent> {
        self.agent.as_mut()
    }

    /// Split borrow of the two fields a session command needs at once.
    pub fn with_session(&mut self, session_id: &str) -> Option<(&mut LiveSession, &mut AcpAgent)> {
        let agent = self.agent.as_mut()?;
        let session = self.sessions.get_mut(session_id)?;
        Some((session, agent))
    }

    pub fn insert(&mut self, session_id: String, cwd: String) {
        self.sessions.insert(
            session_id,
            LiveSession {
                cwd,
                in_flight: HashSet::new(),
            },
        );
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.sessions.contains_key(session_id)
    }

    pub fn live_ids(&self) -> Vec<String> {
        self.sessions.keys().cloned().collect()
    }

    /// Return the session loaded for exactly this working directory. Extension
    /// RPCs are scoped to a project, so guessing from an arbitrary live session
    /// can mutate the wrong repository when several projects share the link.
    pub fn session_id_for_cwd(&self, cwd: &str) -> Option<String> {
        self.sessions
            .iter()
            .find(|(_, session)| session.cwd == cwd)
            .map(|(session_id, _)| session_id.clone())
    }

    /// Remember a prompt so its eventual reply can be attributed.
    pub fn note_prompt(&mut self, session_id: &str, rpc_id: u64) {
        if let Some(session) = self.sessions.get_mut(session_id) {
            session.in_flight.insert(rpc_id);
        }
    }

    /// A prompt reply is a bare JSON-RPC result, so a registered in-flight id is
    /// the only honest link back to a session. An id-less reply names no request
    /// at all: guessing from the set of live turns would end an unrelated turn on
    /// someone else's error, so it is left for the turn-end update to settle.
    pub fn session_for_prompt_rpc(&self, rpc_id: &Value) -> Option<String> {
        let id = rpc_id.as_u64()?;
        self.sessions
            .iter()
            .find(|(_, session)| session.in_flight.contains(&id))
            .map(|(sid, _)| sid.clone())
    }

    /// A reply landed: retire its id.
    pub fn settle_rpc(&mut self, session_id: &str, rpc_id: &Value) {
        let Some(session) = self.sessions.get_mut(session_id) else {
            return;
        };
        if let Some(id) = rpc_id.as_u64() {
            session.in_flight.remove(&id);
        }
    }

    /// The backing Grok session was deliberately closed or deleted. Report an
    /// intentional detach so consumers do not immediately reconnect it.
    pub fn drop_session_no_reconnect(&mut self, session_id: &str) {
        self.forget(session_id, true);
    }

    fn forget(&mut self, session_id: &str, no_reconnect: bool) {
        if self.sessions.remove(session_id).is_some() {
            self.detached
                .push_back((Some(session_id.to_string()), no_reconnect));
            self.wake.notify();
        }
    }

    /// Report every session the link was carrying so each parked turn can be
    /// settled. Reconnecting is the link-wide event's job, not theirs.
    fn strand_sessions(&mut self) {
        for session_id in self.sessions.drain().map(|(id, _)| id) {
            self.detached.push_back((Some(session_id), true));
        }
        if !self.detached.is_empty() {
            self.wake.notify();
        }
    }

    pub fn drop_all(&mut self) {
        self.strand_sessions();
        self.agent = None;
    }

    pub fn respond(&self, request_id: Value, result: Value) -> Result<(), String> {
        self.agent
            .as_ref()
            .ok_or("Agent not started")?
            .respond(request_id, result)
    }

    pub fn respond_error(&self, request_id: Value, code: i64, message: &str) -> Result<(), String> {
        self.agent
            .as_ref()
            .ok_or("Agent not started")?
            .respond_error(request_id, code, message)
    }

    pub fn poll(&mut self) -> Option<LinkEvent> {
        if let Some((session_id, no_reconnect)) = self.detached.pop_front() {
            return Some(LinkEvent::Gone {
                session_id,
                no_reconnect,
            });
        }
        let agent = self.agent.as_mut()?;
        // Drain before declaring death: the reader thread flushes the channel
        // on its way out, and a final stopReason still has to land.
        if let Some(msg) = agent.try_incoming() {
            return Some(LinkEvent::Msg(msg));
        }
        if agent.dead() {
            self.agent = None;
            // Every session goes down with the one child, so each needs its own
            // notice; the link-wide event queued last carries the reconnect.
            self.strand_sessions();
            self.detached.push_back((None, false));
            return self
                .detached
                .pop_front()
                .map(|(session_id, no_reconnect)| LinkEvent::Gone {
                    session_id,
                    no_reconnect,
                });
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn link_with(ids: &[(&str, Option<u64>)]) -> AgentLink {
        let mut link = AgentLink::new();
        for (id, rpc) in ids {
            link.insert((*id).to_string(), "/tmp".into());
            if let Some(rpc_id) = rpc {
                link.note_prompt(id, *rpc_id);
            }
        }
        link
    }

    #[test]
    fn a_prompt_reply_lands_on_the_session_that_sent_it() {
        let link = link_with(&[("a", Some(7)), ("b", Some(9))]);
        assert_eq!(link.session_for_prompt_rpc(&json!(9)).as_deref(), Some("b"));
        // An id from an earlier turn belongs to nobody and must not settle one.
        assert_eq!(link.session_for_prompt_rpc(&json!(4)), None);
    }

    #[test]
    fn one_session_can_hold_several_queued_prompts() {
        let mut link = link_with(&[("a", Some(1))]);
        link.note_prompt("a", 2);
        assert_eq!(link.session_for_prompt_rpc(&json!(1)).as_deref(), Some("a"));
        assert_eq!(link.session_for_prompt_rpc(&json!(2)).as_deref(), Some("a"));
        // The first reply must not end a turn the second prompt is still running.
        link.settle_rpc("a", &json!(1));
        assert_eq!(link.session_for_prompt_rpc(&json!(1)), None);
        assert_eq!(link.session_for_prompt_rpc(&json!(2)).as_deref(), Some("a"));
        link.settle_rpc("a", &json!(2));
        assert_eq!(link.session_for_prompt_rpc(&json!(2)), None);
    }

    #[test]
    fn an_id_less_reply_is_never_guessed_onto_a_session() {
        let one = link_with(&[("a", Some(1)), ("b", None)]);
        assert_eq!(one.session_for_prompt_rpc(&Value::Null), None);
        let two = link_with(&[("a", Some(1)), ("b", Some(2))]);
        assert_eq!(two.session_for_prompt_rpc(&Value::Null), None);
    }

    #[test]
    fn forgetting_a_session_reports_it_once() {
        let mut link = link_with(&[("a", None)]);
        link.drop_session_no_reconnect("a");
        match link.poll() {
            Some(LinkEvent::Gone {
                session_id,
                no_reconnect,
            }) => {
                assert_eq!(session_id.as_deref(), Some("a"));
                assert!(no_reconnect);
            }
            _ => panic!("expected the detach to be reported"),
        }
        // No agent and nothing left queued: the link is simply idle.
        assert!(link.poll().is_none());
        assert!(!link.contains("a"));
    }

    #[test]
    fn deleting_a_session_is_an_intentional_non_reconnecting_detach() {
        let mut link = link_with(&[("a", Some(1))]);
        link.drop_session_no_reconnect("a");

        match link.poll() {
            Some(LinkEvent::Gone {
                session_id,
                no_reconnect,
            }) => {
                assert_eq!(session_id.as_deref(), Some("a"));
                assert!(no_reconnect, "a deleted session must never be reattached");
            }
            _ => panic!("expected deleted detach"),
        }
        assert!(!link.contains("a"));
        assert!(link.poll().is_none());
    }

    #[test]
    fn dropping_the_link_settles_every_session_before_the_link_wide_notice() {
        let mut link = link_with(&[("a", Some(1))]);
        link.drop_all();
        match link.poll() {
            Some(LinkEvent::Gone {
                session_id,
                no_reconnect,
            }) => {
                assert_eq!(session_id.as_deref(), Some("a"));
                assert!(no_reconnect, "a stranded session must not be reattached");
            }
            _ => panic!("expected the session to be reported"),
        }
        assert!(link.poll().is_none());
    }

    #[test]
    fn cwd_lookup_is_exact_and_never_borrows_another_project() {
        let mut link = AgentLink::new();
        link.insert("alpha".into(), "/repo/alpha".into());
        link.insert("beta".into(), "/repo/beta".into());

        assert_eq!(
            link.session_id_for_cwd("/repo/beta").as_deref(),
            Some("beta")
        );
        assert_eq!(link.session_id_for_cwd("/repo/beta/"), None);
        assert_eq!(link.session_id_for_cwd("/repo/missing"), None);
    }
}
