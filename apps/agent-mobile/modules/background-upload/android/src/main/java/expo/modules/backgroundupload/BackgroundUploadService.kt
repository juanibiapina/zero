package expo.modules.backgroundupload

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper

// Keeps the app process running, so Android does not freeze it, while a voice
// note uploads after the user has left the app.
class BackgroundUploadService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val timeout = Runnable { finish() }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // startForeground must run for every startForegroundService call, even
    // when stop() already arrived, or Android crashes the app.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification())
    }
    running = this
    if (!wanted) {
      finish()
      return START_NOT_STICKY
    }
    handler.removeCallbacks(timeout)
    handler.postDelayed(timeout, MAX_RUN_MS)
    return START_NOT_STICKY
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    finish()
  }

  override fun onDestroy() {
    handler.removeCallbacks(timeout)
    if (running === this) running = null
    super.onDestroy()
  }

  fun finish() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(Service.STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
    stopSelf()
  }

  private fun notification(): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Sending voice notes", NotificationManager.IMPORTANCE_LOW))
    }
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID) else @Suppress("DEPRECATION") Notification.Builder(this)
    return builder
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle("Sending voice note")
      .setContentIntent(open)
      .setOngoing(true)
      .setProgress(0, 0, true)
      .build()
  }

  companion object {
    private const val CHANNEL_ID = "voice_note_upload"
    private const val NOTIFICATION_ID = 7342
    private const val MAX_RUN_MS = 3 * 60_000L

    @Volatile
    var wanted = false

    @Volatile
    var running: BackgroundUploadService? = null
      private set
  }
}
