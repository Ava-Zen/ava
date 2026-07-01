package com.ava_zen.ava

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  private var pendingWebViewPermission: PermissionRequest? = null

  private val requestMicrophonePermissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestPermission()
  ) { granted ->
    pendingWebViewPermission?.let { request ->
      if (granted) {
        request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
      } else {
        request.deny()
      }
      pendingWebViewPermission = null
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    hookWebViewPermissions()
  }

  override fun onResume() {
    super.onResume()
    hookWebViewPermissions()
  }

  private fun hookWebViewPermissions() {
    window.decorView.post {
      findWebView(window.decorView.rootView)?.let { webView ->
        webView.settings.mediaPlaybackRequiresUserGesture = false

        val audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION

        webView.webChromeClient = object : WebChromeClient() {
          override fun onPermissionRequest(request: PermissionRequest) {
            runOnUiThread {
              val requestedAudio = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
              if (!requestedAudio) {
                request.deny()
                return@runOnUiThread
              }

              if (hasMicrophonePermission()) {
                request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                return@runOnUiThread
              }

              pendingWebViewPermission = request
              requestMicrophonePermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
            }
          }
        }
      }
    }
  }

  private fun hasMicrophonePermission(): Boolean =
    ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        findWebView(view.getChildAt(index))?.let { return it }
      }
    }
    return null
  }
}
