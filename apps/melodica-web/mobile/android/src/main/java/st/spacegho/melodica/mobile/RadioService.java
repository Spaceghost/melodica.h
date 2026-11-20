package st.spacegho.melodica.mobile;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.location.*;
import android.media.*;
import android.media.browse.MediaBrowser;
import android.media.session.*;
import android.os.*;
import android.service.media.MediaBrowserService;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.*;
import org.json.*;

/** The media session and the location subscription live independently of the activity. */
public final class RadioService extends MediaBrowserService {
    static final String CHANNEL = "radio", ROOT = "stations";
    static final int NOTIFICATION = 10;
    private MobileApp app;
    private MediaSession session;
    private LocationManager locations;
    private LocationListener fixes;
    private Bitmap art;
    private String artPath = "";
    boolean foreground;
    private boolean lingering;
    private final Runnable endPausedSession = () -> { lingering = false; stopForeground(STOP_FOREGROUND_REMOVE);
        getSystemService(NotificationManager.class).cancel(NOTIFICATION); stopSelf(); };

    @Override public void onCreate() {
        super.onCreate();
        app = (MobileApp)getApplication();
        app.service = this;
        locations = getSystemService(LocationManager.class);
        getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel(CHANNEL,"Playback and walk recording",NotificationManager.IMPORTANCE_LOW));
        session = new MediaSession(this,"Melodica");
        session.setSessionActivity(openPlayer());
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { command("play"); }
            @Override public void onPause() { command("pause"); }
            @Override public void onSkipToNext() { command("skip"); }
            @Override public void onStop() { command("pause"); }
            @Override public void onCustomAction(String action, Bundle args) {
                if ("love".equals(action)) command(action);
            }
            @Override public void onSetRating(Rating rating) {
                if (rating != null && rating.isRated() && rating.getRatingStyle() == Rating.RATING_THUMB_UP_DOWN)
                    command(rating.isThumbUp() ? "love" : "ban");
            }
            @Override public void onPlayFromMediaId(String id, Bundle extras) {
                if (app.hasStation(id)) app.station(id);
            }
            @Override public void onPlayFromSearch(String query, Bundle extras) {
                if (query == null || query.trim().isEmpty()) { command("play"); return; }
                for (int i = 0; i < app.stations.length(); i++) {
                    JSONObject station = app.stations.optJSONObject(i);
                    if (station != null && query.trim().equalsIgnoreCase(station.optString("name"))) {
                        app.station(station.optString("id")); return;
                    }
                }
            }
        });
        session.setRatingType(Rating.RATING_THUMB_UP_DOWN);
        setSessionToken(session.getSessionToken());
    }
    private void command(String action) {
        app.ensurePlayer();
        if ("pause".equals(action)) app.cancelResume();
        app.event("media",MobileApp.object("action",action));
    }
    @Override public BrowserRoot onGetRoot(String pkg, int uid, Bundle hints) {
        if (uid == getApplicationInfo().uid || uid == android.os.Process.SYSTEM_UID ||
            getSystemService(MediaSessionManager.class).isTrustedForMediaControl(new MediaSessionManager.RemoteUserInfo(pkg,-1,uid)) ||
            ("com.google.android.projection.gearhead".equals(pkg) && getPackageManager().checkSignatures(pkg,"com.google.android.gms") == PackageManager.SIGNATURE_MATCH))
            return new BrowserRoot(ROOT,null);
        return null;
    }
    @Override public void onLoadChildren(String parent, Result<List<MediaBrowser.MediaItem>> result) {
        List<MediaBrowser.MediaItem> rows = new ArrayList<>();
        if (ROOT.equals(parent)) for (int i=0; i<app.stations.length(); i++) {
            JSONObject s = app.stations.optJSONObject(i);
            if (s != null) rows.add(new MediaBrowser.MediaItem(new MediaDescription.Builder()
                .setMediaId(s.optString("id")).setTitle(s.optString("name")).build(),MediaBrowser.MediaItem.FLAG_PLAYABLE));
        }
        result.sendResult(rows);
    }
    private PendingIntent openPlayer() {
        return PendingIntent.getActivity(this,0,new Intent(this,PlayerActivity.class),PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
    private Notification.Action button(int icon,String label,String action) {
        Intent event = new Intent(this,StationWidget.class).setAction("st.spacegho.melodica."+action);
        PendingIntent press = PendingIntent.getBroadcast(this,0,event,PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Action.Builder(icon,label,press).build();
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId) {
        refresh();
        return START_NOT_STICKY;
    }
    void refresh() {
        JSONObject t = app.track;
        String title = t.optString("title"), artist = t.optString("artist");
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE |
            PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SET_RATING | PlaybackState.ACTION_PLAY_FROM_MEDIA_ID | PlaybackState.ACTION_PLAY_FROM_SEARCH;
        session.setPlaybackState(new PlaybackState.Builder().setActions(actions)
            .addCustomAction("love","Thumbs up",android.R.drawable.btn_star_big_on)
            .setState(app.playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                Math.max(0,Math.round(t.optDouble("position",0)*1000)),app.playing ? 1 : 0).build());
        loadArt(t.optString("art"));
        session.setMetadata(new MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE,title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST,artist).putString(MediaMetadata.METADATA_KEY_ALBUM,t.optString("album"))
            .putLong(MediaMetadata.METADATA_KEY_DURATION,Math.round(t.optDouble("duration",0)*1000))
            .putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART,art).build());
        session.setActive(app.playing || !title.isEmpty());
        listenLocation(app.recording);
        Notification.Builder builder = new Notification.Builder(this,CHANNEL).setSmallIcon(R.drawable.record)
            .setContentTitle(title.isEmpty() ? "Melodica Mobile" : title)
            .setContentText(app.recording ? "Recording your walk" + (artist.isEmpty() ? "" : " · "+artist) : artist)
            .setContentIntent(openPlayer()).setOnlyAlertOnce(true).setLargeIcon(art)
            .setVisibility(Notification.VISIBILITY_PUBLIC);
        builder.addAction(button(app.playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
            app.playing ? "Pause" : "Play",app.playing ? "pause" : "play"));
        builder.addAction(button(android.R.drawable.ic_media_next,"Skip","skip"));
        if (app.recording) builder.addAction(button(android.R.drawable.ic_menu_close_clear_cancel,"Finish walk","finishWalk"));
        builder.setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0,1));
        if (app.playing || app.recording) {
            app.main.removeCallbacks(endPausedSession); lingering = false;
            int type = (app.playing ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0) |
                    (app.recording ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0);
            startForeground(NOTIFICATION,builder.build(),type);
            foreground = true;
        } else if (!title.isEmpty() && (foreground || lingering)) {
            if (foreground) stopForeground(STOP_FOREGROUND_DETACH);
            foreground = false;
            getSystemService(NotificationManager.class).notify(NOTIFICATION,builder.build());
            if (!lingering) { lingering = true; app.main.postDelayed(endPausedSession,300_000); }
        } else {
            if (foreground) stopForeground(STOP_FOREGROUND_REMOVE);
            foreground = false;
            stopSelf();
        }
    }
    private void loadArt(String path) {
        if (artPath.equals(path)) return;
        artPath = path; art = null;
        if (!path.matches("https://spacegho\\.st/scrobble/art/[0-9a-f]{64}")) return;
        app.io.execute(() -> {
            Bitmap bitmap = null; HttpURLConnection c = null;
            try {
                c = (HttpURLConnection)new URL(path).openConnection();
                c.setConnectTimeout(4000); c.setReadTimeout(5000); c.setInstanceFollowRedirects(false);
                if (c.getResponseCode() == 200 && c.getContentLengthLong() <= 4_000_000) {
                    try (InputStream in = c.getInputStream()) { bitmap = BitmapFactory.decodeStream(in); }
                }
            } catch (Exception ignored) { }
            finally { if (c != null) c.disconnect(); }
            final Bitmap ready = bitmap;
            if (ready != null) app.main.post(() -> { if (app.service == this && artPath.equals(path)) { art = ready; refresh(); } });
        });
    }
    private void listenLocation(boolean enabled) {
        if (!enabled) {
            if (fixes != null) locations.removeUpdates(fixes);
            fixes = null;
            return;
        }
        if (fixes != null) return;
        final LocationListener current = new LocationListener() {
            @Override public void onLocationChanged(Location fix) {
                if (this != fixes || !app.recording) return;
                try { app.walks.point(fix); app.event("walkUpdate",new JSONObject()); }
                catch (JSONException e) { app.event("walkError",MobileApp.object("message","The location could not be saved.")); }
            }
            @Override public void onStatusChanged(String provider,int status,Bundle info) {}
            @Override public void onProviderEnabled(String provider) {}
            @Override public void onProviderDisabled(String provider) {}
        };
        fixes = current;
        for (String provider : new String[]{LocationManager.GPS_PROVIDER,LocationManager.NETWORK_PROVIDER}) {
            try {
                if (locations.getAllProviders().contains(provider))
                    locations.requestLocationUpdates(provider,2500,0,current,Looper.getMainLooper());
            } catch (SecurityException ignored) { }
        }
    }
    @Override public void onDestroy() {
        app.main.removeCallbacks(endPausedSession);
        listenLocation(false);
        session.release();
        if (app.service == this) app.service = null;
        super.onDestroy();
    }
}
