package org.melodica.scrobble;

import java.io.File;
import java.nio.file.Files;

/**
 * Plain-JVM checks of the scrobbler (no Android SDK): the rule, the payload, and a run against
 * tools/fake_lb.py. Usage: ScrobblerTest BASE TOKEN LOG   (tools/test-scrobble.sh runs it)
 */
public final class ScrobblerTest {
    static int failures = 0;

    static void check(boolean ok, String what) {
        System.out.println((ok ? "ok   " : "FAIL ") + what);
        if (!ok) failures++;
    }

    public static void main(String[] args) throws Exception {
        String base = args[0], token = args[1];
        File log = new File(args[2]);

        check(!ScrobbleRule.counts(30000, 30000), "30 s songs never count");
        check(ScrobbleRule.counts(31000, 15500), "half of a short song counts");
        check(!ScrobbleRule.counts(31000, 15499), "less than half does not");
        check(ScrobbleRule.counts(600000, 240000), "4 minutes of a long song counts");
        check(!ScrobbleRule.counts(600000, 239999), "under 4 minutes does not");

        Listen l = new Listen("Test Artist", "melodica-client-test pandoroid \"q\"", "LP", "http://cont.p-cdn.us/images/a.jpg", "Test Radio", 200000, 1762600000);
        String j = l.toJson(true, "Pandoroid", "0.2");
        check(j.contains("\"listened_at\":1762600000"), "single has listened_at");
        check(!l.toJson(false, "Pandoroid", "0.2").contains("listened_at"), "playing_now has none");
        check(j.contains("\"art_url\":\"http://cont.p-cdn.us/images/a.jpg\""), "art_url as Pandora gives it (http)");
        check(j.contains("\"station_name\":\"Test Radio\"") && j.contains("\"duration_ms\":200000")
            && j.contains("\"music_service\":\"pandora.com\"") && j.contains("\"music_service_name\":\"Pandora\""), "station, duration, service");
        check(j.contains("\\\"q\\\""), "quotes escaped");
        check(!j.contains("pandora_"), "no Pandora ids");

        if (base.equals("-")) { done(); return; }
        File qf = File.createTempFile("lbq", ".jsonl");
        qf.delete();
        Scrobbler s = new Scrobbler(qf, "Pandoroid", "test");
        final StringBuilder said = new StringBuilder();
        s.configure(base, token, new Scrobbler.Status() { public void report(String m) { said.append(m); } });
        long now = System.currentTimeMillis() / 1000L;
        // fake_lb --fail 2: the first playing_now and the first single get 503
        s.started(new Listen("Test Artist", "melodica-client-test pandoroid one", "LP", "http://cont.p-cdn.us/a.jpg", "Test Radio", 200000, now - 300));
        s.progress(100000, 200000);
        s.progress(150000, 200000); // already reported: nothing more
        s.started(new Listen("Test Artist", "melodica-client-test pandoroid two", null, null, "Test Radio", 0, now - 100));
        s.progress(5000, 0);        // length unknown yet
        s.progress(100000, 180000);
        s.shutdown(30000);
        check(new ListenQueue(qf).size() == 0, "queue empty after retry");
        String text = new String(Files.readAllBytes(log.toPath()), "UTF-8");
        String[] lines = text.trim().split("\n");
        StringBuilder seq = new StringBuilder();
        for (String line : lines) {
            String type = line.replaceAll(".*\"listen_type\": \"([a-z_]+)\".*", "$1");
            String status = line.replaceAll(".*\"status\": ([0-9]+).*", "$1");
            seq.append(type).append(':').append(status).append(' ');
        }
        System.out.println("     server saw: " + seq);
        check(seq.toString().equals("playing_now:503 single:503 playing_now:200 import:200 single:200 "), "playing_now, single, queue after failure, retry as import");
        check(text.contains("melodica-client-test pandoroid one") && text.contains("\"listened_at\": " + (now - 300)), "queued listen kept its time");
        check(!text.contains(token), "token not in the server's log");
        check(said.length() == 0, "no status messages");

        // a refused token keeps the listen
        File qf2 = File.createTempFile("lbq", ".jsonl");
        qf2.delete();
        Scrobbler bad = new Scrobbler(qf2, "Pandoroid", "test");
        final StringBuilder said2 = new StringBuilder();
        bad.configure(base, "sgs_wrong", new Scrobbler.Status() { public void report(String m) { said2.append(m); } });
        bad.started(new Listen("Test Artist", "melodica-client-test pandoroid bad", null, null, null, 100000, now));
        bad.progress(60000, 100000);
        bad.shutdown(30000);
        check(new ListenQueue(qf2).size() == 1, "listen kept when the token is refused");
        check(said2.indexOf("token") >= 0 && said2.indexOf("sgs_") < 0, "user told, token not shown");
        check(new ListenBrainzClient(base, token).validate() == 200, "validate-token: valid");
        check(new ListenBrainzClient(base, "sgs_wrong").validate() == 401, "validate-token: invalid");
        done();
    }

    static void done() {
        System.out.println(failures == 0 ? "PASS" : failures + " FAILED");
        System.exit(failures == 0 ? 0 : 1);
    }
}
