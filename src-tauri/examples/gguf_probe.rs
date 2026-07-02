//! Quick diagnostic: attempts to load a GGUF and generate a few tokens,
//! printing every llama.cpp error verbatim.
//!
//! Usage:
//!   cargo run --features native-llm --example gguf_probe -- <path-to-gguf>

#[cfg(feature = "native-llm")]
fn main() {
  use llama_cpp_2::{
    context::params::LlamaContextParams,
    llama_backend::LlamaBackend,
    llama_batch::LlamaBatch,
    model::{params::LlamaModelParams, AddBos, LlamaChatMessage, LlamaModel},
    sampling::LlamaSampler,
  };
  use std::num::NonZeroU32;

  let path = std::env::args().nth(1).expect("usage: gguf_probe <path>");
  eprintln!("== loading {path}");

  let backend = LlamaBackend::init().expect("backend init");
  let params = LlamaModelParams::default();
  let model = match LlamaModel::load_from_file(&backend, &path, &params) {
    Ok(m) => m,
    Err(e) => {
      eprintln!("!! MODEL LOAD FAILED: {e}");
      std::process::exit(1);
    }
  };
  eprintln!("== model loaded: {} params, {} layers", model.n_params(), model.n_layer());

  let chat = vec![
    LlamaChatMessage::new("system".into(), "You are a helpful assistant.".into()).unwrap(),
    LlamaChatMessage::new("user".into(), "Say hello in three words.".into()).unwrap(),
  ];
  // Same strategy as engine::render_prompt: embedded template, then the
  // built-in named handler for the architecture family.
  let prompt = match model
    .chat_template(None)
    .map_err(|e| e.to_string())
    .and_then(|t| model.apply_chat_template(&t, &chat, true).map_err(|e| e.to_string()))
  {
    Ok(p) => p,
    Err(e) => {
      let arch = model.meta_val_str("general.architecture").unwrap_or_default().to_lowercase();
      let name = if arch.starts_with("gemma") { "gemma" } else { "chatml" };
      eprintln!("== embedded template failed ({e}); trying built-in '{name}' (arch={arch})");
      let tmpl = llama_cpp_2::model::LlamaChatTemplate::new(name).expect("builtin template");
      match model.apply_chat_template(&tmpl, &chat, true) {
        Ok(p) => p,
        Err(e) => {
          eprintln!("!! APPLY TEMPLATE FAILED: {e}");
          std::process::exit(3);
        }
      }
    }
  };
  eprintln!("== prompt starts with: {:?}", &prompt[..prompt.len().min(120)]);

  let tokens = match model.str_to_token(&prompt, AddBos::Always) {
    Ok(t) => t,
    Err(e) => {
      eprintln!("!! TOKENIZE FAILED: {e}");
      std::process::exit(4);
    }
  };
  eprintln!("== {} prompt tokens", tokens.len());

  let ctx_params = LlamaContextParams::default().with_n_ctx(NonZeroU32::new(8192));
  let mut ctx = match model.new_context(&backend, ctx_params) {
    Ok(c) => c,
    Err(e) => {
      eprintln!("!! CONTEXT FAILED: {e}");
      std::process::exit(5);
    }
  };

  let mut batch = LlamaBatch::new(tokens.len().max(512), 1);
  let last = tokens.len() - 1;
  for (i, t) in tokens.iter().enumerate() {
    batch.add(*t, i as i32, &[0], i == last).expect("batch add");
  }
  if let Err(e) = ctx.decode(&mut batch) {
    eprintln!("!! PROMPT DECODE FAILED: {e}");
    std::process::exit(6);
  }

  let mut sampler = LlamaSampler::greedy();
  let mut decoder = encoding_rs::UTF_8.new_decoder();
  let mut pos = tokens.len() as i32;
  let mut out = String::new();
  for _ in 0..12 {
    let token = sampler.sample(&ctx, batch.n_tokens() - 1);
    sampler.accept(token);
    if model.is_eog_token(token) {
      break;
    }
    out.push_str(&model.token_to_piece(token, &mut decoder, false, None).unwrap_or_default());
    batch.clear();
    batch.add(token, pos, &[0], true).expect("batch add");
    pos += 1;
    if let Err(e) = ctx.decode(&mut batch) {
      eprintln!("!! GENERATION DECODE FAILED: {e}");
      std::process::exit(7);
    }
  }
  eprintln!("== OK, generated: {out:?}");
}

#[cfg(not(feature = "native-llm"))]
fn main() {
  eprintln!("rebuild with --features native-llm");
}
