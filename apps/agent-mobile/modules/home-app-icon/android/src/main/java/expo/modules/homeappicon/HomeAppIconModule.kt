package expo.modules.homeappicon

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HomeAppIconModule : Module() {
  private val iconNames = listOf(
    "Default",
    "OneTask",
    "TwoTasks",
    "ThreeTasks",
    "FourPlusTasks"
  )
  private val stateLock = Any()
  private var requestedComponent: String? = null

  override fun definition() = ModuleDefinition {
    Name("HomeAppIcon")

    Function("setIcon") { name: String ->
      if (name !in iconNames) return@Function false

      val packageName = context.packageName
      val target = "$packageName.MainActivityIcon$name"
      if (!componentExists(target)) return@Function false

      synchronized(stateLock) {
        requestedComponent = if (enabledComponent() == target) null else target
      }
      true
    }

    // Switching a launcher alias can restart an activity on some launchers. Do
    // it only after React Native has entered the background; task interactions
    // remain uninterrupted and the launcher sees the new state immediately.
    OnActivityEntersBackground {
      applyRequestedIcon()
    }

    OnActivityDestroys {
      applyRequestedIcon()
    }
  }

  private fun applyRequestedIcon() {
    val target = synchronized(stateLock) {
      requestedComponent.also { requestedComponent = null }
    } ?: return

    val packageName = context.packageName
    val packageManager = context.packageManager
    try {
      // Keep one launch path throughout the transition.
      setEnabled(packageManager, packageName, target, true)
    } catch (error: Exception) {
      Log.e(TAG, "Could not enable launcher alias $target", error)
      return
    }

    iconNames
      .map { "$packageName.MainActivityIcon$it" }
      .filter { it != target }
      .forEach { component ->
        try {
          setEnabled(packageManager, packageName, component, false)
        } catch (error: Exception) {
          Log.w(TAG, "Could not disable launcher alias $component", error)
        }
      }
  }

  private fun enabledComponent(): String? {
    val packageName = context.packageName
    val packageManager = context.packageManager
    return iconNames
      .map { "$packageName.MainActivityIcon$it" }
      .firstOrNull { component ->
        val componentName = ComponentName(packageName, component)
        when (packageManager.getComponentEnabledSetting(componentName)) {
          PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
          PackageManager.COMPONENT_ENABLED_STATE_DEFAULT ->
            try {
              packageManager.getActivityInfo(
                componentName,
                PackageManager.MATCH_DISABLED_COMPONENTS
              ).enabled
            } catch (_: PackageManager.NameNotFoundException) {
              false
            }
          else -> false
        }
      }
  }

  private fun componentExists(component: String): Boolean = try {
    context.packageManager.getActivityInfo(
      ComponentName(context.packageName, component),
      PackageManager.MATCH_DISABLED_COMPONENTS
    )
    true
  } catch (_: PackageManager.NameNotFoundException) {
    false
  }

  private fun setEnabled(
    packageManager: PackageManager,
    packageName: String,
    component: String,
    enabled: Boolean
  ) {
    packageManager.setComponentEnabledSetting(
      ComponentName(packageName, component),
      if (enabled) {
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED
      } else {
        PackageManager.COMPONENT_ENABLED_STATE_DISABLED
      },
      PackageManager.DONT_KILL_APP
    )
  }

  private val context: Context
    get() = requireNotNull(appContext.reactContext) {
      "React Application Context is unavailable"
    }

  companion object {
    private const val TAG = "HomeAppIcon"
  }
}
