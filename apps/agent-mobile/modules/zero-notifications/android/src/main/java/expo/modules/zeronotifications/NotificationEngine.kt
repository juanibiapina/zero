package expo.modules.zeronotifications

import android.app.ActivityManager
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.AtomicFile
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.concurrent.CopyOnWriteArraySet

internal class Card(val source: String, val key: String, val date: String, val stage: Int, val anchor: String, val offset: Int, val shownAt: Long)

internal class ScreenContent(val title: String, val text: String, val actions: List<Action>)

internal class Postpone(val source: String, val key: String, val date: String, val anchor: String, val due: Long)

internal object LegacyStore {
  private fun minutes(time: String) = time.substring(0, 2).toInt() * 60 + time.substring(3, 5).toInt()

  fun schedule(json: String): String {
    val root = JSONObject(json)
    val reminders = root.optJSONArray("reminders") ?: return json
    var changed = false
    for (i in 0 until reminders.length()) {
      val reminder = reminders.getJSONObject(i)
      val stages = reminder.optJSONArray("stages") ?: continue
      for (s in 0 until stages.length()) if (stages.getJSONObject(s).remove("icon") != null) changed = true
      if (reminder.has("at") || stages.length() == 0) continue
      val anchor = stages.getJSONObject(stages.length() - 1).getString("at")
      for (s in 0 until stages.length()) {
        val stage = stages.getJSONObject(s)
        stage.put("offset", minutes(stage.getString("at")) - minutes(anchor))
        stage.remove("at")
      }
      reminder.put("at", anchor)
      changed = true
    }
    return if (changed) root.toString() else json
  }

  fun position(schedule: String?, key: String, at: String): Pair<String, Int> {
    val anchor = schedule?.let { (ScheduleParser.parse(it) as? ScheduleResult.Ok)?.schedule?.reminder(key)?.at?.toString() } ?: at
    return anchor to (minutes(at) - minutes(anchor))
  }
}

internal class State(
  var workspace: String? = null,
  var quiesced: Boolean = false,
  var processedUntil: Long = 0,
  val schedules: MutableMap<String, String> = linkedMapOf(),
  val settledHere: MutableSet<String> = linkedSetOf(),
  val receipts: MutableList<JSONObject> = mutableListOf(),
  val cards: MutableMap<String, Card> = linkedMapOf(),
  val postpones: MutableMap<String, Postpone> = linkedMapOf(),
  var alarms: List<Pair<Wake, Long>> = emptyList(),
) {
  fun toJson(): JSONObject = JSONObject()
    .put("workspace", workspace ?: JSONObject.NULL)
    .put("quiesced", quiesced)
    .put("processedUntil", processedUntil)
    .put("schedules", JSONObject().also { out -> schedules.forEach { (source, json) -> out.put(source, json) } })
    .put("settledHere", JSONArray(settledHere.toList()))
    .put("receipts", JSONArray(receipts))
    .put("cards", JSONObject().also { out ->
      cards.forEach { (id, card) -> out.put(id, JSONObject().put("source", card.source).put("key", card.key).put("date", card.date).put("stage", card.stage).put("anchor", card.anchor).put("offset", card.offset).put("shownAt", card.shownAt)) }
    })
    .put("postpones", JSONObject().also { out ->
      postpones.forEach { (id, postpone) -> out.put(id, JSONObject().put("source", postpone.source).put("key", postpone.key).put("date", postpone.date).put("anchor", postpone.anchor).put("due", postpone.due)) }
    })
    .put("alarms", JSONArray(alarms.map { (wake, time) -> JSONObject().put("wake", if (wake == Wake.ALARM_CLOCK) "alarmClock" else "exact").put("time", time) }))

  companion object {
    fun fromJson(json: JSONObject): State {
      val state = State(
        workspace = if (json.isNull("workspace")) null else json.getString("workspace"),
        quiesced = json.optBoolean("quiesced"),
        processedUntil = json.optLong("processedUntil"),
      )
      json.optJSONObject("schedules")?.let { schedules -> schedules.keys().forEach { state.schedules[it] = LegacyStore.schedule(schedules.getString(it)) } }
      fun position(item: JSONObject): Pair<String, Int> =
        if (item.has("offset")) item.getString("anchor") to item.getInt("offset")
        else LegacyStore.position(state.schedules[item.getString("source")], item.getString("key"), item.getString("at"))
      json.optJSONArray("settledHere")?.let { list -> for (i in 0 until list.length()) state.settledHere += list.getString(i) }
      json.optJSONArray("receipts")?.let { list -> for (i in 0 until list.length()) state.receipts += list.getJSONObject(i) }
      json.optJSONObject("cards")?.let { cards ->
        cards.keys().forEach { id ->
          val card = cards.getJSONObject(id)
          val (anchor, offset) = position(card)
          state.cards[id] = Card(card.getString("source"), card.getString("key"), card.getString("date"), card.getInt("stage"), anchor, offset, card.getLong("shownAt"))
        }
      }
      json.optJSONObject("snoozes")?.let { snoozes ->
        snoozes.keys().forEach { id ->
          val snooze = snoozes.getJSONObject(id)
          state.postpones[id] = Postpone(snooze.getString("source"), snooze.getString("key"), snooze.getString("date"), position(snooze).first, snooze.getLong("until"))
        }
      }
      json.optJSONObject("postpones")?.let { postpones ->
        postpones.keys().forEach { id ->
          val postpone = postpones.getJSONObject(id)
          state.postpones[id] = Postpone(postpone.getString("source"), postpone.getString("key"), postpone.getString("date"), postpone.getString("anchor"), postpone.getLong("due"))
        }
      }
      return state
    }
  }
}

