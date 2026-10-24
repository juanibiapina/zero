package expo.modules.headsetmic

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.annotation.RequiresApi
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HeadsetMicModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var pendingRoute: PendingRoute? = null
  private var recordingCallback: AudioManager.AudioRecordingCallback? = null

  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  private val audioManager: AudioManager
    get() = context.getSystemService(AudioManager::class.java)

  override fun definition() = ModuleDefinition {
    Name("HeadsetMic")

    Events(RECORDING_INPUT)

    AsyncFunction("routeToHeadset") { promise: Promise ->
      mainHandler.post { routeToHeadset(promise) }
    }

    Function("releaseHeadset") {
      mainHandler.post { releaseHeadset() }
    }

    Function("watchRecordingInput") {
      mainHandler.post { watchRecordingInput() }
    }

    Function("unwatchRecordingInput") {
      mainHandler.post { unwatchRecordingInput() }
    }

    OnDestroy {
      mainHandler.post {
        unwatchRecordingInput()
        releaseHeadset()
      }
    }
  }

  private fun routeToHeadset(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      promise.resolve(false)
      return
    }
    finishPendingRoute(routed = false)

    val headset = audioManager.availableCommunicationDevices
      .filter { it.type in HEADSET_TYPES }
      .minByOrNull { HEADSET_TYPES.indexOf(it.type) }
    if (headset == null) {
      promise.resolve(false)
      return
    }
    if (audioManager.communicationDevice?.id == headset.id) {
      promise.resolve(true)
      return
    }

    val pending = PendingRoute(headset, promise)
    pendingRoute = pending
    audioManager.addOnCommunicationDeviceChangedListener(context.mainExecutor, pending.deviceChanged)
    audioManager.registerAudioDeviceCallback(pending.devicesChanged, mainHandler)

    val accepted = try {
      audioManager.setCommunicationDevice(headset)
    } catch (_: IllegalArgumentException) {
      false
    }
    if (!accepted) finishPendingRoute(routed = false)
  }

  @RequiresApi(Build.VERSION_CODES.S)
  private fun finishPendingRoute(routed: Boolean) {
    val pending = pendingRoute ?: return
    pendingRoute = null
    audioManager.removeOnCommunicationDeviceChangedListener(pending.deviceChanged)
    audioManager.unregisterAudioDeviceCallback(pending.devicesChanged)
    if (!routed) audioManager.clearCommunicationDevice()
    pending.promise.resolve(routed)
  }

  private fun releaseHeadset() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
    finishPendingRoute(routed = false)
    audioManager.clearCommunicationDevice()
  }

  private fun watchRecordingInput() {
    if (recordingCallback != null) return
    val callback = object : AudioManager.AudioRecordingCallback() {
      override fun onRecordingConfigChanged(configs: List<AudioRecordingConfiguration>) {
        report(configs)
      }
    }
    recordingCallback = callback
    audioManager.registerAudioRecordingCallback(callback, mainHandler)
    report(audioManager.activeRecordingConfigurations)
  }

  private fun unwatchRecordingInput() {
    val callback = recordingCallback ?: return
    recordingCallback = null
    audioManager.unregisterAudioRecordingCallback(callback)
  }

  private fun report(configs: List<AudioRecordingConfiguration>) {
    if (recordingCallback == null || configs.isEmpty()) return
    val device = configs.firstNotNullOfOrNull { it.audioDevice }
    sendEvent(RECORDING_INPUT, mapOf("mic" to device?.let(::describe)))
  }

  private fun describe(device: AudioDeviceInfo): Map<String, Any?> = mapOf(
    "name" to device.productName?.toString()?.trim()?.ifEmpty { null },
    "kind" to when (device.type) {
      AudioDeviceInfo.TYPE_BUILTIN_MIC -> "phone"
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth"
      TYPE_BLE_HEADSET -> "bluetooth-le"
      AudioDeviceInfo.TYPE_HEARING_AID -> "hearing-aid"
      AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired"
      AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE -> "usb"
      else -> "other"
    }
  )

  private inner class PendingRoute(val headset: AudioDeviceInfo, val promise: Promise) {
    val deviceChanged = AudioManager.OnCommunicationDeviceChangedListener { device ->
      if (device?.id == headset.id) finishPendingRoute(routed = true)
    }

    val devicesChanged = object : AudioDeviceCallback() {
      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
        if (removedDevices.any { it.id == headset.id }) finishPendingRoute(routed = false)
      }
    }
  }

  private companion object {
    const val RECORDING_INPUT = "onRecordingInput"
    const val TYPE_BLE_HEADSET = 26
    val HEADSET_TYPES = listOf(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_HEARING_AID)
  }
}
