package expo.modules.medicinereminders

import android.app.AlarmManager
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
import java.time.ZoneId

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MedicineContractTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()
  private val alarms: AlarmManager get() = context.getSystemService(AlarmManager::class.java)
  private val manager: NotificationManager get() = context.getSystemService(NotificationManager::class.java)
  private val workspace = "workspace"

  private fun fixture(name: String) = JSONObject(requireNotNull(javaClass.classLoader?.getResource(name)) { "Missing contract fixture $name" }.readText())
  private fun at(instant: String, zone: String) { MedicineEngine.clock = { Clock.fixed(Instant.parse(instant), ZoneId.of(zone)) } }
  private fun plan(medicine: JSONObject) = JSONObject().put("medicines", JSONArray().put(medicine)).put("confirmed", JSONArray()).toString()
  private fun payloads() = shadowOf(alarms).scheduledAlarms.map { JSONObject(shadowOf(it.operation).savedIntent.getStringExtra("payload")!!) }
  private fun objects(array: JSONArray) = (0 until array.length()).map { array.getJSONObject(it) }
  private fun contractDose(dose: JSONObject) = listOf(dose.getString("id"), dose.getString("medicineId"), dose.getString("slotId"), dose.getString("on"), Instant.parse(dose.getString("scheduledAt")))
  private fun fields(receipt: JSONObject) = receipt.keys().asSequence().filter { it != "actionId" }.associateWith { receipt.get(it).takeUnless { value -> value == JSONObject.NULL } }

  @Before
  fun enableScheduling() { ShadowAlarmManager.setCanScheduleExactAlarms(true) }

  @After
  fun restoreClock() { MedicineEngine.clock = { Clock.systemDefaultZone() } }

  @Test
  fun plansTheSameDosesAsAgentCore() {
    for (case in objects(fixture("occurrences.json").getJSONArray("cases"))) {
      at(case.getString("now"), case.getString("zone"))
      MedicineEngine.clear(context, workspace)
      MedicineEngine.replace(context, workspace, plan(case.getJSONObject("medicine")))
      val planned = payloads()
        .filter { it.getString("kind") == "alarm" }
        .flatMap { objects(it.getJSONArray("doses")) }
        .filter { it.getString("on") == case.getString("on") }
        .map(::contractDose)
        .sortedBy { it.toString() }
      val expected = objects(case.getJSONArray("doses")).map(::contractDose).sortedBy { it.toString() }
      assertEquals(case.getString("name"), expected, planned)
    }
  }

  @Test
  fun writesTheReceiptsAgentCoreReads() {
    val contract = fixture("receipts.json")
    val zone = contract.getString("zone")
    at(contract.getString("installedAt"), zone)
    MedicineEngine.replace(context, workspace, plan(contract.getJSONObject("medicine")))
    at(contract.getString("presentedAt"), zone)
    MedicineEngine.deliver(context, payloads().first { it.getString("kind") == "reminder" }.toString())
    at(contract.getString("takenAt"), zone)
    val expected = objects(contract.getJSONArray("receipts"))
    val notification = shadowOf(manager).getNotification(expected.first().getString("id"), 0)
    MedicineReceiver().onReceive(context, shadowOf(notification.actions.single().actionIntent).savedIntent)

    val written = objects(JSONArray(MedicineEngine.receipts(context, workspace)))
    assertEquals(expected.map(::fields), written.map(::fields))
    assertTrue(written.all { it.getString("actionId").isNotBlank() })
  }
}
