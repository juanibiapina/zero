package expo.modules.zeronotifications

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

internal interface AlarmSound {
  fun play()
  fun stop()
}

private class RingtoneAlarmSound(c: Context) : AlarmSound {
  private val ringtone: Ringtone? = (RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION))
    ?.let { RingtoneManager.getRingtone(c, it) }
    ?.apply {
      audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
      if (Build.VERSION.SDK_INT >= 28) isLooping = true
    }
  override fun play() { ringtone?.play() }
  override fun stop() { ringtone?.stop() }
}

class ReminderScreenActivity : Activity() {
  private class Target(val workspace: String, val source: String, val key: String, val date: String, val shownAt: Long)

  private val handler = Handler(Looper.getMainLooper())
  private val silence = Runnable { stopSound() }
  private var target: Target? = null
  private var sound: AlarmSound? = null
  private var rang: Target? = null
  private var unsubscribe: (() -> Unit)? = null
  private lateinit var title: TextView
  private lateinit var text: TextView
  private lateinit var error: TextView
  private lateinit var actions: LinearLayout
  private var foregroundColor = Color.BLACK
  private var secondaryColor = Color.DKGRAY
  private var primary = Color.BLUE
  private var onPrimary = Color.WHITE
  private var neutral = Color.LTGRAY

