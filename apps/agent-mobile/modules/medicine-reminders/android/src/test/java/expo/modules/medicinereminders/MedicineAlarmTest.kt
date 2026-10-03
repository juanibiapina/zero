package expo.modules.medicinereminders

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.time.LocalDate
import java.time.ZoneId

@org.robolectric.annotation.Implements(android.app.NotificationManager::class)
class DeniedFullScreenAccess : org.robolectric.shadows.ShadowNotificationManager() {
  @org.robolectric.annotation.Implementation(minSdk = 34)
  fun canUseFullScreenIntent(): Boolean = false
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@LooperMode(LooperMode.Mode.PAUSED)
class MedicineAlarmTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()
  private val workspace = "taskdo-workspace-medicine-proof.sqlite"
  private lateinit var dose: JSONObject

  @Before
  fun installMutedSchedule() {
    context.applicationInfo.flags = context.applicationInfo.flags or ApplicationInfo.FLAG_DEBUGGABLE
    MedicineEngine.silenceProof(context)
    val day = LocalDate.now().toString()
    val medicine = JSONObject("""{"id":"medicine","name":"Pill","instructions":"After food","startsOn":"$day","endsOn":null,"paused":false,"doses":[{"id":"evening","remindAt":"00:00","alarmAt":"23:59"}]}""")
    MedicineEngine.replace(context, workspace, """{"medicines":[$medicine],"confirmed":[]}""")
    dose = JSONObject("""{"id":"dose","medicineId":"medicine","slotId":"evening","on":"$day","name":"Pill","instructions":"After food","alarmLabel":"23:59","takenAt":null}""")
      .put("id", org.json.JSONArray(listOf("medicine", "evening", day)).toString())
      .put("scheduledAt", LocalDate.now().atTime(23, 59).atZone(ZoneId.systemDefault()).toInstant().toString())
  }

  private fun stopButton(view: android.view.View): android.widget.Button? = button(view, "Stop alarm")
  private fun button(view: android.view.View, label: String): android.widget.Button? {
    if (view is android.widget.Button && view.text.toString() == label) return view
    if (view is android.view.ViewGroup) for (index in 0 until view.childCount) {
      button(view.getChildAt(index), label)?.let { return it }
    }
    return null
  }

  @Test
  fun longMedicineContentLeavesBothActionsAtTheBottom() {
    dose.put("name", "A medicine with a very long name ".repeat(8))
    val controller = Robolectric.buildService(MedicineAlarmService::class.java).create()
    var activity: org.robolectric.android.controller.ActivityController<MedicineAlarmActivity>? = null
    try {
      controller.get().onStartCommand(Intent(context, MedicineAlarmService::class.java).putExtra("workspace", workspace).putExtra("dose", dose.toString()), 0, 1)
      val entry = shadowOf(shadowOf(controller.get()).lastForegroundNotification.contentIntent).savedIntent
      activity = Robolectric.buildActivity(MedicineAlarmActivity::class.java, entry).create().start().resume().visible()
      val content = activity.get().findViewById<android.view.View>(android.R.id.content)
      content.measure(android.view.View.MeasureSpec.makeMeasureSpec(360, android.view.View.MeasureSpec.EXACTLY), android.view.View.MeasureSpec.makeMeasureSpec(640, android.view.View.MeasureSpec.EXACTLY))
      content.layout(0, 0, 360, 640)
      for (label in listOf("Stop alarm", "Taken")) {
        val action = button(content, label)!!
        val position = IntArray(2); action.getLocationInWindow(position)
        assertTrue("$label must remain near the bottom", position[1] >= 440)
        assertTrue(action.isShown)
      }
    } finally { activity?.pause()?.stop()?.destroy(); controller.destroy() }
  }

