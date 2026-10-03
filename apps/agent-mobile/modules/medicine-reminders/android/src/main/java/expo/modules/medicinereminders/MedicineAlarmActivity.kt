package expo.modules.medicinereminders

import android.app.Activity
import android.content.res.Configuration
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.os.Bundle
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

class MedicineAlarmActivity : Activity() {
  private var unsubscribe: (() -> Unit)? = null
  private var foregroundColor = Color.BLACK
  private var secondaryColor = Color.DKGRAY
  private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
  private fun systemColor(name: String, fallback: String): Int {
    val id = if (Build.VERSION.SDK_INT >= 31) resources.getIdentifier(name, "color", "android") else 0
    return if (id != 0) getColor(id) else Color.parseColor(fallback)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
    setTheme(if (dark) android.R.style.Theme_Material_NoActionBar else android.R.style.Theme_Material_Light_NoActionBar)
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { keepAlarmVisible() }
    if (Build.VERSION.SDK_INT >= 27) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    val session = MedicineAlarmService.current()
    if (session == null || intent.getStringExtra("workspace") != session.workspace || intent.getStringExtra("session") != session.id) {
      finish()
      return
    }
    val surface = systemColor(if (dark) "system_neutral1_900" else "system_neutral1_10", if (dark) "#191C20" else "#FAFAFA")
    foregroundColor = systemColor(if (dark) "system_neutral1_50" else "system_neutral1_900", if (dark) "#F1F3F4" else "#202124")
    secondaryColor = systemColor(if (dark) "system_neutral2_200" else "system_neutral2_700", if (dark) "#BDC1C6" else "#5F6368")
    val primary = systemColor(if (dark) "system_accent1_200" else "system_accent1_600", if (dark) "#AAC7FF" else "#0B57D0")
    val onPrimary = systemColor(if (dark) "system_accent1_800" else "system_accent1_0", if (dark) "#062E6F" else "#FFFFFF")
    val neutral = systemColor(if (dark) "system_neutral2_800" else "system_neutral2_100", if (dark) "#30343B" else "#E9EEF6")
    val spacing = dp(24)
    val content = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(surface)
      setPadding(spacing, spacing, spacing, spacing)
    }
    val details = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER }
    renderDetails(details, session)
    content.addView(ScrollView(this).apply { isFillViewport = true; addView(details) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    val errorMessage = TextView(this).apply {
      visibility = View.GONE
      textSize = 16f
      gravity = Gravity.CENTER
      setTextColor(foregroundColor)
      setPadding(0, dp(16), 0, dp(16))
      accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }
    content.addView(errorMessage)
    val largeText = resources.configuration.fontScale > 1.3f
    val actions = LinearLayout(this).apply {
      orientation = if (largeText) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
      setPadding(0, dp(24), 0, 0)
    }
    val stop = actionButton("Stop alarm", neutral, foregroundColor) {
      MedicineAlarmService.stopAlarm(session.workspace, session.id)
    }
    val taken = actionButton("Taken", primary, onPrimary) {
      try { MedicineAlarmService.takeAlarm(session.workspace, session.id) }
      catch (error: Exception) {
        errorMessage.text = "Could not save Taken. Try again or stop the alarm."
        errorMessage.visibility = View.VISIBLE
      }
    }
    for ((index, button) in listOf(stop, taken).withIndex()) {
      val params = if (largeText) LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        else LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
      if (index > 0) { if (largeText) params.topMargin = dp(12) else params.leftMargin = dp(16) }
      actions.addView(button, params)
    }
    content.addView(actions)
    content.setOnApplyWindowInsetsListener { view, insets ->
      if (Build.VERSION.SDK_INT >= 30) {
        val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        view.setPadding(spacing + bars.left, spacing + bars.top, spacing + bars.right, spacing + bars.bottom)
      } else {
        @Suppress("DEPRECATION")
        view.setPadding(spacing + insets.systemWindowInsetLeft, spacing + insets.systemWindowInsetTop, spacing + insets.systemWindowInsetRight, spacing + insets.systemWindowInsetBottom)
      }
      insets
    }
    setContentView(content)
    if (Build.VERSION.SDK_INT >= 30) {
      val mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
      window.insetsController?.setSystemBarsAppearance(if (dark) 0 else mask, mask)
    } else {
      @Suppress("DEPRECATION")
      window.decorView.systemUiVisibility = if (dark) 0 else View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
    }
    unsubscribe = MedicineAlarmService.observe {
      val current = MedicineAlarmService.current()
      if (current == null || current.id != session.id || current.workspace != session.workspace) finish()
      else renderDetails(details, current)
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

  private fun renderDetails(details: LinearLayout, session: AlarmSession) {
    details.removeAllViews()
    for ((index, dose) in session.doses.withIndex()) {
      val medicine = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setPadding(0, if (index == 0) dp(24) else dp(40), 0, dp(24))
      }
      medicine.addView(TextView(this).apply {
        text = dose.getString("name")
        textSize = 36f
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        gravity = Gravity.CENTER
        setTextColor(foregroundColor)
        setPadding(0, 0, 0, dp(12))
      })
      medicine.addView(TextView(this).apply {
        text = dose.getString("alarmLabel")
        textSize = 24f
        fontFeatureSettings = "tnum"
        gravity = Gravity.CENTER
        setTextColor(secondaryColor)
      })
      val instructions = dose.optString("instructions")
      if (instructions.isNotBlank()) medicine.addView(TextView(this).apply {
        text = instructions
        textSize = 18f
        gravity = Gravity.CENTER
        setTextColor(secondaryColor)
        setPadding(0, dp(12), 0, 0)
      })
      details.addView(medicine, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
  }
  private fun keepAlarmVisible() { if (MedicineAlarmService.current() == null) finish() }
  @Deprecated("Uses the native alarm gate")
  override fun onBackPressed() { keepAlarmVisible() }
  override fun onDestroy() { unsubscribe?.invoke(); super.onDestroy() }
}
