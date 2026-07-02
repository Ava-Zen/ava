//! Native LLM inference engine host (llama.cpp via the `llama-cpp-2` crate).
//!
//! Compiled in with the `native-llm` cargo feature (or a GPU variant such as
//! `native-llm-vulkan`). Without the feature the commands stay registered but
//! report `available: false`, and the WebView falls back to transformers.js.
//!
//! Commands:
//! - `llm_native_status`  — engine availability
//! - `llm_load_model`     — resumable GGUF download into the app data dir,
//!                          then model load
//! - `llm_generate`       — chat-template application + token streaming over
//!                          a `tauri::ipc::Channel<String>`
//! - `llm_cancel`         — abort the in-flight generation
//!
//! The TypeScript client for this contract lives in
//! `src/app/services/llm/native-llama-backend.ts`.

use std::sync::{
  atomic::{AtomicBool, Ordering},
  Arc,
};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLlmStatus {
  pub available: bool,
  pub engine: &'static str,
  pub reason: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(feature = "native-llm"), allow(dead_code))]
pub struct ChatMessage {
  pub role: String,
  pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(feature = "native-llm"), allow(dead_code))]
pub struct GenerateOptions {
  pub max_new_tokens: u32,
  pub temperature: f32,
  pub top_p: f32,
  pub do_sample: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoadProgress {
  pub status: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub progress: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadResult {
  pub device: String,
  pub label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFileInfo {
  pub name: String,
  pub size_bytes: u64,
  /// True for interrupted downloads (`.part` files).
  pub partial: bool,
}

/// Resolves (and creates) the directory GGUF models are downloaded into.
fn models_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  use tauri::Manager;
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|e| e.to_string())?
    .join("models");
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

/// Lists downloaded model files with their on-disk sizes.
#[tauri::command]
pub fn llm_list_models(app: tauri::AppHandle) -> Result<Vec<ModelFileInfo>, String> {
  let dir = models_dir(&app)?;
  let mut files: Vec<ModelFileInfo> = std::fs::read_dir(&dir)
    .map_err(|e| e.to_string())?
    .filter_map(|entry| {
      let entry = entry.ok()?;
      let meta = entry.metadata().ok()?;
      if !meta.is_file() {
        return None;
      }
      let name = entry.file_name().to_string_lossy().to_string();
      let partial = name.ends_with(".part");
      (name.ends_with(".gguf") || partial).then(|| ModelFileInfo {
        name,
        size_bytes: meta.len(),
        partial,
      })
    })
    .collect();
  files.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
  Ok(files)
}

/// Opens the model storage folder in the system file manager.
#[tauri::command]
pub fn llm_open_models_dir(app: tauri::AppHandle) -> Result<(), String> {
  let dir = models_dir(&app)?;
  tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

/// Deletes a downloaded model file (name only, no paths).
#[tauri::command]
pub fn llm_delete_model(app: tauri::AppHandle, name: String) -> Result<(), String> {
  if name.contains(['/', '\\']) || name.contains("..") {
    return Err("Invalid file name".into());
  }
  let path = models_dir(&app)?.join(&name);
  std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// Shared engine state managed by Tauri.
#[derive(Default)]
pub struct NativeLlm {
  #[cfg(feature = "native-llm")]
  model: std::sync::Mutex<Option<Arc<engine::LoadedModel>>>,
  cancel: Arc<AtomicBool>,
}

/// Reports whether the bundled native inference engine is usable on this
/// device. The WebView falls back to transformers.js when `available` is
/// false, so older frontends keep working against newer hosts and vice versa.
#[tauri::command]
pub fn llm_native_status() -> NativeLlmStatus {
  if cfg!(feature = "native-llm") {
    NativeLlmStatus {
      available: true,
      engine: "llama.cpp",
      reason: "",
    }
  } else {
    NativeLlmStatus {
      available: false,
      engine: "llama.cpp",
      reason: "built without the native-llm feature",
    }
  }
}

#[tauri::command]
pub async fn llm_load_model(
  app: tauri::AppHandle,
  state: tauri::State<'_, NativeLlm>,
  repo_id: String,
  file: String,
  display_name: Option<String>,
  on_progress: Channel<LoadProgress>,
) -> Result<LoadResult, String> {
  imp::load_model(app, state, repo_id, file, display_name, on_progress).await
}

#[tauri::command]
pub async fn llm_generate(
  state: tauri::State<'_, NativeLlm>,
  messages: Vec<ChatMessage>,
  options: GenerateOptions,
  on_token: Channel<String>,
) -> Result<String, String> {
  imp::generate(state, messages, options, on_token).await
}

#[tauri::command]
pub fn llm_cancel(state: tauri::State<'_, NativeLlm>) {
  state.cancel.store(true, Ordering::Relaxed);
}

#[cfg(not(feature = "native-llm"))]
mod imp {
  use super::*;

  pub async fn load_model(
    _app: tauri::AppHandle,
    _state: tauri::State<'_, NativeLlm>,
    _repo_id: String,
    _file: String,
    _display_name: Option<String>,
    _on_progress: Channel<LoadProgress>,
  ) -> Result<LoadResult, String> {
    Err("Native LLM engine is not bundled in this build".into())
  }

  pub async fn generate(
    _state: tauri::State<'_, NativeLlm>,
    _messages: Vec<ChatMessage>,
    _options: GenerateOptions,
    _on_token: Channel<String>,
  ) -> Result<String, String> {
    Err("Native LLM engine is not bundled in this build".into())
  }
}

#[cfg(feature = "native-llm")]
mod imp {
  use std::{fs, path::PathBuf};

  use tauri::Manager;
  use tauri_plugin_http::reqwest;

  use super::*;

  pub async fn load_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeLlm>,
    repo_id: String,
    file: String,
    display_name: Option<String>,
    on_progress: Channel<LoadProgress>,
  ) -> Result<LoadResult, String> {
    // Friendly name for UI progress lines; fall back to the file name.
    let display = display_name.unwrap_or_else(|| file.clone());
    let path = download_gguf(&app, &repo_id, &file, &display, &on_progress).await?;

    let _ = on_progress.send(LoadProgress {
      status: format!("Loading {display} into memory"),
      progress: None,
    });

    let loaded = tauri::async_runtime::spawn_blocking(move || engine::load(&path))
      .await
      .map_err(|e| e.to_string())??;

    let result = LoadResult {
      device: loaded.device.clone(),
      label: loaded.label.clone(),
    };
    *state.model.lock().map_err(|e| e.to_string())? = Some(Arc::new(loaded));
    Ok(result)
  }

  pub async fn generate(
    state: tauri::State<'_, NativeLlm>,
    messages: Vec<ChatMessage>,
    options: GenerateOptions,
    on_token: Channel<String>,
  ) -> Result<String, String> {
    let model = state
      .model
      .lock()
      .map_err(|e| e.to_string())?
      .clone()
      .ok_or("No model loaded")?;

    state.cancel.store(false, Ordering::Relaxed);
    let cancel = Arc::clone(&state.cancel);

    tauri::async_runtime::spawn_blocking(move || {
      engine::generate(&model, &messages, &options, &cancel, |piece| {
        let _ = on_token.send(piece);
      })
    })
    .await
    .map_err(|e| e.to_string())?
  }

  /// Downloads a GGUF file from the Hugging Face CDN into the app data dir,
  /// resuming partial downloads via HTTP Range requests.
  async fn download_gguf(
    app: &tauri::AppHandle,
    repo_id: &str,
    file: &str,
    display: &str,
    on_progress: &Channel<LoadProgress>,
  ) -> Result<PathBuf, String> {
    let dir = app
      .path()
      .app_data_dir()
      .map_err(|e| e.to_string())?
      .join("models");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let dest = dir.join(file);
    if dest.exists() {
      return Ok(dest);
    }

    let part = dir.join(format!("{file}.part"));
    let resume_from = part.metadata().map(|m| m.len()).unwrap_or(0);

    let url = format!("https://huggingface.co/{repo_id}/resolve/main/{file}");
    let client = reqwest::Client::new();
    let mut request = client.get(&url);
    if resume_from > 0 {
      request = request.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
    }

    let mut response = request.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
      return Err(format!(
        "Download failed: HTTP {} for {url}",
        response.status()
      ));
    }

    // A plain 200 to a Range request means the server restarted from zero.
    let resumed = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut downloaded = if resumed { resume_from } else { 0 };
    let total = response.content_length().map(|len| len + downloaded);

    let mut out = fs::OpenOptions::new()
      .create(true)
      .append(resumed)
      .write(!resumed)
      .truncate(!resumed)
      .open(&part)
      .map_err(|e| e.to_string())?;

    use std::io::Write;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
      out.write_all(&chunk).map_err(|e| e.to_string())?;
      downloaded += chunk.len() as u64;
      let progress = total.map(|t| downloaded as f64 / t as f64 * 100.0);
      let _ = on_progress.send(LoadProgress {
        status: format!("Downloading {display}"),
        progress,
      });
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);

    fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
  }
}

#[cfg(feature = "native-llm")]
mod engine {
  use std::{
    num::NonZeroU32,
    path::Path,
    sync::{
      atomic::{AtomicBool, Ordering},
      OnceLock,
    },
  };

