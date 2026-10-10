package expo.modules.zeronotifications

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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
import java.time.ZoneId
import java.time.ZoneOffset

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NotificationEngineTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()
  private val manager: NotificationManager get() = context.getSystemService(NotificationManager::class.java)
  private val alarms: AlarmManager get() = context.getSystemService(AlarmManager::class.java)
  private val workspace = "workspace"
  private val source = "source"
  private val day = "2026-10-02"
  private var zone: ZoneId = ZoneOffset.UTC

  private fun reminder(
    key: String = "item", early: String = "07:45", due: String = "08:00", settled: List<String> = emptyList(),
    from: String = "2026-09-01", until: String? = null, weekdays: List<Int> = (1..7).toList(), late: Int? = null,
  ) = JSONObject()
    .put("key", key).put("channel", "alerts").put("icon", "pill").put("title", "Title $key")
    .put("lockScreen", JSONObject().put("title", "Reminder").put("text", "Open the app"))
    .put("url", "app:///items/$key?date={date}")
    .put("recurrence", JSONObject().put("from", from).put("until", until ?: JSONObject.NULL).put("weekdays", JSONArray(weekdays)))
    .put("at", due)
    .put("stages", JSONArray()
      .put(JSONObject().put("offset", -lead(early, due)).put("wake", "exact").put("text", "Early $early"))
      .put(JSONObject().put("offset", 0).put("wake", "alarmClock").put("text", "Due $due"))
      .also { stages -> if (late != null) stages.put(JSONObject().put("offset", late).put("wake", "alarmClock").put("text", "Late $late")) })
    .put("actions", JSONArray()
      .put(JSONObject().put("id", "done").put("label", "Done").put("kind", "settle"))
      .put(JSONObject().put("id", "later").put("label", "Later").put("kind", "snooze").put("minutes", 60)))
    .put("settled", JSONArray(settled))
    .put("data", "{\"key\":\"$key\"}")

  private fun minutes(time: String) = time.substring(0, 2).toInt() * 60 + time.substring(3, 5).toInt()
  private fun lead(early: String, due: String) = ((minutes(due) - minutes(early)) % 1440 + 1440) % 1440

  private fun schedule(vararg reminders: JSONObject) = JSONObject()
    .put("channels", JSONArray().put(JSONObject().put("id", "alerts").put("name", "Alerts").put("group", JSONObject().put("id", "group").put("name", "Group"))))
    .put("reminders", JSONArray(reminders.toList())).toString()

  private fun install(vararg reminders: JSONObject, into: String = workspace) = NotificationEngine.install(context, into, source, schedule(*reminders))
  private fun at(time: String, date: String = day) { NotificationEngine.clock = { Clock.fixed(java.time.LocalDateTime.parse("${date}T$time").atZone(zone).toInstant(), zone) } }
  private fun fire(time: String, date: String = day) { at(time, date); NotificationEngine.wake(context) }
  private fun card(key: String = "item", date: String = day): Notification? = shadowOf(manager).getNotification(NotificationEngine.occurrence(source, key, date), 0)
  private fun text(key: String = "item", date: String = day) = card(key, date)?.extras?.getString(Notification.EXTRA_TEXT)
  private fun tap(label: String, key: String = "item", date: String = day) = NotificationReceiver().onReceive(context, button(label, key, date))
  private fun button(label: String, key: String = "item", date: String = day) = shadowOf(card(key, date)!!.actions.first { it.title == label }.actionIntent).savedIntent
  private fun receipts() = JSONArray(NotificationEngine.receipts(context, workspace, source)).let { list -> (0 until list.length()).map { list.getJSONObject(it) } }
  private fun armed(wake: String) = shadowOf(alarms).scheduledAlarms.firstOrNull { shadowOf(it.operation).savedIntent.data.toString().endsWith(wake) }?.triggerAtMs
  private fun ms(time: String, date: String = day) = java.time.LocalDateTime.parse("${date}T$time").atZone(zone).toInstant().toEpochMilli()
  private fun alerting(notification: Notification) = notification.flags and Notification.FLAG_ONLY_ALERT_ONCE == 0

  @Before
  fun enableScheduling() {
    ShadowAlarmManager.setCanScheduleExactAlarms(true)
    zone = ZoneOffset.UTC
  }

  @After
  fun restoreClock() { NotificationEngine.clock = { Clock.systemDefaultZone() } }

  @Test
  fun theLaterStageReplacesTheEarlierCardOfTheSameOccurrence() {
    at("07:00"); install(reminder())
    fire("07:45")
    assertEquals("Early 07:45", text())
    assertTrue(alerting(card()!!))
    fire("08:00")
    assertEquals("Due 08:00", text())
    assertTrue(alerting(card()!!))
    assertEquals(1, shadowOf(manager).allNotifications.size)
    assertEquals(listOf("presented", "presented"), receipts().map { it.getString("type") })
  }

  @Test
  fun armsTheNextAlarmClockAndTheNextExactTime() {
    at("07:00"); install(reminder())
    assertEquals(ms("08:00"), armed("alarm_clock"))
    assertEquals(ms("07:45"), armed("exact"))
    fire("08:00")
    assertEquals(ms("08:00", "2026-10-03"), armed("alarm_clock"))
    assertEquals(ms("07:45", "2026-10-03"), armed("exact"))
    assertEquals("app:///items/item?date=2026-10-03", shadowOf(alarms).scheduledAlarms.first { it.alarmClockInfo != null }.alarmClockInfo!!.showIntent.let { shadowOf(it).savedIntent.data.toString() })
  }

  @Test
  fun arrivesOnlyOnChosenWeekdays() {
    at("09:00"); install(reminder(weekdays = listOf(1, 3, 5)))
    assertEquals(ms("08:00", "2026-10-05"), armed("alarm_clock"))
  }

  @Test
  fun anOlderCardStaysWhenTheNextOccurrenceShows() {
    at("07:00"); install(reminder())
    fire("08:00")
    fire("07:45", "2026-10-03")
    assertEquals("Due 08:00", text())
    assertEquals("Early 07:45", text(date = "2026-10-03"))
  }

  @Test
  fun aStageAlreadyPastWhenFirstInstalledNeverShows() {
    at("07:50"); install(reminder())
    assertNull(card())
    at("07:55"); install(reminder())
    assertNull(card())
    at("07:56"); install(reminder(early = "07:10"))
    fire("08:00")
    assertEquals("Due 08:00", text())
  }

  @Test
  fun aReinstallKeepsAStageThatWasScheduledBeforeItsTime() {
    at("07:00"); install(reminder())
    at("08:00:30"); install(reminder())
    assertEquals("Due 08:00", text())
    assertTrue(alerting(card()!!))
    NotificationEngine.wake(context)
    assertEquals(1, receipts().size)
  }

  @Test
  fun settleRecordsOneReceiptAndSilencesTheLaterStage() {
    at("07:00"); install(reminder())
    fire("07:45")
    val done = button("Done")
    at("07:46")
    NotificationReceiver().onReceive(context, done)
    NotificationReceiver().onReceive(context, done)
    assertNull(card())
    fire("08:00")
    assertNull(card())
    val settled = receipts().filter { it.getString("type") == "settled" }
    assertEquals(1, settled.size)
    assertEquals("done", settled.single().getString("action"))
    assertEquals("2026-10-02T07:46:00Z", settled.single().getString("at"))
    assertEquals("{\"key\":\"item\"}", settled.single().getString("data"))
    assertEquals(ms("08:00", "2026-10-03"), armed("alarm_clock"))
  }

  @Test
  fun anUnacknowledgedSettleSurvivesInstallAndAnAcknowledgedOneFollowsTheSchedule() {
    at("07:00"); install(reminder())
    fire("07:45")
    at("07:46"); tap("Done")
    at("07:50"); install(reminder())
    fire("08:00")
    assertNull(card())

    at("07:00", "2026-10-03"); install(reminder())
    fire("07:45", "2026-10-03")
    at("07:46", "2026-10-03"); tap("Done", date = "2026-10-03")
    NotificationEngine.acknowledge(context, workspace, source, receipts().map { it.getString("id") })
    at("07:50", "2026-10-03"); install(reminder())
    fire("08:00", "2026-10-03")
    assertEquals("Due 08:00", text(date = "2026-10-03"))
  }

  @Test
  fun aSettledDateFromTheScheduleClosesAnOldCard() {
    at("07:00"); install(reminder())
    fire("08:00")
    at("07:00", "2026-10-03"); install(reminder(settled = listOf(day)))
    assertNull(card())
  }

  @Test
  fun aSnoozeKeepsTheCardQuietSkipsTheStagesInsideItAndReturnsWithTheLatestStage() {
    at("09:00"); install(reminder(early = "09:50", due = "10:30"))
    fire("09:50")
    at("09:55"); tap("Later")
    assertEquals("Early 09:50", text())
    assertFalse(alerting(card()!!))
    assertEquals(ms("10:55"), armed("alarm_clock"))
    fire("10:30")
    assertEquals("Early 09:50", text())
    fire("10:55")
    assertEquals("Due 10:30", text())
    assertTrue(alerting(card()!!))
    assertEquals(listOf("Done", "Later"), card()!!.actions.map { it.title.toString() })
  }

  @Test
  fun aSnoozeThatEndsBeforeTheNextStageLeavesThatStageInPlace() {
    at("07:00"); install(reminder(early = "08:00", due = "10:30"))
    fire("08:00")
    tap("Later")
    fire("09:00")
    assertEquals("Early 08:00", text())
    fire("10:30")
    assertEquals("Due 10:30", text())
  }

  @Test
  fun aSnoozeReturnsAfterMidnightForItsOwnOccurrence() {
    at("22:00"); install(reminder(early = "22:30", due = "23:00"))
    fire("23:00")
    at("23:30"); tap("Later")
    fire("00:30", "2026-10-03")
    assertEquals("Due 23:00", text())
  }

  @Test
  fun aRepeatedSnoozeTapSnoozesOnce() {
    at("09:00"); install(reminder(early = "09:10", due = "09:30"))
    fire("09:30")
    val later = button("Later")
    NotificationReceiver().onReceive(context, later)
    at("09:40")
    NotificationReceiver().onReceive(context, later)
    assertEquals(ms("10:30"), armed("alarm_clock"))
  }

  @Test
  fun postponingAgainFromTheCardRestartsTheHour() {
    at("09:00"); install(reminder(early = "09:10", due = "09:30"))
    fire("09:30")
    tap("Later")
    at("09:40"); tap("Later")
    assertEquals(ms("10:40"), armed("alarm_clock"))
    fire("10:30")
    assertFalse(alerting(card()!!))
    fire("10:40")
    assertTrue(alerting(card()!!))
  }

  @Test
  fun settlingDuringASnoozeClosesTheCardAndCancelsTheSnooze() {
    at("09:00"); install(reminder(early = "09:10", due = "09:30"))
    fire("09:30")
    tap("Later")
    at("09:40"); tap("Done")
    assertNull(card())
    fire("10:30")
    assertNull(card())
    assertEquals(ms("09:30", "2026-10-03"), armed("alarm_clock"))
  }

  @Test
  fun installClosesCardsForRemovedRemindersAndChangedStageTimes() {
    at("07:00"); install(reminder(), reminder(key = "other"))
    fire("07:45")
    at("07:50"); install(reminder(early = "07:40"), reminder(key = "other"))
    assertNull(card())
    assertNotNull(card("other"))
    install(reminder(early = "07:40"))
    assertNull(card("other"))
  }

  @Test
  fun aSwipedCardComesBackQuietlyAndTheLaterStageStillShows() {
    at("07:00"); install(reminder())
    fire("07:45")
    val swipe = shadowOf(card()!!.deleteIntent).savedIntent
    manager.cancelAll()
    NotificationReceiver().onReceive(context, swipe)
    assertEquals("Early 07:45", text())
    assertFalse(alerting(card()!!))
    fire("08:00")
    assertEquals("Due 08:00", text())
    assertTrue(alerting(card()!!))
  }

  @Test
  fun aSwipeAfterSettleOrOnABlockedChannelShowsNothing() {
    at("07:00"); install(reminder(), reminder(key = "other"))
    fire("07:45")
    val settled = shadowOf(card()!!.deleteIntent).savedIntent
    tap("Done")
    NotificationReceiver().onReceive(context, settled)
    assertNull(card())
    val blocked = shadowOf(card("other")!!.deleteIntent).savedIntent
    manager.cancelAll()
    shadowOf(manager).setNotificationsEnabled(false)
    NotificationReceiver().onReceive(context, blocked)
    assertNull(card("other"))
  }

  @Test
  fun installBringsBackACardThatDisappeared() {
    at("07:00"); install(reminder())
    fire("07:45")
    manager.cancelAll()
    at("07:50"); install(reminder())
    assertEquals("Early 07:45", text())
    assertFalse(alerting(card()!!))
  }

  @Test
  fun cardsAreNotClosedWhenTheAppGoesAway() {
    at("07:00"); install(reminder())
    fire("07:45")
    at("07:50"); install(reminder())
    assertEquals("Early 07:45", text())
  }

  @Test
  fun anEarlyStageBeforeMidnightBelongsToTheNextDaysOccurrence() {
    at("22:00", "2026-10-01"); install(reminder(early = "23:40", due = "00:10"))
    assertEquals(ms("23:40", "2026-10-01"), armed("exact"))
    assertEquals(ms("00:10"), armed("alarm_clock"))
    fire("23:40", "2026-10-01")
    assertEquals("Early 23:40", text(date = day))
    assertNull(card(date = "2026-10-01"))
    fire("00:10")
    assertEquals("Due 00:10", text(date = day))
  }

  @Test
  fun aStageAfterMidnightKeepsItsOccurrenceDate() {
    at("22:00"); install(reminder(early = "23:00", due = "23:30", late = 60))
    fire("23:30")
    assertEquals(ms("00:30", "2026-10-03"), armed("alarm_clock"))
    fire("00:30", "2026-10-03")
    assertEquals("Late 60", text())
    assertTrue(alerting(card()!!))
  }

  @Test
  fun aStoreFromTheOlderFormatKeepsItsCardAndAlarms() {
    val legacy = reminder().apply {
      remove("at")
      put("stages", JSONArray()
        .put(JSONObject().put("at", "07:45").put("wake", "exact").put("text", "Early 07:45"))
        .put(JSONObject().put("at", "08:00").put("wake", "alarmClock").put("text", "Due 08:00")))
    }
    val id = NotificationEngine.occurrence(source, "item", day)
    val stored = JSONObject()
      .put("workspace", workspace).put("quiesced", false).put("processedUntil", ms("07:50"))
      .put("schedules", JSONObject().put(source, schedule(legacy)))
      .put("settledHere", JSONArray()).put("receipts", JSONArray())
      .put("cards", JSONObject().put(id, JSONObject().put("source", source).put("key", "item").put("date", day).put("stage", 0).put("at", "07:45").put("shownAt", ms("07:45"))))
      .put("snoozes", JSONObject()).put("alarms", JSONArray())
    File(context.noBackupFilesDir, "zero-notifications.json").writeText(stored.toString())
    at("07:50"); install(reminder())
    assertEquals("Early 07:45", text())
    assertEquals(ms("08:00"), armed("alarm_clock"))
    fire("08:00")
    assertEquals("Due 08:00", text())
  }

  @Test
  fun rebootBringsVisibleCardsBackQuietlyAndShowsTheNewestMissedStage() {
    at("07:00"); install(reminder(), reminder(key = "other", early = "06:00", due = "06:30"))
    fire("07:45")
    manager.cancelAll()
    for (alarm in shadowOf(alarms).scheduledAlarms.toList()) alarms.cancel(alarm.operation!!)
    at("09:00", "2026-10-04")
    NotificationEngine.restore(context, true)
    assertEquals("Early 07:45", text())
    assertFalse(alerting(card()!!))
    assertEquals("Due 08:00", text(date = "2026-10-04"))
    assertFalse(alerting(card(date = "2026-10-04")!!))
    assertEquals("Due 06:30", text("other", "2026-10-04"))
    assertNull(card(date = "2026-10-03"))
    assertEquals(ms("06:00", "2026-10-05"), armed("exact"))
  }

  @Test
  fun aSnoozeMissedWhileThePhoneWasOffReturnsQuietly() {
    at("09:00"); install(reminder(early = "09:50", due = "10:30"))
    fire("09:50")
    tap("Later")
    at("11:30")
    NotificationEngine.restore(context, true)
    assertEquals("Due 10:30", text())
    assertFalse(alerting(card()!!))
  }

  @Test
  fun timesFollowTheWallClockOfTheCurrentZone() {
    at("07:00"); install(reminder())
    zone = ZoneId.of("Europe/Berlin")
    at("07:00")
    NotificationEngine.restore(context, false)
    assertEquals(ms("08:00"), armed("alarm_clock"))
  }

  @Test
  fun aTimeInsideTheSpringGapMovesForward() {
    zone = ZoneId.of("Europe/Berlin")
    at("01:00", "2026-03-29")
    install(reminder(early = "02:15", due = "02:30", from = "2026-03-01"))
    assertEquals(Instant.parse("2026-03-29T01:30:00Z").toEpochMilli(), armed("alarm_clock"))
  }

  @Test
  fun independentOccurrencesKeepTheirOwnCards() {
    at("07:00"); install(reminder(), reminder(key = "other"))
    fire("07:45")
    tap("Done")
    fire("08:00")
    assertNull(card())
    assertEquals("Due 08:00", text("other"))
  }

  @Test
  fun anotherWorkspaceTakesOverUnlessActionsAreUnimported() {
    at("07:00"); install(reminder(), into = "previous")
    fire("07:45")
    install(reminder(key = "other"))
    assertNull(card())
    assertEquals(0, receipts().size)

    at("07:00", "2026-10-03"); install(reminder(), into = "third")
    fire("07:45", "2026-10-03")
    tap("Done", date = "2026-10-03")
    assertThrows(IllegalStateException::class.java) { install(reminder()) }
    assertEquals(2, JSONArray(NotificationEngine.receipts(context, "third", source)).length())
  }

  @Test
  fun quiesceClosesCardsAndRefusesSettleUntilTheNextInstall() {
    at("07:00"); install(reminder())
    fire("07:45")
    val done = button("Done")
    NotificationEngine.quiesce(context, workspace)
    assertNull(card())
    assertTrue(shadowOf(alarms).scheduledAlarms.isEmpty())
    NotificationReceiver().onReceive(context, done)
    assertTrue(receipts().none { it.getString("type") == "settled" })
    fire("08:00")
    assertNull(card())
    at("09:00"); install(reminder())
    assertNull(card())
    assertEquals(ms("07:45", "2026-10-03"), armed("exact"))
  }

  @Test
  fun settleFromTheAppChecksTheOccurrence() {
    at("07:00"); install(reminder(weekdays = listOf(5)))
    assertThrows(IllegalStateException::class.java) { NotificationEngine.settle(context, workspace, source, "missing", day, "done") }
    assertThrows(IllegalStateException::class.java) { NotificationEngine.settle(context, workspace, source, "item", "2026-10-03", "done") }
    assertThrows(IllegalStateException::class.java) { NotificationEngine.settle(context, workspace, source, "item", day, "later") }
    val first = NotificationEngine.settle(context, workspace, source, "item", day, "done")
    assertEquals(first, NotificationEngine.settle(context, workspace, source, "item", day, "done"))
  }

  @Test
  fun anInvalidScheduleIsRejectedAndChangesNothing() {
    at("07:00"); install(reminder())
    assertThrows(IllegalArgumentException::class.java) { NotificationEngine.install(context, workspace, source, "{\"channels\":[],\"reminders\":[]") }
    assertEquals(ms("08:00"), armed("alarm_clock"))
  }

  @Test
  fun disabledNotificationsShowNothingAndRecordNothing() {
    shadowOf(manager).setNotificationsEnabled(false)
    at("07:00"); install(reminder())
    fire("07:45")
    assertNull(card())
    assertEquals(0, receipts().size)
  }

  @Test
  fun regainedExactAlarmAccessArmsAgainWithoutTheApp() {
    ShadowAlarmManager.setCanScheduleExactAlarms(false)
    at("07:00"); install(reminder())
    assertTrue(shadowOf(alarms).scheduledAlarms.isEmpty())
    ShadowAlarmManager.setCanScheduleExactAlarms(true)
    NotificationEngine.restore(context, false)
    assertEquals(ms("08:00"), armed("alarm_clock"))
  }

  @Test
  fun stateStaysOutOfAndroidBackup() {
    at("07:00"); install(reminder())
    assertTrue(File(context.noBackupFilesDir, "zero-notifications.json").exists())
  }
}
