package com.ava_zen.ava

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps Ava's process and microphone capture alive
 * while the app is in the background — the same mechanism assistants like
 * Gemini use for their "call"-style voice sessions.
 *
 * The service does not capture audio itself; holding a foreground service of
 * type `microphone` allows the WebView's getUserMedia capture to keep running
 * with the screen off or the app backgrounded (Android 10+ requirement).
 *
 * Started/stopped from Rust via the `voice_session_start` / `voice_session_stop`
 * Tauri commands (see `src-tauri/src/voice_session.rs`).
 */
class VoiceSessionService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    startInForeground()
    return START_NOT_STICKY
  }

  private fun startInForeground() {
    val channelId = ensureChannel()
    val contentIntent = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_IMMUTABLE
    )
    val notification: Notification = NotificationCompat.Builder(this, channelId)
      .setContentTitle("Ava is listening")
      .setContentText("Voice session active — tap to return to Ava")
      .setSmallIcon(R.mipmap.ic_launcher)
      .setOngoing(true)
      .setContentIntent(contentIntent)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun ensureChannel(): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (manager.getNotificationChannel(CHANNEL_ID) == null) {
        manager.createNotificationChannel(
          NotificationChannel(
            CHANNEL_ID,
            "Voice session",
            NotificationManager.IMPORTANCE_LOW
          ).apply {
            description = "Shown while Ava keeps listening in the background"
            setShowBadge(false)
          }
        )
      }
    }
    return CHANNEL_ID
  }

  companion object {
    private const val CHANNEL_ID = "ava_voice_session"
    private const val NOTIFICATION_ID = 4210

    @JvmStatic
    fun start(context: Context) {
      val intent = Intent(context, VoiceSessionService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    @JvmStatic
    fun stop(context: Context) {
      context.stopService(Intent(context, VoiceSessionService::class.java))
    }
  }
}