  use llama_cpp_2::{
    context::params::LlamaContextParams,
    llama_backend::LlamaBackend,
    llama_batch::LlamaBatch,
    model::{params::LlamaModelParams, AddBos, LlamaChatMessage, LlamaChatTemplate, LlamaModel},
    sampling::LlamaSampler,
  };

  use super::{ChatMessage, GenerateOptions};

  const CONTEXT_TOKENS: u32 = 8192;

  static BACKEND: OnceLock<LlamaBackend> = OnceLock::new();

  fn backend() -> &'static LlamaBackend {
    BACKEND.get_or_init(|| LlamaBackend::init().expect("failed to init llama.cpp backend"))
  }

  pub struct LoadedModel {
    pub model: LlamaModel,
    pub device: String,
    pub label: String,
  }

  pub fn load(path: &Path) -> Result<LoadedModel, String> {
    // With a GPU feature enabled, offload every layer; ignored on CPU builds.
    let params = LlamaModelParams::default().with_n_gpu_layers(u32::MAX);
    let model =
      LlamaModel::load_from_file(backend(), path, &params).map_err(|e| e.to_string())?;

    let gpu = cfg!(any(
      feature = "native-llm-cuda",
      feature = "native-llm-vulkan",
      feature = "native-llm-metal"
    ));
    Ok(LoadedModel {
      model,
      device: if gpu { "native-gpu" } else { "native-cpu" }.into(),
      label: format!("llama.cpp/{}", if gpu { "gpu" } else { "cpu" }),
    })
  }

