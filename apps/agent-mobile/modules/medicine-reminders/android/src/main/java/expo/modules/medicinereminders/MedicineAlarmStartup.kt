package expo.modules.medicinereminders

import android.app.Activity
import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import java.lang.ref.WeakReference

// Android creates providers before starting Activities or the React runtime.
class MedicineAlarmStartup : ContentProvider(), Application.ActivityLifecycleCallbacks {
  private lateinit var application: Application
  private var foreground: WeakReference<Activity>? = null
  private var unsubscribe: (() -> Unit)? = null

  override fun onCreate(): Boolean {
    application = requireNotNull(context).applicationContext as Application
    application.registerActivityLifecycleCallbacks(this)
    unsubscribe = MedicineAlarmService.observe { present() }
    return true
  }

  override fun onActivityResumed(activity: Activity) {
    if (activity is MedicineAlarmActivity) return
    foreground = WeakReference(activity)
    present()
  }
  private fun present() {
    val activity = foreground?.get()?.takeUnless { it.isFinishing || it.isDestroyed } ?: return
    val session = MedicineAlarmService.current() ?: return
    activity.startActivity(Intent(activity, MedicineAlarmActivity::class.java)
      .putExtra("workspace", session.workspace).putExtra("session", session.id)
      .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP))
  }
  override fun onActivityCreated(activity: Activity, state: Bundle?) {}
  override fun onActivityStarted(activity: Activity) {}
  override fun onActivityPaused(activity: Activity) { if (foreground?.get() === activity) foreground = null }
  override fun onActivityStopped(activity: Activity) {}
  override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
  override fun onActivityDestroyed(activity: Activity) { if (foreground?.get() === activity) foreground = null }

  override fun shutdown() {
    application.unregisterActivityLifecycleCallbacks(this)
    unsubscribe?.invoke()
    foreground = null
    super.shutdown()
  }

  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, order: String?): Cursor? = null
  override fun getType(uri: Uri): String? = null
  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, args: Array<out String>?): Int = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?): Int = 0
}