  @Test
  fun takenOnTheAlarmScreenRecordsTheDoseAndStopsPlayback() {
    val controller = Robolectric.buildService(MedicineAlarmService::class.java).create()
    var activity: org.robolectric.android.controller.ActivityController<MedicineAlarmActivity>? = null
    try {
      controller.get().onStartCommand(Intent(context, MedicineAlarmService::class.java).putExtra("workspace", workspace).putExtra("dose", dose.toString()), 0, 1)
      val entry = shadowOf(shadowOf(controller.get()).lastForegroundNotification.contentIntent).savedIntent
      activity = Robolectric.buildActivity(MedicineAlarmActivity::class.java, entry).create().start().resume().visible()
      val taken = button(activity.get().window.decorView, "Taken")
      org.junit.Assert.assertNotNull(taken)
      taken!!.performClick()
      val receipts = org.json.JSONArray(MedicineEngine.receipts(context, workspace))
      org.junit.Assert.assertEquals(1, receipts.length())
      org.junit.Assert.assertEquals("taken", receipts.getJSONObject(0).getString("kind"))
      org.junit.Assert.assertEquals(dose.getString("id"), receipts.getJSONObject(0).getString("id"))
      org.junit.Assert.assertNotNull(receipts.getJSONObject(0).getString("takenAt"))
      assertTrue(shadowOf(controller.get()).isStoppedBySelf)
      assertTrue(activity.get().isFinishing)
    } finally { activity?.pause()?.stop()?.destroy(); controller.destroy() }
  }

  @Test
  fun duplicateOsDeliveryDoesNotRemoveAStoppedDosesReminder() {
    val launch = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage(context.packageName)
    val resolved = android.content.pm.ResolveInfo().apply {
      activityInfo = android.content.pm.ActivityInfo().apply { packageName = context.packageName; name = "android.app.Activity" }
    }
    shadowOf(context.packageManager).addResolveInfoForIntent(launch, resolved)
    val alarms = context.getSystemService(android.app.AlarmManager::class.java)
    org.robolectric.shadows.ShadowAlarmManager.setCanScheduleExactAlarms(true)
    MedicineEngine.restore(context)
    val delivery = shadowOf(alarms).scheduledAlarms.map { shadowOf(it.operation).savedIntent }.first {
      JSONObject(it.getStringExtra("payload")!!).getString("kind") == "alarm"
    }
    val controller = Robolectric.buildService(MedicineAlarmService::class.java).create()
    try {
      controller.get().onStartCommand(Intent(context, MedicineAlarmService::class.java).putExtra("workspace", workspace).putExtra("dose", dose.toString()), 0, 1)
      val stop = shadowOf(shadowOf(controller.get()).lastForegroundNotification.actions.first { it.title == "Stop alarm" }.actionIntent).savedIntent
      MedicineReceiver().onReceive(context, stop)
      MedicineReceiver().onReceive(context, delivery)
      val manager = context.getSystemService(android.app.NotificationManager::class.java)
      org.junit.Assert.assertNotNull(shadowOf(manager).getNotification(dose.getString("id"), 0))
    } finally { controller.destroy() }
  }

  @Test
  fun aDeliveryFromAnotherWorkspaceCannotStartPlayback() {
    val controller = Robolectric.buildService(MedicineAlarmService::class.java).create()
    try {
      controller.get().onStartCommand(Intent(context, MedicineAlarmService::class.java).putExtra("workspace", "another-workspace").putExtra("dose", dose.toString()), 0, 1)
      org.junit.Assert.assertNull(shadowOf(controller.get()).lastForegroundNotification)
    } finally { controller.destroy() }
  }

  @Test
  fun closingTheWorkspaceStopsRingingAndClosesItsScreen() {
    val controller = Robolectric.buildService(MedicineAlarmService::class.java).create()
    var activity: org.robolectric.android.controller.ActivityController<MedicineAlarmActivity>? = null
    try {
      controller.get().onStartCommand(Intent(context, MedicineAlarmService::class.java).putExtra("workspace", workspace).putExtra("dose", dose.toString()), 0, 1)
      val entry = shadowOf(shadowOf(controller.get()).lastForegroundNotification.contentIntent).savedIntent
      activity = Robolectric.buildActivity(MedicineAlarmActivity::class.java, entry).create().start().resume().visible()
      MedicineEngine.quiesce(context, workspace)
      shadowOf(android.os.Looper.getMainLooper()).idle()
      assertTrue(shadowOf(controller.get()).isStoppedBySelf)
      assertTrue(activity.get().isFinishing)
    } finally { activity?.pause()?.stop()?.destroy(); controller.destroy() }
  }

