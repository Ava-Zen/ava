use std::fs;
use std::path::Path;

use crate::grok::types::{ReplayPage, SubagentInfo, TranscriptItem};

use super::children_in;

const REPLAY_PAGE: usize = 40;
const REPLAY_CHUNK: u64 = 256 * 1024;
const REPLAY_MAX_BYTES: u64 = 2 * 1024 * 1024;
const OVERSIZED_EVENT_NOTICE: &str = "Korg skipped a transcript event larger than 2 MiB.";

fn line_start_before(file: &mut fs::File, at: u64) -> Result<Option<u64>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut end = at;
    let floor = at.saturating_sub(REPLAY_MAX_BYTES);
    while end > floor {
        let start = end.saturating_sub(REPLAY_CHUNK).max(floor);
        file.seek(SeekFrom::Start(start))
            .map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; (end - start) as usize];
        file.read_exact(&mut buf).map_err(|e| e.to_string())?;
        if let Some(index) = buf.iter().rposition(|byte| *byte == b'\n') {
            return Ok(Some(start + index as u64 + 1));
        }
        end = start;
    }
    Ok((floor == 0).then_some(0))
}

fn is_line_start(file: &mut fs::File, at: u64) -> Result<bool, String> {
    use std::io::{Read, Seek, SeekFrom};
    if at == 0 {
        return Ok(true);
    }
    file.seek(SeekFrom::Start(at - 1))
        .map_err(|e| e.to_string())?;
    let mut previous = [0u8; 1];
    file.read_exact(&mut previous).map_err(|e| e.to_string())?;
    Ok(previous[0] == b'\n')
}

pub fn replay_page(dir: &Path, before: Option<u64>) -> Result<ReplayPage, String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = dir.join("updates.jsonl");
    if !path.is_file() {
        return Ok(ReplayPage {
            items: vec![],
            has_more: false,
            cursor: 0,
            turn_complete: true,
        });
    }
    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let end = before.unwrap_or(len).min(len);
    if end == 0 {
        return Ok(ReplayPage {
            items: vec![],
            has_more: false,
            cursor: 0,
            turn_complete: true,
        });
    }
    let children = children_in(dir);
    let mut window = REPLAY_CHUNK.min(end).min(REPLAY_MAX_BYTES);
    loop {
        let start = end.saturating_sub(window);
        file.seek(SeekFrom::Start(start))
            .map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; (end - start) as usize];
        file.read_exact(&mut buf).map_err(|e| e.to_string())?;
        let budget_exhausted = window >= REPLAY_MAX_BYTES && start > 0;
        let starts_at_line_boundary = is_line_start(&mut file, start)?;
        let first_newline = (start > 0)
            .then(|| buf.iter().position(|byte| *byte == b'\n'))
            .flatten();
        let oversized_start = if budget_exhausted {
            let line_start = line_start_before(&mut file, start)?.ok_or_else(|| {
                format!("transcript record near byte {start} exceeds the bounded replay limit")
            })?;
            let line_end = first_newline.map_or(end, |index| start + index as u64);
            (line_end.saturating_sub(line_start) > REPLAY_MAX_BYTES).then_some(line_start)
        } else {
            None
        };
        let (text, text_start) = if starts_at_line_boundary {
            (buf.as_slice(), start)
        } else if start > 0 {
            match first_newline {
                Some(end) => (&buf[end + 1..], start + end as u64 + 1),
                // The window starts in a line larger than the current window.
                // There is nothing safe to parse until the next expansion.
                None => (&[][..], end),
            }
        } else {
            (buf.as_slice(), 0u64)
        };
        let mut parsed = parse_updates_at(text, text_start, &children);
        if let Some(line_start) = oversized_start {
            parsed.insert(0, oversized_event(line_start));
        }
        // When the window starts mid-conversation, require one item of context
        // before the page. Otherwise exactly 40 parsed items could begin with a
        // continuation chunk whose real item starts before this window.
        if parsed.len() > REPLAY_PAGE || start == 0 || budget_exhausted {
            let trimmed = parsed.len() > REPLAY_PAGE;
            if trimmed {
                parsed = parsed.split_off(parsed.len() - REPLAY_PAGE);
            }
            // At the beginning of the file there is no earlier transcript page,
            // even if metadata lines precede the first visible item.
            let cursor = if trimmed {
                parsed.first().map_or(0, |row| row.start)
            } else if budget_exhausted {
                // Return a smaller page rather than repeatedly doubling into a
                // multi-megabyte journal. mergeEarlier joins a continuation on
                // the next page when the boundary falls inside one message.
                parsed.first().map_or(start, |row| row.start)
            } else {
                0
            };
            let mut items = parsed.into_iter().map(|row| row.item).collect::<Vec<_>>();
            // chat_history can be large. Read it once, after the journal window
            // has settled, rather than once per exponential window expansion.
            attach_user_images(dir, &mut items);
            let text = String::from_utf8_lossy(text);
            let turn_complete = if oversized_start.is_some() {
                text.lines()
                    .filter_map(journal_line_kind)
                    .any(|kind| journal_kind_is_turn_end(&kind))
            } else {
                journal_turn_complete(&text)
            };
            return Ok(ReplayPage {
                items,
                has_more: cursor > 0,
                cursor,
                turn_complete,
            });
        }
        if window >= end {
            let cursor = parsed.first().map_or(0, |row| row.start);
            let mut items = parsed.into_iter().map(|row| row.item).collect::<Vec<_>>();
            attach_user_images(dir, &mut items);
            let text = String::from_utf8_lossy(text);
            return Ok(ReplayPage {
                items,
                has_more: cursor > 0,
                cursor,
                turn_complete: journal_turn_complete(&text),
            });
        }
        window = window.saturating_mul(2).min(end).min(REPLAY_MAX_BYTES);
    }
}

