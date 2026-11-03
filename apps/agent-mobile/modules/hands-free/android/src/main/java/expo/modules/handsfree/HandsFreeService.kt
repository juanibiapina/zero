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
import android.view.KeyEvent

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
    if (key == lastKey && now - lastKeyAt < REPEAT_GUARD_MS) return
    lastKey = key
    lastKeyAt = now
    onKey?.invoke(key)
  }

  private fun createSession() = MediaSession(this, "ZeroHandsFree").apply {
    setPlaybackToRemote(object : VolumeProvider(VOLUME_CONTROL_RELATIVE, VOLUME_STEPS, VOLUME_STEPS / 2) {
      override fun onAdjustVolume(direction: Int) {
        when {
          direction > 0 -> emit(KEY_ACCEPT)
          direction < 0 -> emit(KEY_SPEAK)
        }
      }
    })
    setCallback(object : MediaSession.Callback() {
      override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
        val event = keyEvent(mediaButtonIntent) ?: return false
        if (event.action != KeyEvent.ACTION_DOWN || event.repeatCount > 0) return true
        when (event.keyCode) {
          KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
          KeyEvent.KEYCODE_MEDIA_PLAY,
          KeyEvent.KEYCODE_MEDIA_PAUSE,
          KeyEvent.KEYCODE_HEADSETHOOK -> emit(KEY_ACCEPT)
          KeyEvent.KEYCODE_MEDIA_NEXT -> emit(KEY_SPEAK)
          KeyEvent.KEYCODE_MEDIA_PREVIOUS -> emit(KEY_REPEAT)
          else -> return false
        }
        return true
      }
    })
    setPlaybackState(
      PlaybackState.Builder()
        .setActions(
          PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS,
        )
        .setState(PlaybackState.STATE_PLAYING, 0, 1f)
        .build(),
    )
    setMetadata(MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, TITLE).build())
    isActive = true
  }

  @Suppress("DEPRECATION")
  private fun keyEvent(intent: Intent): KeyEvent? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
    } else {
      intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
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
      .setContentText("Volume up accepts. Volume down answers by voice.")
      .setContentIntent(open)
      .setOngoing(true)
      .addAction(Notification.Action.Builder(null, "Stop", stop).build())
      .build()
  }

  companion object {
    const val KEY_ACCEPT = "accept"
    const val KEY_SPEAK = "speak"
    const val KEY_REPEAT = "repeat"
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
