package org.melodica.scrobble;

import java.io.*;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.List;

/** Listens that could not be sent yet: one payload entry (JSON) per line in a file, oldest first. */
public final class ListenQueue {
    public static final int MAX = 1000;
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private final File file;

    public ListenQueue(File file) { this.file = file; }

    public synchronized List<String> all() {
        List<String> out = new ArrayList<String>();
        if (!file.exists()) return out;
        BufferedReader r = null;
        try {
            r = new BufferedReader(new InputStreamReader(new FileInputStream(file), UTF8));
            for (String line; (line = r.readLine()) != null; ) if (line.startsWith("{")) out.add(line);
        } catch (IOException e) {
            // an unreadable queue is an empty one
        } finally {
            close(r);
        }
        return out;
    }

    public synchronized void add(String entry) {
        List<String> items = all();
        items.add(entry);
        while (items.size() > MAX) items.remove(0);
        write(items);
    }

    /** Drops the first n entries (they were delivered, or refused as invalid). */
    public synchronized void removeFirst(int n) {
        List<String> items = all();
        write(new ArrayList<String>(items.subList(Math.min(n, items.size()), items.size())));
    }

    public synchronized int size() { return all().size(); }

    private void write(List<String> items) {
        File tmp = new File(file.getPath() + ".tmp");
        Writer w = null;
        try {
            w = new OutputStreamWriter(new FileOutputStream(tmp), UTF8);
            for (String s : items) w.write(s + "\n");
            w.close();
            w = null;
            if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file); }
        } catch (IOException e) {
            // keep the old file
        } finally {
            close(w);
        }
    }

    private static void close(Closeable c) {
        if (c != null) try { c.close(); } catch (IOException ignored) {}
    }
}
