package expo.modules.medicinereminders

import android.Manifest
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.time.*
import java.time.format.DateTimeFormatter
import java.util.UUID

internal object MedicineEngine {
  const val QUIET = "medicine-reminders"
  const val RING = "medicine-alarms-v1"
  private const val GROUP = "medicines"
  private const val PREFS = "medicine-reminders-v1"
  private val lock = Any()
  private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  private fun load(c: Context): JSONObject = JSONObject(prefs(c).getString("state", "{}") ?: "{}")
  private fun save(c: Context, state: JSONObject) { check(prefs(c).edit().putString("state", state.toString()).commit()) { "Reminder storage failed" } }
  private fun array(state: JSONObject, key: String): JSONArray = state.optJSONArray(key) ?: JSONArray().also { state.put(key, it) }
  private fun obj(state: JSONObject, key: String): JSONObject = state.optJSONObject(key) ?: JSONObject().also { state.put(key, it) }
  private fun instant(ms: Long) = Instant.ofEpochMilli(ms).toString()
  private fun key(medicine: String, slot: String, day: String) = JSONArray(listOf(medicine, slot, day)).toString()
  private fun alarmManager(c: Context) = c.getSystemService(AlarmManager::class.java)
  private fun notificationManager(c: Context) = c.getSystemService(NotificationManager::class.java)
  private fun groupEnabled(c: Context) = Build.VERSION.SDK_INT < 28 || notificationManager(c).getNotificationChannelGroup(GROUP)?.isBlocked != true

  fun silenceProof(c: Context) {
    check(c.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) { "Proof requires a debug build" }
    check(prefs(c).edit().putBoolean("silentProof", true).commit())
  }
  fun proofMuted(c: Context): Boolean = c.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0 &&
    load(c).optString("workspace") == "taskdo-workspace-medicine-proof.sqlite" && prefs(c).getBoolean("silentProof", false)

