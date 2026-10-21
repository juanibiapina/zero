package expo.modules.recordwidget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews

class RecordWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(RECORD_URL))
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val open = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val views = RemoteViews(context.packageName, R.layout.record_widget)
    views.setOnClickPendingIntent(R.id.record_widget_button, open)
    manager.updateAppWidget(ids, views)
  }

  companion object {
    const val RECORD_URL = "zeroagent:///browse/record?source=widget"
  }
}
