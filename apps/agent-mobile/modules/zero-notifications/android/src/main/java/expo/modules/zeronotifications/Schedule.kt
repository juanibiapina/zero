package expo.modules.zeronotifications

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeParseException

internal data class Channel(val id: String, val name: String, val groupId: String, val groupName: String)

internal data class Recurrence(val from: LocalDate, val until: LocalDate?, val weekdays: Set<Int>) {
  fun occursOn(date: LocalDate): Boolean =
    !date.isBefore(from) && (until == null || !date.isAfter(until)) && date.dayOfWeek.value in weekdays

  fun nextOccurrence(start: LocalDate): LocalDate? {
    var date = if (start.isBefore(from)) from else start
    repeat(7) {
      if (until != null && date.isAfter(until)) return null
      if (occursOn(date)) return date
      date = date.plusDays(1)
    }
    return null
  }
}

internal enum class Wake { EXACT, ALARM_CLOCK }

internal enum class Icon(val id: String, val drawable: Int) {
  PILL("pill", R.drawable.ic_notification_pill),
  WARNING("warning", R.drawable.ic_notification_warning);

  companion object {
    fun of(id: String): Icon? = values().firstOrNull { it.id == id }
  }
}

internal enum class Tone { NORMAL, WARNING }

internal data class Stage(
  val offset: Int,
  val wake: Wake,
  val text: String,
  val fullScreen: Boolean = false,
  val title: String? = null,
  val icon: Icon? = null,
  val tone: Tone = Tone.NORMAL,
)

internal data class Action(val id: String, val label: String, val snoozeMinutes: Int?) {
  val settles get() = snoozeMinutes == null
}

internal data class Reminder(
  val key: String,
  val channel: String,
  val icon: Icon,
  val title: String,
  val lockTitle: String,
  val lockText: String,
  val url: String,
  val recurrence: Recurrence,
  val at: LocalTime,
  val stages: List<Stage>,
  val actions: List<Action>,
  val settled: Set<LocalDate>,
  val data: String,
)

internal data class Schedule(val channels: List<Channel>, val reminders: List<Reminder>) {
  fun reminder(key: String) = reminders.firstOrNull { it.key == key }
}

internal sealed class ScheduleResult {
  data class Ok(val schedule: Schedule) : ScheduleResult()
  data class Error(val code: String) : ScheduleResult()
}

private class Invalid(val code: String) : Exception(code)

internal object ScheduleParser {
  private val dateFormat = Regex("^\\d{4}-\\d{2}-\\d{2}$")
  private val timeFormat = Regex("^(?:[01]\\d|2[0-3]):[0-5]\\d$")
  const val MAX_OFFSET = 1440

  fun parse(json: String): ScheduleResult = try {
    val root = try { JSONTokener(json).nextValue() } catch (_: JSONException) { throw Invalid("invalid-shape") }
    val shaped = shape(root)
    semantics(shaped)
    ScheduleResult.Ok(build(shaped))
  } catch (error: Invalid) {
    ScheduleResult.Error(error.code)
  }

  fun require(json: String): Schedule = when (val result = parse(json)) {
    is ScheduleResult.Ok -> result.schedule
    is ScheduleResult.Error -> throw IllegalArgumentException("Invalid schedule: ${result.code}")
  }

  private class RawChannel(val id: String, val name: String, val groupId: String, val groupName: String)
  private class RawAction(val id: String, val label: String, val minutes: Int?)
  private class RawStage(val offset: Int, val wake: Wake, val text: String, val fullScreen: Boolean, val title: String?, val icon: Icon?, val tone: Tone)
  private class RawReminder(
    val key: String, val channel: String, val icon: Icon, val title: String, val lockTitle: String, val lockText: String,
    val url: String, val from: String, val until: String?, val weekdays: List<Int>, val at: String, val stages: List<RawStage>,
    val actions: List<RawAction>, val settled: List<String>, val data: String,
  )
  private class RawSchedule(val channels: List<RawChannel>, val reminders: List<RawReminder>)

  private fun shapeError(): Nothing = throw Invalid("invalid-shape")
  private fun obj(value: Any?, vararg keys: String): JSONObject = objWith(value, keys.toSet(), emptySet())
  private fun objWith(value: Any?, required: Set<String>, optional: Set<String>): JSONObject {
    if (value !is JSONObject) shapeError()
    val present = value.keys().asSequence().toSet()
    if (!present.containsAll(required) || !(required + optional).containsAll(present)) shapeError()
    return value
  }
  private fun icon(value: Any?): Icon = Icon.of(string(value)) ?: shapeError()
  private fun list(value: Any?): List<Any?> {
    if (value !is JSONArray) shapeError()
    return (0 until value.length()).map { value.get(it) }
  }
  private fun string(value: Any?): String = value as? String ?: shapeError()
  private fun integer(value: Any?): Int {
    if (value !is Number || value is Float || (value is Double && (value.isNaN() || value.isInfinite()))) shapeError()
    val number = value.toDouble()
    if (number != Math.floor(number) || number > Int.MAX_VALUE || number < Int.MIN_VALUE) shapeError()
    return number.toInt()
  }

