package org.melodica.scrobble;

/**
 * When a listen counts (Last.fm's rule, which ListenBrainz follows): the song is longer than
 * 30 seconds and has played for half its length or four minutes, whichever comes first.
 */
public final class ScrobbleRule {
    private ScrobbleRule() {}

    public static boolean counts(long lengthMs, long playedMs) {
        return lengthMs > 30000L && playedMs >= Math.min(lengthMs / 2, 240000L);
    }
}