internal object NotificationEngine {
  const val WAKE = "zero.notifications.wake"
  const val BUTTON = "zero.notifications.button"
  const val DISMISS = "zero.notifications.dismiss"
  const val TAG = "ZeroNotifications"
  private const val STATE_FILE = "zero-notifications.json"
  const val SILENT_FILE = "zero-notifications-silent"
  private const val QUIET_GROUP = "zero-notifications-quiet"
  private const val DAY_MS = 24 * 60 * 60 * 1000L
  private val lock = Any()
  private val listeners = CopyOnWriteArraySet<() -> Unit>()
  private const val WARNING_COLOR = 0xFFB3261E.toInt()
  private val TIME = DateTimeFormatter.ofPattern("HH:mm")
  internal var clock: () -> Clock = { Clock.systemDefaultZone() }

  private class Candidate(val source: String, val reminder: Reminder, val date: LocalDate, val stage: Int, val time: Long)

  fun occurrence(source: String, key: String, date: String): String = JSONArray(listOf(source, key, date)).toString()

  private fun stateFile(c: Context) = AtomicFile(File(c.noBackupFilesDir, STATE_FILE))
  private fun load(c: Context): State = try {
    State.fromJson(JSONObject(String(stateFile(c).readFully(), Charsets.UTF_8)))
  } catch (_: FileNotFoundException) {
    State()
  }
  private fun save(c: Context, state: State) {
    val file = stateFile(c)
    val out = file.startWrite()
    try { out.write(state.toJson().toString().toByteArray(Charsets.UTF_8)); file.finishWrite(out) }
    catch (error: Exception) { file.failWrite(out); throw IllegalStateException("Notification storage failed", error) }
    publish()
  }
  private fun publish() = listeners.forEach { it() }

  fun observe(listener: () -> Unit): () -> Unit {
    listeners += listener
    return { listeners -= listener }
  }
  private fun alarmManager(c: Context) = c.getSystemService(AlarmManager::class.java)
  private fun notificationManager(c: Context) = c.getSystemService(NotificationManager::class.java)
  private fun schedules(state: State): Map<String, Schedule> = state.schedules.mapValues { (_, json) -> ScheduleParser.require(json) }
  private fun anchorTime(date: LocalDate, reminder: Reminder, zone: ZoneId) = ZonedDateTime.of(date, reminder.at, zone).toInstant().toEpochMilli()
  private fun due(state: State, source: String, reminder: Reminder, date: LocalDate, zone: ZoneId): Long =
    state.postpones[occurrence(source, reminder.key, date.toString())]?.takeIf { it.anchor == reminder.at.toString() }?.due ?: anchorTime(date, reminder, zone)
  private fun stageTime(due: Long, stage: Stage) = due + stage.offset * 60_000L
  private fun postponedDates(state: State, source: String, reminder: Reminder) =
    state.postpones.values.filter { it.source == source && it.key == reminder.key }.map { LocalDate.parse(it.date) }
  private fun hasStage(reminder: Reminder, anchor: String, offset: Int) = reminder.at.toString() == anchor && reminder.stages.any { it.offset == offset }
  private fun localDate(time: Long, zone: ZoneId) = Instant.ofEpochMilli(time).atZone(zone).toLocalDate()
  private fun isSettled(state: State, source: String, reminder: Reminder, date: LocalDate) =
    date in reminder.settled || occurrence(source, reminder.key, date.toString()) in state.settledHere
  private fun unacknowledgedSettles(state: State) = state.receipts.filter { it.getString("type") == "settled" }
  private fun debuggable(c: Context) = c.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
  fun muted(c: Context, workspace: String?) = debuggable(c) && workspace != null && File(c.noBackupFilesDir, SILENT_FILE).let { it.exists() && it.readText() == workspace }
  private fun groupEnabled(c: Context, group: String?) = Build.VERSION.SDK_INT < 28 || group == null || notificationManager(c).getNotificationChannelGroup(group)?.isBlocked != true

