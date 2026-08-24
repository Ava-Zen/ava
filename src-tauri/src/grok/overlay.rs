use std::collections::{HashMap, HashSet};
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crate::grok::types::RosterItem;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::grok::grok_bin::grok_home;

const SESSION_COLORS: &[&str] = &[
    "#f0a05a", "#6ea8e8", "#d2a679", "#7dcc9a", "#ee7b88", "#9d95e8", "#5eb8b8",
];
const SESSION_SHAPES: &[&str] = &["panda", "pebble", "triangle", "squircle"];

pub fn default_session_style(session_id: &str) -> (String, String) {
    let mut hash: u32 = 2166136261;
    for byte in session_id.bytes() {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(16777619);
    }
    (
        SESSION_COLORS[(hash as usize) % SESSION_COLORS.len()].to_string(),
        SESSION_SHAPES[((hash >> 8) as usize) % SESSION_SHAPES.len()].to_string(),
    )
}

fn pick_least_used(preferred: &str, used: &[String], palette: &[&str]) -> String {
    let Some(pref_idx) = palette.iter().position(|slot| *slot == preferred) else {
        return preferred.to_string();
    };
    let mut counts = vec![0usize; palette.len()];
    for value in used {
        if let Some(index) = palette.iter().position(|slot| *slot == value.as_str()) {
            counts[index] += 1;
        }
    }
    let min = counts.iter().copied().min().unwrap_or(0);
    for offset in 0..palette.len() {
        let index = (pref_idx + offset) % palette.len();
        if counts[index] == min {
            return palette[index].to_string();
        }
    }
    preferred.to_string()
}

fn overlay_dir() -> PathBuf {
    grok_home().join("ava")
}

