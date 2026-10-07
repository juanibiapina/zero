package expo.modules.zeronotifications

import android.app.NotificationManager
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAlarmManager
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ConformanceTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()
  private fun fixture(name: String) = JSONObject(requireNotNull(javaClass.classLoader?.getResource(name)) { "Missing conformance fixture $name" }.readText())
  private fun objects(array: JSONArray) = (0 until array.length()).map { array.getJSONObject(it) }
  private fun text(value: Any): String = if (value is String) JSONObject.quote(value) else value.toString()
  private fun recurrence(json: JSONObject) = Recurrence(
    LocalDate.parse(json.getString("from")),
    if (json.isNull("until")) null else LocalDate.parse(json.getString("until")),
    (0 until json.getJSONArray("weekdays").length()).map { json.getJSONArray("weekdays").getInt(it) }.toSet(),
  )

  @Before
  fun enableScheduling() { ShadowAlarmManager.setCanScheduleExactAlarms(true) }

  @After
  fun restoreClock() { NotificationEngine.clock = { Clock.systemDefaultZone() } }

  @Test
  fun parsesSchedulesLikeTypeScript() {
    for (case in objects(fixture("schedule-parse.json").getJSONArray("cases"))) {
      val expected = case.getJSONObject("expected")
      val actual = when (val result = ScheduleParser.parse(text(case.get("input")))) {
        is ScheduleResult.Ok -> JSONObject().put("ok", true)
        is ScheduleResult.Error -> JSONObject().put("error", result.code)
      }
      assertEquals(case.getString("name"), expected.toString(), actual.toString())
    }
  }

  @Test
  fun followsRecurrencesLikeTypeScript() {
    for (case in objects(fixture("recurrence.json").getJSONArray("cases"))) {
      val rule = recurrence(case.getJSONObject("recurrence"))
      for (check in objects(case.getJSONArray("occursOn"))) {
        assertEquals("${case.getString("name")} on ${check.getString("date")}", check.getBoolean("expected"), rule.occursOn(LocalDate.parse(check.getString("date"))))
      }
      for (check in objects(case.getJSONArray("nextOccurrence"))) {
        val expected = if (check.isNull("expected")) null else LocalDate.parse(check.getString("expected"))
        assertEquals("${case.getString("name")} from ${check.getString("from")}", expected, rule.nextOccurrence(LocalDate.parse(check.getString("from"))))
      }
    }
  }

  @Test
  fun writesTheReceiptsTypeScriptReads() {
    val contract = fixture("receipts.json")
    val zone = ZoneId.of(contract.getString("zone"))
    val source = contract.getString("source")
    fun at(instant: String) { NotificationEngine.clock = { Clock.fixed(Instant.parse(instant), zone) } }
    at(contract.getString("installedAt"))
    NotificationEngine.install(context, "workspace", source, contract.getJSONObject("schedule").toString())
    at(contract.getString("presentedAt"))
    NotificationEngine.wake(context)
    at(contract.getString("settledAt"))
    val expected = objects(contract.getJSONArray("receipts"))
    val manager = context.getSystemService(NotificationManager::class.java)
    val card = shadowOf(manager).getNotification(NotificationEngine.occurrence(source, expected.first().getString("key"), expected.first().getString("date")), 0)
    NotificationReceiver().onReceive(context, shadowOf(card.actions.first { it.title == "Taken" }.actionIntent).savedIntent)

    val written = objects(JSONArray(NotificationEngine.receipts(context, "workspace", source)))
    fun fields(receipt: JSONObject) = receipt.keys().asSequence().filter { it != "id" }.associateWith { receipt.get(it) }
    assertEquals(expected.map(::fields), written.map(::fields))
    assertTrue(written.all { it.getString("id").isNotBlank() })
  }
}