  fun install(c: Context, workspace: String, source: String, json: String) = synchronized(lock) {
    val schedule = ScheduleParser.require(json)
    var state = load(c)
    if (state.workspace != null && state.workspace != workspace) state = release(c, state)
    ensureChannels(c, schedule.channels)
    val now = clock().millis()
    val active = state.workspace != null && !state.quiesced
    val previous = if (active) state.schedules[source]?.let(ScheduleParser::require) else null
    state.workspace = workspace
    state.quiesced = false
    state.schedules[source] = json
    state.settledHere.clear()
    unacknowledgedSettles(state).forEach { state.settledHere += occurrence(it.getString("source"), it.getString("key"), it.getString("date")) }
    val all = schedules(state)
    prune(c, state, all, now)
    if (active) deliver(c, state, all, now, quiet = false, installed = source, previous = previous) else state.processedUntil = now
    repostMissing(c, state, all)
    arm(c, state, all, now)
    save(c, state)
  }

  fun receipts(c: Context, workspace: String, source: String): String = synchronized(lock) {
    val state = load(c)
    if (state.workspace != workspace) "[]" else JSONArray(state.receipts.filter { it.getString("source") == source }).toString()
  }

  fun acknowledge(c: Context, workspace: String, source: String, ids: List<String>) = synchronized(lock) {
    val state = load(c)
    if (state.workspace != workspace) return@synchronized
    val consumed = ids.toSet()
    state.receipts.removeAll { it.getString("source") == source && it.getString("id") in consumed }
    save(c, state)
  }

  fun settle(c: Context, workspace: String, source: String, key: String, date: String, action: String): String = synchronized(lock) {
    val state = load(c)
    check(state.workspace == workspace && !state.quiesced) { "Notification workspace is closed" }
    val all = schedules(state)
    val reminder = all[source]?.reminder(key) ?: throw IllegalStateException("Unknown reminder")
    val day = LocalDate.parse(date)
    check(reminder.recurrence.occursOn(day)) { "The reminder does not occur on that date" }
    check(reminder.actions.any { it.id == action && it.settles }) { "Not a settle action" }
    unacknowledgedSettles(state).firstOrNull { it.getString("source") == source && it.getString("key") == key && it.getString("date") == date }
      ?.let { return@synchronized it.toString() }
    check(!isSettled(state, source, reminder, day)) { "Already settled" }
    val now = clock().millis()
    val receipt = receipt(source, reminder, date, now).put("type", "settled").put("action", action)
    val id = occurrence(source, key, date)
    state.receipts += receipt
    state.settledHere += id
    state.cards.remove(id)
    state.postpones.remove(id)
    save(c, state)
    notificationManager(c).cancel(id, 0)
    arm(c, state, all, now)
    save(c, state)
    receipt.toString()
  }

  fun button(c: Context, workspace: String, source: String, key: String, date: String, action: String, shownAt: Long) {
    val reminder = synchronized(lock) { schedules(load(c))[source]?.reminder(key) } ?: return
    val chosen = reminder.actions.firstOrNull { it.id == action } ?: return
    if (chosen.settles) settle(c, workspace, source, key, date, action) else postpone(c, workspace, source, key, date, chosen, shownAt)
  }

