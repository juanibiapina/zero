package expo.modules.medicinereminders

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.provider.Settings
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MedicineNotificationsTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()
  private val manager: NotificationManager get() = context.getSystemService(NotificationManager::class.java)
  private fun dose() = JSONObject("""{"id":"dose","medicineId":"medicine","name":"Pill","alarmLabel":"20:00","instructions":"After food","kind":"alarm","stageAt":"2026-10-04T20:00:00Z"}""")

  @Test
  @org.robolectric.annotation.GraphicsMode(org.robolectric.annotation.GraphicsMode.Mode.NATIVE)
  fun remindersShowATwoHalfCapsuleOnATransparentBackground() {
    MedicineEngine.channels(context)
    val icon = MedicineEngine.notification(context, "workspace", dose(), true).smallIcon.loadDrawable(context)!!
    val bitmap = android.graphics.Bitmap.createBitmap(24, 24, android.graphics.Bitmap.Config.ARGB_8888)
    icon.setBounds(0, 0, 24, 24); icon.draw(android.graphics.Canvas(bitmap))
    for ((x, y) in listOf(7 to 17, 17 to 7)) assertEquals(255, android.graphics.Color.alpha(bitmap.getPixel(x, y)))
    for ((x, y) in listOf(0 to 0, 7 to 7, 17 to 17, 12 to 12)) assertEquals(0, android.graphics.Color.alpha(bitmap.getPixel(x, y)))
  }

  @Test
  fun normalRemindersAreAudibleVibratingDismissibleAndBridgeable() {
    MedicineEngine.channels(context)
    val notification = MedicineEngine.notification(context, "workspace", dose(), true)
    val channel = manager.getNotificationChannel(notification.channelId)
    assertEquals(NotificationManager.IMPORTANCE_HIGH, channel.importance)
    assertEquals(Settings.System.DEFAULT_NOTIFICATION_URI, channel.sound)
    assertEquals(AudioAttributes.USAGE_NOTIFICATION, channel.audioAttributes.usage)
    assertTrue(channel.shouldVibrate())
    assertEquals("Medicines", manager.getNotificationChannelGroup(channel.group).name)
    assertEquals(0, notification.flags and (Notification.FLAG_ONGOING_EVENT or Notification.FLAG_LOCAL_ONLY or Notification.FLAG_ONLY_ALERT_ONCE))
    assertNull(notification.fullScreenIntent)
    assertEquals(Notification.CATEGORY_REMINDER, notification.category)
    assertEquals("Taken", notification.actions.single().title)
    assertEquals("medicine.taken", shadowOf(notification.actions.single().actionIntent).savedIntent.action)
    assertEquals("medicine.dismissed", shadowOf(notification.deleteIntent).savedIntent.action)
    assertTrue(shadowOf(notification.contentIntent).savedIntent.data.toString().contains("/browse/medicines/medicine"))
    assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility)
    assertEquals("Medicine reminder", notification.publicVersion.extras.getString(Notification.EXTRA_TITLE))
  }

  @Test
  fun restoredCardsAreQuietWithoutChangingTheAudibleChannel() {
    MedicineEngine.channels(context)
    val restored = MedicineEngine.notification(context, "workspace", dose(), false)
    assertEquals(Notification.GROUP_ALERT_SUMMARY, restored.groupAlertBehavior)
    assertTrue(restored.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0)
    assertEquals(Settings.System.DEFAULT_NOTIFICATION_URI, manager.getNotificationChannel(restored.channelId).sound)
  }

  @Test
  fun aBlockedMedicinesGroupBlocksTheNewChannel() {
    MedicineEngine.channels(context)
    val group = manager.getNotificationChannelGroup("medicines")
    ReflectionHelpers.callInstanceMethod<Void>(group, "setBlocked", ReflectionHelpers.ClassParameter.from(Boolean::class.javaPrimitiveType!!, true))
    manager.createNotificationChannelGroup(group)
    assertEquals(false, MedicineEngine.capabilities(context)["alertChannel"])
  }

  @Test
  fun returningToTheAppPreservesUserSelectedChannelSound() {
    MedicineEngine.channels(context)
    val channel = manager.getNotificationChannel(MedicineEngine.ALERTS)
    channel.setSound(null, null)
    manager.createNotificationChannel(channel)
    MedicineEngine.channels(context)
    assertNull(manager.getNotificationChannel(MedicineEngine.ALERTS).sound)
  }
}