  @Test
  fun stoppingAnAlarmRestoresItsPendingReminder() {
    val manager = context.getSystemService(android.app.NotificationManager::class.java)
    // The early notification already exists when the alarm replaces it.
    manager.notify(dose.getString("id"), 0, MedicineEngine.notification(context, workspace, dose, false))
    val controller = Robolectric.buildService(MedicineAlarmService::class.java).create()
    try {
      controller.get().onStartCommand(Intent(context, MedicineAlarmService::class.java).putExtra("workspace", workspace).putExtra("dose", dose.toString()), 0, 1)
      manager.cancel(dose.getString("id"), 0)
      val stop = shadowOf(shadowOf(controller.get()).lastForegroundNotification.actions.first { it.title == "Stop alarm" }.actionIntent).savedIntent
      MedicineReceiver().onReceive(context, stop)
      val pending = shadowOf(manager).getNotification(dose.getString("id"), 0)
      org.junit.Assert.assertNotNull(pending)
      org.junit.Assert.assertEquals(android.app.Notification.CATEGORY_REMINDER, pending.category)
    } finally { controller.destroy() }
  }

  @Test
  @Config(shadows = [DeniedFullScreenAccess::class])
  fun deniedFullScreenAccessIsReportedWhileStopRemainsAvailable() {
    org.junit.Assert.assertEquals(false, MedicineEngine.capabilities(context)["fullScreenAlarms"])
    val controller = Robolectric.buildService(MedicineAlarmService::class.java).create()
    try {
      controller.get().onStartCommand(Intent(context, MedicineAlarmService::class.java).putExtra("workspace", workspace).putExtra("dose", dose.toString()), 0, 1)
      assertTrue(shadowOf(controller.get()).lastForegroundNotification.actions.any { it.title == "Stop alarm" })
    } finally { controller.destroy() }
  }

  private fun visibleText(view: android.view.View): List<String> {
    val own = if (view is android.widget.TextView) listOf(view.text.toString()) else emptyList()
    return own + if (view is android.view.ViewGroup) (0 until view.childCount).flatMap { visibleText(view.getChildAt(it)) } else emptyList()
  }

  @Test
  fun simultaneousAlarmsAppearOnOneScreenAndStopTogether() {
    val day = LocalDate.now().toString()
    val medicines = org.json.JSONArray()
    for (id in listOf("medicine", "other")) medicines.put(JSONObject("""{"id":"$id","name":"$id","instructions":"After food","startsOn":"$day","endsOn":null,"paused":false,"doses":[{"id":"evening","remindAt":"00:00","alarmAt":"23:59"}]}"""))
    MedicineEngine.replace(context, workspace, JSONObject().put("medicines", medicines).put("confirmed", org.json.JSONArray()).toString())
    val peer = JSONObject(dose.toString()).put("id", "peer-dose").put("medicineId", "other").put("name", "Second pill")
    val controller = Robolectric.buildService(MedicineAlarmService::class.java).create()
    var activity: org.robolectric.android.controller.ActivityController<MedicineAlarmActivity>? = null
    try {
      controller.get().onStartCommand(Intent(context, MedicineAlarmService::class.java).putExtra("workspace", workspace).putExtra("dose", dose.toString()), 0, 1)
      val entry = shadowOf(shadowOf(controller.get()).lastForegroundNotification.contentIntent).savedIntent
      activity = Robolectric.buildActivity(MedicineAlarmActivity::class.java, entry).create().start().resume().visible()
      controller.get().onStartCommand(Intent(context, MedicineAlarmService::class.java).putExtra("workspace", workspace).putExtra("dose", peer.toString()), 0, 2)
      assertTrue(visibleText(activity.get().window.decorView).any { it.contains("Second pill") })
      stopButton(activity.get().window.decorView)!!.performClick()
      assertTrue(shadowOf(controller.get()).isStoppedBySelf)
      assertTrue(activity.get().isFinishing)
    } finally { activity?.pause()?.stop()?.destroy(); controller.destroy() }
  }

