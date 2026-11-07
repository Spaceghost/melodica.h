// Console-level smoke driver for pianobar.exe, used by contrib/windows/smoke.ps1 in CI.
//
// pianobar's Windows port reads keystrokes with ReadConsoleInput and paints the
// screen with the console API, so a redirected stdin/stdout pipe cannot drive it.
// This program runs inside a real console, starts pianobar.exe as a child sharing
// that console, scrapes the screen buffer (ReadConsoleOutputCharacter) to follow
// what pianobar prints, types answers with WriteConsoleInput, and leaves a
// transcript (the final screen) plus a result JSON behind.
//
// Checkpoints: when a phase of interest is reached it writes <label>-ready-<name>
// in the output directory and waits (up to 90 s) for <label>-go-<name>, so the
// caller can take a screenshot of the live console before the run continues.
//
// usage: SmokeDriver.exe <pianobar.exe> <outdir> <label> [station|-] [hold-seconds] [login-timeout-seconds]
// Compiled with Windows PowerShell's Add-Type (C# 5): keep the syntax old.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class SmokeDriver
{
    [StructLayout(LayoutKind.Sequential)]
    struct COORD { public short X; public short Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct SMALL_RECT { public short Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct CONSOLE_SCREEN_BUFFER_INFO
    {
        public COORD dwSize;
        public COORD dwCursorPosition;
        public ushort wAttributes;
        public SMALL_RECT srWindow;
        public COORD dwMaximumWindowSize;
    }

    [StructLayout(LayoutKind.Explicit, Size = 20)]
    struct INPUT_RECORD
    {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public int bKeyDown;
        [FieldOffset(8)] public ushort wRepeatCount;
        [FieldOffset(10)] public ushort wVirtualKeyCode;
        [FieldOffset(12)] public ushort wVirtualScanCode;
        [FieldOffset(14)] public char UnicodeChar;
        [FieldOffset(16)] public uint dwControlKeyState;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CONSOLE_SCREEN_BUFFER_INFO info);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ReadConsoleOutputCharacterW(IntPtr h, [Out] StringBuilder buf, uint len, COORD at, out uint read);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] recs, uint len, out uint written);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr h, int cmd);

    const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
    const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3;
    const ushort KEY_EVENT = 1;

    static IntPtr conOut, conIn;
    static string outDir, label;
    static List<string> events = new List<string>();
    static Stopwatch clock = Stopwatch.StartNew();

    static void Note(string s)
    {
        string line = string.Format("[{0,7:0.000}s] {1}", clock.Elapsed.TotalSeconds, s);
        events.Add(line);
        try { File.AppendAllText(Path.Combine(outDir, label + "-driver.log"), line + "\r\n"); } catch { }
    }

    static string[] Screen()
    {
        CONSOLE_SCREEN_BUFFER_INFO info;
        if (!GetConsoleScreenBufferInfo(conOut, out info)) return new string[0];
        int w = info.dwSize.X, h = info.dwSize.Y;
        if (w <= 0 || h <= 0) return new string[0];
        var lines = new List<string>(h);
        var sb = new StringBuilder(w + 1);
        for (short y = 0; y < h; y++)
        {
            COORD at; at.X = 0; at.Y = y;
            uint read;
            sb.Length = 0; sb.EnsureCapacity(w + 1);
            if (!ReadConsoleOutputCharacterW(conOut, sb, (uint)w, at, out read)) break;
            lines.Add(sb.ToString(0, (int)read).TrimEnd());
        }
        int last = lines.Count;
        while (last > 0 && lines[last - 1].Length == 0) last--;
        return lines.GetRange(0, last).ToArray();
    }

    static string Join(string[] lines) { return string.Join("\n", lines); }

    static bool Contains(string[] lines, string needle)
    {
        foreach (var l in lines) if (l.Contains(needle)) return true;
        return false;
    }

    // Waits until pred(screen) is true or the deadline passes; returns the last screen.
    static string[] WaitFor(string what, Func<string[], bool> pred, int seconds, Process child)
    {
        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        string[] s = Screen();
        while (!pred(s))
        {
            if (child.HasExited) { Note(what + ": pianobar exited early with code " + child.ExitCode); return s; }
            if (DateTime.UtcNow > deadline) { Note(what + ": timeout after " + seconds + "s"); return s; }
            Thread.Sleep(250);
            s = Screen();
        }
        Note(what + ": matched");
        return s;
    }

    static void TypeKeys(string text)
    {
        var recs = new List<INPUT_RECORD>();
        foreach (char c in text)
        {
            ushort vk = c == '\r' ? (ushort)0x0D : (ushort)char.ToUpperInvariant(c);
            var down = new INPUT_RECORD(); down.EventType = KEY_EVENT; down.bKeyDown = 1; down.wRepeatCount = 1; down.wVirtualKeyCode = vk; down.UnicodeChar = c;
            var up = down; up.bKeyDown = 0;
            recs.Add(down); recs.Add(up);
        }
        uint written;
        if (!WriteConsoleInputW(conIn, recs.ToArray(), (uint)recs.Count, out written))
            Note("WriteConsoleInput failed: " + Marshal.GetLastWin32Error());
        else
            Note("typed " + text.Replace("\r", "<Enter>") + " (" + written + " records)");
    }

    static void Checkpoint(string name)
    {
        string ready = Path.Combine(outDir, label + "-ready-" + name);
        string go = Path.Combine(outDir, label + "-go-" + name);
        File.WriteAllText(ready, DateTime.UtcNow.ToString("o"));
        Note("checkpoint " + name + ": waiting for " + Path.GetFileName(go));
        var deadline = DateTime.UtcNow.AddSeconds(90);
        while (!File.Exists(go) && DateTime.UtcNow < deadline) Thread.Sleep(250);
        Note("checkpoint " + name + (File.Exists(go) ? ": released" : ": not released, continuing"));
    }

    static string JsonStr(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') { sb.Append('\\').Append(c); }
            else if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c);
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    static int Main(string[] args)
    {
        if (args.Length < 3) { Console.Error.WriteLine("usage: SmokeDriver <pianobar.exe> <outdir> <label> [station|-] [hold-seconds] [login-timeout]"); return 2; }
        string exe = Path.GetFullPath(args[0]);
        outDir = Path.GetFullPath(args[1]);
        label = args[2];
        string station = args.Length > 3 && args[3] != "-" ? args[3] : null;
        int hold = args.Length > 4 ? int.Parse(args[4]) : 10;
        int loginTimeout = args.Length > 5 ? int.Parse(args[5]) : 20;
        Directory.CreateDirectory(outDir);

        conOut = CreateFileW("CONOUT$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        conIn = CreateFileW("CONIN$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (conOut == (IntPtr)(-1) || conIn == (IntPtr)(-1)) { Console.Error.WriteLine("no console"); return 2; }
        IntPtr wnd = GetConsoleWindow();
        if (wnd != IntPtr.Zero) { ShowWindow(wnd, 9 /* SW_RESTORE */); SetForegroundWindow(wnd); }
        Note("console window " + wnd + ", starting " + exe);

        var psi = new ProcessStartInfo(exe);
        psi.UseShellExecute = false;
        psi.WorkingDirectory = Path.GetDirectoryName(exe);
        Process child = Process.Start(psi);
        Note("pianobar pid " + child.Id);

        bool welcome = false, stations = false, nowPlaying = false;
        string login = "none";
        string[] screen;

        screen = WaitFor("welcome", s => Contains(s, "Welcome to pianobar"), 20, child);
        welcome = Contains(screen, "Welcome to pianobar");

        screen = WaitFor("login", s => Contains(s, "Login... Ok.") || Contains(s, "Login... Error") || Contains(s, "/!\\") || Contains(s, "Error:"), loginTimeout, child);
        if (Contains(screen, "Login... Ok.")) login = "ok";
        else if (Contains(screen, "Login...")) login = "error";
        else login = "timeout";
        Note("login line: " + login);

        if (login == "ok" && station != null)
        {
            screen = WaitFor("station list", s => Contains(s, "Select station:"), 20, child);
            stations = Contains(screen, "Get stations... Ok.") && Contains(screen, "Select station:");
            Checkpoint("login");
            if (stations)
            {
                TypeKeys(station + "\r");
                screen = WaitFor("now playing", s => Contains(s, "|>"), 30, child);
                nowPlaying = Contains(screen, "|>");
                if (nowPlaying)
                {
                    Note("holding " + hold + "s so the player can fetch audio");
                    Thread.Sleep(hold * 1000);
                }
                Checkpoint("stations");
            }
        }
        else
        {
            Checkpoint("login");
        }

        screen = Screen();
        bool exited = child.HasExited;
        if (!exited) { try { child.Kill(); } catch { } }
        Note("pianobar " + (exited ? "had exited with code " + child.ExitCode : "killed"));

        var t = new StringBuilder();
        t.AppendLine("# pianobar console screen (" + label + "), captured " + DateTime.UtcNow.ToString("o"));
        t.AppendLine("# exe: " + exe);
        t.AppendLine();
        foreach (var l in screen) t.AppendLine(l);
        t.AppendLine();
        t.AppendLine("# driver events");
        foreach (var e in events) t.AppendLine(e);
        File.WriteAllText(Path.Combine(outDir, label + "-transcript.txt"), t.ToString(), new UTF8Encoding(false));

        var j = new StringBuilder("{");
        j.Append("\"label\":").Append(JsonStr(label));
        j.Append(",\"welcome\":").Append(welcome ? "true" : "false");
        j.Append(",\"login\":").Append(JsonStr(login));
        j.Append(",\"stations\":").Append(stations ? "true" : "false");
        j.Append(",\"nowPlaying\":").Append(nowPlaying ? "true" : "false");
        j.Append(",\"exitedEarly\":").Append(exited ? "true" : "false");
        j.Append(",\"screen\":[");
        for (int i = 0; i < screen.Length; i++) { if (i > 0) j.Append(','); j.Append(JsonStr(screen[i])); }
        j.Append("]}");
        File.WriteAllText(Path.Combine(outDir, label + "-result.json"), j.ToString(), new UTF8Encoding(false));
        return welcome ? 0 : 1;
    }
}
