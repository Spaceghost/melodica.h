package org.melodica.scrobble;

import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * POST {base}/1/submit-listens and GET {base}/1/validate-token with "Authorization: Token ...".
 * The token is only ever put in that header: never in a message, exception or log.
 */
public final class ListenBrainzClient {
    public static final String SPACEGHOST = "https://spacegho.st/scrobble";
    public static final String LISTENBRAINZ = "https://api.listenbrainz.org";
    /** Status for a request that never got an HTTP answer. */
    public static final int NETWORK = -1;

    private final String base;
    private final String token;

    public ListenBrainzClient(String base, String token) {
        String b = base == null || base.trim().length() == 0 ? SPACEGHOST : base.trim();
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        this.base = b;
        this.token = token == null ? "" : token.trim();
    }

    public boolean configured() { return token.length() > 0; }

    /** listenType: playing_now, single or import; entries: payload JSON objects. Returns the HTTP status. */
    public int submit(String listenType, java.util.List<String> entries) {
        StringBuilder body = new StringBuilder("{\"listen_type\":").append(Json.quote(listenType)).append(",\"payload\":[");
        for (int i = 0; i < entries.size(); i++) body.append(i > 0 ? "," : "").append(entries.get(i));
        body.append("]}");
        return request("POST", "/1/submit-listens", body.toString());
    }

    /** 200 with "valid": true is a good token. Returns the status, or 401 for a token the server calls invalid. */
    public int validate() {
        int[] status = new int[1];
        String body = requestBody("GET", "/1/validate-token", null, status);
        if (status[0] == 200 && body != null && !body.replaceAll("\\s", "").contains("\"valid\":true")) return 401;
        return status[0];
    }

    private int request(String method, String path, String json) {
        int[] status = new int[1];
        requestBody(method, path, json, status);
        return status[0];
    }

    private String requestBody(String method, String path, String json, int[] status) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(base + path).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            c.setRequestMethod(method);
            c.setRequestProperty("Authorization", "Token " + token);
            c.setRequestProperty("Accept", "application/json");
            if (json != null) {
                byte[] data = json.getBytes("UTF-8");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                c.setFixedLengthStreamingMode(data.length);
                OutputStream o = c.getOutputStream();
                o.write(data);
                o.close();
            }
            status[0] = c.getResponseCode();
            InputStream in = status[0] < 400 ? c.getInputStream() : c.getErrorStream();
            if (in == null) return null;
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[4096];
            for (int n; (n = in.read(b)) > 0 && buf.size() < 65536; ) buf.write(b, 0, n);
            in.close();
            return buf.toString("UTF-8");
        } catch (IOException e) {
            status[0] = NETWORK;
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
