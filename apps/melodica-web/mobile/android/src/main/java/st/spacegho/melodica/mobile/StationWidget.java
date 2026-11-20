package st.spacegho.melodica.mobile;

import android.app.PendingIntent;
import android.appwidget.*;
import android.content.*;
import android.net.Uri;
import android.widget.RemoteViews;
import java.util.UUID;
import org.json.*;

public final class StationWidget extends AppWidgetProvider {
    private static final String PIN = "st.spacegho.melodica.PIN_WIDGET";
    private static final String PREFIX = "st.spacegho.melodica.";
    private static ComponentName component(Context context) { return new ComponentName(context,StationWidget.class); }
    static boolean pin(MobileApp app,String id,String name) {
        if (!app.hasStation(id)) return false;
        AppWidgetManager manager = AppWidgetManager.getInstance(app);
        if (!manager.isRequestPinAppWidgetSupported()) return false;
        Intent result = new Intent(app,StationWidget.class).setAction(PIN)
            .setData(Uri.fromParts("melodica-widget",UUID.randomUUID().toString(),null)).putExtra("station",id);
        return manager.requestPinAppWidget(component(app),null,PendingIntent.getBroadcast(app,0,result,
            PendingIntent.FLAG_ONE_SHOT | PendingIntent.FLAG_MUTABLE));
    }
    static void update(MobileApp app) {
        AppWidgetManager manager = AppWidgetManager.getInstance(app);
        new StationWidget().onUpdate(app,manager,manager.getAppWidgetIds(component(app)));
    }
    @Override public void onReceive(Context context,Intent intent) {
        super.onReceive(context,intent);
        MobileApp app = (MobileApp)context.getApplicationContext();
        String action = intent.getAction();
        if (PIN.equals(action)) {
            int widget = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,AppWidgetManager.INVALID_APPWIDGET_ID);
            String station = intent.getStringExtra("station");
            if (widget != AppWidgetManager.INVALID_APPWIDGET_ID && app.hasStation(station)) {
                app.getSharedPreferences("widgets",0).edit().putString("station."+widget,station).apply(); update(app);
            }
        } else if ((PREFIX+"finishWalk").equals(action)) {
            try { app.walks.finish(); app.updateRecording(); app.event("walkUpdate",new JSONObject()); }
            catch (JSONException ignored) { }
        } else if ((PREFIX+"pause").equals(action) || (PREFIX+"play").equals(action) || (PREFIX+"skip").equals(action)) {
            if ((PREFIX+"pause").equals(action)) app.cancelResume();
            app.event("media",MobileApp.object("action",action.substring(PREFIX.length())));
        }
    }
    @Override public void onUpdate(Context context,AppWidgetManager manager,int[] ids) {
        MobileApp app = (MobileApp)context.getApplicationContext();
        for (int widget : ids) {
            String id = app.getSharedPreferences("widgets",0).getString("station."+widget,"");
            JSONObject station = app.findStation(id);
            RemoteViews views = new RemoteViews(context.getPackageName(),R.layout.station_widget);
            views.setTextViewText(R.id.station,station == null ? "Open Melodica" : station.optString("name"));
            Intent open = new Intent(context,PlayerActivity.class).setAction("st.spacegho.melodica.widget."+widget)
                .putExtra("station",station == null ? "" : id);
            views.setOnClickPendingIntent(R.id.station,PendingIntent.getActivity(context,widget,open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            manager.updateAppWidget(widget,views);
        }
    }
    @Override public void onDeleted(Context context,int[] ids) {
        SharedPreferences.Editor edit = context.getSharedPreferences("widgets",0).edit();
        for (int id : ids) edit.remove("station."+id);
        edit.apply();
    }
}