fn journal_line_kind(line: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(line).ok()?;
    value
        .pointer("/params/update/sessionUpdate")
        .and_then(|row| row.as_str())
        .map(str::to_string)
}

fn journal_kind_is_turn_end(kind: &str) -> bool {
    kind.contains("turn_completed") || kind.contains("cancelled")
}

/// Last user turn is done if a later line is turn_completed/cancelled.
/// Trailing thoughts after that still count as complete — Grok often writes one.
pub(super) fn journal_turn_complete(text: &str) -> bool {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum State {
        Empty,
        Open,
        Closed,
    }
    let mut state = State::Empty;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some(kind) = journal_line_kind(line) else {
            continue;
        };
        if kind == "user_message_chunk" {
            state = State::Open;
        } else if journal_kind_is_turn_end(&kind) {
            state = State::Closed;
        } else if state == State::Empty {
            state = State::Open;
        }
    }
    state != State::Open
}

fn event_id(v: &serde_json::Value) -> Option<String> {
    match v.pointer("/params/_meta/eventId")? {
        serde_json::Value::String(id) if !id.is_empty() => Some(id.clone()),
        _ => None,
    }
}

fn event_time_ms(v: &serde_json::Value) -> Option<String> {
    if let Some(ms) = v
        .pointer("/_meta/agentTimestampMs")
        .and_then(|x| x.as_i64())
        .filter(|ms| *ms > 0)
    {
        return Some(ms.to_string());
    }
    if let Some(secs) = v
        .get("timestamp")
        .and_then(|x| x.as_i64())
        .filter(|s| *s > 0)
    {
        let ms = if secs < 1_000_000_000_000 {
            secs.saturating_mul(1000)
        } else {
            secs
        };
        return Some(ms.to_string());
    }
    None
}

struct ParsedItem {
    item: TranscriptItem,
    /// Absolute byte offset of the first JSONL line that contributed to item.
    start: u64,
}

fn oversized_event(start: u64) -> ParsedItem {
    ParsedItem {
        item: TranscriptItem {
            kind: "work".into(),
            text: OVERSIZED_EVENT_NOTICE.into(),
            title: None,
            meta: Some("replay-warning".into()),
            session_id: None,
            status: None,
            details: None,
            images: None,
            at: None,
            eid: None,
        },
        start,
    }
}

#[cfg(test)]
fn parse_updates(raw: &str, children: &[SubagentInfo]) -> Vec<TranscriptItem> {
    parse_updates_at(raw.as_bytes(), 0, children)
        .into_iter()
        .map(|row| row.item)
        .collect()
}

