package expo.modules.zeronotifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class NotificationReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    try {
      when (intent.action) {
        NotificationEngine.WAKE -> NotificationEngine.wake(context)
        NotificationEngine.BUTTON -> NotificationEngine.button(
          context, intent.getStringExtra("workspace") ?: return, intent.getStringExtra("source") ?: return, intent.getStringExtra("key") ?: return,
          intent.getStringExtra("date") ?: return, intent.getStringExtra("action") ?: return, intent.getLongExtra("shownAt", -1),
        )
        NotificationEngine.DISMISS -> NotificationEngine.dismissed(
          context, intent.getStringExtra("workspace") ?: return, intent.getStringExtra("source") ?: return, intent.getStringExtra("key") ?: return,
          intent.getStringExtra("date") ?: return, intent.getLongExtra("shownAt", -1),
        )
        else -> NotificationEngine.restore(context, intent.action == Intent.ACTION_BOOT_COMPLETED)
      }
    } catch (error: Exception) {
      Log.e(NotificationEngine.TAG, "Notification operation failed", error)
    }
  }
}
