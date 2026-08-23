use std::{
  env, fs,
  path::{Path, PathBuf},
};

#[derive(serde::Serialize)]
pub struct HomeEntry {
  name: String,
  rel: String,
  dir: bool,
}

#[tauri::command]
pub fn home_pick_folder() -> Option<String> {
  #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
  {
    rfd::FileDialog::new()
      .set_title("Choose Ava's home folder")
      .pick_folder()
      .map(|path| path.to_string_lossy().into_owned())
  }
  #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
  {
    None
  }
}

#[tauri::command]
pub fn home_suggested_path() -> Option<String> {
  suggested_home().map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn home_ensure(root: String) -> Result<String, String> {
  let path = PathBuf::from(root.trim());
  if path.as_os_str().is_empty() {
    return Err("Missing home folder.".into());
  }
  fs::create_dir_all(&path).map_err(|error| error.to_string())?;
  Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn home_read_text(root: String, rel: String) -> Result<String, String> {
  let path = resolve_inside(&root, &rel)?;
  fs::read_to_string(&path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn home_write_text(root: String, rel: String, contents: String) -> Result<(), String> {
  let path = resolve_inside(&root, &rel)?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  fs::write(&path, contents).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn home_list(root: String, rel: String) -> Result<Vec<HomeEntry>, String> {
  let path = resolve_inside(&root, &rel)?;
  if !path.exists() {
    return Ok(Vec::new());
  }
  if !path.is_dir() {
    return Err("Not a folder.".into());
  }
  let prefix = rel_prefix(&rel);
  let mut entries = Vec::new();
  for item in fs::read_dir(&path).map_err(|error| error.to_string())? {
    let item = item.map_err(|error| error.to_string())?;
    let name = item.file_name().to_string_lossy().into_owned();
    if name.starts_with('.') {
      continue;
    }
    let dir = item.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
    entries.push(HomeEntry {
      rel: if prefix.is_empty() {
        name.clone()
      } else {
        format!("{prefix}/{name}")
      },
      name,
      dir,
    });
  }
  entries.sort_by(|a, b| a.dir.cmp(&b.dir).reverse().then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
  Ok(entries)
}

fn suggested_home() -> Option<PathBuf> {
  env::var("USERPROFILE")
    .or_else(|_| env::var("HOME"))
    .ok()
    .map(|home| Path::new(&home).join("Documents").join("Ava"))
}

fn rel_prefix(rel: &str) -> String {
  rel.replace('\\', "/").trim_matches('/').to_string()
}

fn resolve_inside(root: &str, rel: &str) -> Result<PathBuf, String> {
  let root_raw = PathBuf::from(root.trim());
  if root_raw.as_os_str().is_empty() {
    return Err("Missing home folder.".into());
  }
  if !root_raw.exists() {
    fs::create_dir_all(&root_raw).map_err(|error| error.to_string())?;
  }
  let joined = join_rel(&root_raw, rel)?;
  if let Some(parent) = joined.parent() {
    if !parent.exists() {
      fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
  }
  Ok(joined)
}

fn join_rel(root: &Path, rel: &str) -> Result<PathBuf, String> {
  let mut out = root.to_path_buf();
  for part in rel.replace('\\', "/").split('/') {
    if part.is_empty() || part == "." {
      continue;
    }
    if part == ".." {
      return Err("Path is outside the home folder.".into());
    }
    out.push(part);
  }
  if !is_inside(root, &out) {
    return Err("Path is outside the home folder.".into());
  }
  Ok(out)
}

fn is_inside(root: &Path, candidate: &Path) -> bool {
  let root = normalize(root);
  let candidate = normalize(candidate);
  candidate == root || candidate.starts_with(&root)
}

fn normalize(path: &Path) -> PathBuf {
  let mut text = path.to_string_lossy().replace('/', std::path::MAIN_SEPARATOR_STR);
  #[cfg(windows)]
  {
    const UNC: &str = r"\\?\";
    if let Some(stripped) = text.strip_prefix(UNC) {
      text = stripped.to_string();
    }
    text = text.to_ascii_lowercase();
  }
  PathBuf::from(text)
}
