package expo.modules.medicinereminders

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import org.junit.Assert.assertTrue
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MedicineNotificationsTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()
  private val manager: NotificationManager get() = context.getSystemService(NotificationManager::class.java)

  @Test
  fun aBlockedMedicinesGroupDisablesBothCategories() {
    MedicineEngine.channels(context)
    val group = manager.getNotificationChannelGroup("medicines")
    ReflectionHelpers.callInstanceMethod<Void>(group, "setBlocked", ReflectionHelpers.ClassParameter.from(Boolean::class.javaPrimitiveType!!, true))
    manager.createNotificationChannelGroup(group)
    val capabilities = MedicineEngine.capabilities(context)
    assertEquals(false, capabilities["quietChannel"])
    assertEquals(false, capabilities["alarmChannel"])
  }

  @Test
  fun aPendingReminderStaysVisibleAndOffersTaken() {
    MedicineEngine.channels(context)
    val dose = JSONObject("""{"id":"dose","medicineId":"medicine","name":"Pill","alarmLabel":"20:00","instructions":"After food"}""")
    val notification = MedicineEngine.notification(context, "workspace", dose, false)
    assertTrue(notification.flags and Notification.FLAG_ONGOING_EVENT != 0)
    assertEquals(Notification.CATEGORY_REMINDER, notification.category)
    assertEquals("Taken", notification.actions.single().title)
    val channel = manager.getNotificationChannel(notification.channelId)
    assertEquals(null, channel.sound)
    assertEquals(false, channel.shouldVibrate())
  }

  @Test
  fun medicineCategoriesAreTogetherInAndroidSettings() {
    MedicineEngine.channels(context)
    val reminder = manager.getNotificationChannel(MedicineEngine.QUIET)
    val alarm = manager.getNotificationChannel(MedicineEngine.RING)
    assertEquals("Medicines", manager.getNotificationChannelGroup(reminder.group)?.name)
    assertEquals(reminder.group, alarm.group)
  }

  @Test
  fun earlyRemindersHaveProminentDefaults() {
    MedicineEngine.channels(context)
    assertEquals(NotificationManager.IMPORTANCE_HIGH, manager.getNotificationChannel(MedicineEngine.QUIET).importance)
  }
}
