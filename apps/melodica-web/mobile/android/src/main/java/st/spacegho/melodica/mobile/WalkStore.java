package st.spacegho.melodica.mobile;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.location.Location;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.UUID;

/** An entry is removed only after the walk journal confirms its IndexedDB transaction. */
final class WalkStore extends SQLiteOpenHelper {
    private String lastSong = "";
    private Location lastPoint;
    private boolean cut = true;

    WalkStore(Context context) {
        super(context, "walks.sqlite", null, 1);
        // A fresh process cannot account for motion or audio during the interruption.
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            try (Cursor c = db.rawQuery("SELECT w.id,e.data FROM walks w JOIN events e ON e.walk=w.id WHERE w.ending IS NULL ORDER BY e.seq DESC LIMIT 1",null)) {
                if (c.moveToFirst()) {
                    long last = new JSONObject(c.getString(1)).getLong("at");
                    append(c.getString(0),"changes",new JSONObject().put("at",last+1).put("unknown",true));
                }
            } catch (JSONException e) { throw new IllegalStateException("Invalid saved walk",e); }
            db.execSQL("UPDATE walks SET paused=1 WHERE ending IS NULL");
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE walks(id TEXT PRIMARY KEY, start INTEGER NOT NULL, ending INTEGER, paused INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE UNIQUE INDEX one_active ON walks((1)) WHERE ending IS NULL");
        db.execSQL("CREATE TABLE events(seq INTEGER PRIMARY KEY, walk TEXT NOT NULL REFERENCES walks(id) ON DELETE CASCADE, kind TEXT NOT NULL, data TEXT NOT NULL)");
        db.execSQL("CREATE INDEX walk_events ON events(walk,seq)");
    }
    @Override public void onConfigure(SQLiteDatabase db) { db.setForeignKeyConstraintsEnabled(true); }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        throw new IllegalStateException("Unsupported walk database version");
    }

    private JSONObject row(Cursor cursor) throws JSONException {
        return new JSONObject().put("id",cursor.getString(0)).put("start",cursor.getLong(1))
                .put("end",cursor.isNull(2) ? JSONObject.NULL : cursor.getLong(2)).put("paused",cursor.getInt(3) != 0);
    }
    JSONObject active() throws JSONException {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT id,start,ending,paused FROM walks WHERE ending IS NULL", null)) {
            return c.moveToFirst() ? row(c) : null;
        }
    }
    JSONArray list() throws JSONException {
        JSONArray result = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT id,start,ending,paused FROM walks ORDER BY start", null)) {
            while (c.moveToNext()) result.put(row(c));
        }
        return result;
    }
    JSONObject start() throws JSONException {
        JSONObject current = active();
        if (current == null) {
            ContentValues v = new ContentValues();
            v.put("id", UUID.randomUUID().toString());
            v.put("start", System.currentTimeMillis());
            getWritableDatabase().insertOrThrow("walks", null, v);
        }
        pause(false);
        return active();
    }
    void pause(boolean paused) {
        getWritableDatabase().execSQL("UPDATE walks SET paused=? WHERE ending IS NULL", new Object[]{paused ? 1 : 0});
        cut = true;
        lastPoint = null;
    }
    void finish() {
        getWritableDatabase().execSQL("UPDATE walks SET ending=?,paused=1 WHERE ending IS NULL", new Object[]{System.currentTimeMillis()});
        lastSong = "";
        lastPoint = null;
        cut = true;
    }
    private void append(String id, String kind, JSONObject data) {
        ContentValues v = new ContentValues();
        v.put("walk",id); v.put("kind",kind); v.put("data",data.toString());
        getWritableDatabase().insertOrThrow("events",null,v);
    }
    void point(Location fix) throws JSONException {
        JSONObject w = active();
        if (w == null || w.getBoolean("paused") || !fix.hasAccuracy() || fix.getAccuracy() > 80
                || Math.abs(System.currentTimeMillis()-fix.getTime()) > 30000 || fix.getTime() < w.getLong("start")) return;
        if (lastPoint != null) {
            long elapsed = fix.getTime() - lastPoint.getTime();
            if (elapsed <= 0) return;
            float distance = fix.distanceTo(lastPoint);
            if (elapsed < 18000 && distance < Math.max(4,Math.min(22,(fix.getAccuracy()+lastPoint.getAccuracy())*.45))) return;
            cut |= elapsed > 90000 || distance > 100 && distance * 1000 / elapsed > 12;
        }
        append(w.getString("id"),"points",new JSONObject().put("at",fix.getTime()).put("lat",fix.getLatitude())
            .put("lon",fix.getLongitude()).put("accuracy",fix.getAccuracy()).put("cut",cut));
        lastPoint = new Location(fix);
        cut = false;
    }
    void song(JSONObject metadata, boolean playing) throws JSONException {
        JSONObject w = active();
        if (w == null) return;
        JSONObject clean = new JSONObject();
        if (playing && metadata != null && !metadata.optString("title").isEmpty() && !metadata.optString("artist").isEmpty()) {
            for (String key : new String[]{"title","artist","stationId","stationName"}) {
                String value = metadata.optString(key,"").trim();
                if (!value.isEmpty()) clean.put(key,value.substring(0, Math.min(250,value.length())));
            }
        }
        String identity = clean.toString();
        if (identity.equals(lastSong)) return;
        lastSong = identity;
        append(w.getString("id"),"changes",clean.put("at",System.currentTimeMillis()));
    }
    JSONObject page(String id, long cursor) throws JSONException {
        JSONArray events = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT seq,kind,data FROM events WHERE walk=? AND seq>? ORDER BY seq LIMIT 256",
                new String[]{id,Long.toString(cursor)})) {
            while (c.moveToNext()) {
                cursor = c.getLong(0);
                events.put(new JSONObject().put("kind",c.getString(1)).put("data",new JSONObject(c.getString(2))));
            }
        }
        return new JSONObject().put("events",events).put("cursor",cursor);
    }
    void recovered(String id) {
        getWritableDatabase().delete("walks","id=? AND ending IS NOT NULL",new String[]{id});
    }
}
