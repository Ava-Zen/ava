//! Gemini-style background voice session.
//!
//! On Android, starts/stops the `VoiceSessionService` foreground service
//! (type `microphone`) so the WebView's audio capture keeps running while the
//! app is backgrounded or the screen is off. On other platforms the commands
//! are no-ops: desktop OSes don't suspend backgrounded apps the same way.

#[tauri::command]
pub fn voice_session_start() -> Result<(), String> {
  #[cfg(target_os = "android")]
  {
    call_service("start")
  }
  #[cfg(not(target_os = "android"))]
  {
    Ok(())
  }
}

#[tauri::command]
pub fn voice_session_stop() -> Result<(), String> {
  #[cfg(target_os = "android")]
  {
    call_service("stop")
  }
  #[cfg(not(target_os = "android"))]
  {
    Ok(())
  }
}

/// Invokes `VoiceSessionService.start(context)` / `.stop(context)` over JNI.
///
/// The class is resolved through the application context's class loader —
/// `FindClass` on a native (non-Java) thread only sees system classes.
#[cfg(target_os = "android")]
fn call_service(method: &str) -> Result<(), String> {
  use jni::objects::{JClass, JObject, JValue};

  fn inner_call_service(method: &str) -> Result<(), String> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| format!("JNI VM init failed: {e}"))?;
    let mut env = vm
      .attach_current_thread()
      .map_err(|e| format!("JNI thread attach failed: {e}"))?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };

    if env
      .exception_check()
      .map_err(|e| format!("JNI exception check failed: {e}"))?
    {
      env.exception_describe();
      env.exception_clear();
      return Err("Java threw an exception before the voice session command ran".to_string());
    }

    let class_obj = env
      .find_class("com/ava_zen/ava/VoiceSessionService")
      .map_err(|e| format!("VoiceSessionService class lookup failed: {e}"))?;

    let result = env
      .call_static_method(
        JClass::from(class_obj),
        method,
        "(Landroid/content/Context;)Ljava/lang/Boolean;",
        &[JValue::Object(&context)],
      )
      .and_then(|v| v.l())
      .map_err(|e| format!("voice session {method} failed: {e}"))?;

    let success = env
      .call_method(&result, "booleanValue", "()Z", &[])
      .and_then(|v| v.z())
      .map_err(|e| format!("voice session {method} result handling failed: {e}"))?;

    if !success {
      return Err(format!("voice session {method} reported a Java-side failure"));
    }

    if env
      .exception_check()
      .map_err(|e| format!("JNI exception check failed after {method}: {e}"))?
    {
      env.exception_describe();
      env.exception_clear();
      return Err(format!("voice session {method} threw a Java exception"));
    }

    Ok(())
  }

  match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| inner_call_service(method))) {
    Ok(result) => result,
    Err(payload) => {
      let message = match payload.downcast_ref::<&str>() {
        Some(value) => value.to_string(),
        None => match payload.downcast_ref::<String>() {
          Some(value) => value.clone(),
          None => "unknown panic".to_string(),
        },
      };
      log::error!("voice session JNI bridge panicked: {message}");
      Err(format!("voice session JNI bridge panicked: {message}"))
    }
  }
}