  private fun shape(root: Any?): RawSchedule {
    val document = obj(root, "channels", "reminders")
    val channels = list(document.get("channels")).map {
      val channel = obj(it, "id", "name", "group")
      val group = obj(channel.get("group"), "id", "name")
      RawChannel(string(channel.get("id")), string(channel.get("name")), string(group.get("id")), string(group.get("name")))
    }
    val reminders = list(document.get("reminders")).map {
      val reminder = obj(it, "key", "channel", "icon", "title", "lockScreen", "url", "recurrence", "at", "stages", "actions", "settled", "data")
      val icon = icon(reminder.get("icon"))
      val lock = obj(reminder.get("lockScreen"), "title", "text")
      val recurrence = obj(reminder.get("recurrence"), "from", "until", "weekdays")
      val until = recurrence.get("until").let { value -> if (value == JSONObject.NULL) null else string(value) }
      val stages = list(reminder.get("stages")).map { item ->
        val stage = objWith(item, setOf("offset", "wake", "text"), setOf("fullScreen", "title", "icon", "tone"))
        val fullScreen = stage.has("fullScreen")
        if (fullScreen && stage.get("fullScreen") != true) shapeError()
        val tone = if (!stage.has("tone")) Tone.NORMAL else if (stage.get("tone") == "warning") Tone.WARNING else shapeError()
        val wake = when (string(stage.get("wake"))) { "exact" -> Wake.EXACT; "alarmClock" -> Wake.ALARM_CLOCK; else -> shapeError() }
        RawStage(
          integer(stage.get("offset")), wake, string(stage.get("text")), fullScreen,
          if (stage.has("title")) string(stage.get("title")) else null,
          if (stage.has("icon")) icon(stage.get("icon")) else null,
          tone,
        )
      }
      val actions = list(reminder.get("actions")).map { item ->
        if (item !is JSONObject) shapeError()
        when (item.opt("kind")) {
          "settle" -> obj(item, "id", "label", "kind").let { action -> RawAction(string(action.get("id")), string(action.get("label")), null) }
          "snooze" -> obj(item, "id", "label", "kind", "minutes").let { action -> RawAction(string(action.get("id")), string(action.get("label")), integer(action.get("minutes"))) }
          else -> shapeError()
        }
      }
      RawReminder(
        string(reminder.get("key")), string(reminder.get("channel")), icon, string(reminder.get("title")),
        string(lock.get("title")), string(lock.get("text")), string(reminder.get("url")),
        string(recurrence.get("from")), until, list(recurrence.get("weekdays")).map(::integer), string(reminder.get("at")), stages, actions,
        list(reminder.get("settled")).map(::string), string(reminder.get("data")),
      )
    }
    return RawSchedule(channels, reminders)
  }

  private fun isDate(value: String): Boolean =
    dateFormat.matches(value) && try { LocalDate.parse(value); true } catch (_: DateTimeParseException) { false }
  private fun <T : Comparable<T>> ascending(values: List<T>) = values.zipWithNext().all { (a, b) -> a < b }

  private fun semantics(schedule: RawSchedule) {
    val channels = mutableSetOf<String>()
    for (channel in schedule.channels) {
      if (channel.id.isEmpty() || channel.id in channels || channel.name.isEmpty() || channel.groupId.isEmpty() || channel.groupName.isEmpty()) throw Invalid("invalid-channel")
      channels += channel.id
    }
    val keys = mutableSetOf<String>()
    for (reminder in schedule.reminders) {
      if (reminder.key.isEmpty() || reminder.key in keys) throw Invalid("invalid-key")
      if (reminder.channel !in channels) throw Invalid("invalid-channel")
      if (!isDate(reminder.from) || (reminder.until != null && !isDate(reminder.until)) || !reminder.settled.all(::isDate)) throw Invalid("invalid-date")
      if (reminder.weekdays.isEmpty() || !ascending(reminder.weekdays) || reminder.weekdays.any { it < 1 || it > 7 }) throw Invalid("invalid-recurrence")
      if (reminder.until != null && reminder.until < reminder.from) throw Invalid("invalid-recurrence")
      if (!timeFormat.matches(reminder.at)) throw Invalid("invalid-time")
      if (reminder.stages.isEmpty() || !ascending(reminder.stages.map { it.offset }) || reminder.stages.any { it.offset < -MAX_OFFSET || it.offset > MAX_OFFSET }) throw Invalid("invalid-stages")
      if (reminder.actions.size > 3) throw Invalid("invalid-actions")
      val actionIds = mutableSetOf<String>()
      for (action in reminder.actions) {
        if (action.id.isEmpty() || action.id in actionIds || action.label.isEmpty()) throw Invalid("invalid-actions")
        if (action.minutes != null && (action.minutes < 1 || action.minutes > 1440)) throw Invalid("invalid-actions")
        actionIds += action.id
      }
      if (!ascending(reminder.settled)) throw Invalid("invalid-settled")
      if (reminder.title.isEmpty() || reminder.url.isEmpty() || reminder.lockTitle.isEmpty() || reminder.lockText.isEmpty() || reminder.stages.any { it.text.isEmpty() || it.title == "" }) throw Invalid("invalid-content")
      keys += reminder.key
    }
  }

  private fun build(schedule: RawSchedule) = Schedule(
    schedule.channels.map { Channel(it.id, it.name, it.groupId, it.groupName) },
    schedule.reminders.map { reminder ->
      Reminder(
        reminder.key, reminder.channel, reminder.icon, reminder.title, reminder.lockTitle, reminder.lockText, reminder.url,
        Recurrence(LocalDate.parse(reminder.from), reminder.until?.let(LocalDate::parse), reminder.weekdays.toSet()),
        LocalTime.parse(reminder.at),
        reminder.stages.map { Stage(it.offset, it.wake, it.text, it.fullScreen, it.title, it.icon, it.tone) },
        reminder.actions.map { Action(it.id, it.label, it.minutes) },
        reminder.settled.map(LocalDate::parse).toSet(),
        reminder.data,
      )
    },
  )
}