fn parse_updates_at(raw: &[u8], base: u64, children: &[SubagentInfo]) -> Vec<ParsedItem> {
    let mut items: Vec<ParsedItem> = Vec::new();
    let mut work: Vec<String> = Vec::new();
    let mut work_start: Option<u64> = None;
    let mut work_eid: Option<String> = None;
    let mut seen_tools = std::collections::HashSet::<String>::new();
    let mut seen_subs = std::collections::HashSet::<String>::new();

    let flush_work = |items: &mut Vec<ParsedItem>,
                      work: &mut Vec<String>,
                      work_start: &mut Option<u64>,
                      work_eid: &mut Option<String>| {
        let text = summarize_work(work);
        work.clear();
        let start = work_start.take().unwrap_or(base);
        let eid = work_eid.take();
        if text.is_empty() {
            return;
        }
        if let Some(last) = items.last() {
            if last.item.kind == "work" && last.item.text == text {
                return;
            }
        }
        items.push(ParsedItem {
            item: TranscriptItem {
                kind: "work".into(),
                text,
                title: None,
                meta: None,
                session_id: None,
                status: None,
                details: None,
                images: None,
                at: None,
                eid,
            },
            start,
        });
    };

    let mut consumed = 0u64;
    for line in raw.split_inclusive(|byte| *byte == b'\n') {
        let line_start = base + consumed;
        consumed = consumed.saturating_add(line.len() as u64);
        let line = line.strip_suffix(b"\n").unwrap_or(line);
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue;
        };
        let at = event_time_ms(&v);
        let eid = event_id(&v);
        let Some(update) = v.pointer("/params/update") else {
            continue;
        };
        let Some(kind) = update.get("sessionUpdate").and_then(|k| k.as_str()) else {
            continue;
        };
        match kind {
            "agent_thought_chunk" => {}
            "user_message_chunk" | "agent_message_chunk" => {
                flush_work(&mut items, &mut work, &mut work_start, &mut work_eid);
                let mapped = if kind == "user_message_chunk" {
                    "user"
                } else {
                    "agent"
                };
                let text = chunk_text(update);
                if let Some(last) = items.last_mut() {
                    if last.item.kind == mapped {
                        last.item.text.push_str(&text);
                        continue;
                    }
                }
                items.push(ParsedItem {
                    item: TranscriptItem {
                        kind: mapped.into(),
                        text,
                        title: None,
                        meta: None,
                        session_id: None,
                        status: None,
                        details: None,
                        images: None,
                        at,
                        eid,
                    },
                    start: line_start,
                });
            }
            "tool_call" | "tool_call_update" => {
                let id = update
                    .get("toolCallId")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string();
                let title = update
                    .get("title")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = resolve_tool_name(update, &title);
                let title = if title.is_empty() {
                    if name.is_empty() {
                        "tool".into()
                    } else {
                        name.clone()
                    }
                } else {
                    title
                };
                if is_internal_tool(&name, &title) {
                    continue;
                }
                if let Some(mut edit) = parse_edit_tool(&name, update) {
                    if !id.is_empty() && !seen_tools.insert(id.clone()) {
                        continue;
                    }
                    flush_work(&mut items, &mut work, &mut work_start, &mut work_eid);
                    edit.at = at.clone();
                    edit.eid = eid.clone();
                    items.push(ParsedItem {
                        item: edit,
                        start: line_start,
                    });
                    continue;
                }
                if name == "spawn_subagent" {
                    if !id.is_empty() && !seen_subs.insert(id.clone()) {
                        continue;
                    }
                    flush_work(&mut items, &mut work, &mut work_start, &mut work_eid);
                    let desc = update
                        .pointer("/rawInput/description")
                        .or_else(|| update.pointer("/rawInput/prompt"))
                        .and_then(|t| t.as_str())
                        .map(|s| s.lines().next().unwrap_or(s).trim().to_string())
                        .filter(|s| !s.is_empty() && !is_internal_tool(&name, s));
                    let Some(desc) = desc else {
                        continue;
                    };
                    let matched = children
                        .iter()
                        .find(|c| desc.contains(&c.description) || c.description.contains(&desc));
                    items.push(ParsedItem {
                        item: TranscriptItem {
                            kind: "subagent".into(),
                            text: matched.map(|c| c.description.clone()).unwrap_or(desc),
                            title: Some(
                                matched
                                    .map(|c| c.subagent_type.clone())
                                    .unwrap_or_else(|| "subagent".into()),
                            ),
                            meta: matched.map(|c| c.status.clone()),
                            session_id: matched.map(|c| c.session_id.clone()),
                            status: matched.map(|c| c.status.clone()),
                            details: None,
                            images: None,
                            at,
                            eid,
                        },
                        start: line_start,
                    });
                    continue;
                }
                if !id.is_empty() && !seen_tools.insert(id) {
                    continue;
                }
                if let Some(kind) = work_kind(&name, &title) {
                    if work.is_empty() {
                        work_start = Some(line_start);
                        work_eid = eid;
                    }
                    work.push(kind.to_string());
                }
            }
            _ => {}
        }
    }
    flush_work(&mut items, &mut work, &mut work_start, &mut work_eid);
    sanitize_parsed_items(items)
}