  private fun postpone(c: Context, workspace: String, source: String, key: String, date: String, action: Action, shownAt: Long) = synchronized(lock) {
    val state = load(c)
    if (state.workspace != workspace || state.quiesced) return@synchronized
    val id = occurrence(source, key, date)
    if (state.cards[id]?.shownAt != shownAt) return@synchronized
    val all = schedules(state)
    val reminder = all[source]?.reminder(key) ?: return@synchronized
    val now = clock().millis()
    val zone = clock().zone
    val day = LocalDate.parse(date)
    deliver(c, state, all, now, quiet = false)
    val moved = maxOf(due(state, source, reminder, day, zone), now - now % 60_000L) + action.snoozeMinutes!! * 60_000L
    state.postpones[id] = Postpone(source, key, date, reminder.at.toString(), moved)
    val stage = reminder.stages.indices.lastOrNull { stageTime(moved, reminder.stages[it]) <= now }
    if (stage == null) {
      state.cards.remove(id)
      notificationManager(c).cancel(id, 0)
    } else {
      show(c, state, Candidate(source, reminder, day, stage, stageTime(moved, reminder.stages[stage])), alert = false, now = now)
    }
    arm(c, state, all, now)
    save(c, state)
  }

  fun dismissed(c: Context, workspace: String, source: String, key: String, date: String, shownAt: Long) = synchronized(lock) {
    val state = load(c)
    if (state.workspace != workspace || state.quiesced) return@synchronized
    val id = occurrence(source, key, date)
    val card = state.cards[id]?.takeIf { it.shownAt == shownAt } ?: return@synchronized
    val reminder = schedules(state)[source]?.reminder(key) ?: return@synchronized
    if (canNotify(c, state, reminder.channel)) notificationManager(c).notify(id, 0, notification(c, state, card, reminder, false))
  }

  private fun repostMissing(c: Context, state: State, all: Map<String, Schedule>) {
    if (state.workspace == null || state.quiesced) return
    val visible = notificationManager(c).activeNotifications.mapNotNull { it.tag }.toSet()
    for ((id, card) in state.cards) {
      if (id in visible) continue
      val reminder = all[card.source]?.reminder(card.key) ?: continue
      if (canNotify(c, state, reminder.channel)) notificationManager(c).notify(id, 0, notification(c, state, card, reminder, false))
    }
  }

  fun wake(c: Context) = synchronized(lock) {
    val state = load(c)
    if (state.workspace == null || state.quiesced) return@synchronized
    val now = clock().millis()
    val all = schedules(state)
    deliver(c, state, all, now, quiet = false)
    repostMissing(c, state, all)
    arm(c, state, all, now)
    save(c, state)
  }

  fun restore(c: Context, boot: Boolean) = synchronized(lock) {
    val state = load(c)
    if (state.workspace == null || state.quiesced) return@synchronized
    val now = clock().millis()
    val all = schedules(state)
    repostMissing(c, state, all)
    deliver(c, state, all, now, quiet = boot)
    arm(c, state, all, now)
    save(c, state)
  }

  fun quiesce(c: Context, workspace: String) = synchronized(lock) {
    val state = load(c)
    if (state.workspace != workspace) return@synchronized
    state.quiesced = true
    closeEverything(c, state)
    save(c, state)
  }

  fun clear(c: Context, workspace: String) = synchronized(lock) {
    val state = load(c)
    if (state.workspace != workspace) return@synchronized
    closeEverything(c, state)
    stateFile(c).delete()
    publish()
  }

  fun screen(c: Context, workspace: String, source: String, key: String, date: String, shownAt: Long): ScreenContent? = synchronized(lock) {
    val state = load(c)
    if (state.workspace != workspace || state.quiesced) return@synchronized null
    val card = state.cards[occurrence(source, key, date)]?.takeIf { it.shownAt == shownAt } ?: return@synchronized null
    val reminder = schedules(state)[source]?.reminder(key) ?: return@synchronized null
    ScreenContent(reminder.title, withTime(state, card, reminder)(stageOf(reminder, card).text), reminder.actions)
  }

  fun silence(c: Context, workspace: String) {
    check(debuggable(c)) { "Silencing requires a debug build" }
    File(c.noBackupFilesDir, SILENT_FILE).writeText(workspace)
  }

