package expo.modules.zeronotifications

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ZeroNotificationsModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)
  override fun definition() = ModuleDefinition {
    Name("ZeroNotifications")
    AsyncFunction("install") { workspace: String, source: String, schedule: String -> NotificationEngine.install(context, workspace, source, schedule) }
    AsyncFunction("receipts") { workspace: String, source: String -> NotificationEngine.receipts(context, workspace, source) }
    AsyncFunction("acknowledge") { workspace: String, source: String, ids: List<String> -> NotificationEngine.acknowledge(context, workspace, source, ids) }
    AsyncFunction("settle") { workspace: String, source: String, key: String, date: String, action: String -> NotificationEngine.settle(context, workspace, source, key, date, action) }
    AsyncFunction("quiesce") { workspace: String -> NotificationEngine.quiesce(context, workspace) }
    AsyncFunction("clear") { workspace: String -> NotificationEngine.clear(context, workspace) }
    AsyncFunction("capabilities") { NotificationEngine.capabilities(context) }
    AsyncFunction("silence") { workspace: String -> NotificationEngine.silence(context, workspace) }
    Function("requestNotifications") {
      if (Build.VERSION.SDK_INT >= 33) appContext.currentActivity?.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7401)
    }
    Function("openNotificationSettings") {
      context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    Function("openChannelSettings") { channel: String ->
      context.startActivity(Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).putExtra(Settings.EXTRA_CHANNEL_ID, channel).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    Function("openExactAlarmSettings") {
      if (Build.VERSION.SDK_INT >= 31) context.startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    Function("openFullScreenSettings") {
      val intent = if (Build.VERSION.SDK_INT >= 34) Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}"))
        else Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    Function("openBatterySettings") {
      context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }
}