pub(super) fn find_ignore_ascii_case(hay: &str, needle: &str) -> Option<usize> {
    hay.as_bytes()
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

fn strip_system_reminders_with(s: &str, trim: bool) -> String {
    const OPEN: &str = "<system-reminder>";
    const CLOSE: &str = "</system-reminder>";
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = find_ignore_ascii_case(rest, OPEN) {
        let at_block = start == 0 || rest.as_bytes().get(start.saturating_sub(1)) == Some(&b'\n');
        out.push_str(&rest[..start]);
        let after_open = &rest[start + OPEN.len()..];
        if let Some(end) = find_ignore_ascii_case(after_open, CLOSE) {
            rest = &after_open[end + CLOSE.len()..];
            continue;
        }
        if at_block {
            rest = "";
            break;
        }
        out.push_str(&rest[start..start + OPEN.len()]);
        rest = after_open;
    }
    out.push_str(rest);
    let mut cleaned = String::with_capacity(out.len());
    let mut newlines = 0;
    for ch in out.chars() {
        if ch == '\n' {
            newlines += 1;
            if newlines <= 2 {
                cleaned.push(ch);
            }
        } else {
            newlines = 0;
            cleaned.push(ch);
        }
    }
    if trim {
        cleaned.trim().to_string()
    } else {
        cleaned
    }
}

pub(super) fn strip_system_reminders(s: &str) -> String {
    strip_system_reminders_with(s, true)
}

pub(super) fn looks_like_reminder_residue(s: &str) -> bool {
    let t = s.trim();
    t.starts_with("</system-reminder>")
        || (t.starts_with("Background task \"") && t.contains("completed (exit code:"))
        || t.contains("Use get_command_or_subagent_output")
}

fn sanitize_parsed_items(items: Vec<ParsedItem>) -> Vec<ParsedItem> {
    items
        .into_iter()
        .filter_map(|mut row| {
            if row.item.kind == "user" || row.item.kind == "agent" {
                row.item.text = strip_system_reminders_with(&row.item.text, false);
                if row.item.text.trim().is_empty() || looks_like_system_prompt(&row.item.text) {
                    return None;
                }
            }
            Some(row)
        })
        .collect()
}

fn json_str(v: Option<&serde_json::Value>) -> String {
    v.and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn resolve_tool_name(update: &serde_json::Value, title: &str) -> String {
    if let Some(name) = update
        .pointer("/_meta/x.ai/tool/name")
        .and_then(|t| t.as_str())
        .filter(|s| !s.is_empty())
    {
        return name.to_string();
    }
    let kind = update
        .pointer("/_meta/x.ai/tool/kind")
        .and_then(|t| t.as_str())
        .unwrap_or("");
    let key = title.to_ascii_lowercase();
    if kind.eq_ignore_ascii_case("edit")
        || key.contains("search_replace")
        || key.starts_with("edit ")
        || key.starts_with("edit`")
        || key.starts_with("edit/")
    {
        return "search_replace".into();
    }
    if kind.eq_ignore_ascii_case("write")
        || key == "write"
        || key.starts_with("write ")
        || key.starts_with("write`")
        || key.starts_with("write/")
    {
        return "write".into();
    }
    title.to_string()
}

fn parse_edit_tool(name: &str, update: &serde_json::Value) -> Option<TranscriptItem> {
    let raw = update.get("rawInput")?;
    let path = raw.get("file_path")?.as_str()?.to_string();
    if path.is_empty() {
        return None;
    }
    let key = name.to_ascii_lowercase();
    let named_write = key == "write" || key.ends_with("/write") || key.starts_with("write ");
    let named_edit = key.contains("search_replace")
        || key.contains("str_replace")
        || key.contains("strreplace")
        || key.starts_with("edit ")
        || key.starts_with("edit`")
        || key.starts_with("edit/");
    let before = json_str(raw.get("old_string"));
    let after_swap = json_str(raw.get("new_string"));
    let contents = json_str(raw.get("content"));
    let looks_write = named_write
        || (!named_edit && before.is_empty() && after_swap.is_empty() && !contents.is_empty());
    let looks_edit = named_edit || !before.is_empty() || !after_swap.is_empty();
    let (verb, before, after) = if looks_write && !looks_edit {
        (
            "Write",
            String::new(),
            if contents.is_empty() {
                after_swap
            } else {
                contents
            },
        )
    } else if looks_edit {
        (
            "Edit",
            before,
            if after_swap.is_empty() {
                contents
            } else {
                after_swap
            },
        )
    } else {
        return None;
    };
    Some(TranscriptItem {
        kind: "edit".into(),
        text: path,
        title: Some(verb.into()),
        meta: None,
        session_id: None,
        status: None,
        details: Some(vec![before, after]),
        images: None,
        at: None,
        eid: None,
    })
}

fn work_kind(name: &str, title: &str) -> Option<&'static str> {
    let key = format!("{name} {title}").to_ascii_lowercase();
    if is_internal_tool(name, title) {
        return None;
    }
    if key.contains("search_replace")
        || key.contains("str_replace")
        || key.contains("strreplace")
        || name.eq_ignore_ascii_case("write")
        || key.contains("spawn_subagent")
        || key.contains("ask_user_question")
        || key.contains("exit_plan")
        || title_starts_with(title, "edit")
        || title_starts_with(title, "write")
    {
        return None;
    }
    if key.contains("read_file") || key.contains("list_dir") || title_starts_with(title, "read") {
        return Some("read");
    }
    if key.contains("grep")
        || title_starts_with(title, "search")
        || title_starts_with(title, "searched")
    {
        return Some("search");
    }
    if key.contains("run_terminal")
        || key.contains("bash")
        || key.contains("execute")
        || title_starts_with(title, "run")
    {
        return Some("run");
    }
    if key.contains("web_search") || key.contains("web_fetch") || key.contains("open_page") {
        return Some("web");
    }
    if key.contains("image") {
        return Some("image");
    }
    Some("work")
}

fn title_starts_with(title: &str, verb: &str) -> bool {
    let title = title.trim().to_ascii_lowercase();
    title == verb || title.starts_with(&format!("{verb} "))
}

fn summarize_work(kinds: &[String]) -> String {
    let mut read = 0usize;
    let mut search = 0usize;
    let mut run = 0usize;
    let mut web = 0usize;
    let mut image = 0usize;
    let mut work = 0usize;
    for kind in kinds {
        match kind.as_str() {
            "read" => read += 1,
            "search" => search += 1,
            "run" => run += 1,
            "web" => web += 1,
            "image" => image += 1,
            _ => work += 1,
        }
    }
    let mut parts: Vec<String> = Vec::new();
    if read == 1 {
        parts.push("Read 1 file".into());
    } else if read > 1 {
        parts.push(format!("Read {read} files"));
    }
    if search == 1 {
        parts.push("Searched 1 pattern".into());
    } else if search > 1 {
        parts.push(format!("Searched {search} patterns"));
    }
    if run == 1 {
        parts.push("Ran 1 command".into());
    } else if run > 1 {
        parts.push(format!("Ran {run} commands"));
    }
    if web == 1 {
        parts.push("Searched the web".into());
    } else if web > 1 {
        parts.push(format!("Searched the web {web} times"));
    }
    if image == 1 {
        parts.push("Made an image".into());
    } else if image > 1 {
        parts.push(format!("Made {image} images"));
    }
    if work > 0 && parts.is_empty() {
        parts.push("Worked".into());
    }
    parts.join(", ")
}

fn is_internal_tool(name: &str, title: &str) -> bool {
    let key = format!("{name} {title}").to_ascii_lowercase();
    key.contains("get_command_or_subagent")
        || key.contains("command_or_subagent_output")
        || key.contains("await_subagent")
        || key.contains("wait_subagent")
}

pub(super) fn looks_like_system_prompt(s: &str) -> bool {
    let raw = s.trim();
    if raw.is_empty() {
        return false;
    }
    if raw.starts_with("<system-reminder>") || looks_like_reminder_residue(raw) {
        return true;
    }
    let t = strip_system_reminders(raw);
    if t.is_empty() {
        return raw.to_ascii_lowercase().contains("system-reminder");
    }
    if looks_like_reminder_residue(&t) {
        return true;
    }
    let lower = t.to_ascii_lowercase();
    lower.starts_with("you are the ")
        || lower.starts_with("you are a ")
        || lower.starts_with("you are an ")
        || t.contains("You run ONCE")
        || t.contains("Goal Plan Writer")
        || t.contains("## Inputs (below this prompt)")
        || (t.contains("<user_query>") && t.contains("OBJECTIVE"))
}

pub(super) fn chunk_text(update: &serde_json::Value) -> String {
    update
        .pointer("/content/text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string()
}

fn is_image_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".webp")
        || lower.ends_with(".bmp")
        || lower.contains("\\images\\")
        || lower.contains("/images/")
        || lower.contains("\\assets\\")
        || lower.contains("/assets/")
}

