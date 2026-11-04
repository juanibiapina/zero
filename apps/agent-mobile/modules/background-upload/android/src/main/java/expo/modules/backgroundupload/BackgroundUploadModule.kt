package expo.modules.backgroundupload

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class BackgroundUploadModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("BackgroundUpload")

    // Android refuses to start a foreground service while the app is in the
    // background; the upload then runs unprotected, as it did before.
    Function("start") {
      BackgroundUploadService.wanted = true
      val intent = Intent(context, BackgroundUploadService::class.java)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
        true
      } catch (_: Exception) {
        BackgroundUploadService.wanted = false
        false
      }
    }

    Function("stop") {
      BackgroundUploadService.wanted = false
      Handler(Looper.getMainLooper()).post {
        if (!BackgroundUploadService.wanted) BackgroundUploadService.running?.finish()
      }
    }
  }
}
