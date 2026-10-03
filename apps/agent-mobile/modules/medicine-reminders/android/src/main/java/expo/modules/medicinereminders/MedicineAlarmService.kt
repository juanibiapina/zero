package expo.modules.medicinereminders

import android.app.*
import android.content.*
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Handler
import android.os.Looper
import org.json.JSONObject

internal data class AlarmSession(val workspace: String, val id: String, val doses: List<JSONObject>)

class MedicineAlarmService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val ringing = mutableMapOf<String, Runnable>()
  private var sound: Ringtone? = null
  private val occurrences = mutableMapOf<String, JSONObject>()
  private var workspace = ""
  private var session = ""
  override fun onBind(intent: Intent?) = null
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val dose = intent?.getStringExtra("dose")?.let(::JSONObject) ?: run { stopSelf(); return START_NOT_STICKY }
    val id = dose.getString("id")
    val owner = intent.getStringExtra("workspace") ?: ""
    if (!MedicineEngine.canRing(this, owner, dose)) { if (ringing.isEmpty()) stopSelf(); return START_NOT_STICKY }
    workspace = owner
    if (ringing.isEmpty()) session = java.util.UUID.randomUUID().toString()
    occurrences[id] = dose
    startForeground(7402, MedicineEngine.notification(this, workspace, dose, true, session))
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
    publish()
    return START_NOT_STICKY
  }
  private fun finish(id: String, remember: Boolean = true) {
    ringing.remove(id)?.let(handler::removeCallbacks)
    val occurrence = occurrences.remove(id)
    if (ringing.isEmpty()) {
      sound?.stop(); sound = null
      stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    } else {
      getSystemService(NotificationManager::class.java).notify(7402, MedicineEngine.notification(this, workspace, occurrences.values.first(), true, session))
    }
    publish()
    if (remember && occurrence != null) {
      try { MedicineEngine.endAlarm(this, workspace, occurrence) }
      catch (error: Exception) { android.util.Log.e("MedicineReminders", "Alarm stopped but dismissal could not be saved", error) }
    }
  }
  override fun onDestroy() { if (active === this) active = null; handler.removeCallbacksAndMessages(null); sound?.stop(); publish(); super.onDestroy() }
  companion object {
    private val listeners = mutableSetOf<() -> Unit>()
    private fun publish() { listeners.toList().forEach { it() } }
    internal fun observe(listener: () -> Unit): () -> Unit {
      listeners.add(listener)
      return { listeners.remove(listener) }
    }
    internal fun current(): AlarmSession? = active?.takeIf { it.ringing.isNotEmpty() }?.let {
      AlarmSession(it.workspace, it.session, it.occurrences.values.map { dose -> JSONObject(dose.toString()) })
    }
    fun remove(c: Context, id: String) {
      // Do not start an absent service just to stop it.
      active?.let { service -> service.handler.post { service.finish(id) } }
    }
    fun takeAlarm(workspace: String, session: String) {
      active?.takeIf { it.workspace == workspace && it.session == session }?.let { service ->
        service.sound?.stop(); service.sound = null
        MedicineEngine.takeDoses(service, workspace, service.occurrences.values.toList())
        stopAlarm(workspace, session)
      }
    }
    fun stopAlarm(workspace: String, session: String) {
      active?.takeIf { it.workspace == workspace && it.session == session }?.let { service ->
        service.sound?.stop(); service.sound = null
        service.ringing.keys.toList().forEach { service.finish(it) }
      }
    }
    fun stopAll(c: Context) {
      active?.let { service ->
        val discard = Runnable {
          service.sound?.stop(); service.sound = null
          service.ringing.keys.toList().forEach { service.finish(it, false) }
        }
        if (Looper.myLooper() == service.handler.looper) discard.run() else service.handler.post(discard)
      }
      c.stopService(Intent(c, MedicineAlarmService::class.java))
    }
    @Volatile private var active: MedicineAlarmService? = null
  }
  override fun onCreate() { super.onCreate(); active = this }
}
