package expo.modules.medicinereminders

import android.app.*
import android.content.*
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Handler
import android.os.Looper
import org.json.JSONObject

class MedicineAlarmService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val ringing = mutableMapOf<String, Runnable>()
  private var sound: Ringtone? = null
  private val occurrences = mutableMapOf<String, JSONObject>()
  private var workspace = ""
  override fun onBind(intent: Intent?) = null
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "medicine.remove") {
      val id = intent.getStringExtra("id")
      if (id == null) ringing.keys.toList().forEach { finish(it) } else finish(id)
      if (ringing.isEmpty()) stopSelf()
      return START_NOT_STICKY
    }
    val dose = intent?.getStringExtra("dose")?.let(::JSONObject) ?: run { stopSelf(); return START_NOT_STICKY }
    val id = dose.getString("id")
    if (!MedicineEngine.canRing(this, dose)) { if (ringing.isEmpty()) stopSelf(); return START_NOT_STICKY }
    workspace = intent.getStringExtra("workspace") ?: ""
    occurrences[id] = dose
    startForeground(7402, MedicineEngine.notification(this, workspace, dose, true))
    if (!ringing.containsKey(id)) {
      val timeout = Runnable { finish(id) }
      ringing[id] = timeout
      handler.postDelayed(timeout, 60_000)
    }
    if (sound == null && !MedicineEngine.proofMuted(this)) {
      sound = RingtoneManager.getRingtone(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM))?.apply {
        audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        isLooping = true
        play()
      }
    }
    return START_NOT_STICKY
  }
  private fun finish(id: String) {
    ringing.remove(id)?.let(handler::removeCallbacks)
    occurrences.remove(id)
    if (ringing.isEmpty()) {
      sound?.stop(); sound = null
      stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    } else {
      getSystemService(NotificationManager::class.java).notify(7402, MedicineEngine.notification(this, workspace, occurrences.values.first(), true))
    }
  }
  override fun onDestroy() { active = null; handler.removeCallbacksAndMessages(null); sound?.stop(); super.onDestroy() }
  companion object {
    fun remove(c: Context, id: String) {
      // Do not start an absent service just to stop it.
      active?.let { service -> service.handler.post { service.finish(id) } }
    }
    fun stopAll(c: Context) { c.stopService(Intent(c, MedicineAlarmService::class.java)) }
    private var active: MedicineAlarmService? = null
  }
  override fun onCreate() { super.onCreate(); active = this }
}