  pub fn generate(
    loaded: &LoadedModel,
    messages: &[ChatMessage],
    options: &GenerateOptions,
    cancel: &AtomicBool,
    mut on_token: impl FnMut(String),
  ) -> Result<String, String> {
    let model = &loaded.model;

    // The GGUF ships its own chat template — no hand-rolled prompts.
    let chat: Vec<LlamaChatMessage> = messages
      .iter()
      .map(|m| LlamaChatMessage::new(m.role.clone(), m.content.clone()))
      .collect::<Result<_, _>>()
      .map_err(|e| e.to_string())?;
    let prompt = render_prompt(model, &chat)?;

    let tokens = model
      .str_to_token(&prompt, AddBos::Always)
      .map_err(|e| e.to_string())?;

    let ctx_params =
      LlamaContextParams::default().with_n_ctx(NonZeroU32::new(CONTEXT_TOKENS));
    let mut ctx = model
      .new_context(backend(), ctx_params)
      .map_err(|e| e.to_string())?;

    let mut batch = LlamaBatch::new(tokens.len().max(512), 1);
    let last = tokens.len().saturating_sub(1);
    for (i, token) in tokens.iter().enumerate() {
      batch
        .add(*token, i as i32, &[0], i == last)
        .map_err(|e| e.to_string())?;
    }
    ctx.decode(&mut batch).map_err(|e| e.to_string())?;

    let mut sampler = if options.do_sample {
      LlamaSampler::chain_simple([
        LlamaSampler::top_p(options.top_p, 1),
        LlamaSampler::temp(options.temperature),
        LlamaSampler::dist(rand_seed()),
      ])
    } else {
      LlamaSampler::greedy()
    };

    let mut output = String::new();
    let mut position = tokens.len() as i32;
    // Stateful decoder: model tokens can split multi-byte UTF-8 characters.
    let mut decoder = encoding_rs::UTF_8.new_decoder();
    for _ in 0..options.max_new_tokens {
      if cancel.load(Ordering::Relaxed) {
        break;
      }
      let token = sampler.sample(&ctx, batch.n_tokens() - 1);
      sampler.accept(token);
      if model.is_eog_token(token) {
        break;
      }
      let piece = model
        .token_to_piece(token, &mut decoder, false, None)
        .unwrap_or_default();
      output.push_str(&piece);
      on_token(piece);

      batch.clear();
      batch
        .add(token, position, &[0], true)
        .map_err(|e| e.to_string())?;
      position += 1;
      ctx.decode(&mut batch).map_err(|e| e.to_string())?;
    }

    Ok(output)
  }

  fn rand_seed() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|d| d.subsec_nanos())
      .unwrap_or(0)
  }

  /// Renders the conversation into a prompt string.
  ///
  /// Prefers the Jinja template embedded in the GGUF. llama.cpp's minimal
  /// template engine cannot parse some newer templates (e.g. Gemma 4's — it
  /// fails with `ffi error -1`), so fall back to llama.cpp's *built-in named
  /// handler* for the model's architecture family.
  fn render_prompt(model: &LlamaModel, chat: &[LlamaChatMessage]) -> Result<String, String> {
    let embedded = model
      .chat_template(None)
      .map_err(|e| e.to_string())
      .and_then(|tmpl| model.apply_chat_template(&tmpl, chat, true).map_err(|e| e.to_string()));
    let first_err = match embedded {
      Ok(prompt) => return Ok(prompt),
      Err(e) => e,
    };

    let arch = model
      .meta_val_str("general.architecture")
      .unwrap_or_default()
      .to_lowercase();
    let name = if arch.starts_with("gemma") {
      "gemma"
    } else if arch.starts_with("llama") {
      "llama3"
    } else {
      // Qwen and most other instruct models speak ChatML.
      "chatml"
    };
    log::warn!("embedded chat template failed ({first_err}); falling back to built-in '{name}'");

    let tmpl = LlamaChatTemplate::new(name).map_err(|e| e.to_string())?;
    model
      .apply_chat_template(&tmpl, chat, true)
      .map_err(|e| format!("embedded template failed ({first_err}); built-in '{name}' also failed: {e}"))
  }
}
