package org.melodica.scrobble;

import java.io.File;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Reports plays to a ListenBrainz-compatible server (spacegho.st by default): playing_now when a
 * song starts, a single listen once it counts (ScrobbleRule). Listens that fail to send (no
 * network, 401, 429, 5xx) wait in a ListenQueue and go out, oldest first, as imports on the next
 * contact. Every request runs on one background thread, never the caller's.
 */
public final class Scrobbler {
    public interface Status { void report(String message); }

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ListenQueue queue;
    private final String client, version;
    private volatile ListenBrainzClient api;
    private volatile Status status;
    private Listen current;        // worker thread only
    private boolean reported;      // worker thread only

    public Scrobbler(File queueFile, String client, String version) {
        this.queue = new ListenQueue(queueFile);
        this.client = client;
        this.version = version;
    }

    public void configure(String base, String token, Status status) {
        this.api = new ListenBrainzClient(base, token);
        this.status = status;
    }

    public ListenQueue queue() { return queue; }

    /** A new song started playing. */
    public void started(final Listen listen) {
        worker.execute(new Runnable() { public void run() {
            current = listen;
            reported = false;
            ListenBrainzClient a = api;
            if (a == null || !a.configured() || !listen.isSong()) return;
            int s = a.submit("playing_now", Collections.singletonList(listen.toJson(false, client, version)));
            if (s == 401) say("The scrobble token was refused; check it in Settings.");
            if (s >= 200 && s < 300) flush(a);
        }});
    }

    /** Playback progress of the current song; lengthMs is 0 while unknown. */
    public void progress(final long playedMs, final long lengthMs) {
        worker.execute(new Runnable() { public void run() {
            Listen l = current;
            if (l == null || reported || !l.isSong()) return;
            long length = lengthMs > 0 ? lengthMs : l.durationMs;
            if (!ScrobbleRule.counts(length, playedMs)) return;
            reported = true;
            ListenBrainzClient a = api;
            if (a == null || !a.configured()) return;
            String entry = l.withDuration(length).toJson(true, client, version);
            int s = a.submit("single", Collections.singletonList(entry));
            if (s >= 200 && s < 300) flush(a);
            else if (s != 400) {
                queue.add(entry);
                if (s == 401) say("The scrobble token was refused; the listen is kept until it works.");
            }
        }});
    }

    /** Sends queued listens now (e.g. at start-up). */
    public void retry() {
        worker.execute(new Runnable() { public void run() {
            ListenBrainzClient a = api;
            if (a != null && a.configured()) flush(a);
        }});
    }

    private void flush(ListenBrainzClient a) {
        for (List<String> items = queue.all(); !items.isEmpty(); items = queue.all()) {
            List<String> batch = items.subList(0, Math.min(100, items.size()));
            int s = a.submit("import", batch);
            if ((s >= 200 && s < 300) || s == 400) queue.removeFirst(batch.size());
            else return;
        }
    }

    private void say(String message) {
        Status s = status;
        if (s != null) s.report(message);
    }

    /** Waits for pending work (tests, shutdown). */
    public void shutdown(long timeoutMs) {
        worker.shutdown();
        try { worker.awaitTermination(timeoutMs, TimeUnit.MILLISECONDS); } catch (InterruptedException ignored) {}
    }
}
