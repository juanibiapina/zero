package expo.modules.handsfree

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaMetadata
import android.media.VolumeProvider
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.os.SystemClock

class HandsFreeService : Service() {
  private var session: MediaSession? = null
  private var lastKey: String? = null
  private var lastKeyAt = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      onKey?.invoke(KEY_STOP)
      stopSelf()
      return START_NOT_STICKY
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification(),
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification())
    }
    if (session == null) session = createSession()
    running = true
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    session?.run {
      isActive = false
      release()
    }
    session = null
    super.onDestroy()
  }

  private fun emit(key: String) {
    val now = SystemClock.elapsedRealtime()
    val held = key == lastKey && now - lastKeyAt < REPEAT_GUARD_MS
    lastKey = key
    lastKeyAt = now
    if (!held) onKey?.invoke(key)
  }

  private fun createSession() = MediaSession(this, "ZeroHandsFree").apply {
    setPlaybackToRemote(object : VolumeProvider(VOLUME_CONTROL_RELATIVE, VOLUME_STEPS, VOLUME_STEPS / 2) {
      override fun onAdjustVolume(direction: Int) {
        when {
          direction > 0 -> emit(KEY_UP)
          direction < 0 -> emit(KEY_DOWN)
        }
      }
    })
    setPlaybackState(
      PlaybackState.Builder()
        .setActions(0)
        .setState(PlaybackState.STATE_PLAYING, 0, 1f)
        .build(),
    )
    setMetadata(MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, TITLE).build())
    isActive = true
  }

  private fun notification(): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, TITLE, NotificationManager.IMPORTANCE_LOW))
    }
    val stop = PendingIntent.getService(
      this,
      0,
      Intent(this, HandsFreeService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
    return builder
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle(TITLE)
      .setContentText("Volume up takes the first suggestion. Volume down records.")
      .setContentIntent(open)
      .setOngoing(true)
      .addAction(Notification.Action.Builder(null, "Stop", stop).build())
      .build()
  }

  companion object {
    const val KEY_UP = "up"
    const val KEY_DOWN = "down"
    const val KEY_STOP = "stop"
    private const val ACTION_STOP = "expo.modules.handsfree.STOP"
    private const val CHANNEL_ID = "hands_free"
    private const val NOTIFICATION_ID = 7341
    private const val TITLE = "Zero hands-free"
    private const val VOLUME_STEPS = 10
    private const val REPEAT_GUARD_MS = 400L

    @Volatile
    var onKey: ((String) -> Unit)? = null

    @Volatile
    var running = false
      private set
  }
}
