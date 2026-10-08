package expo.modules.zeronotifications

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowAlarmManager
import org.robolectric.util.ReflectionHelpers
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NotificationCardTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()
  private val manager: NotificationManager get() = context.getSystemService(NotificationManager::class.java)
  private val day = "2026-10-02"
  private fun schedule(channelName: String = "Alerts", fullScreen: Boolean = false) = JSONObject()
    .put("channels", JSONArray().put(JSONObject().put("id", "alerts").put("name", channelName).put("group", JSONObject().put("id", "group").put("name", "Group"))))
    .put("reminders", JSONArray().put(JSONObject()
      .put("key", "item").put("channel", "alerts").put("icon", "pill").put("title", "Title")
      .put("lockScreen", JSONObject().put("title", "Reminder").put("text", "Open the app"))
      .put("url", "app:///items/item?date={date}")
      .put("recurrence", JSONObject().put("from", "2026-09-01").put("until", JSONObject.NULL).put("weekdays", JSONArray((1..7).toList())))
      .put("stages", JSONArray().put(JSONObject().put("at", "08:00").put("wake", "alarmClock").put("text", "Due").also { if (fullScreen) it.put("fullScreen", true) }))
      .put("actions", JSONArray()
        .put(JSONObject().put("id", "done").put("label", "Done").put("kind", "settle"))
        .put(JSONObject().put("id", "later").put("label", "Later").put("kind", "snooze").put("minutes", 60)))
      .put("settled", JSONArray()).put("data", ""))).toString()
  private fun at(time: String) { NotificationEngine.clock = { Clock.fixed(Instant.parse("${day}T${time}:00Z"), ZoneOffset.UTC) } }
  private fun card(): Notification = shadowOf(manager).getNotification(NotificationEngine.occurrence("source", "item", day), 0)

  @Before
  fun showACard() {
    ShadowAlarmManager.setCanScheduleExactAlarms(true)
    NotificationEngine.canUseFullScreen = { true }
    at("07:00")
    NotificationEngine.install(context, "workspace", "source", schedule())
    at("08:00")
    NotificationEngine.wake(context)
  }

  @After
  fun restoreClock() { NotificationEngine.clock = { Clock.systemDefaultZone() } }

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun thePillIconIsATwoHalfCapsuleOnATransparentBackground() {
    val icon = card().smallIcon.loadDrawable(context)!!
    val bitmap = android.graphics.Bitmap.createBitmap(24, 24, android.graphics.Bitmap.Config.ARGB_8888)
    icon.setBounds(0, 0, 24, 24); icon.draw(android.graphics.Canvas(bitmap))
    for ((x, y) in listOf(7 to 17, 17 to 7)) assertEquals(255, android.graphics.Color.alpha(bitmap.getPixel(x, y)))
    for ((x, y) in listOf(0 to 0, 7 to 7, 17 to 17, 12 to 12)) assertEquals(0, android.graphics.Color.alpha(bitmap.getPixel(x, y)))
  }

  @Test
  fun cardsAreAudibleVibratingDismissibleAndBridgeable() {
    val notification = card()
    val channel = manager.getNotificationChannel(notification.channelId)
    assertEquals(NotificationManager.IMPORTANCE_HIGH, channel.importance)
    assertEquals(Settings.System.DEFAULT_NOTIFICATION_URI, channel.sound)
    assertEquals(AudioAttributes.USAGE_NOTIFICATION, channel.audioAttributes.usage)
    assertTrue(channel.shouldVibrate())
    assertEquals("Group", manager.getNotificationChannelGroup(channel.group).name)
    assertEquals(0, notification.flags and (Notification.FLAG_ONGOING_EVENT or Notification.FLAG_LOCAL_ONLY or Notification.FLAG_ONLY_ALERT_ONCE))
    assertNull(notification.fullScreenIntent)
    assertEquals(Notification.CATEGORY_REMINDER, notification.category)
    assertEquals(listOf("Done", "Later"), notification.actions.map { it.title.toString() })
    assertEquals(NotificationEngine.DISMISS, shadowOf(notification.deleteIntent).savedIntent.action)
    assertEquals("app:///items/item?date=$day", shadowOf(notification.contentIntent).savedIntent.data.toString())
    assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility)
    assertEquals("Reminder", notification.publicVersion.extras.getString(Notification.EXTRA_TITLE))
    assertEquals("Open the app", notification.publicVersion.extras.getString(Notification.EXTRA_TEXT))
  }

  private fun showFullScreenCard() {
    manager.cancelAll()
    at("07:00")
    NotificationEngine.install(context, "workspace", "source", schedule(fullScreen = true))
    at("08:00")
    NotificationEngine.wake(context)
  }

  @Test
  fun anAlertingFullScreenStageOpensTheReminderScreen() {
    NotificationEngine.clear(context, "workspace")
    showFullScreenCard()
    val screen = shadowOf(card().fullScreenIntent).savedIntent
    assertEquals(ReminderScreenActivity::class.java.name, screen.component?.className)
    assertEquals(listOf("workspace", "source", "item", day), listOf("workspace", "source", "key", "date").map { screen.getStringExtra(it) })
    assertEquals(NotificationEngine.screen(context, "workspace", "source", "item", day, screen.getLongExtra("shownAt", -1))?.text, "Due")
  }

  @Test
  fun aRestoredFullScreenCardOpensNoScreen() {
    NotificationEngine.clear(context, "workspace")
    showFullScreenCard()
    manager.cancelAll()
    NotificationEngine.restore(context, true)
    assertNull(card().fullScreenIntent)
  }

  @Test
  fun withoutFullScreenAccessTheCardStillArrives() {
    NotificationEngine.clear(context, "workspace")
    NotificationEngine.canUseFullScreen = { false }
    showFullScreenCard()
    assertNull(card().fullScreenIntent)
    assertEquals("Due", card().extras.getString(Notification.EXTRA_TEXT))
    assertEquals(false, NotificationEngine.capabilities(context)["fullScreen"])
  }

  @Test
  fun restoredCardsAreQuietWithoutChangingTheAudibleChannel() {
    manager.cancelAll()
    NotificationEngine.restore(context, true)
    val restored = card()
    assertEquals(Notification.GROUP_ALERT_SUMMARY, restored.groupAlertBehavior)
    assertTrue(restored.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)
    assertEquals(Settings.System.DEFAULT_NOTIFICATION_URI, manager.getNotificationChannel(restored.channelId).sound)
  }

  @Test
  fun aBlockedGroupBlocksItsChannel() {
    val group = manager.getNotificationChannelGroup("group")
    ReflectionHelpers.callInstanceMethod<Void>(group, "setBlocked", ReflectionHelpers.ClassParameter.from(Boolean::class.javaPrimitiveType!!, true))
    manager.createNotificationChannelGroup(group)
    @Suppress("UNCHECKED_CAST")
    assertEquals(false, (NotificationEngine.capabilities(context)["channels"] as Map<String, Boolean>)["alerts"])
  }

  @Test
  fun reinstallingKeepsTheUserSoundAndRenamesTheChannel() {
    val channel = manager.getNotificationChannel("alerts")
    channel.setSound(null, null)
    manager.createNotificationChannel(channel)
    NotificationEngine.install(context, "workspace", "source", schedule("Renamed"))
    assertNull(manager.getNotificationChannel("alerts").sound)
    assertEquals("Renamed", manager.getNotificationChannel("alerts").name)
  }
}