fn decode_path(raw: &str) -> String {
    let cleaned = raw.trim().trim_matches('"').to_string();
    if Path::new(&cleaned).is_file() {
        return cleaned;
    }
    let alt = cleaned
        .replace("%5C", "\\")
        .replace("%5c", "\\")
        .replace("%3A", ":")
        .replace("%3a", ":");
    if Path::new(&alt).is_file() {
        return alt;
    }
    cleaned
}

fn extract_image_file_list(text: &str) -> Vec<String> {
    let Some(start) = text.find("<image_files>") else {
        return Vec::new();
    };
    let rest = &text[start..];
    let end = rest.find("</image_files>").unwrap_or(rest.len());
    let mut out = Vec::new();
    for line in rest[..end].lines() {
        let line = line.trim();
        let Some(dot) = line.find(". ") else {
            continue;
        };
        if !line.as_bytes().first().is_some_and(|b| b.is_ascii_digit()) {
            continue;
        }
        let path = decode_path(&line[dot + 2..]);
        if is_image_path(&path) {
            out.push(path);
        }
    }
    out
}

fn extract_at_paths(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = text[from..].find('@') {
        let start = from + rel + 1;
        let slice = &text[start..];
        let path = if let Some(rest) = slice.strip_prefix('"') {
            rest.split('"').next().unwrap_or("")
        } else {
            slice.split_whitespace().next().unwrap_or("")
        };
        let path = decode_path(path);
        if is_image_path(&path) {
            out.push(path);
        }
        // Advance by a whole char: `start + 1` lands mid-codepoint on non-ASCII
        // and past the end when the text ends with '@'.
        match slice.chars().next() {
            Some(c) => from = start + c.len_utf8(),
            None => break,
        }
    }
    out
}

fn strip_image_markup(text: &str) -> String {
    let mut s = text.to_string();
    if let (Some(a), Some(b)) = (s.find("<image_files>"), s.find("</image_files>")) {
        s.replace_range(a..b + "</image_files>".len(), "");
    }
    s = s.replace("<user_query>", "").replace("</user_query>", "");
    let mut cleaned = String::new();
    let mut rest = s.as_str();
    while let Some(at) = rest.find("[Image #") {
        cleaned.push_str(&rest[..at]);
        if let Some(end) = rest[at..].find(']') {
            rest = &rest[at + end + 1..];
        } else {
            rest = &rest[at + 8..];
        }
    }
    cleaned.push_str(rest);
    let mut out = String::new();
    let mut from = 0;
    let bytes = cleaned.as_str();
    while let Some(rel) = bytes[from..].find('@') {
        out.push_str(&bytes[from..from + rel]);
        let start = from + rel + 1;
        let slice = &bytes[start..];
        let (path, skip) = if let Some(rest) = slice.strip_prefix('"') {
            match rest.find('"') {
                Some(n) => (&rest[..n], n + 2),
                None => ("", 1),
            }
        } else {
            let n = slice.find(char::is_whitespace).unwrap_or(slice.len());
            (&slice[..n], n)
        };
        if !is_image_path(&decode_path(path)) {
            out.push('@');
            from = start;
            continue;
        }
        from = start + skip;
    }
    out.push_str(&bytes[from..]);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn load_image_turns(dir: &Path) -> Vec<(String, Vec<String>)> {
    let raw = fs::read_to_string(dir.join("chat_history.jsonl")).unwrap_or_default();
    let mut out = Vec::new();
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        let mut blob = String::new();
        if let Some(arr) = v.get("content").and_then(|c| c.as_array()) {
            for part in arr {
                if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                        blob.push_str(t);
                        blob.push('\n');
                    }
                }
            }
        } else if let Some(t) = v.get("content").and_then(|c| c.as_str()) {
            blob.push_str(t);
        }
        let paths = extract_image_file_list(&blob);
        if paths.is_empty() {
            continue;
        }
        let key = strip_image_markup(&blob);
        out.push((key, paths));
    }
    out
}

