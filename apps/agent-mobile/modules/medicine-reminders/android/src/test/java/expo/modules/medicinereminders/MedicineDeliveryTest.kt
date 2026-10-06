package expo.modules.medicinereminders

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
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
class MedicineDeliveryTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()
  private val manager: NotificationManager get() = context.getSystemService(NotificationManager::class.java)
  private val alarms: AlarmManager get() = context.getSystemService(AlarmManager::class.java)
  private val workspace = "workspace"
  private val day = "2026-10-02"
  private fun id(medicine: String = "medicine") = JSONArray(listOf(medicine, "evening", day)).toString()
  private fun plans(ids: List<String> = listOf("medicine"), confirmed: List<String> = emptyList(), paused: Boolean = false): String {
    val medicines = JSONArray()
    for (id in ids) medicines.put(JSONObject("""{"id":"$id","name":"Pill $id","instructions":"After food","startsOn":"$day","endsOn":null,"paused":$paused,"doses":[{"id":"evening","remindAt":"23:57","alarmAt":"23:59"}]}"""))
    return JSONObject().put("medicines", medicines).put("confirmed", JSONArray(confirmed)).toString()
  }
  private fun payload(kind: String): String = shadowOf(alarms).scheduledAlarms.map { shadowOf(it.operation).savedIntent.getStringExtra("payload")!! }.first { JSONObject(it).getString("kind") == kind }
  private fun notification(medicine: String = "medicine") = shadowOf(manager).getNotification(id(medicine), 0)
  private fun receipts() = JSONArray(MedicineEngine.receipts(context, workspace))
  private fun presentedCount() = (0 until receipts().length()).count { receipts().getJSONObject(it).getString("kind") == "presented" }

  @Before
  fun enableScheduling() {
    ShadowAlarmManager.setCanScheduleExactAlarms(true)
    MedicineEngine.clock = { Clock.fixed(Instant.parse("${day}T10:00:00Z"), ZoneOffset.UTC) }
  }

  @After
  fun restoreClock() { MedicineEngine.clock = { Clock.systemDefaultZone() } }

  @Test
  fun bothScheduledStagesAlertOnceWithoutOpeningTheApp() {
    MedicineEngine.replace(context, workspace, plans())
    MedicineEngine.deliver(context, payload("reminder"))
    assertEquals("Dose at 23:59 · After food", notification().extras.getString(Notification.EXTRA_TEXT))
    assertEquals(0, notification().flags and Notification.FLAG_ONLY_ALERT_ONCE)
    val deadline = payload("alarm")
    MedicineEngine.deliver(context, deadline)
    assertEquals("23:59 dose due · After food", notification().extras.getString(Notification.EXTRA_TEXT))
    assertEquals(2, presentedCount())
    MedicineEngine.deliver(context, deadline)
    MedicineEngine.replace(context, workspace, plans())
    MedicineEngine.restore(context, true)
    assertEquals(2, presentedCount())
    assertEquals(Notification.GROUP_ALERT_SUMMARY, notification().groupAlertBehavior)
  }

  @Test
  fun dismissalLeavesTheDosePendingAndTheDeadlineStillAlerts() {
    MedicineEngine.replace(context, workspace, plans())
    MedicineEngine.deliver(context, payload("reminder"))
    val dismiss = shadowOf(notification().deleteIntent).savedIntent
    manager.cancel(id(), 0)
    MedicineReceiver().onReceive(context, dismiss)
    MedicineEngine.replace(context, workspace, plans())
    MedicineEngine.restore(context, true)
    assertNull(notification())
    assertEquals(1, presentedCount())
    MedicineEngine.deliver(context, payload("alarm"))
    assertNotNull(notification())
    assertEquals(2, presentedCount())
    MedicineReceiver().onReceive(context, dismiss)
    MedicineEngine.restore(context, true)
    assertNotNull(notification())
    assertTrue((0 until receipts().length()).none { receipts().getJSONObject(it).getString("kind") == "taken" })
  }

  @Test
  fun simultaneousDosesShareAWakeUpButTakenOnlyConfirmsOne() {
    val ids = listOf("medicine", "other")
    MedicineEngine.replace(context, workspace, plans(ids))
    assertEquals(2, JSONObject(payload("alarm")).getJSONArray("doses").length())
    val alarm = shadowOf(alarms).scheduledAlarms.first { JSONObject(shadowOf(it.operation).savedIntent.getStringExtra("payload")!!).getString("kind") == "alarm" }
    assertNotNull(alarm.alarmClockInfo)
    MedicineEngine.deliver(context, payload("reminder"))
    val take = shadowOf(notification().actions.single().actionIntent).savedIntent
    MedicineReceiver().onReceive(context, take)
    MedicineReceiver().onReceive(context, take)
    assertNull(notification())
    assertNotNull(notification("other"))
    assertEquals(1, JSONObject(payload("alarm")).getJSONArray("doses").length())
    MedicineEngine.deliver(context, payload("alarm"))
    assertNull(notification())
    assertEquals("23:59 dose due · After food", notification("other").extras.getString(Notification.EXTRA_TEXT))
    val taken = (0 until receipts().length()).map { receipts().getJSONObject(it) }.filter { it.getString("kind") == "taken" }
    assertEquals(1, taken.size)
    assertEquals(id(), taken.single().getString("id"))
    assertNotNull(taken.single().getString("takenAt"))
  }

  @Test
  fun staleWorkspaceAndGenerationDeliveriesCannotPost() {
    MedicineEngine.replace(context, workspace, plans())
    val old = payload("alarm")
    MedicineEngine.replace(context, workspace, plans())
    MedicineEngine.deliver(context, old)
    val beforeRestore = payload("alarm")
    MedicineEngine.restore(context)
    MedicineEngine.deliver(context, beforeRestore)
    MedicineEngine.deliver(context, JSONObject(payload("alarm")).put("workspace", "another").toString())
    assertNull(notification())
    assertEquals(0, receipts().length())
  }

  @Test
  fun pauseAndWorkspaceClosureCancelDeliveryAndRejectTaken() {
    MedicineEngine.replace(context, workspace, plans())
    MedicineEngine.deliver(context, payload("reminder"))
    val take = shadowOf(notification().actions.single().actionIntent).savedIntent
    MedicineEngine.replace(context, workspace, plans(paused = true))
    assertNull(notification())
    assertTrue(shadowOf(alarms).scheduledAlarms.isEmpty())
    MedicineReceiver().onReceive(context, take)
    assertTrue((0 until receipts().length()).none { receipts().getJSONObject(it).getString("kind") == "taken" })
    MedicineEngine.replace(context, workspace, plans())
    MedicineEngine.quiesce(context, workspace)
    MedicineReceiver().onReceive(context, take)
    MedicineEngine.restore(context, true)
    assertNull(notification())
    assertTrue(shadowOf(alarms).scheduledAlarms.isEmpty())
  }

  @Test
  fun rebootRestoresSchedulingAndPendingCardsQuietly() {
    MedicineEngine.replace(context, workspace, plans())
    MedicineEngine.deliver(context, payload("reminder"))
    manager.cancelAll()
    for (alarm in shadowOf(alarms).scheduledAlarms.toList()) alarms.cancel(alarm.operation!!)
    MedicineEngine.restore(context, true)
    assertNotNull(notification())
    assertEquals(Notification.GROUP_ALERT_SUMMARY, notification().groupAlertBehavior)
    assertNotNull(payload("alarm"))
    assertEquals(1, presentedCount())
  }

  @Test
  fun notificationPermissionBlocksPostingWithoutCreatingConfirmation() {
    shadowOf(manager).setNotificationsEnabled(false)
    MedicineEngine.replace(context, workspace, plans())
    MedicineEngine.deliver(context, payload("alarm"))
    assertNull(notification())
    assertEquals(0, receipts().length())
  }

  @Test
  fun exactAlarmAccessCanBeRestoredWithoutOpeningTheWorkspaceAgain() {
    ShadowAlarmManager.setCanScheduleExactAlarms(false)
    MedicineEngine.replace(context, workspace, plans())
    assertTrue(shadowOf(alarms).scheduledAlarms.isEmpty())
    ShadowAlarmManager.setCanScheduleExactAlarms(true)
    MedicineEngine.restore(context)
    assertNotNull(payload("alarm"))
  }

  @Test
  fun aNewlyActiveWorkspaceTakesOverRemindersAnotherWorkspaceLeftBehind() {
    MedicineEngine.replace(context, "previous", plans())
    MedicineEngine.deliver(context, payload("reminder"))
    assertNotNull(notification())
    MedicineEngine.replace(context, workspace, plans(listOf("other")))
    assertNull(notification())
    assertNotNull(payload("alarm"))
    assertEquals(listOf("other"), shadowOf(alarms).scheduledAlarms
      .map { JSONObject(shadowOf(it.operation).savedIntent.getStringExtra("payload")!!) }
      .filter { it.has("doses") }
      .flatMap { batch -> (0 until batch.getJSONArray("doses").length()).map { batch.getJSONArray("doses").getJSONObject(it).getString("medicineId") } }
      .distinct())
    assertEquals(0, receipts().length())
    assertEquals(0, JSONArray(MedicineEngine.receipts(context, "previous")).length())
  }

  @Test
  fun anotherWorkspacesUnimportedConfirmationIsNotDropped() {
    MedicineEngine.replace(context, "previous", plans())
    MedicineEngine.deliver(context, payload("reminder"))
    MedicineReceiver().onReceive(context, shadowOf(notification().actions.single().actionIntent).savedIntent)
    assertThrows(IllegalStateException::class.java) { MedicineEngine.replace(context, workspace, plans(listOf("other"))) }
    assertEquals(1, (0 until JSONArray(MedicineEngine.receipts(context, "previous")).length()).count { JSONArray(MedicineEngine.receipts(context, "previous")).getJSONObject(it).getString("kind") == "taken" })
  }

  @Test
  fun aReminderFileRestoredFromAnotherInstallDoesNotBlockReminders() {
    val restored = JSONObject(plans()).put("workspace", "restored")
    context.getSharedPreferences("medicine-reminders-v1", Context.MODE_PRIVATE).edit().putString("state", restored.toString()).commit()
    MedicineEngine.replace(context, workspace, plans(listOf("other")))
    assertNotNull(payload("alarm"))
  }

  @Test
  fun reminderStateStaysOutOfAndroidBackup() {
    MedicineEngine.replace(context, workspace, plans())
    assertTrue(File(context.noBackupFilesDir, "medicine-reminders.json").exists())
    assertTrue(File(context.dataDir, "shared_prefs").listFiles().orEmpty().none { it.name.startsWith("medicine") })
  }
}
