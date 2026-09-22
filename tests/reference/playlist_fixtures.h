#ifndef MELODICA_PLAYLIST_FIXTURES_H
#define MELODICA_PLAYLIST_FIXTURES_H

#define PLAYLIST_SONG \
    "{\"artistName\":\"Artist \\u266b\",\"albumName\":\"Album\"," \
    "\"songName\":\"Song \\\"one\\\"\",\"trackToken\":\"track/one\",\"stationId\":\"s1\"," \
    "\"albumArtUrl\":\"https://example.invalid/art\",\"songDetailUrl\":\"https://example.invalid/song\"," \
    "\"trackGain\":-3.25,\"trackLength\":123,\"songRating\":1,\"audioUrlMap\":{" \
    "\"lowQuality\":{\"encoding\":\"aacplus\",\"audioUrl\":\"https://example.invalid/low\"}," \
    "\"mediumQuality\":{\"encoding\":\"mp3\",\"audioUrl\":\"https://example.invalid/medium\"}," \
    "\"highQuality\":{\"encoding\":\"mp3\",\"audioUrl\":\"https://example.invalid/high\"}}}"
#define PLAYLIST_FOUR "{\"stat\":\"ok\",\"result\":{\"items\":[" \
    PLAYLIST_SONG "," PLAYLIST_SONG "," PLAYLIST_SONG "," PLAYLIST_SONG "]}}"
#define PLAYLIST_MIXED "{\"stat\":\"ok\",\"result\":{\"items\":[" \
    "{\"adToken\":\"ad-one\"}," PLAYLIST_SONG "," \
    "{\"artistName\":\"Sparse\"}," \
    "{\"artistName\":\"Other\",\"songRating\":2,\"audioUrlMap\":{" \
    "\"highQuality\":{\"encoding\":\"future-codec\",\"audioUrl\":\"https://example.invalid/other\"}}}]}}"
#define PLAYLIST_LATE_FAILURE "{\"stat\":\"ok\",\"result\":{\"items\":[" \
    PLAYLIST_SONG ",{" \
    "\"artistName\":\"Missing quality\",\"audioUrlMap\":{}}]}}"

#endif