  @Test
  fun takenRecordsAllSimultaneousDosesInTheCurrentSession() {
    val day = LocalDate.now().toString()
    val medicines = org.json.JSONArray()
    for (id in listOf("medicine", "other")) medicines.put(JSONObject("""{"id":"$id","name":"$id","instructions":"After food","startsOn":"$day","endsOn":null,"paused":false,"doses":[{"id":"evening","remindAt":"00:00","alarmAt":"23:59"}]}"""))
    MedicineEngine.replace(context, workspace, JSONObject().put("medicines", medicines).put("confirmed", org.json.JSONArray()).toString())
    val peer = JSONObject(dose.toString()).put("id", org.json.JSONArray(listOf("other", "evening", day)).toString()).put("medicineId", "other").put("name", "Second pill")
    val controller = Robolectric.buildService(MedicineAlarmService::class.java).create()
    var activity: org.robolectric.android.controller.ActivityController<MedicineAlarmActivity>? = null
    try {
      for (item in listOf(dose, peer)) controller.get().onStartCommand(Intent(context, MedicineAlarmService::class.java).putExtra("workspace", workspace).putExtra("dose", item.toString()), 0, 1)
      val entry = shadowOf(shadowOf(controller.get()).lastForegroundNotification.contentIntent).savedIntent
      activity = Robolectric.buildActivity(MedicineAlarmActivity::class.java, entry).create().start().resume().visible()
      button(activity.get().window.decorView, "Taken")!!.performClick()
      val receipts = org.json.JSONArray(MedicineEngine.receipts(context, workspace))
      org.junit.Assert.assertEquals(2, receipts.length())
      org.junit.Assert.assertEquals(setOf(dose.getString("id"), peer.getString("id")), (0 until receipts.length()).map { receipts.getJSONObject(it).getString("id") }.toSet())
      assertTrue((0 until receipts.length()).all { receipts.getJSONObject(it).getString("kind") == "taken" })
      assertTrue(shadowOf(controller.get()).isStoppedBySelf)
      assertTrue(activity.get().isFinishing)
    } finally { activity?.pause()?.stop()?.destroy(); controller.destroy() }
  }

  @Test
  fun backDoesNotExposeTheAppWhileTheAlarmIsRinging() {
    val controller = Robolectric.buildService(MedicineAlarmService::class.java).create()
    var activity: org.robolectric.android.controller.ActivityController<MedicineAlarmActivity>? = null
    try {
      controller.get().onStartCommand(Intent(context, MedicineAlarmService::class.java)
        .putExtra("workspace", workspace).putExtra("dose", dose.toString()), 0, 1)
      val entry = shadowOf(shadowOf(controller.get()).lastForegroundNotification.contentIntent).savedIntent
      activity = Robolectric.buildActivity(MedicineAlarmActivity::class.java, entry).create().start().resume().visible()
      @Suppress("DEPRECATION")
      activity.get().onBackPressed()
      org.junit.Assert.assertFalse(activity.get().isFinishing)
      assertTrue(stopButton(activity.get().window.decorView)!!.isShown)
    } finally { activity?.pause()?.stop()?.destroy(); controller.destroy() }
  }

