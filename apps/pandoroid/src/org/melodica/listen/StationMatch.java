package org.melodica.listen;

import java.util.List;
import java.util.Locale;

/** Which of the user's stations a listen:// link means. Plain Java (ListenUriTest covers it). */
public final class StationMatch {
    private StationMatch() {}

    private static String norm(String s) {
        return s == null ? "" : s.trim().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
    }

    /**
     * The index of the station a station, artist or genre link names, or -1. station/&lt;id&gt;:
     * that station id. artist/genre &lt;name&gt;: a station called "&lt;name&gt;" or "&lt;name&gt; Radio"
     * (case-insensitive).
     */
    public static int match(ListenUri link, List<String> ids, List<String> names) {
        if (link.target.equals("station")) return ids.indexOf(link.get("station"));
        if (!link.target.equals("artist") && !link.target.equals("genre")) return -1;
        String want = norm(link.get("name"));
        for (int i = 0; i < names.size(); i++) {
            String n = norm(names.get(i));
            if (n.equals(want) || n.equals(want + " radio")) return i;
        }
        return -1;
    }
}
