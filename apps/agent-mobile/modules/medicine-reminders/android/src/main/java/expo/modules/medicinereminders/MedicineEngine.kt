package expo.modules.medicinereminders

import android.app.*
import android.content.*
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.time.*
import java.util.UUID

internal object MedicineEngine {
  const val ALERTS = "medicine-alerts-v2"
  private const val PROOF = "medicine-proof-v2"
  private const val GROUP = "medicines"
  private const val PREFS = "medicine-reminders-v1"
  private val lock = Any()
  internal var clock: () -> Clock = { Clock.systemDefaultZone() }
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
    channels(c)
    notificationManager(c).createNotificationChannel(NotificationChannel(PROOF, "Medicine test notifications", NotificationManager.IMPORTANCE_HIGH).apply {
      group = GROUP; setSound(null, null); enableVibration(false)
    })
  }
  private fun proofMuted(c: Context, workspace: String): Boolean = c.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0 &&
    workspace == "taskdo-workspace-medicine-proof.sqlite" && prefs(c).getBoolean("silentProof", false)

  fun capabilities(c: Context): Map<String, Any> {
    channels(c)
    val manager = notificationManager(c)
    val channel = manager.getNotificationChannel(ALERTS)
    return mapOf("notifications" to manager.areNotificationsEnabled(),
      "exactAlarms" to (Build.VERSION.SDK_INT < 31 || alarmManager(c).canScheduleExactAlarms()),
      "alertChannel" to (groupEnabled(c) && channel.importance != NotificationManager.IMPORTANCE_NONE),
      "backgroundRestricted" to (Build.VERSION.SDK_INT >= 28 && c.getSystemService(ActivityManager::class.java).isBackgroundRestricted))
  }
  fun channels(c: Context) = synchronized(lock) {
    val manager = notificationManager(c)
    if (manager.getNotificationChannelGroup(GROUP) == null) manager.createNotificationChannelGroup(NotificationChannelGroup(GROUP, "Medicines"))
    if (manager.getNotificationChannel(ALERTS) == null) {
      manager.createNotificationChannel(NotificationChannel(ALERTS, "Medicine reminders", NotificationManager.IMPORTANCE_HIGH).apply {
        group = GROUP
        setSound(Settings.System.DEFAULT_NOTIFICATION_URI, AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        enableVibration(true)
      })
    }
  }
  fun receipts(c: Context, workspace: String): String = synchronized(lock) {
    val state = load(c)
    if (state.optString("workspace") != workspace) "[]" else array(state, "receipts").toString()
  }
  fun acknowledge(c: Context, workspace: String, ids: List<String>) = synchronized(lock) {
    val state = load(c)
    if (state.optString("workspace") != workspace) return@synchronized
    val consumed = ids.toSet()
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
    val visible = obj(state, "visible")
    for (id in visible.keys().asSequence().toList()) {
      val occurrence = visible.getJSONObject(id)
      if (suppressed.optBoolean(id) || !eligible(state, occurrence) || !currentDose(state, occurrence)) {
        notificationManager(c).cancel(id, 0); visible.remove(id)
      }
    }
    save(c, state)
    schedule(c, state)
  }
  fun quiesce(c: Context, workspace: String) = synchronized(lock) {
    val state = load(c); if (state.optString("workspace") != workspace) return@synchronized
    state.put("quiesced", true); cancelIntents(c, state)
    for (id in obj(state, "visible").keys()) notificationManager(c).cancel(id, 0)
    state.put("visible", JSONObject()); save(c, state)
  }
  fun clear(c: Context, workspace: String) = synchronized(lock) {
    val state = load(c); if (state.optString("workspace") != workspace) return@synchronized
    cancelIntents(c, state)
    for (id in obj(state, "visible").keys()) notificationManager(c).cancel(id, 0)
    check(prefs(c).edit().remove("state").commit())
  }
  fun taken(c: Context, workspace: String, occurrence: String): String = synchronized(lock) {
    val state = load(c); val dose = JSONObject(occurrence)
    check(state.optString("workspace") == workspace && !state.optBoolean("quiesced")) { "Reminder workspace is closed" }
    check(eligible(state, dose)) { "This medicine reminder is no longer active" }
    val id = dose.getString("id")
    val existing = array(state, "receipts")
    for (i in 0 until existing.length()) {
      val receipt = existing.getJSONObject(i)
      if (receipt.getString("kind") == "taken" && receipt.getString("id") == id) return@synchronized receipt.toString()
    }
    check(!obj(state, "suppressed").optBoolean(id)) { "This dose is already taken" }
    val receipt = JSONObject(dose.toString()).put("kind", "taken").put("actionId", UUID.randomUUID().toString()).put("takenAt", instant(clock().millis()))
    array(state, "receipts").put(receipt); obj(state, "suppressed").put(id, true); obj(state, "visible").remove(id)
    save(c, state)
    notificationManager(c).cancel(id, 0)
    cancelIntents(c, state); schedule(c, state)
    receipt.toString()
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
  private fun currentDose(state: JSONObject, dose: JSONObject): Boolean {
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
  private fun stageKey(dose: JSONObject) = JSONArray(listOf(dose.getString("id"), dose.getString("kind"), dose.getString("stageAt"))).toString()
  private fun canNotify(c: Context, state: JSONObject): Boolean {
    channels(c)
    val channel = if (proofMuted(c, state.optString("workspace"))) PROOF else ALERTS
    return notificationManager(c).areNotificationsEnabled() && groupEnabled(c) && notificationManager(c).getNotificationChannel(channel)?.importance != NotificationManager.IMPORTANCE_NONE
  }
  fun dismissed(c: Context, workspace: String, occurrence: String) = synchronized(lock) {
    val state = load(c); val dose = JSONObject(occurrence)
    if (state.optString("workspace") != workspace) return@synchronized
    val id = dose.getString("id"); val visible = obj(state, "visible")
    if (visible.optJSONObject(id)?.optString("stageAt") == dose.optString("stageAt")) {
      visible.remove(id); save(c, state)
    }
  }
  fun restore(c: Context, notificationsLost: Boolean = false) = synchronized(lock) {
    val state = load(c)
    if (state.optBoolean("quiesced") || !state.has("workspace")) return@synchronized
    state.put("generation", UUID.randomUUID().toString())
    if (notificationsLost && canNotify(c, state)) for (id in obj(state, "visible").keys()) {
      notificationManager(c).notify(id, 0, notification(c, state.getString("workspace"), obj(state, "visible").getJSONObject(id), false))
    }
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
    val time = clock(); val now = time.millis(); val zone = time.zone; val today = LocalDate.now(time)
    val scheduled = JSONArray(); state.put("scheduled", scheduled)
    val batches = sortedMapOf<Pair<Long, String>, JSONArray>(compareBy<Pair<Long, String>> { it.first }.thenBy { it.second })
    val delivered = obj(state, "delivered")
    for (identity in delivered.keys().asSequence().toList()) if (delivered.getString(identity) < today.toString()) delivered.remove(identity)
    val visible = obj(state, "visible")
    for (id in visible.keys().asSequence().toList()) if (visible.getJSONObject(id).getString("on") < today.toString()) { notificationManager(c).cancel(id, 0); visible.remove(id) }
    fun plan(dose: JSONObject, kind: String, time: Long) {
      val stage = JSONObject(dose.toString()).put("kind", kind).put("stageAt", instant(time))
      if (time > now && !delivered.has(stageKey(stage))) batches.getOrPut(time to kind) { JSONArray() }.put(stage)
      else if (kind == "reminder" && time <= now && !delivered.has(stageKey(stage))) show(c, state, stage, false)
    }
    val medicines = array(state, "medicines")
    for (i in 0 until medicines.length()) {
      val m = medicines.getJSONObject(i); if (m.optBoolean("paused")) continue
      val start = LocalDate.parse(m.getString("startsOn")); val end = if (m.isNull("endsOn")) null else LocalDate.parse(m.getString("endsOn"))
      val slots = m.getJSONArray("doses")
      for (j in 0 until slots.length()) {
        val slot = slots.getJSONObject(j)
        var day = if (start > today) start else today
        for (attempt in 0..1) {
          if (end != null && day > end) break
          val id = key(m.getString("id"), slot.getString("id"), day.toString())
          if (!obj(state, "suppressed").optBoolean(id)) {
            val alarmAt = day.atTime(LocalTime.parse(slot.getString("alarmAt"))).atZone(zone).toInstant().toEpochMilli()
            val remindAt = day.atTime(LocalTime.parse(slot.getString("remindAt"))).atZone(zone).toInstant().toEpochMilli()
            val dose = JSONObject().put("id", id).put("medicineId", m.getString("id")).put("slotId", slot.getString("id")).put("on", day.toString()).put("scheduledAt", instant(alarmAt)).put("takenAt", JSONObject.NULL).put("name", m.getString("name")).put("instructions", if (m.isNull("instructions")) "" else m.optString("instructions", "")).put("alarmLabel", slot.getString("alarmAt"))
            if (alarmAt > now) {
              plan(dose, "alarm", alarmAt)
              plan(dose, "reminder", remindAt)
              break
            }
          }
          day = day.plusDays(1)
        }
      }
    }
    fun arm(identity: String, time: Long, data: JSONObject) {
      data.put("identity", identity).put("generation", state.optString("generation")).put("workspace", state.optString("workspace"))
      scheduled.put(data); save(c, state)
      val delivery = intent(c, identity, data)
      if (data.getString("kind") == "alarm") {
        val show = PendingIntent.getActivity(c, 0, Intent(Intent.ACTION_VIEW, Uri.parse("zeroagent:///browse/medicines")).setPackage(c.packageName), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        manager.setAlarmClock(AlarmManager.AlarmClockInfo(time, show), delivery)
      } else manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, time, delivery)
    }
    for ((entry, doses) in batches) arm("${entry.second}/${entry.first}", entry.first, JSONObject().put("kind", entry.second).put("time", entry.first).put("doses", doses))
    if (scheduled.length() > 0 || visible.length() > 0) arm("midnight", today.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli(), JSONObject().put("kind", "midnight"))
    save(c, state)
  }
  fun deliver(c: Context, payload: String) = synchronized(lock) {
    val state = load(c); val batch = JSONObject(payload)
    if (state.optBoolean("quiesced") || batch.optString("generation") != state.optString("generation") || batch.optString("workspace") != state.optString("workspace")) return@synchronized
    val doses = batch.optJSONArray("doses") ?: JSONArray()
    for (i in 0 until doses.length()) {
      val dose = doses.getJSONObject(i)
      if (eligible(state, dose) && currentDose(state, dose) && !obj(state, "suppressed").optBoolean(dose.getString("id")) && dose.getString("on") == LocalDate.now(clock()).toString()) show(c, state, dose, true)
    }
    cancelIntents(c, state); schedule(c, state)
  }
  private fun show(c: Context, state: JSONObject, dose: JSONObject, alert: Boolean) {
    if (!canNotify(c, state)) return
    val delivered = obj(state, "delivered"); val identity = stageKey(dose)
    if (delivered.has(identity)) return
    val id = dose.getString("id")
    delivered.put(identity, dose.getString("on")); obj(state, "visible").put(id, dose)
    array(state, "receipts").put(JSONObject(dose.toString()).put("actionId", UUID.randomUUID().toString()).put("kind", "presented").put("takenAt", JSONObject.NULL))
    save(c, state)
    if (alert) notificationManager(c).cancel(id, 0)
    notificationManager(c).notify(id, 0, notification(c, state.getString("workspace"), dose, alert))
    android.util.Log.i("MedicineReminders", "notification_presented stage=${dose.getString("kind")} scheduled=${dose.getString("stageAt")} delivered=${instant(clock().millis())} alert=$alert")
  }
  fun notification(c: Context, workspace: String, dose: JSONObject, alert: Boolean): Notification {
    val id = dose.getString("id")
    val open = Intent(Intent.ACTION_VIEW, Uri.parse("zeroagent:///browse/medicines/${Uri.encode(dose.getString("medicineId"))}?dose=${Uri.encode(id)}")).setPackage(c.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val openPending = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    fun action(kind: String) = PendingIntent.getBroadcast(c, 0, Intent(c, MedicineReceiver::class.java).setAction("medicine.$kind")
      .setData(Uri.parse("zero-medicine:$kind/${Uri.encode(workspace)}/${Uri.encode(id)}/${Uri.encode(dose.optString("stageAt"))}"))
      .putExtra("workspace", workspace).putExtra("payload", dose.toString()), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val channel = if (proofMuted(c, workspace)) PROOF else ALERTS
    val text = listOf(if (dose.optString("kind") == "alarm") "${dose.getString("alarmLabel")} dose due" else "Dose at ${dose.getString("alarmLabel")}", dose.optString("instructions", "")).filter { it.isNotBlank() }.joinToString(" · ")
    val public = Notification.Builder(c, channel).setSmallIcon(R.drawable.ic_medicine_notification).setContentTitle("Medicine reminder").setContentText("Open Zero Agent for details").build()
    val builder = Notification.Builder(c, channel).setSmallIcon(R.drawable.ic_medicine_notification).setContentTitle(dose.getString("name"))
      .setContentText(text).setStyle(Notification.BigTextStyle().bigText(text)).setContentIntent(openPending).setDeleteIntent(action("dismissed"))
      .setCategory(Notification.CATEGORY_REMINDER).setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(public)
      .setOnlyAlertOnce(!alert)
      .addAction(Notification.Action.Builder(null, "Taken", action("taken")).build())
    if (!alert) builder.setGroup("medicine-quiet").setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY)
    return builder.build()
  }
}

class MedicineReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    try {
      when (intent.action) {
        "medicine.taken" -> MedicineEngine.taken(context, intent.getStringExtra("workspace") ?: return, intent.getStringExtra("payload") ?: return)
        "medicine.dismissed" -> MedicineEngine.dismissed(context, intent.getStringExtra("workspace") ?: return, intent.getStringExtra("payload") ?: return)
        "medicine.delivery" -> MedicineEngine.deliver(context, intent.getStringExtra("payload") ?: return)
        else -> MedicineEngine.restore(context, intent.action == Intent.ACTION_BOOT_COMPLETED)
      }
    } catch (error: Exception) { android.util.Log.e("MedicineReminders", "Native reminder operation failed", error) }
  }
}
