package org.melodica.listen;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * listen:// links (melodica-scrobble docs/LISTEN-URI.md): a port of the reference parser
 * src/listen-uri.js. It accepts and rejects exactly what tests/listen-uri.test.mjs pins.
 * Plain Java (no Android types). Parsing never plays anything: the app asks first.
 */
public final class ListenUri {
    public static final String HTTPS_BASE = "https://spacegho.st/listen/";
    public static final String SITE = "https://spacegho.st";
    private static final int MAX_TEXT = 200;
    private static final Pattern SCHEME = Pattern.compile("^(listen|web\\+listen)://([^\n\r\u2028\u2029]*)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern RAW_SEG = Pattern.compile("^[A-Za-z0-9\\-._~%!$&'()*+,;=:@]*$");
    private static final Pattern SLUG = Pattern.compile("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$");
    private static final Pattern USERNAME = Pattern.compile("^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$");
    private static final Pattern STATION = Pattern.compile("^[A-Za-z0-9]{1,64}$");
    private static final Pattern TRACK = Pattern.compile("^(?:[0-9a-f]{64}|[A-Za-z0-9]{1,64})$");
    private static final Pattern T = Pattern.compile("^[0-9]{1,5}$");

    private static final Map<String, String[]> SEGS = new HashMap<String, String[]>();
    private static final Map<String, String[]> FIELDS = new HashMap<String, String[]>();
    static {
        target("artist", new String[] {"text"}, "name");
        target("genre", new String[] {"text"}, "name");
        target("station", new String[] {"station"}, "station");
        target("track", new String[] {"track"}, "track");
        target("map", new String[] {"slug", "slug?"}, "land", "province");
        target("user", new String[] {"username"}, "username");
        target("listens", new String[0]);
        target("leaderboard", new String[0]);
    }
    private static void target(String name, String[] segs, String... fields) {
        SEGS.put(name, segs);
        FIELDS.put(name, fields);
    }

    public final String target;
    /** Field values by name (name, station, track, land, province, username). */
    public final Map<String, String> fields;
    /** The t= of a track link, or null. */
    public final Integer t;
    public final String uri, web, https;

    private ListenUri(String target, Map<String, String> fields, Integer t) {
        this.target = target;
        this.fields = fields;
        this.t = t;
        StringBuilder path = new StringBuilder(target);
        for (String f : FIELDS.get(target)) if (fields.containsKey(f)) path.append('/').append(encodeComponent(fields.get(f)));
        if (t != null) path.append("?t=").append(t);
        uri = "listen://" + path;
        web = "web+listen://" + path;
        https = HTTPS_BASE + path;
    }

    public String get(String field) { return fields.get(field); }

    /** The parsed link, or null for anything the reference parser rejects. */
    public static ListenUri parse(String input) {
        if (input == null || input.length() > 1024) return null;
        String rest;
        Matcher m = SCHEME.matcher(input);
        if (m.matches()) rest = m.group(2);
        else if (input.toLowerCase(Locale.ROOT).startsWith(HTTPS_BASE)) rest = input.substring(HTTPS_BASE.length());
        else return null;
        if (rest.indexOf('#') >= 0) return null;
        int q = rest.indexOf('?');
        String path = q >= 0 ? rest.substring(0, q) : rest;
        String query = q >= 0 ? rest.substring(q + 1) : "";
        if (path.endsWith("/")) path = path.substring(0, path.length() - 1);
        List<String> parts = new ArrayList<String>(Arrays.asList(path.split("/", -1)));
        String target = parts.remove(0).toLowerCase(Locale.ROOT);
        String[] segs = SEGS.get(target);
        if (segs == null) return null;
        int required = 0;
        for (String r : segs) if (!r.endsWith("?")) required++;
        if (parts.size() < required || parts.size() > segs.length) return null;
        Map<String, String> fields = new HashMap<String, String>();
        for (int i = 0; i < parts.size(); i++) {
            String v = decodeSeg(parts.get(i));
            String ok = v == null ? null : checkSeg(segs[i], v);
            if (ok == null) return null;
            fields.put(FIELDS.get(target)[i], ok);
        }
        Integer t = null;
        if (query.length() > 0) {
            for (String pair : query.split("&", -1)) {
                String[] kv = pair.split("=", -1);
                String k = kv[0], v = kv.length > 1 ? kv[1] : "";
                if (!(target.equals("track") && k.equals("t")) || t != null) return null;
                if (!T.matcher(v).matches() || Integer.parseInt(v) > 86400) return null;
                t = Integer.valueOf(v);
            }
        }
        return new ListenUri(target, fields, t);
    }

    /** Builds a link from a target and its fields; null when it would not parse back. */
    public static ListenUri build(String target, Map<String, String> fields, Integer t) {
        if (!SEGS.containsKey(target)) return null;
        ListenUri l = new ListenUri(target, fields == null ? new HashMap<String, String>() : fields, t);
        return parse(l.uri) != null ? l : null;
    }

    /** The spacegho.st page for this link (path only), as the reference routeOf. */
    public String route() {
        if (target.equals("artist") || target.equals("genre")) return "/melodica/app/?seed=" + target + ":" + encodeComponent(get("name"));
        if (target.equals("station")) return "/melodica/app/?station=" + encodeComponent(get("station"));
        if (target.equals("track")) return "/melodica/listens/?track=" + encodeComponent(get("track")) + (t != null ? "&t=" + t : "");
        if (target.equals("map")) return "/melodica/map/?land=" + encodeComponent(get("land")) + (get("province") != null ? "&province=" + encodeComponent(get("province")) : "");
        if (target.equals("user")) return "/melodica/leaderboard/?user=" + encodeComponent(get("username"));
        if (target.equals("listens")) return "/melodica/listens/";
        if (target.equals("leaderboard")) return "/melodica/leaderboard/";
        return "/melodica/";
    }

    private static String decodeSeg(String raw) {
        if (!RAW_SEG.matcher(raw).matches()) return null;
        String s = decodeComponent(raw);
        if (s == null || s.length() == 0 || s.length() > MAX_TEXT || !s.equals(jsTrim(s))) return null;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c <= 0x1f || c == 0x7f || c == '/' || c == '\\') return null;
        }
        if (s.equals(".") || s.equals("..")) return null;
        return Normalizer.normalize(s, Normalizer.Form.NFC);
    }

