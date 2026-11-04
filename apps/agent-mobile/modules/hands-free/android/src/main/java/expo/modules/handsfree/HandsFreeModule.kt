package expo.modules.handsfree

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.view.KeyEvent
import android.view.Window
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class HandsFreeModule : Module() {
  private var recorder: MediaRecorder? = null
  private var take: File? = null
  private var startedAt = 0L
  private var capture: Capture? = null

  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("HandsFree")

    Events(KEY_EVENT)

    Function("start") {
      if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        return@Function false
      }
      HandsFreeService.onKey = { key -> sendEvent(KEY_EVENT, mapOf("key" to key)) }
      val intent = Intent(context, HandsFreeService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
      appContext.currentActivity?.let { activity -> activity.runOnUiThread { captureVolumeKeys(activity) } }
      true
    }

    Function("stop") {
      stop()
    }

    Function("startRecording") {
      discardRecording()
      val file = File(context.cacheDir, "hands-free-${System.currentTimeMillis()}.m4a")
      val next = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
      try {
        next.setAudioSource(MediaRecorder.AudioSource.MIC)
        next.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        next.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        next.setAudioSamplingRate(16_000)
        next.setAudioChannels(1)
        next.setAudioEncodingBitRate(32_000)
        next.setOutputFile(file.absolutePath)
        next.prepare()
        next.start()
      } catch (error: Exception) {
        next.release()
        file.delete()
        throw error
      }
      recorder = next
      take = file
      startedAt = SystemClock.elapsedRealtime()
    }

    Function("finishRecording") {
      val current = recorder ?: return@Function null
      val file = take ?: return@Function null
      recorder = null
      take = null
      val durationMs = SystemClock.elapsedRealtime() - startedAt
      val stopped = try {
        current.stop()
        true
      } catch (_: RuntimeException) {
        false
      } finally {
        current.release()
      }
      if (!stopped) {
        file.delete()
        return@Function null
      }
      mapOf("uri" to Uri.fromFile(file).toString(), "durationMs" to durationMs)
    }

    OnDestroy {
      discardRecording()
      stop()
    }
  }

  private fun captureVolumeKeys(activity: Activity) {
    releaseVolumeKeys()
    val window = activity.window ?: return
    val original = window.callback ?: return
    val next = Capture(window, original)
    window.callback = next
    capture = next
  }

  private fun releaseVolumeKeys() {
    val current = capture ?: return
    capture = null
    current.window.decorView.post {
      if (current.window.callback === current) current.window.callback = current.original
    }
  }

  private class Capture(val window: Window, val original: Window.Callback) : Window.Callback by original {
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
      val key = when (event.keyCode) {
        KeyEvent.KEYCODE_VOLUME_UP -> HandsFreeService.KEY_UP
        KeyEvent.KEYCODE_VOLUME_DOWN -> HandsFreeService.KEY_DOWN
        else -> return original.dispatchKeyEvent(event)
      }
      if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) HandsFreeService.press(key)
      return true
    }
  }

  private fun stop() {
    releaseVolumeKeys()
    HandsFreeService.onKey = null
    context.stopService(Intent(context, HandsFreeService::class.java))
  }

  private fun discardRecording() {
    val current = recorder ?: return
    recorder = null
    try {
      current.stop()
    } catch (_: RuntimeException) {
    }
    current.release()
    take?.delete()
    take = null
  }

  private companion object {
    const val KEY_EVENT = "onKey"
  }
}
