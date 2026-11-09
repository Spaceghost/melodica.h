package org.melodica.scrobble;

/** One play of one Pandora song, as a ListenBrainz listen. Plain Java: no Android types. */
public final class Listen {
    public final String artist, track, album, artUrl, station;
    public final long durationMs;     // 0 when unknown
    public final long startedAt;      // Unix seconds

    public Listen(String artist, String track, String album, String artUrl, String station, long durationMs, long startedAt) {
        this.artist = artist == null ? "" : artist;
        this.track = track == null ? "" : track;
        this.album = album;
        this.artUrl = artUrl;
        this.station = station;
        this.durationMs = durationMs;
        this.startedAt = startedAt;
    }

    public Listen withDuration(long ms) {
        return new Listen(artist, track, album, artUrl, station, ms, startedAt);
    }

    /** A song worth reporting: it has an artist and a title. */
    public boolean isSong() {
        return artist.trim().length() > 0 && track.trim().length() > 0;
    }

    /** The payload entry: track_metadata, plus listened_at unless this is playing_now. */
    public String toJson(boolean withTimestamp, String client, String clientVersion) {
        StringBuilder info = new StringBuilder();
        Json.field(info, "submission_client", client);
        Json.field(info, "submission_client_version", clientVersion);
        Json.field(info, "media_player", client);
        Json.field(info, "music_service", "pandora.com");
        Json.field(info, "music_service_name", "Pandora");
        if (durationMs > 0) Json.raw(info, "duration_ms", Long.toString(durationMs));
        if (artUrl != null && (artUrl.startsWith("http://") || artUrl.startsWith("https://"))) Json.field(info, "art_url", artUrl);
        if (station != null && station.length() > 0) Json.field(info, "station_name", station);
        StringBuilder meta = new StringBuilder();
        Json.field(meta, "artist_name", artist);
        Json.field(meta, "track_name", track);
        if (album != null && album.length() > 0) Json.field(meta, "release_name", album);
        Json.raw(meta, "additional_info", "{" + info + "}");
        StringBuilder out = new StringBuilder();
        if (withTimestamp) Json.raw(out, "listened_at", Long.toString(startedAt));
        Json.raw(out, "track_metadata", "{" + meta + "}");
        return "{" + out + "}";
    }
}
