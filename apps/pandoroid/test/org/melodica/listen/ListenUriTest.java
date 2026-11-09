package org.melodica.listen;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.TreeMap;

/**
 * The cases of melodica-scrobble tests/listen-uri.test.mjs, ported one for one.
 * With "--canon", reads one JSON-string-escaped input per line on stdin and prints the
 * canonical parse (tools/listen-uri-diff.sh compares that with the reference parser).
 */
public final class ListenUriTest {
    static int failures = 0;

    static void check(boolean ok, String what) {
        if (!ok) { System.out.println("FAIL " + what); failures++; }
    }

    static Map<String, String> m(String... kv) {
        Map<String, String> out = new HashMap<String, String>();
        for (int i = 0; i < kv.length; i += 2) out.put(kv[i], kv[i + 1]);
        return out;
    }

    static String rep(char c, int n) { StringBuilder b = new StringBuilder(); for (int i = 0; i < n; i++) b.append(c); return b.toString(); }

    public static void main(String[] args) throws Exception {
        if (args.length > 0 && args[0].equals("--canon")) { canon(); return; }
        Object[][] cases = {
            {"listen://artist/Modest%20Mouse", m("target", "artist", "name", "Modest Mouse")},
            {"web+listen://genre/thrash%20metal", m("target", "genre", "name", "thrash metal")},
            {"https://spacegho.st/listen/station/4123456789012345", m("target", "station", "station", "4123456789012345")},
            {"listen://track/" + rep('a', 64) + "?t=95", m("target", "track", "track", rep('a', 64), "t", "95")},
            {"listen://map/neon-plains/synthwave-reach", m("target", "map", "land", "neon-plains", "province", "synthwave-reach")},
            {"listen://map/neon-plains", m("target", "map", "land", "neon-plains")},
            {"listen://user/knewter", m("target", "user", "username", "knewter")},
            {"listen://listens", m("target", "listens")},
            {"LISTEN://Leaderboard/", m("target", "leaderboard")},
            {"listen://artist/Sigur%20R%C3%B3s", m("target", "artist", "name", "Sigur Rós")},
        };
        for (Object[] c : cases) {
            String u = (String) c[0];
            @SuppressWarnings("unchecked") Map<String, String> want = (Map<String, String>) c[1];
            ListenUri p = ListenUri.parse(u);
            check(p != null, u);
            if (p == null) continue;
            for (Map.Entry<String, String> e : want.entrySet()) {
                String got = e.getKey().equals("target") ? p.target : e.getKey().equals("t") ? String.valueOf(p.t) : p.get(e.getKey());
                check(e.getValue().equals(got), u + " " + e.getKey());
            }
            check(ListenUri.parse(p.https).uri.equals(p.uri), "https round trip " + u);
            check(ListenUri.parse(p.web).uri.equals(p.uri), "web+ round trip " + u);
        }
        check(ListenUri.parse("listen://artist/AC%2FDC") == null, "no slash inside a name");
        check(ListenUri.build("artist", m("name", "Guns N' Roses"), null).https.equals("https://spacegho.st/listen/artist/Guns%20N'%20Roses"), "build https");
        check(ListenUri.parse(ListenUri.build("artist", m("name", "Guns N' Roses"), null).uri).get("name").equals("Guns N' Roses"), "build round trip");

        String[] bad = {
            "listen://http://evil.example", "listen://url/https%3A%2F%2Fevil.example", "listen://artist", "listen://artist/a/b",
            "listen://artist/%00x", "listen://artist/%2e%2e", "listen://artist/" + rep('x', 201), "listen://artist/%E0%A4%A",
            "listen://artist/ x", "listen://artist/x?autoplay=1", "listen://track/zzz!?t=1", "listen://track/abc?t=999999",
            "listen://track/abc?t=1&t=2", "listen://map/Neon_Plains", "listen://map/a/b/c", "listen://user/A", "listen://station/12-34",
            "listen://artist/x#frag", "javascript:alert(1)", "https://evil.example/listen/artist/x", "https://spacegho.st/listen/../oauth/admin",
            "listen://listens/extra", "listen://artist/<script>", null,
        };
        for (String u : bad) check(ListenUri.parse(u) == null, "rejects " + u);
        check(ListenUri.build("url", m("name", "x"), null) == null, "no url target");
        check(ListenUri.build("artist", m("name", ".."), null) == null, ".. is not a name");
        check(ListenUri.build("artist", m("name", "..."), null) != null, "three dots is a name");
        check(ListenUri.build("user", m("username", "NO"), null) == null, "uppercase username");

        check(ListenUri.parse("listen://artist/Modest%20Mouse").route().equals("/melodica/app/?seed=artist:Modest%20Mouse"), "route artist");
        check(ListenUri.parse("listen://map/neon-plains/synthwave-reach").route().equals("/melodica/map/?land=neon-plains&province=synthwave-reach"), "route map");
        check(ListenUri.parse("listen://track/abc?t=5").route().equals("/melodica/listens/?track=abc&t=5"), "route track");
        for (String u : new String[] {"listen://listens", "listen://leaderboard", "listen://user/knewter", "listen://station/123", "listen://genre/dance"})
            check(ListenUri.parse(u).route().startsWith("/melodica/"), "route " + u);
        // Which station a link selects (the app asks before it plays).
        java.util.List<String> ids = Arrays.asList("111", "222", "333"), names = Arrays.asList("QuickMix", "Aurora Fields Radio", "thrash metal");
        check(StationMatch.match(ListenUri.parse("listen://station/222"), ids, names) == 1, "station by id");
        check(StationMatch.match(ListenUri.parse("listen://station/999"), ids, names) == -1, "unknown station");
        check(StationMatch.match(ListenUri.parse("listen://artist/aurora%20fields"), ids, names) == 1, "artist -> <name> Radio");
        check(StationMatch.match(ListenUri.parse("listen://genre/Thrash%20Metal"), ids, names) == 2, "genre -> <name>");
        check(StationMatch.match(ListenUri.parse("listen://artist/Nobody"), ids, names) == -1, "no match");
        check(StationMatch.match(ListenUri.parse("listen://listens"), ids, names) == -1, "not a station target");
        System.out.println(failures == 0 ? "PASS listen-uri" : failures + " FAILED");
        System.exit(failures == 0 ? 0 : 1);
    }

    /** One line per input: null, or target|sorted fields|t|uri|https|route. */
    static void canon() throws Exception {
        BufferedReader r = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
        StringBuilder out = new StringBuilder();
        for (String line; (line = r.readLine()) != null; ) {
            ListenUri p = ListenUri.parse(unescape(line));
            if (p == null) { out.append("null\n"); continue; }
            out.append(p.target).append('|').append(new TreeMap<String, String>(p.fields)).append('|').append(p.t)
               .append('|').append(p.uri).append('|').append(p.https).append('|').append(p.route()).append('\n');
        }
        System.out.write(out.toString().getBytes("UTF-8"));
        System.out.flush();
    }

    /** The inputs are written with \\uXXXX escapes so any UTF-16 (even lone surrogates) survives a line. */
    static String unescape(String s) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\\' && i + 5 < s.length() + 0 + 1 && s.charAt(i + 1) == 'u') { b.append((char) Integer.parseInt(s.substring(i + 2, i + 6), 16)); i += 5; }
            else b.append(c);
        }
        return b.toString();
    }
}