fn state_path() -> PathBuf {
    overlay_dir().join("state.json")
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlayState {
    #[serde(default)]
    titles: HashMap<String, String>,
    #[serde(default)]
    reads: HashMap<String, String>,
    #[serde(default)]
    pins: Vec<String>,
    /// Read old state files without treating their cached Grok values as
    /// authoritative. They are intentionally omitted on the next write.
    #[serde(default, rename = "models", skip_serializing)]
    legacy_models: HashMap<String, SessionModelPref>,
    #[serde(default, rename = "modes", skip_serializing)]
    legacy_modes: HashMap<String, String>,
    /// Korg-only picker/permission preference. This may affect prompt `_meta`
    /// and presentation, but is never replayed as an ACP session mutation.
    #[serde(default)]
    mode_preferences: HashMap<String, String>,
    #[serde(default)]
    theme: String,
    #[serde(default)]
    default_mode: String,
    /// Last Korg-selected session id, including the local draft id. Restores
    /// the empty composer (with last project + default mode) across relaunch.
    #[serde(default)]
    last_session: String,
    #[serde(default)]
    last_project: String,
    #[serde(default)]
    recent_projects: Vec<String>,
    #[serde(default)]
    styles: HashMap<String, SessionStyle>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStyle {
    color: String,
    shape: String,
}

const LOCK_WAIT: Duration = Duration::from_secs(5);
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

struct TransactionLock {
    file: fs::File,
}

impl TransactionLock {
    fn acquire(data_path: &Path) -> Result<Self, String> {
        if let Some(parent) = data_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let lock_path = sibling_path(data_path, ".lock");
        // Keep one stable inode at this path. Removing a stale create_new lock
        // can race with another process recreating it; OS locks are released
        // automatically when a process exits and need no stale-file protocol.
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|err| format!("{}: {err}", lock_path.display()))?;
        let deadline = Instant::now() + LOCK_WAIT;
        loop {
            match try_lock_exclusive(&file) {
                Ok(true) => return Ok(Self { file }),
                Ok(false) => {
                    if Instant::now() >= deadline {
                        return Err(format!(
                            "timed out waiting for overlay transaction lock {}",
                            lock_path.display()
                        ));
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                Err(err) => return Err(format!("{}: {err}", lock_path.display())),
            }
        }
    }
}

impl Drop for TransactionLock {
    fn drop(&mut self) {
        let _ = unlock_file(&self.file);
    }
}

fn sibling_path(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

#[cfg(unix)]
fn try_lock_exclusive(file: &fs::File) -> std::io::Result<bool> {
    use std::os::fd::AsRawFd;

    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(true);
    }
    let err = std::io::Error::last_os_error();
    if matches!(err.raw_os_error(), Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN)
    {
        Ok(false)
    } else {
        Err(err)
    }
}

#[cfg(unix)]
fn unlock_file(file: &fs::File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;

    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn try_lock_exclusive(file: &fs::File) -> std::io::Result<bool> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::ERROR_LOCK_VIOLATION;
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;

    let mut overlapped = unsafe { std::mem::zeroed::<OVERLAPPED>() };
    let result = unsafe {
        LockFileEx(
            file.as_raw_handle(),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            u32::MAX,
            u32::MAX,
            &mut overlapped,
        )
    };
    if result != 0 {
        return Ok(true);
    }
    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(ERROR_LOCK_VIOLATION as i32) {
        Ok(false)
    } else {
        Err(err)
    }
}

#[cfg(windows)]
fn unlock_file(file: &fs::File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::UnlockFileEx;
    use windows_sys::Win32::System::IO::OVERLAPPED;

    let mut overlapped = unsafe { std::mem::zeroed::<OVERLAPPED>() };
    if unsafe { UnlockFileEx(file.as_raw_handle(), 0, u32::MAX, u32::MAX, &mut overlapped) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn read_json<T: DeserializeOwned + Default>(path: &Path, label: &str) -> Result<T, String> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(T::default()),
        Err(err) => return Err(format!("could not read {label} {}: {err}", path.display())),
    };
    serde_json::from_slice(&raw).map_err(|err| {
        format!(
            "could not parse {label} {}; refusing to overwrite it: {err}",
            path.display()
        )
    })
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = sibling_path(path, &format!(".tmp-{}-{sequence}", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| format!("{}: {e}", temp.display()))?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        atomic_replace(&temp, path).map_err(|e| {
            format!(
                "could not atomically replace {} with {}: {e}",
                path.display(),
                temp.display()
            )
        })?;
        #[cfg(unix)]
        if let Some(parent) = path.parent() {
            fs::File::open(parent)
                .and_then(|dir| dir.sync_all())
                .map_err(|e| format!("could not sync {}: {e}", parent.display()))?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(not(windows))]
fn atomic_replace(temp: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(temp, target)
}

#[cfg(windows)]
fn atomic_replace(temp: &Path, target: &Path) -> std::io::Result<()> {
    use std::iter;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temp = temp
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
    if unsafe { MoveFileExW(temp.as_ptr(), target.as_ptr(), flags) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn with_json_transaction<T, R>(
    path: &Path,
    label: &str,
    edit: impl FnOnce(&mut T) -> Result<(R, bool), String>,
) -> Result<R, String>
where
    T: DeserializeOwned + Serialize + Default,
{
    let _lock = TransactionLock::acquire(path)?;
    let mut value = read_json(path, label)?;
    let (result, dirty) = edit(&mut value)?;
    if dirty {
        write_json_atomic(path, &value)?;
    }
    Ok(result)
}

fn load_state() -> OverlayState {
    read_json(&state_path(), "overlay state").unwrap_or_else(|err| {
        eprintln!("[ava-overlay] {err}");
        OverlayState::default()
    })
}

fn with_state_transaction<R>(
    edit: impl FnOnce(&mut OverlayState) -> Result<(R, bool), String>,
) -> Result<R, String> {
    with_json_transaction(&state_path(), "overlay state", edit)
}

/// Apply only Korg-owned presentation state. Model and effort stay exactly as
/// returned by `x.ai/sessions/list`.
pub fn decorate_roster(rows: &mut [RosterItem]) {
    let result = with_state_transaction(|store| {
        let dirty = decorate_roster_state(store, rows);
        Ok(((), dirty))
    });
    if let Err(err) = result {
        eprintln!("[ava-overlay] {err}");
    }
}

fn decorate_roster_state(store: &mut OverlayState, rows: &mut [RosterItem]) -> bool {
    let pins: HashSet<&str> = store.pins.iter().map(String::as_str).collect();
    let mut dirty = false;
    for row in rows.iter_mut() {
        if let Some(title) = store.titles.get(&row.session_id) {
            if !title.is_empty() {
                row.title = title.clone();
            }
        }
        row.pinned = pins.contains(row.session_id.as_str());
        if !row.updated_at.is_empty() {
            match store.reads.get(&row.session_id) {
                None => {
                    store
                        .reads
                        .insert(row.session_id.clone(), row.updated_at.clone());
                    dirty = true;
                    row.unread = false;
                }
                Some(seen) => row.unread = row.updated_at.as_str() > seen.as_str(),
            }
        }
    }
    dirty |= assign_roster_styles(rows, &mut store.styles);
    dirty
}

fn assign_roster_styles(
    rows: &mut [RosterItem],
    styles: &mut HashMap<String, SessionStyle>,
) -> bool {
    let mut used_colors = Vec::new();
    let mut used_shapes = Vec::new();
    let mut unlocked = Vec::new();
    for (index, row) in rows.iter_mut().enumerate() {
        if styles.contains_key(&row.session_id) {
            let _ = apply_locked_style(row, styles);
            if !row.color.is_empty() {
                used_colors.push(row.color.clone());
            }
            if !row.shape.is_empty() {
                used_shapes.push(row.shape.clone());
            }
        } else {
            unlocked.push(index);
        }
    }
    let mut dirty = false;
    for index in unlocked {
        let row = &mut rows[index];
        if !row.color.is_empty() {
            row.color = pick_least_used(&row.color, &used_colors, SESSION_COLORS);
        }
        if !row.shape.is_empty() {
            row.shape = pick_least_used(&row.shape, &used_shapes, SESSION_SHAPES);
        }
        if apply_locked_style(row, styles) {
            dirty = true;
            used_colors.push(row.color.clone());
            used_shapes.push(row.shape.clone());
        }
    }
    dirty
}

fn apply_locked_style(row: &mut RosterItem, styles: &mut HashMap<String, SessionStyle>) -> bool {
    if let Some(saved) = styles.get(&row.session_id) {
        if !saved.color.is_empty() {
            row.color = saved.color.clone();
        }
        if !saved.shape.is_empty() {
            row.shape = saved.shape.clone();
        }
        return false;
    }
    if row.color.is_empty() || row.shape.is_empty() {
        return false;
    }
    styles.insert(
        row.session_id.clone(),
        SessionStyle {
            color: row.color.clone(),
            shape: row.shape.clone(),
        },
    );
    true
}

pub fn rename(session_id: &str, title: &str) -> Result<(), String> {
    with_state_transaction(|store| {
        let changed = store
            .titles
            .get(session_id)
            .map_or(true, |saved| saved != title);
        if changed {
            store
                .titles
                .insert(session_id.to_string(), title.to_string());
        }
        Ok(((), changed))
    })
}

pub fn title_override(session_id: &str) -> Option<String> {
    load_state().titles.get(session_id).cloned()
}

pub fn forget_session(session_id: &str) {
    let _ = with_state_transaction(|store| {
        let mut changed = store.titles.remove(session_id).is_some();
        changed |= store.reads.remove(session_id).is_some();
        let pin_count = store.pins.len();
        store.pins.retain(|id| id != session_id);
        changed |= pin_count != store.pins.len();
        changed |= store.legacy_models.remove(session_id).is_some();
        changed |= store.legacy_modes.remove(session_id).is_some();
        changed |= store.mode_preferences.remove(session_id).is_some();
        changed |= store.styles.remove(session_id).is_some();
        if store.last_session == session_id {
            store.last_session.clear();
            changed = true;
        }
        Ok(((), changed))
    });
}

pub fn mark_read(session_id: &str, seen_at: &str) -> Result<(), String> {
    if seen_at.is_empty() {
        return Ok(());
    }
    with_state_transaction(|store| {
        let newer = store
            .reads
            .get(session_id)
            .map(|prev| seen_at > prev.as_str())
            .unwrap_or(true);
        if newer {
            store
                .reads
                .insert(session_id.to_string(), seen_at.to_string());
        }
        Ok(((), newer))
    })
}

pub fn set_pinned(session_id: &str, pinned: bool) -> Result<(), String> {
    with_state_transaction(|store| {
        let has = store.pins.iter().any(|id| id == session_id);
        let changed = has != pinned;
        if pinned {
            if !has {
                store.pins.push(session_id.to_string());
            }
        } else if has {
            store.pins.retain(|id| id != session_id);
        }
        Ok(((), changed))
    })
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelPref {
    pub model: String,
    pub effort: String,
}

pub fn session_model(_session_id: &str) -> Option<SessionModelPref> {
    // Kept for the existing session-detail call site. Grok's journal/roster is
    // the only model source; legacy overlay values must never fill or override it.
    None
}

pub fn session_mode(session_id: &str) -> Option<String> {
    load_state()
        .mode_preferences
        .get(session_id)
        .cloned()
        .filter(|mode| !mode.is_empty())
}

pub fn set_session_mode(session_id: &str, mode: &str) -> Result<(), String> {
    let mode = normalize_mode(mode);
    with_state_transaction(|store| {
        let changed = store.mode_preferences.get(session_id) != Some(&mode);
        if changed {
            store.mode_preferences.insert(session_id.to_string(), mode);
        }
        Ok(((), changed))
    })
}

pub fn default_mode() -> String {
    let stored = load_state().default_mode;
    if !stored.trim().is_empty() {
        return normalize_mode(&stored);
    }
    "ask".into()
}

pub fn set_default_mode(mode: &str) -> Result<String, String> {
    let mode = normalize_mode(mode);
    with_state_transaction(|store| {
        let changed = store.default_mode != mode;
        if changed {
            store.default_mode = mode.clone();
        }
        Ok((mode, changed))
    })
}

pub fn last_session() -> String {
    load_state().last_session
}

pub fn remember_session(session_id: &str) -> Result<(), String> {
    let session_id = session_id.trim().to_string();
    with_state_transaction(|store| {
        let changed = store.last_session != session_id;
        if changed {
            store.last_session = session_id;
        }
        Ok(((), changed))
    })
}

pub fn effective_mode(session_id: &str) -> String {
    session_mode(session_id).unwrap_or_else(default_mode)
}

pub fn normalize_mode_preference(mode: &str) -> String {
    normalize_mode(mode)
}

pub fn permission_meta(mode: &str) -> serde_json::Value {
    let mode = normalize_mode(mode);
    serde_json::json!({
        "yoloMode": mode == "full",
        "autoMode": mode == "auto",
    })
}

/// Korg's picker mixes two agent-side axes: permission (`_meta.yoloMode` /
/// `autoMode`) and session mode (ACP `session/set_mode`). Only `plan` moves
/// the session mode; the rest run the default mode at different permissions.
pub fn session_mode_id(mode: &str) -> &'static str {
    if normalize_mode(mode) == "plan" {
        "plan"
    } else {
        "default"
    }
}

/// Reflect an observed agent mode into Korg's picker preference. This follows
/// an ACP notification; the stored value is never replayed back onto attach.
/// Leaving plan lands on `ask`; a `default` report while the user is on
/// auto/full is not a permission downgrade.
pub fn adopt_agent_mode(session_id: &str, mode_id: &str) -> Option<String> {
    let current = effective_mode(session_id);
    let next = if mode_id.eq_ignore_ascii_case("plan") {
        "plan"
    } else if current == "plan" {
        "ask"
    } else {
        return None;
    };
    if next == current {
        return None;
    }
    set_session_mode(session_id, next).ok()?;
    Some(next.to_string())
}

fn normalize_mode(raw: &str) -> String {
    let key = raw.trim().to_ascii_lowercase().replace(['_', ' '], "-");
    match key.as_str() {
        "plan" => "plan".into(),
        "auto" => "auto".into(),
        "full" => "full".into(),
        _ => "ask".into(),
    }
}

fn normalize_theme(raw: &str) -> String {
    match raw {
        "light" | "dark" | "system" => raw.to_string(),
        _ => "system".into(),
    }
}

pub fn app_theme() -> String {
    normalize_theme(&load_state().theme)
}

pub fn set_app_theme(theme: &str) -> Result<String, String> {
    let theme = normalize_theme(theme);
    with_state_transaction(|store| {
        let changed = store.theme != theme;
        if changed {
            store.theme = theme.clone();
        }
        Ok((theme, changed))
    })
}

const RECENT_PROJECT_LIMIT: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPrefs {
    pub last_project: String,
    pub recent_projects: Vec<String>,
}

pub fn normalize_project(path: &str) -> String {
    let trimmed = path.trim();
    let stripped = trimmed.trim_end_matches(['/', '\\']);
    if stripped.len() == 2 && stripped.ends_with(':') {
        trimmed.to_string()
    } else {
        stripped.to_string()
    }
}

pub fn push_recent(recents: &[String], path: &str, limit: usize) -> Vec<String> {
    let path = normalize_project(path);
    if path.is_empty() {
        return recents
            .iter()
            .map(|item| normalize_project(item))
            .filter(|item| !item.is_empty())
            .take(limit)
            .collect();
    }
    let mut out = vec![path.clone()];
    for item in recents {
        let item = normalize_project(item);
        if item.is_empty() || item == path {
            continue;
        }
        out.push(item);
        if out.len() >= limit {
            break;
        }
    }
    out
}

fn living_dir(path: &str) -> Option<String> {
    let path = normalize_project(path);
    if path.is_empty() {
        return None;
    }
    Path::new(&path).is_dir().then_some(path)
}

pub fn project_prefs() -> ProjectPrefs {
    let store = load_state();
    let recent_projects: Vec<String> = store
        .recent_projects
        .iter()
        .filter_map(|path| living_dir(path))
        .collect();
    let last_project = living_dir(&store.last_project)
        .or_else(|| recent_projects.first().cloned())
        .unwrap_or_default();
    ProjectPrefs {
        last_project,
        recent_projects,
    }
}

pub fn remember_project(path: &str) -> Result<ProjectPrefs, String> {
    let path = normalize_project(path);
    if path.is_empty() {
        return Ok(project_prefs());
    }
    with_state_transaction(|store| {
        let next_recent = push_recent(&store.recent_projects, &path, RECENT_PROJECT_LIMIT);
        let changed = store.last_project != path || store.recent_projects != next_recent;
        if changed {
            store.last_project = path.clone();
            store.recent_projects = next_recent;
        }
        Ok((
            ProjectPrefs {
                last_project: store.last_project.clone(),
                recent_projects: store.recent_projects.clone(),
            },
            changed,
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn test_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "korg-overlay-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ))
    }

    #[test]
    fn normalize_strips_trailing_slashes() {
        assert_eq!(normalize_project(" /Users/lynn/src/ "), "/Users/lynn/src");
        assert_eq!(normalize_project("/tmp/"), "/tmp");
    }

    #[test]
    fn recent_projects_move_to_front_and_dedupe() {
        let next = push_recent(&["/a".into(), "/b".into(), "/c".into()], "/b/", 8);
        assert_eq!(next, vec!["/b", "/a", "/c"]);
    }

    #[test]
    fn recent_projects_cap() {
        let next = push_recent(&["/a".into(), "/b".into()], "/c", 2);
        assert_eq!(next, vec!["/c", "/a"]);
    }

    #[test]
    fn permission_meta_sets_auto_without_yolo() {
        let meta = super::permission_meta("auto");
        assert_eq!(meta["autoMode"], true);
        assert_eq!(meta["yoloMode"], false);
        let full = super::permission_meta("full");
        assert_eq!(full["yoloMode"], true);
        assert_eq!(full["autoMode"], false);
    }

    #[test]
    fn only_plan_moves_the_session_mode() {
        assert_eq!(super::session_mode_id("plan"), "plan");
        assert_eq!(super::session_mode_id("ask"), "default");
        assert_eq!(super::session_mode_id("auto"), "default");
        assert_eq!(super::session_mode_id("full"), "default");
    }

    fn style_row(id: &str, color: &str, shape: &str) -> crate::grok::types::RosterItem {
        crate::grok::types::RosterItem {
            session_id: id.into(),
            cwd: String::new(),
            title: String::new(),
            preview: String::new(),
            color: color.into(),
            shape: shape.into(),
            pinned: false,
            updated_at: String::new(),
            model_id: None,
            unread: false,
            effort: None,
        }
    }

    #[test]
    fn first_seen_avatar_style_stays_locked() {
        use std::collections::HashMap;
        let mut styles = HashMap::new();
        let mut first = style_row("s1", "#f0a05a", "panda");
        assert!(super::apply_locked_style(&mut first, &mut styles));
        let mut later = style_row("s1", "#6ea8e8", "triangle");
        assert!(!super::apply_locked_style(&mut later, &mut styles));
        assert_eq!(later.color, "#f0a05a");
        assert_eq!(later.shape, "panda");
    }

    #[test]
    fn new_sessions_spread_off_an_overused_hash_color() {
        let tan_ids = [
            "01a026f8-851c-7fe3-8a7a-b36c506bb747",
            "01a026f1-a932-77a1-ad67-7f6a0fff823e",
            "01a026ef-7cb5-72b0-921e-67a7c6acdb5a",
        ];
        let mut rows: Vec<_> = tan_ids
            .iter()
            .map(|id| {
                let (color, shape) = super::default_session_style(id);
                assert_eq!(color, "#d2a679");
                style_row(id, &color, &shape)
            })
            .collect();
        let mut state = OverlayState::default();
        assert!(decorate_roster_state(&mut state, &mut rows));
        let colors: Vec<_> = rows.iter().map(|row| row.color.clone()).collect();
        assert_eq!(colors[0], "#d2a679");
        assert_eq!(
            colors
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            3
        );

        let mut later: Vec<_> = tan_ids
            .iter()
            .map(|id| style_row(id, "#f0a05a", "panda"))
            .collect();
        assert!(!decorate_roster_state(&mut state, &mut later));
        assert_eq!(later[0].color, rows[0].color);
        assert_eq!(later[1].color, rows[1].color);
        assert_eq!(later[2].color, rows[2].color);
    }

    #[test]
    fn new_sessions_spread_off_an_overused_hash_shape() {
        let pebble_ids = [
            "01a0234e-4fe3-75d0-9852-e40a6dd02bf7",
            "01a0234d-021b-7cd0-b0cb-dddcb7d6243e",
            "01a0234b-f7bf-7282-8399-f3a278bafc6d",
        ];
        let mut rows: Vec<_> = pebble_ids
            .iter()
            .map(|id| {
                let (color, shape) = super::default_session_style(id);
                assert_eq!(shape, "pebble");
                style_row(id, &color, &shape)
            })
            .collect();
        let mut state = OverlayState::default();
        assert!(decorate_roster_state(&mut state, &mut rows));
        let shapes: Vec<_> = rows.iter().map(|row| row.shape.clone()).collect();
        assert_eq!(shapes[0], "pebble");
        assert_eq!(
            shapes
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            3
        );

        let mut later: Vec<_> = pebble_ids
            .iter()
            .map(|id| style_row(id, "#f0a05a", "panda"))
            .collect();
        assert!(!decorate_roster_state(&mut state, &mut later));
        assert_eq!(later[0].shape, rows[0].shape);
        assert_eq!(later[1].shape, rows[1].shape);
        assert_eq!(later[2].shape, rows[2].shape);
    }

    #[test]
    fn legacy_model_and_mode_cache_never_override_authoritative_roster() {
        let mut state: OverlayState = serde_json::from_value(serde_json::json!({
            "models": {
                "s1": { "model": "legacy-model", "effort": "legacy-effort" }
            },
            "modes": { "s1": "plan" }
        }))
        .unwrap();
        assert!(state.mode_preferences.is_empty());
        assert_eq!(state.legacy_models.len(), 1);
        assert_eq!(state.legacy_modes.len(), 1);

        let mut row = style_row("s1", "", "");
        row.model_id = Some("acp-model".into());
        row.effort = Some("acp-effort".into());
        assert!(!decorate_roster_state(
            &mut state,
            std::slice::from_mut(&mut row)
        ));
        assert_eq!(row.model_id.as_deref(), Some("acp-model"));
        assert_eq!(row.effort.as_deref(), Some("acp-effort"));

        let encoded = serde_json::to_value(&state).unwrap();
        assert!(encoded.get("models").is_none());
        assert!(encoded.get("modes").is_none());
    }

    #[test]
    fn composer_defaults_round_trip_through_overlay_state() {
        let state: OverlayState = serde_json::from_value(serde_json::json!({
            "defaultMode": "full",
            "lastSession": "draft",
            "lastProject": "/Users/lynn/src/korg"
        }))
        .unwrap();
        assert_eq!(state.default_mode, "full");
        assert_eq!(state.last_session, "draft");
        assert_eq!(state.last_project, "/Users/lynn/src/korg");
        let encoded = serde_json::to_value(&state).unwrap();
        assert_eq!(encoded["defaultMode"], "full");
        assert_eq!(encoded["lastSession"], "draft");
        assert_eq!(encoded["lastProject"], "/Users/lynn/src/korg");
    }

    #[test]
    fn picker_preference_is_separate_from_legacy_session_mode() {
        let state: OverlayState = serde_json::from_value(serde_json::json!({
            "modes": { "s1": "plan" },
            "modePreferences": { "s2": "auto" }
        }))
        .unwrap();
        assert_eq!(
            state.legacy_modes.get("s1").map(String::as_str),
            Some("plan")
        );
        assert_eq!(
            state.mode_preferences.get("s2").map(String::as_str),
            Some("auto")
        );
        assert!(!state.mode_preferences.contains_key("s1"));
    }

    #[test]
    fn corrupt_overlay_state_is_never_replaced_by_a_default() {
        let dir = test_dir("corrupt-state");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let corrupt = b"{ definitely not valid json";
        fs::write(&path, corrupt).unwrap();

        let err = with_json_transaction::<OverlayState, ()>(&path, "overlay state", |store| {
            store.theme = "dark".into();
            Ok(((), true))
        })
        .unwrap_err();
        assert!(err.contains("refusing to overwrite"));
        assert_eq!(fs::read(&path).unwrap(), corrupt);
        assert!(sibling_path(&path, ".lock").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_overlay_transactions_do_not_lose_updates() {
        let dir = test_dir("concurrent-state");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let workers = 12usize;
        let writes_per_worker = 8usize;
        let mut threads = Vec::new();
        for worker in 0..workers {
            let path = path.clone();
            threads.push(thread::spawn(move || {
                for write in 0..writes_per_worker {
                    let value = format!("worker-{worker}-write-{write}");
                    with_json_transaction::<OverlayState, ()>(&path, "overlay state", |store| {
                        store.recent_projects.push(value);
                        Ok(((), true))
                    })
                    .unwrap();
                }
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        let state: OverlayState = read_json(&path, "overlay state").unwrap();
        assert_eq!(state.recent_projects.len(), workers * writes_per_worker);
        let unique = state.recent_projects.iter().collect::<HashSet<_>>();
        assert_eq!(unique.len(), workers * writes_per_worker);
        let _ = fs::remove_dir_all(&dir);
    }
}