  fun capabilities(c: Context): Map<String, Any> {
    channels(c)
    val manager = notificationManager(c)
    return mapOf("supported" to true, "notifications" to manager.areNotificationsEnabled(),
      "exactAlarms" to (Build.VERSION.SDK_INT < 31 || alarmManager(c).canScheduleExactAlarms()),
      "alarmVolume" to c.getSystemService(android.media.AudioManager::class.java).getStreamVolume(android.media.AudioManager.STREAM_ALARM),
      "quietChannelImportance" to (manager.getNotificationChannel(QUIET)?.importance ?: NotificationManager.IMPORTANCE_NONE),
      "quietChannel" to (groupEnabled(c) && manager.getNotificationChannel(QUIET)?.importance != NotificationManager.IMPORTANCE_NONE),
      "alarmChannel" to (groupEnabled(c) && manager.getNotificationChannel(RING)?.importance != NotificationManager.IMPORTANCE_NONE))
  }
  fun channels(c: Context) {
    val manager = notificationManager(c)
    if (manager.getNotificationChannelGroup(GROUP) == null) manager.createNotificationChannelGroup(NotificationChannelGroup(GROUP, "Medicines"))
    manager.createNotificationChannel(NotificationChannel(QUIET, "Medicine reminders", NotificationManager.IMPORTANCE_HIGH).apply {
      group = GROUP
      setSound(null, null)
      enableVibration(false)
    })
    manager.createNotificationChannel(NotificationChannel(RING, "Medicine alarms", NotificationManager.IMPORTANCE_HIGH).apply { group = GROUP; setSound(null, null) })
  }
  fun receipts(c: Context, workspace: String): String = synchronized(lock) {
    val state = load(c)
    if (state.optString("workspace") != workspace) "[]" else array(state, "receipts").toString()
  }
  fun acknowledge(c: Context, workspace: String, ids: String) = synchronized(lock) {
    val state = load(c)
    if (state.optString("workspace") != workspace) return@synchronized
    val idsArray = JSONArray(ids); val consumed = (0 until idsArray.length()).map { idsArray.getString(it) }.toSet()
    val remaining = JSONArray(); val receipts = array(state, "receipts")
    for (i in 0 until receipts.length()) if (!consumed.contains(receipts.getJSONObject(i).getString("actionId"))) remaining.put(receipts.getJSONObject(i))
    state.put("receipts", remaining); save(c, state)
  }
  fun replace(c: Context, workspace: String, payload: String) = synchronized(lock) {
    channels(c)
    val state = load(c)
    check(state.optString("workspace", workspace) == workspace || array(state, "medicines").length() == 0) { "Another workspace owns reminders" }
    cancelIntents(c, state)
    state.put("workspace", workspace); state.put("quiesced", false)
    val plans = JSONObject(payload)
    state.put("medicines", plans.getJSONArray("medicines")); state.put("confirmed", plans.getJSONArray("confirmed"))
    val suppressed = JSONObject()
    val confirmed = array(state, "confirmed")
    for (i in 0 until confirmed.length()) suppressed.put(confirmed.getString(i), true)
    val processed = plans.optJSONArray("processedActions") ?: JSONArray()
    val processedIds = (0 until processed.length()).map { processed.getString(it) }.toSet()
    val queued = array(state, "receipts")
    for (i in 0 until queued.length()) {
      val receipt = queued.getJSONObject(i)
      if (receipt.getString("kind") == "taken" && !processedIds.contains(receipt.getString("actionId"))) suppressed.put(receipt.getString("id"), true)
    }
    state.put("suppressed", suppressed); state.put("generation", UUID.randomUUID().toString())
    // Remove notifications and sound for confirmations or removed definitions.
    val visible = obj(state, "visible")
    for (id in visible.keys().asSequence().toList()) {
      val occurrence = visible.getJSONObject(id)
      if (suppressed.optBoolean(id) || !eligible(state, occurrence) || !currentAlarm(state, occurrence)) {
        notificationManager(c).cancel(id, 0); visible.remove(id); MedicineAlarmService.remove(c, id)
      }
    }
    save(c, state)
    schedule(c, state)
  }
  fun quiesce(c: Context, workspace: String) = synchronized(lock) {
    val state = load(c); if (state.optString("workspace") != workspace) return@synchronized
    state.put("quiesced", true); cancelIntents(c, state)
    for (id in obj(state, "visible").keys()) notificationManager(c).cancel(id, 0)
    state.put("visible", JSONObject())
    MedicineAlarmService.stopAll(c); save(c, state)
  }
  fun clear(c: Context, workspace: String) = synchronized(lock) {
    val state = load(c); if (state.optString("workspace") != workspace) return@synchronized
    cancelIntents(c, state)
    for (id in obj(state, "visible").keys()) notificationManager(c).cancel(id, 0)
    MedicineAlarmService.stopAll(c); check(prefs(c).edit().remove("state").commit())
  }
  fun taken(c: Context, workspace: String, occurrence: String): String = synchronized(lock) {
    val state = load(c); check(state.optString("workspace") == workspace && !state.optBoolean("quiesced")) { "Reminder workspace is closed" }
    val dose = JSONObject(occurrence)
    check(eligible(state, dose)) { "This medicine reminder is no longer active" }
    val id = dose.getString("id")
    val receipt = JSONObject(dose.toString()).put("kind", "taken").put("actionId", UUID.randomUUID().toString()).put("takenAt", instant(System.currentTimeMillis()))
    array(state, "receipts").put(receipt); obj(state, "suppressed").put(id, true)
    obj(state, "visible").remove(id); save(c, state)
    notificationManager(c).cancel(id, 0); MedicineAlarmService.remove(c, id)
    cancelIntents(c, state); schedule(c, state)
    receipt.toString()
  }
  fun undo(c: Context, workspace: String, id: String) = synchronized(lock) {
    val state = load(c); check(state.optString("workspace") == workspace && !state.optBoolean("quiesced"))
    obj(state, "suppressed").remove(id); save(c, state)
  }
  private fun eligible(state: JSONObject, dose: JSONObject): Boolean {
    val medicines = array(state, "medicines")
    for (i in 0 until medicines.length()) {
      val m = medicines.getJSONObject(i)
      if (m.getString("id") != dose.getString("medicineId")) continue
      if (m.optBoolean("paused")) return false
      val day = dose.getString("on")
      if (day < m.getString("startsOn") || (!m.isNull("endsOn") && day > m.getString("endsOn"))) return false
      val slots = m.getJSONArray("doses")
      return (0 until slots.length()).any { slots.getJSONObject(it).getString("id") == dose.getString("slotId") }
    }
    return false
  }
  private fun currentAlarm(state: JSONObject, dose: JSONObject): Boolean {
    val medicines = array(state, "medicines")
    for (i in 0 until medicines.length()) {
      val medicine = medicines.getJSONObject(i)
      if (medicine.getString("id") != dose.getString("medicineId")) continue
      val slots = medicine.getJSONArray("doses")
      for (j in 0 until slots.length()) {
        val slot = slots.getJSONObject(j)
        if (slot.getString("id") == dose.getString("slotId")) return slot.getString("alarmAt") == dose.optString("alarmLabel")
      }
    }
    return false
  }
  fun canRing(c: Context, dose: JSONObject): Boolean = synchronized(lock) {
    val state = load(c)
    notificationManager(c).areNotificationsEnabled() && groupEnabled(c) && notificationManager(c).getNotificationChannel(RING)?.importance != NotificationManager.IMPORTANCE_NONE && !state.optBoolean("quiesced") && eligible(state, dose) && currentAlarm(state, dose) && dose.getString("on") == LocalDate.now().toString() && !obj(state, "suppressed").optBoolean(dose.getString("id"))
  }
  fun restore(c: Context, notificationsLost: Boolean = false) = synchronized(lock) {
    val state = load(c)
    if (state.optBoolean("quiesced")) return@synchronized
    if (notificationsLost) state.put("visible", JSONObject())
    cancelIntents(c, state); schedule(c, state)
  }
  private fun intent(c: Context, identity: String, extras: JSONObject): PendingIntent {
    val receiver = Intent(c, MedicineReceiver::class.java).setAction("medicine.delivery").setData(Uri.parse("zero-medicine:${Uri.encode(identity)}")).putExtra("payload", extras.toString())
    return PendingIntent.getBroadcast(c, 0, receiver, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }
  private fun cancelIntents(c: Context, state: JSONObject) {
    val scheduled = array(state, "scheduled")
    for (i in 0 until scheduled.length()) {
      val item = scheduled.getJSONObject(i)
      alarmManager(c).cancel(intent(c, item.getString("identity"), item))
    }
    state.put("scheduled", JSONArray())
  }
  private fun schedule(c: Context, state: JSONObject) {
    if (state.optBoolean("quiesced")) return
    val manager = alarmManager(c)
    if (Build.VERSION.SDK_INT >= 31 && !manager.canScheduleExactAlarms()) { save(c, state); return }
    val now = System.currentTimeMillis(); val zone = ZoneId.systemDefault(); val today = LocalDate.now(zone)
    val scheduled = JSONArray(); state.put("scheduled", scheduled)
    fun arm(identity: String, time: Long, data: JSONObject) {
      data.put("identity", identity).put("generation", state.optString("generation")).put("workspace", state.optString("workspace"))
      scheduled.put(data)
      // Persist cancellation identity before creating the OS alarm.
      save(c, state)
      val delivery = intent(c, identity, data)
      if (data.getString("kind") == "alarm") {
        val show = PendingIntent.getActivity(c, 0, c.packageManager.getLaunchIntentForPackage(c.packageName), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        manager.setAlarmClock(AlarmManager.AlarmClockInfo(time, show), delivery)
      } else manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, time, delivery)
    }
    val visible = obj(state, "visible")
    for (id in visible.keys().asSequence().toList()) if (visible.getJSONObject(id).getString("on") < today.toString()) { notificationManager(c).cancel(id, 0); visible.remove(id); MedicineAlarmService.remove(c, id) }
    val medicines = array(state, "medicines")
    for (i in 0 until medicines.length()) {
      val m = medicines.getJSONObject(i); if (m.optBoolean("paused")) continue
      val start = LocalDate.parse(m.getString("startsOn")); val end = if (m.isNull("endsOn")) null else LocalDate.parse(m.getString("endsOn"))
      val slots = m.getJSONArray("doses")
      for (j in 0 until slots.length()) {
        val slot = slots.getJSONObject(j)
        var day = if (start > today) start else today
        // Only today's and the next eligible day's intents are needed; firing
        // and midnight both restore definitions for subsequent days.
        for (attempt in 0..1) {
          if (end != null && day > end) break
          val id = key(m.getString("id"), slot.getString("id"), day.toString())
          if (!obj(state, "suppressed").optBoolean(id)) {
            val alarmAt = day.atTime(LocalTime.parse(slot.getString("alarmAt"))).atZone(zone).toInstant().toEpochMilli()
            val remindAt = day.atTime(LocalTime.parse(slot.getString("remindAt"))).atZone(zone).toInstant().toEpochMilli()
            val dose = JSONObject().put("id", id).put("medicineId", m.getString("id")).put("slotId", slot.getString("id")).put("on", day.toString()).put("scheduledAt", instant(alarmAt)).put("takenAt", JSONObject.NULL).put("name", m.getString("name")).put("instructions", if (m.isNull("instructions")) "" else m.optString("instructions", "")).put("alarmLabel", slot.getString("alarmAt"))
            if (alarmAt > now) {
              arm("$id/alarm", alarmAt, JSONObject(dose.toString()).put("kind", "alarm"))
              if (remindAt > now) arm("$id/reminder", remindAt, JSONObject(dose.toString()).put("kind", "reminder"))
              else if (!visible.has(id)) show(c, state, dose, false)
              break
            }
          }
          day = day.plusDays(1)
        }
      }
    }
    if (scheduled.length() > 0 || visible.length() > 0) arm("midnight", today.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli(), JSONObject().put("kind", "midnight"))
    save(c, state)
  }
  fun deliver(c: Context, payload: String) = synchronized(lock) {
    val state = load(c); val dose = JSONObject(payload)
    if (state.optBoolean("quiesced") || dose.optString("generation") != state.optString("generation") || dose.optString("workspace") != state.optString("workspace")) return@synchronized
    if (dose.getString("kind") != "midnight" && eligible(state, dose) && !obj(state, "suppressed").optBoolean(dose.getString("id")) && dose.getString("on") == LocalDate.now().toString()) show(c, state, dose, dose.getString("kind") == "alarm")
    cancelIntents(c, state); schedule(c, state)
  }
  private fun show(c: Context, state: JSONObject, dose: JSONObject, ringing: Boolean) {
    if (!notificationManager(c).areNotificationsEnabled() || !groupEnabled(c)) return
    channels(c)
    if (notificationManager(c).getNotificationChannel(if (ringing) RING else QUIET)?.importance == NotificationManager.IMPORTANCE_NONE) return
    val id = dose.getString("id")
    obj(state, "visible").put(id, dose)
    array(state, "receipts").put(JSONObject(dose.toString()).put("actionId", UUID.randomUUID().toString()).put("kind", "presented").put("takenAt", JSONObject.NULL))
    save(c, state)
    notificationManager(c).notify(id, 0, notification(c, state.optString("workspace"), dose, ringing))
    if (ringing) {
      val service = Intent(c, MedicineAlarmService::class.java).putExtra("dose", dose.toString()).putExtra("workspace", state.optString("workspace"))
      c.startForegroundService(service)
    }
  }
  fun notification(c: Context, workspace: String, dose: JSONObject, ringing: Boolean): Notification {
    val id = dose.getString("id")
    val open = Intent(Intent.ACTION_VIEW, Uri.parse("zeroagent:///browse/medicines/${Uri.encode(dose.getString("medicineId"))}?dose=${Uri.encode(id)}")).setPackage(c.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val openPending = PendingIntent.getActivity(c, id.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val taken = Intent(c, MedicineReceiver::class.java).setAction("medicine.taken").setData(Uri.parse("zero-medicine:taken/${Uri.encode(id)}")).putExtra("workspace", workspace).putExtra("payload", dose.toString())
    val takenPending = PendingIntent.getBroadcast(c, 0, taken, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    return Notification.Builder(c, if (ringing) RING else QUIET).setSmallIcon(android.R.drawable.ic_lock_idle_alarm).setContentTitle(dose.getString("name"))
      .setContentText(if (ringing) "${dose.getString("alarmLabel")} dose not recorded" else listOf(dose.optString("instructions", ""), "Alarm at ${dose.getString("alarmLabel")}").filter { it.isNotBlank() }.joinToString(" · "))
      .setContentIntent(openPending).setCategory(if (ringing) Notification.CATEGORY_ALARM else Notification.CATEGORY_REMINDER).setOngoing(!ringing).setOnlyAlertOnce(true)
      .addAction(Notification.Action.Builder(null, "Taken", takenPending).build()).build()
  }
}

class MedicineReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    try {
      when (intent.action) {
        "medicine.taken" -> MedicineEngine.taken(context, intent.getStringExtra("workspace") ?: return, intent.getStringExtra("payload") ?: return)
        "medicine.delivery" -> MedicineEngine.deliver(context, intent.getStringExtra("payload") ?: return)
        else -> MedicineEngine.restore(context, intent.action == Intent.ACTION_BOOT_COMPLETED)
      }
    } catch (error: Exception) { android.util.Log.e("MedicineReminders", "Native reminder operation failed", error) }
  }
}
