package expo.modules.screenlock

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ScreenLockModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ScreenLock")

    Function("lockScreen") {
      lockScreen()
    }
  }

  private fun lockScreen() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return
    val service = ScreenLockService.connected
    if (service != null) {
      service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN)
      return
    }
    // An app cannot turn on its own accessibility service; send the user to the toggle.
    val activity = appContext.currentActivity ?: return
    activity.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
  }
}
