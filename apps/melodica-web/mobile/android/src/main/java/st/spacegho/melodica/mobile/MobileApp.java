package st.spacegho.melodica.mobile;

import android.app.Application;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.*;
import android.content.pm.PackageManager;
import android.media.*;
import android.net.*;
import android.os.*;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.util.Base64;
import android.webkit.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.*;

public final class MobileApp extends Application {
    static final String ORIGIN = "https://spacegho.st";
    static final String PLAYER = ORIGIN + "/melodica/app/";
    final Handler main = new Handler(Looper.getMainLooper());
    final ExecutorService io = Executors.newSingleThreadExecutor();
    PlayerActivity activity;
    MutableContextWrapper webContext;
    WebView web;
    WalkStore walks;
    RadioService service;
    JSONObject track = new JSONObject();
    JSONArray stations = new JSONArray();
    boolean playing, visible, recording;
    private WebMessagePort port;
    private int navigation;
    private AudioManager audio;
    private AudioFocusRequest focus;
    private boolean heldFocus, interrupted, resumeCall = true, speak;
    private String pendingStation = "", pendingLink = "", spokenKey = "";
    private TextToSpeech speech;
    private boolean speechReady;

    @Override public void onCreate() {
        super.onCreate();
        walks = new WalkStore(this);
        try { stations = new JSONArray(getSharedPreferences("stations",0).getString("list","[]")); }
        catch (JSONException ignored) { }
        audio = getSystemService(AudioManager.class);
        focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()).setWillPauseWhenDucked(true)
            .setOnAudioFocusChangeListener(this::focusChanged,main).build();
        BroadcastReceiver noisy = new BroadcastReceiver() {
            @Override public void onReceive(Context c,Intent i) {
                interrupted = false;
                event("media",object("action","pause"));
            }
        };
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(noisy,new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),RECEIVER_NOT_EXPORTED);
        else registerReceiver(noisy,new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        cm.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
            @Override public void onCapabilitiesChanged(Network n,NetworkCapabilities c) { main.post(() -> event("device",device())); }
            @Override public void onLost(Network n) { main.post(() -> event("device",device())); }
        });
        audio.registerAudioDeviceCallback(new AudioDeviceCallback() {
            @Override public void onAudioDevicesAdded(AudioDeviceInfo[] d) { event("device",device()); }
            @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] d) { event("device",device()); }
        },main);
    }
    static JSONObject object(Object... entries) {
        JSONObject o = new JSONObject();
        try { for (int i=0; i<entries.length; i+=2) o.put((String)entries[i],entries[i+1]); }
        catch (JSONException e) { throw new IllegalArgumentException(e); }
        return o;
    }
    JSONObject device() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        NetworkCapabilities n = cm.getNetworkCapabilities(cm.getActiveNetwork());
        String network = n == null ? "offline" : n.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ? "cellular" : "wifi";
        String route = "speaker", label = "Phone speaker";
        if (Build.VERSION.SDK_INT >= 30) {
            List<MediaRoute2Info> selected = MediaRouter2.getInstance(this).getSystemController().getSelectedRoutes();
            if (!selected.isEmpty()) { route = selected.get(0).getId(); label = selected.get(0).getName().toString(); }
        } else {
            MediaRouter router = (MediaRouter)getSystemService(MEDIA_ROUTER_SERVICE);
            MediaRouter.RouteInfo info = router.getSelectedRoute(MediaRouter.ROUTE_TYPE_LIVE_AUDIO);
            if (info != null) route = label = info.getName().toString();
        }
        return object("network",network,"route",route,"label",label);
    }
    void attach(PlayerActivity a) {
        activity = a;
        ensurePlayer();
        webContext.setBaseContext(a);
    }
    void ensurePlayer() {
        if (web != null) return;
        webContext = new MutableContextWrapper(activity == null ? this : activity);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        web = new WebView(webContext);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false); s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString()+" MelodicaMobile/1 Android");
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView w,ValueCallback<Uri[]> cb,FileChooserParams p) {
                return activity != null && trusted(w.getUrl()) && activity.chooseFile(cb,p);
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView w,String url,android.graphics.Bitmap icon) {
                navigation++;
                if (port != null) port.close();
                port = null;
            }
            @Override public void onPageFinished(WebView w,String url) {
                if (!trusted(url) || !url.equals(w.getUrl())) return;
                int generation = navigation;
                try (InputStream in = getAssets().open("bridge.js")) {
                    w.evaluateJavascript(readText(in), result -> {
                        if (generation != navigation || !trusted(w.getUrl()) || port != null) return;
                        WebMessagePort[] pair = w.createWebMessageChannel();
                        port = pair[0];
                        port.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
                            @Override public void onMessage(WebMessagePort sender,WebMessage msg) {
                                if (sender == port && generation == navigation && trusted(w.getUrl())) handle(msg.getData());
                            }
                        });
                        w.postWebMessage(new WebMessage("melodica-device-v1",new WebMessagePort[]{pair[1]}),Uri.parse(ORIGIN));
                    });
                } catch (IOException ignored) { }
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView w,WebResourceRequest r) {
                Uri uri = r.getUrl();
                String path = uri.getPath();
                if (!"GET".equals(r.getMethod()) || !owned(uri) || path == null || path.contains("..")) return null;
                boolean shell = r.isForMainFrame() && shellPath(uri.getEncodedPath());
                if (!shell && !path.startsWith("/melodica/app/")) return null;
                String name = shell ? "index.html" : path.substring("/melodica/app/".length());
                if (!name.matches("[a-zA-Z0-9_./-]+") || name.startsWith("/") || name.contains("//")) return null;
                try {
                    InputStream in = getAssets().open("player/"+name);
                    String type = name.endsWith(".js") ? "text/javascript" : name.endsWith(".wasm") ? "application/wasm" :
                        name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "text/plain";
                    if (shell) {
                        try (InputStream raw = in) {
                            String html = readText(raw).replace("<head>","<head><base href=\"/melodica/app/\">");
                            in = new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8));
                        }
                    }
                    Map<String,String> headers = new HashMap<>();
                    headers.put("X-Content-Type-Options","nosniff");
                    if (shell) headers.put("Content-Security-Policy","default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src https: blob:; connect-src 'self' https://lrclib.net/api/get; font-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'; worker-src 'self'");
                    return new WebResourceResponse(type,type.equals("application/wasm") ? null : "utf-8",200,"OK",
                        headers,in);
                } catch (IOException e) { return null; }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView w,WebResourceRequest r) {
                Uri u = r.getUrl();
                if (!r.isForMainFrame()) return false;
                if (owned(u) || ("https".equals(u.getScheme()) && "github.com".equals(u.getHost()) && u.getPort() == -1)) return false;
                if (activity != null && ("https".equals(u.getScheme()) || "http".equals(u.getScheme()))) {
                    try { activity.startActivity(new Intent(Intent.ACTION_VIEW,u)); } catch (ActivityNotFoundException ignored) {}
                }
                return true;
            }
        });
        web.loadUrl(PLAYER);
    }
    static String readText(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192]; int count;
        while ((count = in.read(buf)) != -1) out.write(buf,0,count);
        return out.toString("UTF-8");
    }
    static boolean owned(Uri u) { return u != null && "https".equals(u.getScheme()) && "spacegho.st".equals(u.getHost()) && (u.getPort() == -1 || u.getPort() == 443) && u.getUserInfo() == null; }
    static boolean shellPath(String path) {
        return path != null && path.matches("/melodica(?:/(?:app|track|rooms|garden|listens|leaderboard|map|account|aquarium|apps|extension|rooms/[A-Za-z0-9_-]{16,64}))?/?");
    }
    static boolean trusted(String url) {
        if (url == null) return false;
        Uri u = Uri.parse(url);
        return owned(u) && shellPath(u.getEncodedPath());
    }
    private void post(JSONObject packet) {
        if (port != null) try { port.postMessage(new WebMessage(packet.toString())); } catch (IllegalStateException ignored) {}
    }
    void reply(int id,Object value,String error) { post(object("id",id,"value",value,"error",error)); }
    void event(String event,JSONObject value) { post(object("event",event,"value",value)); }
    void openListenLink(Uri uri) {
        if (!"listen".equals(uri.getScheme()) && !"web+listen".equals(uri.getScheme())) return;
        String raw = uri.toString();
        if (raw.length() > 1024) return;
        pendingLink = raw;
        if (!trusted(web.getUrl()) && web.getUrl() != null) web.loadUrl(PLAYER);
        else event("listenLink",object("url",raw));
    }
    void station(String id) {
        if (!hasStation(id)) return;
        pendingStation = id;
        ensurePlayer();
        if (port != null) event("station",object("id",id));
    }
    JSONObject findStation(String id) {
        for (int i = 0; i < stations.length(); i++) {
            JSONObject item = stations.optJSONObject(i);
            if (item != null && item.optString("id").equals(id)) return item;
        }
        return null;
    }
    void updateShortcuts() {
        android.content.pm.ShortcutManager manager = getSystemService(android.content.pm.ShortcutManager.class);
        if (manager == null || manager.isRateLimitingActive()) return;
        List<android.content.pm.ShortcutInfo> shortcuts = new ArrayList<>();
        for (int i = 0; i < Math.min(stations.length(),manager.getMaxShortcutCountPerActivity()); i++) {
            JSONObject s = stations.optJSONObject(i);
            if (s == null || s.optString("id").isEmpty() || s.optString("name").isEmpty()) continue;
            shortcuts.add(new android.content.pm.ShortcutInfo.Builder(this,s.optString("id"))
                .setShortLabel(s.optString("name")).setIcon(android.graphics.drawable.Icon.createWithResource(this,R.drawable.record))
                .setIntent(new Intent(this,PlayerActivity.class).setAction(Intent.ACTION_VIEW).putExtra("station",s.optString("id"))).build());
        }
        manager.setDynamicShortcuts(shortcuts);
    }
    boolean hasStation(String id) { return findStation(id) != null; }
    void cancelResume() { interrupted = false; }
    private void handle(String raw) {
        if (raw == null || raw.length() > 24_000_000) return;
        int id = 0;
        try {
            JSONObject msg = new JSONObject(raw); id = msg.getInt("id");
            JSONObject v = msg.optJSONObject("value"); if (v == null) v = new JSONObject();
            Object result = true;
            switch (msg.getString("action")) {
                case "state": result = device().put("station",pendingStation).put("listenLink",pendingLink); break;
                case "linkHandled": if (pendingLink.equals(v.optString("url"))) pendingLink = ""; break;
                case "stationHandled": if (pendingStation.equals(v.optString("id"))) pendingStation = ""; break;
                case "stations":
                    JSONArray list = v.getJSONArray("stations");
                    if (list.length() > 5000) throw new IllegalArgumentException();
                    stations = list; getSharedPreferences("stations",0).edit().putString("list",list.toString()).apply();
                    if (service != null) service.notifyChildrenChanged("stations");
                    StationWidget.update(this); updateShortcuts(); break;
                case "now": updateTrack(v); break;
                case "options": resumeCall = v.optBoolean("resumeCall",true); speak = v.optBoolean("speak"); break;
                case "userPause": interrupted = false; break;
                case "walkList": result = walks.list(); break;
                case "walkStart":
                    if (activity == null || !visible) throw new IllegalStateException("Open Melodica to start recording.");
                    activity.startWalk(id); return;
                case "walkPause":
                    if (!v.getBoolean("paused")) {
                        if (activity == null || !visible || walks.active() == null) throw new IllegalStateException("Open the walk to resume GPS.");
                        activity.startWalk(id); return;
                    }
                    walks.pause(true); updateRecording(); break;
                case "walkFinish":
                    JSONObject activeWalk = walks.active();
                    if (v.has("id") && (activeWalk == null || !activeWalk.optString("id").equals(v.optString("id"))))
                        throw new IllegalStateException("This walk is already finished.");
                    walks.finish(); updateRecording(); break;
                case "walkRead": result = walks.page(v.getString("id"),v.optLong("cursor")); break;
                case "walkAck": walks.recovered(v.getString("id")); break;
                case "pin": result = StationWidget.pin(this,v.getString("id"),v.getString("name")); break;
                case "output":
                    if (activity == null) throw new IllegalStateException("Open the player to choose an output.");
                    if (Build.VERSION.SDK_INT < 34 || !MediaRouter2.getInstance(this).showSystemOutputSwitcher())
                        activity.startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS));
                    break;
                case "share":
                    Uri link = Uri.parse(v.getString("url"));
                    if (activity == null || !visible || !"https".equals(link.getScheme())) throw new IllegalStateException("Open the player to share.");
                    activity.startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain")
                        .putExtra(Intent.EXTRA_TEXT,v.optString("text")+" "+link),"Share from Melodica"));
                    break;
                case "saveFile":
                    if (activity == null) throw new IllegalStateException("Open the player to save the file.");
                    String mime = v.getString("mime");
                    if (!Arrays.asList("application/gpx+xml","image/png","application/json","text/csv").contains(mime))
                        throw new IllegalArgumentException("Unsupported file format.");
                    String filename = v.getString("name").replaceAll("[^a-zA-Z0-9._-]","_");
                    activity.saveFile(id,filename,mime,Base64.decode(v.getString("data"),Base64.DEFAULT)); return;
                default: throw new IllegalArgumentException("Unknown device action.");
            }
            reply(id,result,null);
        } catch (Exception e) { reply(id,null,e.getMessage() == null ? "The phone could not complete that action." : e.getMessage()); }
    }
    private void updateTrack(JSONObject v) throws JSONException {
        boolean wasPlaying = playing;
        track = v;
        playing = v.optBoolean("playing");
        walks.song(track,playing && track.optBoolean("audible",playing));
        if (playing != wasPlaying) {
            if (playing) {
                if (!heldFocus) heldFocus = audio.requestAudioFocus(focus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
                ensureService();
            } else if (!interrupted && heldFocus) {
                audio.abandonAudioFocusRequest(focus); heldFocus = false;
            }
        }
        if (service != null) service.refresh();
        String key = v.optString("artist") + "\n" + v.optString("title");
        if (playing && !key.equals(spokenKey)) {
            spokenKey = key;
            if (speak && !v.optString("artist").isEmpty()) {
                if (speech == null) speech = new TextToSpeech(this,status -> {
                    speechReady = status == TextToSpeech.SUCCESS;
                    if (speechReady && playing && speak && spokenKey.equals(key)) sayTrack();
                });
                else if (speechReady) sayTrack();
            }
        }
    }
    private void sayTrack() { speech.speak(track.optString("title")+" by "+track.optString("artist"),TextToSpeech.QUEUE_FLUSH,null,"track"); }
    private void focusChanged(int change) {
        if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) event("duck",object("factor",0.25));
        else if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT || change == AudioManager.AUDIOFOCUS_LOSS) {
            interrupted = change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT && playing;
            if (!interrupted) heldFocus = false;
            event("media",object("action","pause"));
        } else if (change == AudioManager.AUDIOFOCUS_GAIN) {
            event("duck",object("factor",1));
            if (interrupted && resumeCall) event("media",object("action","play"));
            interrupted = false;
        }
    }
    void beginWalk(int id) {
        try {
            JSONObject w = walks.start();
            walks.song(track,playing && track.optBoolean("audible",playing)); updateRecording(); reply(id,w,null);
        } catch (Exception e) { walks.pause(true); recording = false; reply(id,null,"The walk recorder could not start."); }
    }
    void updateRecording() throws JSONException {
        JSONObject active = walks.active();
        recording = active != null && !active.getBoolean("paused");
        if (recording) ensureService();
        if (service != null) service.refresh();
    }
    private void ensureService() {
        if (service == null || !service.foreground) startForegroundService(new Intent(this,RadioService.class));
    }
}