  @Test
  fun anAlarmBeginningWhileTheAppIsVisibleCoversTheApp() {
    val startup = Robolectric.buildContentProvider(MedicineAlarmStartup::class.java).create()
    val main = Robolectric.buildActivity(android.app.Activity::class.java).create().start().resume()
    val controller = Robolectric.buildService(MedicineAlarmService::class.java).create()
    try {
      controller.get().onStartCommand(Intent(context, MedicineAlarmService::class.java)
        .putExtra("workspace", workspace).putExtra("dose", dose.toString()), 0, 1)
      org.junit.Assert.assertEquals("expo.modules.medicinereminders.MedicineAlarmActivity", shadowOf(main.get()).nextStartedActivity?.component?.className)
    } finally { main.pause().stop().destroy(); controller.destroy(); startup.get().shutdown() }
  }

  @Test
  fun openingAnAppScreenWhileRingingPresentsTheSameNativeAlarm() {
    val startup = Robolectric.buildContentProvider(MedicineAlarmStartup::class.java).create()
    val controller = Robolectric.buildService(MedicineAlarmService::class.java).create()
    var main: org.robolectric.android.controller.ActivityController<android.app.Activity>? = null
    try {
      controller.get().onStartCommand(Intent(context, MedicineAlarmService::class.java)
        .putExtra("workspace", workspace).putExtra("dose", dose.toString()), 0, 1)
      main = Robolectric.buildActivity(android.app.Activity::class.java).create().start().resume()
      org.junit.Assert.assertEquals("expo.modules.medicinereminders.MedicineAlarmActivity", shadowOf(main.get()).nextStartedActivity?.component?.className)
    } finally { main?.pause()?.stop()?.destroy(); controller.destroy(); startup.get().shutdown() }
  }

