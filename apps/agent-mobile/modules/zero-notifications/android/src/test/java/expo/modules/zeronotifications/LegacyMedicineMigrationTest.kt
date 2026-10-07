package expo.modules.zeronotifications

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAlarmManager
import java.io.File
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class LegacyMedicineMigrationTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()
  private val manager: NotificationManager get() = context.getSystemService(NotificationManager::class.java)
  private val alarms: AlarmManager get() = context.getSystemService(AlarmManager::class.java)
  private val doseId = JSONArray(listOf("medicine", "slot", "2026-10-02")).toString()
  private fun oldDose(kind: String, actionId: String, takenAt: Any) = JSONObject()
    .put("id", doseId).put("medicineId", "medicine").put("slotId", "slot").put("on", "2026-10-02")
    .put("scheduledAt", "2026-10-02T20:00:00Z").put("takenAt", takenAt).put("name", "Pill").put("instructions", "")
    .put("alarmLabel", "20:00").put("kind", kind).put("stageAt", "2026-10-02T19:45:00Z").put("actionId", actionId)
  private fun oldAlarm(identity: String) = PendingIntent.getBroadcast(
    context, 0,
    Intent().setComponent(ComponentName(context.packageName, "expo.modules.medicinereminders.MedicineReceiver")).setAction("medicine.delivery").setData(Uri.parse("zero-medicine:${Uri.encode(identity)}")),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )

  @Before
  fun writeTheOldStore() {
    ShadowAlarmManager.setCanScheduleExactAlarms(true)
    NotificationEngine.clock = { Clock.fixed(Instant.parse("2026-10-02T21:00:00Z"), ZoneOffset.UTC) }
    manager.createNotificationChannel(NotificationChannel("medicine-alerts-v2", "Medicine reminders", NotificationManager.IMPORTANCE_HIGH))
    manager.notify(doseId, 0, Notification.Builder(context, "medicine-alerts-v2").setSmallIcon(R.drawable.ic_notification_pill).setContentTitle("Pill").build())
    alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, Instant.parse("2026-10-03T19:45:00Z").toEpochMilli(), oldAlarm("reminder/1"))
    val old = JSONObject()
      .put("workspace", "workspace")
      .put("receipts", JSONArray().put(oldDose("presented", "presented-action", JSONObject.NULL)).put(oldDose("taken", "taken-action", "2026-10-02T19:50:00Z")))
      .put("visible", JSONObject().put(doseId, oldDose("reminder", "visible", JSONObject.NULL)))
      .put("scheduled", JSONArray().put(JSONObject().put("identity", "reminder/1")))
    File(context.noBackupFilesDir, "medicine-reminders.json").writeText(old.toString())
  }

  @After
  fun restoreClock() { NotificationEngine.clock = { Clock.systemDefaultZone() } }

  @Test
  fun keepsUnimportedConfirmationsAndClosesTheOldCardsAndAlarms() {
    val receipts = JSONArray(NotificationEngine.receipts(context, "workspace", "medicines")).let { list -> (0 until list.length()).map { list.getJSONObject(it) } }
    val key = JSONArray(listOf("medicine", "slot")).toString()
    val data = JSONObject().put("alarmAt", "20:00").toString()
    assertEquals(
      listOf(
        mapOf("id" to "presented-action", "source" to "medicines", "key" to key, "date" to "2026-10-02", "data" to data, "type" to "presented", "at" to "2026-10-02T19:45:00Z"),
        mapOf("id" to "taken-action", "source" to "medicines", "key" to key, "date" to "2026-10-02", "data" to data, "type" to "settled", "action" to "taken", "at" to "2026-10-02T19:50:00Z"),
      ),
      receipts.map { receipt -> receipt.keys().asSequence().associateWith { receipt.get(it) } },
    )
    assertNull(shadowOf(manager).getNotification(doseId, 0))
    assertTrue(shadowOf(alarms).scheduledAlarms.isEmpty())
    assertFalse(File(context.noBackupFilesDir, "medicine-reminders.json").exists())
  }

  @Test
  fun anotherWorkspaceCannotTakeOverBeforeTheConfirmationsAreImported() {
    val schedule = JSONObject().put("channels", JSONArray()).put("reminders", JSONArray()).toString()
    assertThrows(IllegalStateException::class.java) { NotificationEngine.install(context, "other", "medicines", schedule) }
    NotificationEngine.install(context, "workspace", "medicines", schedule)
    assertEquals(2, JSONArray(NotificationEngine.receipts(context, "workspace", "medicines")).length())
  }
}