  fun capabilities(c: Context): Map<String, Any> {
    val manager = notificationManager(c)
    val channels = manager.notificationChannels.filterNot { it.id.endsWith("-proof") }
      .associate { it.id to (it.importance != NotificationManager.IMPORTANCE_NONE && groupEnabled(c, it.group)) }
    return mapOf(
      "notifications" to manager.areNotificationsEnabled(),
      "exactAlarms" to (Build.VERSION.SDK_INT < 31 || alarmManager(c).canScheduleExactAlarms()),
      "backgroundRestricted" to (Build.VERSION.SDK_INT >= 28 && c.getSystemService(ActivityManager::class.java).isBackgroundRestricted),
      "fullScreen" to canUseFullScreen(c),
      "channels" to channels,
    )
  }

  private fun release(c: Context, state: State): State {
    check(unacknowledgedSettles(state).isEmpty()) { "Another workspace has unimported notification actions" }
    closeEverything(c, state)
    return State()
  }

  private fun closeEverything(c: Context, state: State) {
    cancelAlarms(c)
    state.alarms = emptyList()
    for (id in state.cards.keys) notificationManager(c).cancel(id, 0)
    state.cards.clear()
    state.postpones.clear()
  }

  private fun ensureChannels(c: Context, channels: List<Channel>) {
    val manager = notificationManager(c)
    for (channel in channels) {
      val existingGroup = manager.getNotificationChannelGroup(channel.groupId)
      if (existingGroup == null || existingGroup.name != channel.groupName) manager.createNotificationChannelGroup(NotificationChannelGroup(channel.groupId, channel.groupName))
      val existing = manager.getNotificationChannel(channel.id)
      if (existing == null) {
        manager.createNotificationChannel(NotificationChannel(channel.id, channel.name, NotificationManager.IMPORTANCE_HIGH).apply {
          group = channel.groupId
          setSound(Settings.System.DEFAULT_NOTIFICATION_URI, AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
          enableVibration(true)
        })
      } else if (existing.name != channel.name) {
        existing.name = channel.name
        manager.createNotificationChannel(existing)
      }
    }
  }

  private fun channelFor(c: Context, state: State, channelId: String): String {
    if (!muted(c, state.workspace)) return channelId
    val manager = notificationManager(c)
    val proof = "$channelId-proof"
    if (manager.getNotificationChannel(proof) == null) {
      val base = manager.getNotificationChannel(channelId)
      manager.createNotificationChannel(NotificationChannel(proof, "${base?.name ?: channelId} (test)", NotificationManager.IMPORTANCE_HIGH).apply {
        group = base?.group; setSound(null, null); enableVibration(false)
      })
    }
    return proof
  }

  private fun canNotify(c: Context, state: State, channelId: String): Boolean {
    val manager = notificationManager(c)
    val channel = manager.getNotificationChannel(channelFor(c, state, channelId)) ?: return false
    return manager.areNotificationsEnabled() && channel.importance != NotificationManager.IMPORTANCE_NONE && groupEnabled(c, channel.group)
  }

  private fun prune(c: Context, state: State, all: Map<String, Schedule>, now: Long) {
    fun open(source: String, key: String, date: String): Reminder? {
      val reminder = all[source]?.reminder(key) ?: return null
      val day = LocalDate.parse(date)
      return reminder.takeIf { it.recurrence.occursOn(day) && !isSettled(state, source, it, day) }
    }
    for ((id, card) in state.cards.toList()) if (open(card.source, card.key, card.date)?.let { hasStage(it, card.anchor, card.offset) } != true) {
      notificationManager(c).cancel(id, 0); state.cards.remove(id)
    }
    for ((id, postpone) in state.postpones.toList()) {
      val reminder = open(postpone.source, postpone.key, postpone.date)
      val spent = id !in state.cards && reminder != null && reminder.stages.all { stageTime(postpone.due, it) <= now }
      if (reminder == null || reminder.at.toString() != postpone.anchor || spent) state.postpones.remove(id)
    }
  }

  private fun deliver(c: Context, state: State, all: Map<String, Schedule>, now: Long, quiet: Boolean, installed: String? = null, previous: Schedule? = null) {
    val zone = clock().zone
    val candidates = mutableListOf<Candidate>()
    val after = state.processedUntil
    val first = localDate(maxOf(after, now - 8 * DAY_MS), zone).minusDays(2)
    val last = localDate(now, zone).plusDays(2)
    val window = generateSequence(first) { it.plusDays(1) }.takeWhile { !it.isAfter(last) }.toList()
    if (after in 1 until now) for ((source, schedule) in all) for (reminder in schedule.reminders) {
      for (date in (window + postponedDates(state, source, reminder)).distinct()) {
        if (!reminder.recurrence.occursOn(date) || isSettled(state, source, reminder, date)) continue
        val dueAt = due(state, source, reminder, date, zone)
        reminder.stages.forEachIndexed { index, stage ->
          val time = stageTime(dueAt, stage)
          if (time <= after || time > now) return@forEachIndexed
          if (source == installed) {
            val old = previous?.reminder(reminder.key)
            if (old == null || !old.recurrence.occursOn(date) || !hasStage(old, reminder.at.toString(), stage.offset)) return@forEachIndexed
          }
          candidates += Candidate(source, reminder, date, index, time)
        }
      }
    }
    val newest = candidates.groupBy { it.source to it.reminder.key }.values.map { group ->
      val day = group.maxOf { it.date }
      group.filter { it.date == day }.maxWith(compareBy<Candidate> { it.time }.thenBy { it.stage })
    }
    for (candidate in newest) show(c, state, candidate, alert = !quiet, now = now)
    state.processedUntil = now
  }

  private fun show(c: Context, state: State, candidate: Candidate, alert: Boolean, now: Long) {
    val reminder = candidate.reminder
    if (!canNotify(c, state, reminder.channel)) return
    val date = candidate.date.toString()
    val id = occurrence(candidate.source, reminder.key, date)
    val stage = reminder.stages[candidate.stage]
    val card = Card(candidate.source, reminder.key, date, candidate.stage, reminder.at.toString(), stage.offset, now)
    state.cards[id] = card
    state.receipts += receipt(candidate.source, reminder, date, now).put("type", "presented")
    save(c, state)
    if (alert) notificationManager(c).cancel(id, 0)
    notificationManager(c).notify(id, 0, notification(c, state, card, reminder, alert))
    val wake = if (stage.wake == Wake.ALARM_CLOCK) "alarmClock" else "exact"
    Log.i(TAG, "notification_presented stage=${candidate.stage} wake=$wake scheduled=${Instant.ofEpochMilli(candidate.time)} delivered=${Instant.ofEpochMilli(now)} alert=$alert")
  }

  private fun receipt(source: String, reminder: Reminder, date: String, now: Long) = JSONObject()
    .put("id", UUID.randomUUID().toString()).put("source", source).put("key", reminder.key).put("date", date)
    .put("at", Instant.ofEpochMilli(now).toString()).put("data", reminder.data)

  private fun wakeIntent(c: Context, wake: Wake): PendingIntent {
    val intent = Intent(c, NotificationReceiver::class.java).setAction(WAKE).setData(Uri.parse("zero-notifications:wake/${wake.name.lowercase()}"))
    return PendingIntent.getBroadcast(c, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  private fun cancelAlarms(c: Context) {
    alarmManager(c).cancel(wakeIntent(c, Wake.ALARM_CLOCK))
    alarmManager(c).cancel(wakeIntent(c, Wake.EXACT))
  }

  private fun arm(c: Context, state: State, all: Map<String, Schedule>, now: Long) {
    cancelAlarms(c)
    state.alarms = emptyList()
    if (state.workspace == null || state.quiesced) return
    val manager = alarmManager(c)
    if (Build.VERSION.SDK_INT >= 31 && !manager.canScheduleExactAlarms()) return
    val zone = clock().zone
    var alarmClock: Pair<Long, String>? = null
    var exact: Long? = null
    for ((source, schedule) in all) for (reminder in schedule.reminders) {
      val wakes = reminder.stages.map { it.wake }.toSet()
      val next = mutableMapOf<Wake, Pair<Long, LocalDate>>()
      fun consider(date: LocalDate) {
        if (!reminder.recurrence.occursOn(date) || isSettled(state, source, reminder, date)) return
        val dueAt = due(state, source, reminder, date, zone)
        for (stage in reminder.stages) {
          val time = stageTime(dueAt, stage)
          if (time <= now) continue
          val best = next[stage.wake]
          if (best == null || time < best.first) next[stage.wake] = time to date
        }
      }
      var cursor = localDate(now, zone).minusDays(2)
      var steps = 0
      while (steps++ < 16) {
        val date = reminder.recurrence.nextOccurrence(cursor) ?: break
        cursor = date.plusDays(1)
        val earliest = ZonedDateTime.of(date, reminder.at, zone).toInstant().toEpochMilli() - ScheduleParser.MAX_OFFSET * 60_000L
        if (next.keys == wakes && next.values.all { it.first < earliest }) break
        consider(date)
      }
      postponedDates(state, source, reminder).forEach(::consider)
      next[Wake.ALARM_CLOCK]?.let { (time, date) -> if (alarmClock == null || time < alarmClock.first) alarmClock = time to reminder.url.replace("{date}", date.toString()) }
      next[Wake.EXACT]?.let { (time, _) -> if (exact == null || time < exact) exact = time }
    }
    val armed = mutableListOf<Pair<Wake, Long>>()
    alarmClock?.let { (time, url) ->
      val show = PendingIntent.getActivity(c, 1, Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(c.packageName), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      manager.setAlarmClock(AlarmManager.AlarmClockInfo(time, show), wakeIntent(c, Wake.ALARM_CLOCK))
      armed += Wake.ALARM_CLOCK to time
    }
    exact?.let { time ->
      manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, time, wakeIntent(c, Wake.EXACT))
      armed += Wake.EXACT to time
    }
    state.alarms = armed
  }

  internal var canUseFullScreen: (Context) -> Boolean = { c -> Build.VERSION.SDK_INT < 34 || notificationManager(c).canUseFullScreenIntent() }
  private fun stageOf(reminder: Reminder, card: Card) = reminder.stages.firstOrNull { it.offset == card.offset } ?: reminder.stages[card.stage.coerceIn(reminder.stages.indices)]
  private fun withTime(state: State, card: Card, reminder: Reminder): (String) -> String {
    val zone = clock().zone
    val time = Instant.ofEpochMilli(due(state, card.source, reminder, LocalDate.parse(card.date), zone)).atZone(zone).toLocalTime().format(TIME)
    return { it.replace("{time}", time) }
  }

  fun notification(c: Context, state: State, card: Card, reminder: Reminder, alert: Boolean): Notification {
    val workspace = state.workspace!!
    val id = occurrence(card.source, card.key, card.date)
    val stage = stageOf(reminder, card)
    val open = Intent(Intent.ACTION_VIEW, Uri.parse(reminder.url.replace("{date}", card.date))).setPackage(c.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val openPending = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    fun broadcast(action: String, button: String) = PendingIntent.getBroadcast(c, 0, Intent(c, NotificationReceiver::class.java).setAction(action)
      .setData(Uri.parse("zero-notifications:${Uri.encode(action)}/${Uri.encode(id)}/${Uri.encode(button)}/${card.shownAt}"))
      .putExtra("workspace", workspace).putExtra("source", card.source).putExtra("key", card.key).putExtra("date", card.date)
      .putExtra("action", button).putExtra("shownAt", card.shownAt), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val channel = channelFor(c, state, reminder.channel)
    val icon = reminder.icon.drawable
    val warning = stage.tone == Tone.WARNING
    val fill = withTime(state, card, reminder)
    val text = fill(stage.text)
    val public = Notification.Builder(c, channel).setSmallIcon(icon).setContentTitle(reminder.lockTitle).setContentText(reminder.lockText)
      .also { if (warning) it.setColor(WARNING_COLOR) }.build()
    val builder = Notification.Builder(c, channel).setSmallIcon(icon).setContentTitle(fill(stage.title ?: reminder.title))
      .setContentText(text).setStyle(Notification.BigTextStyle().bigText(text)).setContentIntent(openPending).setDeleteIntent(broadcast(DISMISS, ""))
      .setCategory(if (warning) Notification.CATEGORY_ALARM else Notification.CATEGORY_REMINDER).setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(public)
      .setOngoing(true).setOnlyAlertOnce(!alert)
    if (warning) builder.setColor(WARNING_COLOR)
    for (action in reminder.actions) builder.addAction(Notification.Action.Builder(null, action.label, broadcast(BUTTON, action.id)).build())
    if (!alert) builder.setGroup(QUIET_GROUP).setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY)
    if (alert && stage.fullScreen && canUseFullScreen(c)) {
      val screen = Intent(c, ReminderScreenActivity::class.java)
        .setData(Uri.parse("zero-notifications:screen/${Uri.encode(id)}/${card.shownAt}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        .putExtra("workspace", workspace).putExtra("source", card.source).putExtra("key", card.key).putExtra("date", card.date).putExtra("shownAt", card.shownAt)
      builder.setFullScreenIntent(PendingIntent.getActivity(c, 0, screen, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE), true)
    }
    return builder.build()
  }
}
