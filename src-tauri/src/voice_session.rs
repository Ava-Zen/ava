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

  let ctx = ndk_context::android_context();
  let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
  let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
  let context = unsafe { JObject::from_raw(ctx.context().cast()) };

  let loader = env
    .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
    .and_then(|v| v.l())
    .map_err(|e| e.to_string())?;
  let class_name = env
    .new_string("com.ava_zen.ava.VoiceSessionService")
    .map_err(|e| e.to_string())?;
  let class_obj = env
    .call_method(
      &loader,
      "loadClass",
      "(Ljava/lang/String;)Ljava/lang/Class;",
      &[JValue::Object(&JObject::from(class_name))],
    )
    .and_then(|v| v.l())
    .map_err(|e| e.to_string())?;

  env
    .call_static_method(
      JClass::from(class_obj),
      method,
      "(Landroid/content/Context;)V",
      &[JValue::Object(&context)],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}
