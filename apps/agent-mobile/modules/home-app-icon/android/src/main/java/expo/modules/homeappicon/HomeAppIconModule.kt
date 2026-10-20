package expo.modules.homeappicon

import android.app.ActivityManager
import android.app.ActivityManager.RunningAppProcessInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.PackageManager.ComponentEnabledSetting
import android.os.Build
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HomeAppIconModule : Module() {
  private val stateLock = Any()
  private var requestedComponent: String? = null

  override fun definition() = ModuleDefinition {
    Name("HomeAppIcon")

    Function("setIcon") { name: String ->
      val target = "${context.packageName}.$ALIAS_PREFIX$name"
      if (target !in aliases()) return@Function false

      synchronized(stateLock) {
        requestedComponent = if (enabledComponent() == target) null else target
      }
      if (isInForeground()) applyRequestedIcon(inForeground = true)
      true
    }

    OnActivityEntersForeground {
      applyRequestedIcon(inForeground = true)
    }

    OnActivityEntersBackground {
      applyRequestedIcon(inForeground = false)
    }
  }

  private fun applyRequestedIcon(inForeground: Boolean) {
    val target = synchronized(stateLock) {
      val requested = requestedComponent ?: return
      val leavesInstallIcon = requested != defaultAlias && isEnabled(defaultAlias)
      if (leavesInstallIcon == inForeground) return
      requestedComponent = null
      requested
    }

    val states = listOf(target to PackageManager.COMPONENT_ENABLED_STATE_ENABLED) +
      aliases().filter { it != target }.map { component ->
        component to if (component == defaultAlias) {
          PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        } else {
          PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
        }
      }

    try {
      setStates(states)
    } catch (error: Exception) {
      Log.e(TAG, "Could not switch launcher alias to $target", error)
    }
  }

  private fun setStates(states: List<Pair<String, Int>>) {
    val packageName = context.packageName
    val packageManager = context.packageManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      packageManager.setComponentEnabledSettings(
        states.map { (component, state) ->
          ComponentEnabledSetting(
            ComponentName(packageName, component),
            state,
            PackageManager.DONT_KILL_APP
          )
        }
      )
    } else {
      states.forEach { (component, state) ->
        packageManager.setComponentEnabledSetting(
          ComponentName(packageName, component),
          state,
          PackageManager.DONT_KILL_APP
        )
      }
    }
  }

  private fun isInForeground(): Boolean {
    val state = RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(state)
    return state.importance == RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }

  private fun aliases(): List<String> {
    val packageName = context.packageName
    val launcher = Intent(Intent.ACTION_MAIN)
      .addCategory(Intent.CATEGORY_LAUNCHER)
      .setPackage(packageName)
    return context.packageManager
      .queryIntentActivities(launcher, PackageManager.MATCH_DISABLED_COMPONENTS)
      .map { it.activityInfo.name }
      .filter { it.startsWith("$packageName.$ALIAS_PREFIX") }
      .distinct()
  }

  private fun enabledComponent(): String? = aliases().firstOrNull(::isEnabled)

  private fun isEnabled(component: String): Boolean {
    val packageManager = context.packageManager
    val componentName = ComponentName(context.packageName, component)
    return when (packageManager.getComponentEnabledSetting(componentName)) {
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

  private val defaultAlias: String
    get() = "${context.packageName}.${ALIAS_PREFIX}Default"

  private val context: Context
    get() = requireNotNull(appContext.reactContext) {
      "React Application Context is unavailable"
    }

  companion object {
    private const val TAG = "HomeAppIcon"
    private const val ALIAS_PREFIX = "MainActivityIcon"
  }
}
