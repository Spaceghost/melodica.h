package org.melodica.scrobble;

/** The little JSON writing the scrobbler needs (org.json is not on a plain JVM). */
final class Json {
    private Json() {}

    static String quote(String s) {
        StringBuilder b = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c);
            }
        }
        return b.append('"').toString();
    }

    static void field(StringBuilder b, String key, String value) {
        if (value != null) raw(b, key, quote(value));
    }

    static void raw(StringBuilder b, String key, String json) {
        if (b.length() > 0) b.append(',');
        b.append(quote(key)).append(':').append(json);
    }
}