fn attach_user_images(dir: &Path, items: &mut [TranscriptItem]) {
    let needs_history = items
        .iter()
        .any(|item| item.kind == "user" && item.text.contains("[Image #"));
    let turns = if needs_history {
        load_image_turns(dir)
    } else {
        Vec::new()
    };
    let mut used = vec![false; turns.len()];
    for item in items.iter_mut() {
        if item.kind != "user" {
            continue;
        }
        let mut paths = extract_at_paths(&item.text);
        for path in extract_image_file_list(&item.text) {
            if !paths.iter().any(|p| p == &path) {
                paths.push(path);
            }
        }
        if item.text.contains("[Image #") {
            let key = strip_image_markup(&item.text);
            let found = turns.iter().enumerate().position(|(i, (query, _))| {
                if used[i] {
                    return false;
                }
                if key.is_empty() {
                    return true;
                }
                query == &key || query.contains(&key) || key.contains(query)
            });
            if let Some(i) = found {
                used[i] = true;
                for path in &turns[i].1 {
                    if !paths.iter().any(|p| p == path) {
                        paths.push(path.clone());
                    }
                }
            }
        }
        item.text = strip_image_markup(&item.text);
        if !paths.is_empty() {
            item.images = Some(paths);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk_line(kind: &str, text: &str) -> String {
        serde_json::json!({
            "params": {
                "update": {
                    "sessionUpdate": kind,
                    "content": { "text": text }
                }
            }
        })
        .to_string()
    }

    #[test]
    fn items_carry_the_event_id_of_their_journal_line() {
        let raw = [
            r#"{"params":{"_meta":{"eventId":"session-a-11"},"update":{"sessionUpdate":"user_message_chunk","content":{"text":"hi"}}}}"#,
            r#"{"params":{"_meta":{"eventId":"session-a-12"},"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"hello "}}}}"#,
            r#"{"params":{"_meta":{"eventId":"session-a-13"},"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"there"}}}}"#,
        ]
        .join("\n");
        let items = parse_updates(&raw, &[]);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].eid, Some("session-a-11".to_string()));
        // A joined chunk keeps the id that opened the message.
        assert_eq!(items[1].text, "hello there");
        assert_eq!(items[1].eid, Some("session-a-12".to_string()));
    }

    #[test]
    fn dense_pages_use_the_first_returned_items_byte_boundary() {
        let dir = std::env::temp_dir().join(format!(
            "korg-dense-replay-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        let lines = (0..100)
            .map(|index| {
                let kind = if index % 2 == 0 {
                    "user_message_chunk"
                } else {
                    "agent_message_chunk"
                };
                chunk_line(kind, &format!("item-{index:03}"))
            })
            .collect::<Vec<_>>();
        fs::write(dir.join("updates.jsonl"), format!("{}\n", lines.join("\n"))).unwrap();

        let newest = replay_page(&dir, None).unwrap();
        assert_eq!(newest.items.len(), 40);
        assert_eq!(newest.items[0].text, "item-060");
        let expected_newest_cursor = lines[..60]
            .iter()
            .map(|line| line.len() as u64 + 1)
            .sum::<u64>();
        assert_eq!(newest.cursor, expected_newest_cursor);
        assert!(newest.has_more);

        let middle = replay_page(&dir, Some(newest.cursor)).unwrap();
        assert_eq!(middle.items.len(), 40);
        assert_eq!(middle.items[0].text, "item-020");
        assert_eq!(middle.items.last().unwrap().text, "item-059");
        assert!(middle.has_more);

        let oldest = replay_page(&dir, Some(middle.cursor)).unwrap();
        assert_eq!(oldest.items.len(), 20);
        assert_eq!(oldest.items[0].text, "item-000");
        assert_eq!(oldest.items.last().unwrap().text, "item-019");
        assert_eq!(oldest.cursor, 0);
        assert!(!oldest.has_more);

        let all = oldest
            .items
            .iter()
            .chain(middle.items.iter())
            .chain(newest.items.iter())
            .map(|item| item.text.clone())
            .collect::<Vec<_>>();
        assert_eq!(all.len(), 100);
        assert_eq!(
            all,
            (0..100).map(|i| format!("item-{i:03}")).collect::<Vec<_>>()
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn replay_page_stops_at_the_byte_budget_when_chunks_merge() {
        let dir = std::env::temp_dir().join(format!(
            "korg-bounded-replay-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        let line = chunk_line("agent_message_chunk", &"x".repeat(1024));
        let count = (REPLAY_MAX_BYTES as usize / (line.len() + 1)) * 2 + 100;
        let raw = std::iter::repeat(line)
            .take(count)
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(dir.join("updates.jsonl"), format!("{raw}\n")).unwrap();

        let page = replay_page(&dir, None).unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(page.has_more);
        assert!(page.cursor > 0);
        assert!(page.items[0].text.len() < count * 1024);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn replay_page_marks_and_skips_one_oversized_jsonl_record() {
        let dir = std::env::temp_dir().join(format!(
            "korg-oversized-event-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        let first = chunk_line("user_message_chunk", "before");
        let oversized = chunk_line(
            "agent_message_chunk",
            &"x".repeat(REPLAY_MAX_BYTES as usize + 1024),
        );
        fs::write(dir.join("updates.jsonl"), format!("{first}\n{oversized}\n")).unwrap();

        let newest = replay_page(&dir, None).unwrap();
        assert_eq!(newest.items.len(), 1);
        assert_eq!(newest.items[0].kind, "work");
        assert_eq!(newest.items[0].text, OVERSIZED_EVENT_NOTICE);
        assert_eq!(newest.items[0].meta.as_deref(), Some("replay-warning"));
        assert_eq!(newest.cursor, first.len() as u64 + 1);
        assert!(newest.has_more);
        assert!(!newest.turn_complete);

        let oldest = replay_page(&dir, Some(newest.cursor)).unwrap();
        assert_eq!(oldest.items.len(), 1);
        assert_eq!(oldest.items[0].text, "before");
        assert!(!oldest.has_more);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn replay_page_does_not_scan_an_unbounded_oversized_record() {
        let dir = std::env::temp_dir().join(format!(
            "korg-unbounded-event-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        let oversized = chunk_line(
            "agent_message_chunk",
            &"x".repeat((REPLAY_MAX_BYTES * 3) as usize),
        );
        fs::write(dir.join("updates.jsonl"), format!("{oversized}\n")).unwrap();

        let error = replay_page(&dir, None).unwrap_err();
        assert!(error.contains("exceeds the bounded replay limit"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn replay_page_keeps_first_record_when_budget_starts_on_a_line_boundary() {
        let dir = std::env::temp_dir().join(format!(
            "korg-budget-boundary-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        let prefix = "{\"metadata\":true}\n";
        let mut tail = format!("{}\n", chunk_line("user_message_chunk", "keep me")).into_bytes();
        tail.resize(REPLAY_MAX_BYTES as usize, b'\n');
        let mut raw = prefix.as_bytes().to_vec();
        raw.extend(tail);
        fs::write(dir.join("updates.jsonl"), raw).unwrap();

        let newest = replay_page(&dir, None).unwrap();
        assert_eq!(newest.items.len(), 1);
        assert_eq!(newest.items[0].kind, "user");
        assert_eq!(newest.items[0].text, "keep me");
        assert_eq!(newest.cursor, prefix.len() as u64);
        assert!(newest.has_more);

        let oldest = replay_page(&dir, Some(newest.cursor)).unwrap();
        assert!(oldest.items.is_empty());
        assert_eq!(oldest.cursor, 0);
        assert!(!oldest.has_more);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bounded_message_pages_preserve_whitespace_at_their_join() {
        let dir = std::env::temp_dir().join(format!(
            "korg-bounded-whitespace-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        let chunk = "word \n".repeat(160);
        let line = chunk_line("agent_message_chunk", &chunk);
        let count = (REPLAY_MAX_BYTES as usize / (line.len() + 1)) * 2 + 20;
        let raw = std::iter::repeat(line)
            .take(count)
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(dir.join("updates.jsonl"), format!("{raw}\n")).unwrap();

        let expected = chunk.repeat(count);
        let mut before = None;
        let mut combined = String::new();
        loop {
            let page = replay_page(&dir, before).unwrap();
            let page_text = page
                .items
                .iter()
                .filter(|item| item.kind == "agent")
                .map(|item| item.text.as_str())
                .collect::<String>();
            combined = format!("{page_text}{combined}");
            if !page.has_more {
                break;
            }
            before = Some(page.cursor);
        }
        assert_eq!(combined, expected);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn leading_metadata_does_not_create_an_empty_older_page() {
        let dir = std::env::temp_dir().join(format!(
            "korg-leading-metadata-replay-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        let raw = format!(
            "{{\"metadata\":true}}\n{}\n",
            chunk_line("user_message_chunk", "hello")
        );
        fs::write(dir.join("updates.jsonl"), raw).unwrap();
        let page = replay_page(&dir, None).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.cursor, 0);
        assert!(!page.has_more);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn items_have_no_event_id_when_grok_sends_none() {
        let items = parse_updates(&chunk_line("agent_message_chunk", "plain"), &[]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].eid, None);
    }

    #[test]
    fn extract_at_paths_survives_trailing_and_non_ascii_mentions() {
        assert!(extract_at_paths("look at this @").is_empty());
        assert!(extract_at_paths("@中文路径").is_empty());
        assert!(extract_at_paths("@🙂 and @").is_empty());
        assert_eq!(
            extract_at_paths("see @shot.png and @中文 then @a/b.jpg"),
            vec!["shot.png".to_string(), "a/b.jpg".to_string()]
        );
    }

    #[test]
    fn parse_updates_drops_system_reminder_user_chunks() {
        let raw = [
            chunk_line("user_message_chunk", "hello"),
            chunk_line(
                "user_message_chunk",
                "<system-reminder>\nBackground task \"call-1\" completed (exit code: 0).\nUse get_command_or_subagent_output(\"call-1\") to see the full output.\n</system-reminder>",
            ),
            chunk_line("agent_message_chunk", "ok"),
        ]
        .join("\n");
        let items = parse_updates(&raw, &[]);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].kind, "user");
        assert_eq!(items[0].text, "hello");
        assert_eq!(items[1].kind, "agent");
        assert_eq!(items[1].text, "ok");
    }

    #[test]
    fn parse_updates_emits_search_replace_cards() {
        let with_meta = serde_json::json!({
            "params": {
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "t1",
                    "title": "search_replace",
                    "rawInput": {
                        "file_path": "src/App.tsx",
                        "old_string": "a",
                        "new_string": "b"
                    },
                    "_meta": { "x.ai/tool": { "name": "search_replace" } }
                }
            }
        })
        .to_string();
        let titled = serde_json::json!({
            "params": {
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "t2",
                    "title": "Edit `/tmp/a.ts`",
                    "rawInput": {
                        "file_path": "/tmp/a.ts",
                        "old_string": "old",
                        "new_string": "new"
                    }
                }
            }
        })
        .to_string();
        let write = serde_json::json!({
            "params": {
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "t3",
                    "title": "write",
                    "rawInput": { "file_path": "new.ts", "content": "export {}\n" },
                    "_meta": { "x.ai/tool": { "name": "write" } }
                }
            }
        })
        .to_string();
        let items = parse_updates(&format!("{with_meta}\n{titled}\n{write}"), &[]);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].kind, "edit");
        assert_eq!(items[0].text, "src/App.tsx");
        assert_eq!(items[0].title.as_deref(), Some("Edit"));
        assert_eq!(items[0].details.as_ref().unwrap()[1], "b");
        assert_eq!(items[1].text, "/tmp/a.ts");
        assert_eq!(items[2].title.as_deref(), Some("Write"));
        assert_eq!(items[2].text, "new.ts");
    }

    #[test]
    fn parse_updates_emits_work_summary() {
        let read = |id: &str, path: &str| {
            serde_json::json!({
                "params": {
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": id,
                        "title": format!("Read `{path}`"),
                        "rawInput": { "file_path": path },
                        "_meta": { "x.ai/tool": { "name": "read_file" } }
                    }
                }
            })
            .to_string()
        };
        let grep = serde_json::json!({
            "params": {
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "g1",
                    "title": "grep",
                    "rawInput": { "pattern": "foo" },
                    "_meta": { "x.ai/tool": { "name": "grep" } }
                }
            }
        })
        .to_string();
        let agent = chunk_line("agent_message_chunk", "ok");
        let items = parse_updates(
            &format!(
                "{}\n{}\n{grep}\n{agent}",
                read("r1", "a.ts"),
                read("r2", "b.ts")
            ),
            &[],
        );
        assert_eq!(items[0].kind, "work");
        assert_eq!(items[0].text, "Read 2 files, Searched 1 pattern");
        assert_eq!(items[1].kind, "agent");
        assert_eq!(items[1].text, "ok");
    }

    #[test]
    fn work_keeps_its_first_tool_eid_when_the_next_message_flushes_it() {
        let raw = [
            r#"{"params":{"_meta":{"eventId":"session-20"},"update":{"sessionUpdate":"tool_call","toolCallId":"r1","title":"Read `a.ts`","rawInput":{"file_path":"a.ts"},"_meta":{"x.ai/tool":{"name":"read_file"}}}}}"#,
            r#"{"params":{"_meta":{"eventId":"session-21"},"update":{"sessionUpdate":"user_message_chunk","content":{"text":"next"}}}}"#,
        ]
        .join("\n");
        let items = parse_updates(&raw, &[]);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].kind, "work");
        assert_eq!(items[0].eid.as_deref(), Some("session-20"));
        assert_eq!(items[1].kind, "user");
        assert_eq!(items[1].eid.as_deref(), Some("session-21"));
    }

    #[test]
    fn title_only_tool_kinds_match_the_live_projection() {
        assert_eq!(work_kind("", "Search source"), Some("search"));
        assert_eq!(work_kind("", "Searched source"), Some("search"));
        assert_eq!(work_kind("", "Run tests"), Some("run"));
        assert_eq!(work_kind("", "Edit app.ts"), None);
        assert_eq!(work_kind("", "Write report"), None);
        assert_eq!(work_kind("exit_plan", "Done"), None);
    }

    #[test]
    fn journal_turn_complete_ignores_trailing_thoughts() {
        let done = [
            chunk_line("user_message_chunk", "fix it"),
            chunk_line("agent_message_chunk", "ok"),
            chunk_line("turn_completed", ""),
            chunk_line("agent_thought_chunk", "leftover"),
        ]
        .join("\n");
        assert!(journal_turn_complete(&done));
        let open = [
            chunk_line("user_message_chunk", "fix it"),
            chunk_line("tool_call", ""),
        ]
        .join("\n");
        assert!(!journal_turn_complete(&open));
        let tail = [
            chunk_line("tool_call", ""),
            chunk_line("agent_thought_chunk", "still going"),
        ]
        .join("\n");
        assert!(!journal_turn_complete(&tail));
        assert!(journal_turn_complete(""));
    }
}
