package expo.modules.zeronotifications

import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

internal object LegacyMedicineMigration {
  private const val FILE = "medicine-reminders.json"
  private const val RECEIVER = "expo.modules.medicinereminders.MedicineReceiver"
  private const val SOURCE = "medicines"

  fun migrate(c: Context, now: Long): State? {
    val file = AtomicFile(File(c.noBackupFilesDir, FILE))
    if (!file.baseFile.exists()) return null
    val old = try { JSONObject(String(file.readFully(), Charsets.UTF_8)) } catch (_: Exception) { null }
    file.delete()
    if (old == null) return null
    cancelAlarms(c, old.optJSONArray("scheduled") ?: JSONArray())
    old.optJSONObject("visible")?.keys()?.forEach { c.getSystemService(NotificationManager::class.java).cancel(it, 0) }
    val workspace = old.optString("workspace").ifEmpty { return null }
    val state = State(workspace = workspace, processedUntil = now)
    val receipts = old.optJSONArray("receipts") ?: JSONArray()
    for (i in 0 until receipts.length()) {
      val receipt = receipts.optJSONObject(i) ?: continue
      val converted = convert(receipt) ?: continue
      state.receipts += converted
      if (converted.getString("type") == "settled") state.settledHere += NotificationEngine.occurrence(SOURCE, converted.getString("key"), converted.getString("date"))
    }
    return state
  }

  private fun convert(receipt: JSONObject): JSONObject? {
    val medicine = receipt.optString("medicineId").ifEmpty { return null }
    val slot = receipt.optString("slotId").ifEmpty { return null }
    val date = receipt.optString("on").ifEmpty { return null }
    val alarmAt = receipt.optString("alarmLabel").ifEmpty { return null }
    val converted = JSONObject().put("id", receipt.optString("actionId").ifEmpty { return null }).put("source", SOURCE)
      .put("key", JSONArray(listOf(medicine, slot)).toString()).put("date", date).put("data", JSONObject().put("alarmAt", alarmAt).toString())
    return when (receipt.optString("kind")) {
      "taken" -> converted.put("type", "settled").put("action", "taken").put("at", receipt.optString("takenAt").ifEmpty { return null })
      "presented" -> converted.put("type", "presented").put("at", receipt.optString("stageAt").ifEmpty { receipt.optString("scheduledAt") })
      else -> null
    }
  }

  private fun cancelAlarms(c: Context, scheduled: JSONArray) {
    val alarms = c.getSystemService(AlarmManager::class.java)
    for (i in 0 until scheduled.length()) {
      val identity = scheduled.optJSONObject(i)?.optString("identity")?.ifEmpty { null } ?: continue
      val intent = Intent().setComponent(ComponentName(c.packageName, RECEIVER)).setAction("medicine.delivery").setData(Uri.parse("zero-medicine:${Uri.encode(identity)}"))
      val pending = PendingIntent.getBroadcast(c, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      alarms.cancel(pending)
      pending.cancel()
    }
  }
}
