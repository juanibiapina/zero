package expo.modules.zeronotifications

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAlarmManager
import java.io.File
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ReminderScreenActivityTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()
  private val manager: NotificationManager get() = context.getSystemService(NotificationManager::class.java)
  private val day = "2026-10-02"
  private var playing = false
  private var plays = 0
  private val schedule = JSONObject()
    .put("channels", JSONArray().put(JSONObject().put("id", "alerts").put("name", "Alerts").put("group", JSONObject().put("id", "group").put("name", "Group"))))
    .put("reminders", JSONArray().put(JSONObject()
      .put("key", "item").put("channel", "alerts").put("icon", "pill").put("title", "Vitamin D")
      .put("lockScreen", JSONObject().put("title", "Reminder").put("text", "Open the app"))
      .put("url", "app:///items/item?date={date}")
      .put("recurrence", JSONObject().put("from", "2026-09-01").put("until", JSONObject.NULL).put("weekdays", JSONArray((1..7).toList())))
      .put("at", "08:00")
      .put("stages", JSONArray().put(JSONObject().put("offset", 0).put("wake", "alarmClock").put("text", "08:00 dose due").put("fullScreen", true)))
      .put("actions", JSONArray()
        .put(JSONObject().put("id", "taken").put("label", "Taken").put("kind", "settle"))
        .put(JSONObject().put("id", "later").put("label", "Postpone 1 hour").put("kind", "snooze").put("minutes", 60))
        .put(JSONObject().put("id", "skip").put("label", "Skip").put("kind", "settle")))
      .put("settled", JSONArray()).put("data", ""))).toString()

  private fun at(time: String) { NotificationEngine.clock = { Clock.fixed(Instant.parse("${day}T${time}:00Z"), ZoneOffset.UTC) } }
  private fun screenIntent(): Intent =
    shadowOf(shadowOf(manager).getNotification(NotificationEngine.occurrence("source", "item", day), 0).fullScreenIntent).savedIntent
  private fun open(intent: Intent = screenIntent()): ActivityController<ReminderScreenActivity> = Robolectric.buildActivity(ReminderScreenActivity::class.java, intent).setup()
  private fun idle(duration: Duration = Duration.ZERO) = shadowOf(Looper.getMainLooper()).idleFor(duration)
  private fun texts(view: View): List<String> = when (view) {
    is ViewGroup -> (0 until view.childCount).flatMap { texts(view.getChildAt(it)) }
    is TextView -> listOf(view.text.toString()).filter { it.isNotEmpty() && view.visibility == View.VISIBLE }
    else -> emptyList()
  }
  private fun button(activity: ReminderScreenActivity, label: String): Button {
    fun find(view: View): Button? = when {
      view is Button && view.text.toString() == label -> view
      view is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { find(view.getChildAt(it)) }
      else -> null
    }
    return requireNotNull(find(activity.window.decorView)) { "No button $label" }
  }
  private fun receipts() = JSONArray(NotificationEngine.receipts(context, "workspace", "source")).let { list -> (0 until list.length()).map { list.getJSONObject(it) } }

  @Before
  fun showAFullScreenCard() {
    ShadowAlarmManager.setCanScheduleExactAlarms(true)
    NotificationEngine.canUseFullScreen = { true }
    ReminderScreenActivity.alarmSound = {
      object : AlarmSound {
        override fun play() { playing = true; plays++ }
        override fun stop() { playing = false }
      }
    }
    at("07:00")
    NotificationEngine.install(context, "workspace", "source", schedule)
    at("08:00")
    NotificationEngine.wake(context)
  }

  @After
  fun restore() {
    NotificationEngine.clock = { Clock.systemDefaultZone() }
    File(context.noBackupFilesDir, NotificationEngine.SILENT_FILE).delete()
  }

  @Test
  fun showsTheCardAndRings() {
    val activity = open().get()
    assertEquals(listOf("Vitamin D", "08:00 dose due", "Silence", "Postpone 1 hour", "Skip", "Taken"), texts(activity.window.decorView))
    assertTrue(playing)
  }

  @Test
  fun silenceStopsTheSoundAndKeepsTheScreen() {
    val activity = open().get()
    button(activity, "Silence").performClick()
    idle()
    assertFalse(playing)
    assertFalse(activity.isFinishing)
    assertEquals(listOf("Vitamin D", "08:00 dose due", "Postpone 1 hour", "Skip", "Taken"), texts(activity.window.decorView))
    assertTrue(receipts().none { it.getString("type") == "settled" })
    assertTrue(shadowOf(manager).getNotification(NotificationEngine.occurrence("source", "item", day), 0) != null)
    button(activity, "Taken").performClick()
    idle()
    assertEquals(listOf("settled"), receipts().map { it.getString("type") }.filter { it == "settled" })
    assertTrue(activity.isFinishing)
  }

  @Test
  fun stopsRingingAfterAMinuteAndStaysOpen() {
    val activity = open().get()
    idle(Duration.ofSeconds(59))
    assertTrue(playing)
    idle(Duration.ofSeconds(1))
    assertFalse(playing)
    assertFalse(activity.isFinishing)
    assertFalse("Silence" in texts(activity.window.decorView))
  }

  @Test
  fun leavingTheScreenStopsTheSoundForGood() {
    val controller = open()
    controller.pause().stop()
    assertFalse(playing)
    controller.restart().resume()
    assertFalse(playing)
    assertEquals(1, plays)
  }

  @Test
  fun aSilencedWorkspaceNeverRings() {
    context.applicationInfo.flags = context.applicationInfo.flags or ApplicationInfo.FLAG_DEBUGGABLE
    NotificationEngine.silence(context, "workspace")
    val activity = open().get()
    assertEquals(0, plays)
    assertFalse("Silence" in texts(activity.window.decorView))
  }

  @Test
  fun takenSettlesTheOccurrenceAndCloses() {
    val activity = open().get()
    button(activity, "Taken").performClick()
    idle()
    assertEquals(listOf("settled"), receipts().map { it.getString("type") }.filter { it == "settled" })
    assertEquals(null, shadowOf(manager).getNotification(NotificationEngine.occurrence("source", "item", day), 0))
    assertFalse(playing)
    assertTrue(activity.isFinishing)
  }

  @Test
  fun postponeClosesTheScreenAndKeepsTheCard() {
    val activity = open().get()
    button(activity, "Postpone 1 hour").performClick()
    idle()
    assertTrue(receipts().none { it.getString("type") == "settled" })
    assertTrue(shadowOf(manager).getNotification(NotificationEngine.occurrence("source", "item", day), 0) != null)
    assertFalse(playing)
    assertTrue(activity.isFinishing)
  }

  @Test
  fun aStaleCardOpensNothing() {
    val activity = open(screenIntent().putExtra("shownAt", -1L)).get()
    assertTrue(activity.isFinishing)
    assertEquals(0, plays)
  }

  @Test
  fun takenElsewhereClosesTheScreen() {
    val activity = open().get()
    NotificationEngine.settle(context, "workspace", "source", "item", day, "taken")
    idle()
    assertFalse(playing)
    assertTrue(activity.isFinishing)
  }
}