    private static String checkSeg(String rule, String v) {
        String r = rule.replace("?", "");
        if (r.equals("text")) return v;
        Pattern p = r.equals("slug") ? SLUG : r.equals("username") ? USERNAME : r.equals("station") ? STATION : r.equals("track") ? TRACK : null;
        return p != null && p.matcher(v).matches() ? v : null;
    }

    /** decodeURIComponent: %XX sequences must form valid UTF-8; '+' stays '+'. */
    static String decodeComponent(String s) {
        if (s.indexOf('%') < 0) return s;
        StringBuilder out = new StringBuilder();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (int i = 0; i < s.length(); ) {
            char c = s.charAt(i);
            if (c == '%') {
                if (i + 2 >= s.length()) return null;
                int hi = Character.digit(s.charAt(i + 1), 16), lo = Character.digit(s.charAt(i + 2), 16);
                if (hi < 0 || lo < 0) return null;
                bytes.write(hi * 16 + lo);
                i += 3;
            } else {
                if (!flush(bytes, out)) return null;
                out.append(c);
                i++;
            }
        }
        return flush(bytes, out) ? out.toString() : null;
    }

    private static boolean flush(ByteArrayOutputStream bytes, StringBuilder out) {
        if (bytes.size() == 0) return true;
        try {
            out.append(Charset.forName("UTF-8").newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes.toByteArray())));
        } catch (CharacterCodingException e) {
            return false;
        }
        bytes.reset();
        return true;
    }

    /** encodeURIComponent. */
    static String encodeComponent(String s) {
        StringBuilder b = new StringBuilder();
        byte[] utf8;
        try { utf8 = s.getBytes("UTF-8"); } catch (java.io.UnsupportedEncodingException e) { throw new RuntimeException(e); }
        for (byte x : utf8) {
            int c = x & 0xff;
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || "-_.!~*'()".indexOf(c) >= 0) b.append((char) c);
            else b.append('%').append("0123456789ABCDEF".charAt(c >> 4)).append("0123456789ABCDEF".charAt(c & 15));
        }
        return b.toString();
    }

    /** String.prototype.trim: JavaScript's whitespace and line terminators. */
    private static boolean jsSpace(char c) {
        return c == '\t' || c == '\n' || c == 0x0b || c == '\f' || c == '\r' || c == ' ' || c == 0xa0 || c == 0x1680
            || (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
    }

    private static String jsTrim(String s) {
        int a = 0, z = s.length();
        while (a < z && jsSpace(s.charAt(a))) a++;
        while (z > a && jsSpace(s.charAt(z - 1))) z--;
        return s.substring(a, z);
    }
}