  @Test
  fun theCutoffClosesTheScreenAndDuplicateDeliveryDoesNotExtendIt() {
    val controller = Robolectric.buildService(MedicineAlarmService::class.java).create()
    var activity: org.robolectric.android.controller.ActivityController<MedicineAlarmActivity>? = null
    val delivery = Intent(context, MedicineAlarmService::class.java).putExtra("workspace", workspace).putExtra("dose", dose.toString())
    try {
      controller.get().onStartCommand(delivery, 0, 1)
      val entry = shadowOf(shadowOf(controller.get()).lastForegroundNotification.contentIntent).savedIntent
      activity = Robolectric.buildActivity(MedicineAlarmActivity::class.java, entry).create().start().resume().visible()
      shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(30))
      controller.get().onStartCommand(delivery, 0, 2)
      shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(30))
      assertTrue(shadowOf(controller.get()).isStoppedBySelf)
      assertTrue(activity.get().isFinishing)
    } finally { activity?.pause()?.stop()?.destroy(); controller.destroy() }
  }

  @Test
  fun theNativeScreenStopsTheAlarmAndCloses() {
    val controller = Robolectric.buildService(MedicineAlarmService::class.java).create()
    var activity: org.robolectric.android.controller.ActivityController<MedicineAlarmActivity>? = null
    try {
      controller.get().onStartCommand(Intent(context, MedicineAlarmService::class.java)
        .putExtra("workspace", workspace).putExtra("dose", dose.toString()), 0, 1)
      val entry = shadowOf(shadowOf(controller.get()).lastForegroundNotification.contentIntent).savedIntent
      activity = Robolectric.buildActivity(MedicineAlarmActivity::class.java, entry).create().start().resume().visible()
      val stop = stopButton(activity.get().window.decorView)
      org.junit.Assert.assertNotNull(stop)
      stop!!.performClick()
      assertTrue(shadowOf(controller.get()).isStoppedBySelf)
      assertTrue(activity.get().isFinishing)
    } finally { activity?.pause()?.stop()?.destroy(); controller.destroy() }
  }

  @Test
  fun ringingHasAFullScreenEntryAndATapEntryToTheSameAlarmScreen() {
    val controller = Robolectric.buildService(MedicineAlarmService::class.java).create()
    try {
      controller.get().onStartCommand(Intent(context, MedicineAlarmService::class.java)
        .putExtra("workspace", workspace).putExtra("dose", dose.toString()), 0, 1)
      val notification = shadowOf(controller.get()).lastForegroundNotification
      org.junit.Assert.assertNotNull(notification.fullScreenIntent)
      val screen = shadowOf(notification.contentIntent).savedIntent.component?.className
      org.junit.Assert.assertEquals("expo.modules.medicinereminders.MedicineAlarmActivity", screen)
      org.junit.Assert.assertEquals(screen, shadowOf(notification.fullScreenIntent).savedIntent.component?.className)
    } finally { controller.destroy() }
  }

  @Test
  fun anOldStopActionCannotStopANewerAlarm() {
    val first = Robolectric.buildService(MedicineAlarmService::class.java).create()
    first.get().onStartCommand(Intent(context, MedicineAlarmService::class.java)
      .putExtra("workspace", workspace).putExtra("dose", dose.toString()), 0, 1)
    val oldStop = shadowOf(shadowOf(first.get()).lastForegroundNotification.actions.first { it.title == "Stop alarm" }.actionIntent).savedIntent
    MedicineReceiver().onReceive(context, oldStop)
    first.destroy()
    val day = LocalDate.now().toString()
    MedicineEngine.replace(context, workspace, """{"medicines":[{"id":"medicine","name":"Pill","instructions":"After food","startsOn":"$day","endsOn":null,"paused":false,"doses":[{"id":"evening","remindAt":"00:00","alarmAt":"23:58"}]}],"confirmed":[]}""")
    val newerDose = JSONObject(dose.toString()).put("alarmLabel", "23:58")
      .put("scheduledAt", LocalDate.now().atTime(23, 58).atZone(ZoneId.systemDefault()).toInstant().toString())
    val second = Robolectric.buildService(MedicineAlarmService::class.java).create()
    try {
      second.get().onStartCommand(Intent(context, MedicineAlarmService::class.java)
        .putExtra("workspace", workspace).putExtra("dose", newerDose.toString()), 0, 2)
      MedicineReceiver().onReceive(context, oldStop)
      org.junit.Assert.assertFalse(shadowOf(second.get()).isStoppedBySelf)
    } finally { second.destroy() }
  }

  @Test
  fun stoppingLeavesTheDosePendingAndPreventsAlarmReplay() {
    val controller = Robolectric.buildService(MedicineAlarmService::class.java).create()
    val service = controller.get()
    try {
      service.onStartCommand(Intent(context, MedicineAlarmService::class.java)
        .putExtra("workspace", workspace).putExtra("dose", dose.toString()), 0, 1)
      val stop = shadowOf(service).lastForegroundNotification.actions.first { it.title == "Stop alarm" }.actionIntent
      MedicineReceiver().onReceive(context, shadowOf(stop).savedIntent)
      shadowOf(android.os.Looper.getMainLooper()).idle()
      assertTrue(shadowOf(service).isStoppedBySelf)
      val receipts = org.json.JSONArray(MedicineEngine.receipts(context, workspace))
      assertTrue((0 until receipts.length()).none { receipts.getJSONObject(it).getString("kind") == "taken" })
      controller.destroy()
      val replay = Robolectric.buildService(MedicineAlarmService::class.java).create()
      try {
        replay.get().onStartCommand(Intent(context, MedicineAlarmService::class.java)
          .putExtra("workspace", workspace).putExtra("dose", dose.toString()), 0, 2)
        org.junit.Assert.assertNull(shadowOf(replay.get()).lastForegroundNotification)
      } finally { replay.destroy() }
    } finally { if (!shadowOf(service).isStoppedBySelf) controller.destroy() }
  }

  @Test
  fun aRingingAlarmOffersStopWithoutOpeningReact() {
    val controller = Robolectric.buildService(MedicineAlarmService::class.java).create()
    val service = controller.get()
    try {
      service.onStartCommand(Intent(context, MedicineAlarmService::class.java)
        .putExtra("workspace", workspace).putExtra("dose", dose.toString()), 0, 1)
      val notification = shadowOf(service).lastForegroundNotification
      assertTrue(notification.actions.any { it.title == "Stop alarm" })
    } finally {
      controller.destroy()
    }
  }
}
