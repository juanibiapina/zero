package expo.modules.screenlock

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.view.accessibility.AccessibilityEvent

/** Holds the accessibility service the user turned on, so the module can lock the phone through it. */
class ScreenLockService : AccessibilityService() {
  override fun onServiceConnected() {
    super.onServiceConnected()
    connected = this
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

  override fun onInterrupt() = Unit

  override fun onUnbind(intent: Intent?): Boolean {
    disconnect()
    return super.onUnbind(intent)
  }

  override fun onDestroy() {
    disconnect()
    super.onDestroy()
  }

  private fun disconnect() {
    if (connected === this) connected = null
  }

  companion object {
    @Volatile
    var connected: ScreenLockService? = null
      private set
  }
}
