package st.spacegho.melodica.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.widget.FrameLayout;
import java.io.OutputStream;
import org.json.JSONObject;

public final class PlayerActivity extends Activity {
    private MobileApp app;
    private FrameLayout frame;
    private int permissionRequest;
    private ValueCallback<Uri[]> files;
    private byte[] export;
    private int exportId;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        app = (MobileApp)getApplication();
        app.attach(this);
        frame = new FrameLayout(this);
        if (android.os.Build.VERSION.SDK_INT >= 35) frame.setOnApplyWindowInsetsListener((v,insets) -> {
            android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
            v.setPadding(bars.left,bars.top,bars.right,bars.bottom);
            return insets;
        });
        if (app.web.getParent() instanceof ViewGroup) ((ViewGroup)app.web.getParent()).removeView(app.web);
        frame.addView(app.web);
        setContentView(frame);
        dispatch(getIntent());
    }
    @Override public void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); dispatch(intent); }
    private void dispatch(Intent intent) {
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) app.openListenLink(intent.getData());
        String station = intent.getStringExtra("station");
        if (station != null && !station.isEmpty()) app.station(station);
        if (android.provider.MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH.equals(intent.getAction())) {
            String query = intent.getStringExtra(android.app.SearchManager.QUERY);
            if (query != null) for (int i = 0; i < app.stations.length(); i++) {
                JSONObject item = app.stations.optJSONObject(i);
                if (item != null && item.optString("name").equalsIgnoreCase(query.trim())) {
                    app.station(item.optString("id")); return;
                }
            }
        }
    }
    @Override public void onResume() { super.onResume(); app.visible = true; app.web.onResume(); }
    @Override public void onPause() { app.visible = false; super.onPause(); }
    @Override public void onDestroy() {
        if (files != null) files.onReceiveValue(null);
        if (permissionRequest != 0) app.reply(permissionRequest,null,"The location request was interrupted.");
        if (export != null) app.reply(exportId,null,"The file picker closed.");
        if (app.activity == this) {
            app.activity = null;
            frame.removeView(app.web);
            app.webContext.setBaseContext(app);
        }
        super.onDestroy();
    }
    @Override public void onBackPressed() {
        if (app.web.canGoBack()) app.web.goBack();
        else super.onBackPressed();
    }
    void startWalk(int id) {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            app.beginWalk(id);
        } else if (permissionRequest == 0) {
            permissionRequest = id;
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION},11);
        } else app.reply(id,null,"Location permission is already being requested.");
    }
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] grants) {
        super.onRequestPermissionsResult(request,permissions,grants);
        if (request != 11) return;
        int id = permissionRequest;
        permissionRequest = 0;
        for (int grant : grants) if (grant == PackageManager.PERMISSION_GRANTED) { app.beginWalk(id); return; }
        app.reply(id,null,"Allow location to record a walk. Music can still play.");
    }
    boolean chooseFile(ValueCallback<Uri[]> callback,WebChromeClient.FileChooserParams params) {
        if (files != null) files.onReceiveValue(null);
        files = callback;
        try {
            Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
            startActivityForResult(pick,12);
            return true;
        } catch (RuntimeException e) { files = null; return false; }
    }
    void saveFile(int id,String name,String mime,byte[] data) {
        if (export != null) { app.reply(id,null,"Finish the current file export first."); return; }
        export = data; exportId = id;
        try { startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mime).putExtra(Intent.EXTRA_TITLE,name),13); }
        catch (RuntimeException e) { export = null; app.reply(id,null,"The file picker could not open."); }
    }
    @Override public void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);
        Uri uri = data == null ? null : data.getData();
        if (request == 12 && files != null) {
            files.onReceiveValue(result == RESULT_OK && uri != null ? new Uri[]{uri} : null);
            files = null;
        } else if (request == 13 && export != null) {
            byte[] bytes = export; int id = exportId; export = null;
            if (result != RESULT_OK || uri == null) { app.reply(id,false,null); return; }
            app.io.execute(() -> {
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    if (out == null) throw new java.io.IOException();
                    out.write(bytes);
                    app.main.post(() -> app.reply(id,true,null));
                } catch (Exception e) { app.main.post(() -> app.reply(id,null,"The file could not be saved.")); }
            });
        }
    }
}
