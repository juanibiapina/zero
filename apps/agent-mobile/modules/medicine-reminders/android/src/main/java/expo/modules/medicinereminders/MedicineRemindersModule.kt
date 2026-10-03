package expo.modules.medicinereminders

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MedicineRemindersModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)
  override fun definition() = ModuleDefinition {
    Name("MedicineReminders")
    AsyncFunction("capabilities") { MedicineEngine.capabilities(context) }
    AsyncFunction("silenceProof") { MedicineEngine.silenceProof(context) }
    AsyncFunction("replace") { workspace: String, payload: String -> MedicineEngine.replace(context, workspace, payload) }
    AsyncFunction("receipts") { workspace: String -> MedicineEngine.receipts(context, workspace) }
    AsyncFunction("acknowledge") { workspace: String, ids: String -> MedicineEngine.acknowledge(context, workspace, ids) }
    AsyncFunction("take") { workspace: String, dose: String -> MedicineEngine.taken(context, workspace, dose) }
    AsyncFunction("quiesce") { workspace: String -> MedicineEngine.quiesce(context, workspace) }
    AsyncFunction("clear") { workspace: String -> MedicineEngine.clear(context, workspace) }
    Function("requestNotifications") {
      if (Build.VERSION.SDK_INT >= 33) appContext.currentActivity?.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7401)
    }
    Function("openExactAlarmSettings") {
      if (Build.VERSION.SDK_INT >= 31) context.startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    Function("openSoundSettings") {
      context.startActivity(Intent(Settings.ACTION_SOUND_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    Function("openReminderSettings") {
      context.startActivity(Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).putExtra(Settings.EXTRA_CHANNEL_ID, MedicineEngine.QUIET).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    Function("openNotificationSettings") {
      context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }
}