  private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
  private fun systemColor(name: String, fallback: String): Int {
    val id = if (Build.VERSION.SDK_INT >= 31) resources.getIdentifier(name, "color", "android") else 0
    return if (id != 0) getColor(id) else Color.parseColor(fallback)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
    setTheme(if (dark) android.R.style.Theme_Material_NoActionBar else android.R.style.Theme_Material_Light_NoActionBar)
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= 27) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    }
    val surface = systemColor(if (dark) "system_neutral1_900" else "system_neutral1_10", if (dark) "#191C20" else "#FAFAFA")
    foregroundColor = systemColor(if (dark) "system_neutral1_50" else "system_neutral1_900", if (dark) "#F1F3F4" else "#202124")
    secondaryColor = systemColor(if (dark) "system_neutral2_200" else "system_neutral2_700", if (dark) "#BDC1C6" else "#5F6368")
    primary = systemColor(if (dark) "system_accent1_200" else "system_accent1_600", if (dark) "#AAC7FF" else "#0B57D0")
    onPrimary = systemColor(if (dark) "system_accent1_800" else "system_accent1_0", if (dark) "#062E6F" else "#FFFFFF")
    neutral = systemColor(if (dark) "system_neutral2_800" else "system_neutral2_100", if (dark) "#30343B" else "#E9EEF6")
    setContentView(layout(surface))
    if (Build.VERSION.SDK_INT >= 30) {
      val mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
      window.insetsController?.setSystemBarsAppearance(if (dark) 0 else mask, mask)
    } else {
      @Suppress("DEPRECATION")
      window.decorView.systemUiVisibility = if (dark) 0 else View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
    }
    unsubscribe = NotificationEngine.observe { handler.post { if (!isFinishing) refresh() } }
    open(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    stopSound()
    open(intent)
    ring()
  }

  override fun onResume() {
    super.onResume()
    ring()
  }

  override fun onStop() {
    stopSound()
    super.onStop()
  }

  override fun onDestroy() {
    unsubscribe?.invoke()
    stopSound()
    super.onDestroy()
  }

  private fun open(intent: Intent) {
    target = Target(
      intent.getStringExtra("workspace") ?: "", intent.getStringExtra("source") ?: "", intent.getStringExtra("key") ?: "",
      intent.getStringExtra("date") ?: "", intent.getLongExtra("shownAt", -1),
    )
    error.visibility = View.GONE
    refresh()
  }

  private fun content() = target?.let { NotificationEngine.screen(this, it.workspace, it.source, it.key, it.date, it.shownAt) }

  private fun refresh() {
    val content = content() ?: return close()
    title.text = content.title
    text.text = content.text
    actions.removeAllViews()
    val largeText = resources.configuration.fontScale > 1.3f
    actions.orientation = if (largeText) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
    for ((index, action) in content.actions.withIndex()) {
      val button = actionButton(action.label, if (action.settles) primary else neutral, if (action.settles) onPrimary else foregroundColor) { press(action) }
      val params = if (largeText) LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        else LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
      if (index > 0) { if (largeText) params.topMargin = dp(12) else params.leftMargin = dp(16) }
      actions.addView(button, params)
    }
  }

  private fun press(action: Action) {
    val current = target ?: return
    stopSound()
    try {
      NotificationEngine.button(this, current.workspace, current.source, current.key, current.date, action.id, current.shownAt)
    } catch (failure: Exception) {
      Log.e(NotificationEngine.TAG, "Screen button failed", failure)
      error.text = "Couldn’t save. Try again."
      error.visibility = View.VISIBLE
      return
    }
    close()
  }

  private fun ring() {
    val current = target ?: return
    if (rang === current || content() == null) return
    rang = current
    if (NotificationEngine.muted(this, current.workspace)) return
    sound = alarmSound(this).also { it.play() }
    handler.postDelayed(silence, RING_MS)
  }

  private fun stopSound() {
    handler.removeCallbacks(silence)
    sound?.stop()
    sound = null
  }

  private fun close() {
    stopSound()
    if (!isFinishing) finish()
  }

  private fun layout(surface: Int): View {
    val spacing = dp(24)
    title = TextView(this).apply {
      textSize = 36f
      typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      gravity = Gravity.CENTER
      setTextColor(foregroundColor)
      setPadding(0, 0, 0, dp(12))
    }
    text = TextView(this).apply {
      textSize = 22f
      gravity = Gravity.CENTER
      setTextColor(secondaryColor)
    }
    error = TextView(this).apply {
      visibility = View.GONE
      textSize = 16f
      gravity = Gravity.CENTER
      setTextColor(foregroundColor)
      setPadding(0, dp(16), 0, dp(16))
      accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }
    actions = LinearLayout(this).apply { setPadding(0, dp(24), 0, 0) }
    val details = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      addView(title)
      addView(text)
    }
    return LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(surface)
      setPadding(spacing, spacing, spacing, spacing)
      addView(ScrollView(this@ReminderScreenActivity).apply { isFillViewport = true; addView(details) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
      addView(error)
      addView(actions)
      setOnApplyWindowInsetsListener { view, insets ->
        if (Build.VERSION.SDK_INT >= 30) {
          val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
          view.setPadding(spacing + bars.left, spacing + bars.top, spacing + bars.right, spacing + bars.bottom)
        } else {
          @Suppress("DEPRECATION")
          view.setPadding(spacing + insets.systemWindowInsetLeft, spacing + insets.systemWindowInsetTop, spacing + insets.systemWindowInsetRight, spacing + insets.systemWindowInsetBottom)
        }
        insets
      }
    }
  }

  private fun actionButton(label: String, color: Int, textColor: Int, action: () -> Unit) = Button(this).apply {
    text = label
    isAllCaps = false
    textSize = 18f
    typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    minWidth = 0
    minimumWidth = 0
    minimumHeight = dp(72)
    setPadding(dp(16), dp(20), dp(16), dp(20))
    setTextColor(textColor)
    val shape = GradientDrawable().apply { setColor(color); cornerRadius = dp(40).toFloat() }
    background = RippleDrawable(ColorStateList.valueOf(Color.argb(40, Color.red(textColor), Color.green(textColor), Color.blue(textColor))), shape, null)
    elevation = 0f
    setOnClickListener { action() }
  }

  internal companion object {
    const val RING_MS = 60_000L
    var alarmSound: (Context) -> AlarmSound = ::RingtoneAlarmSound
  }
}
