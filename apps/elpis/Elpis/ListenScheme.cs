/*
 * Registers Elpis as the handler of listen:// links for the current Windows user
 * (HKCU\Software\Classes\listen, no administrator rights). Elpis registers itself when no
 * handler is registered or the registered program no longer exists, so it does not take
 * listen:// from another program; Settings can make Elpis the handler on purpose.
 */
using System;
using System.IO;
using Microsoft.Win32;

namespace Elpis.Links
{
    public static class ListenScheme
    {
        public const string Scheme = "listen";

        public static string CommandFor(string exePath) { return "\"" + exePath + "\" \"%1\""; }

        /// <summary>The program the scheme opens now, or null.</summary>
        public static string RegisteredCommand(string scheme = Scheme)
        {
            using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Classes\" + scheme + @"\shell\open\command"))
                return k == null ? null : k.GetValue("") as string;
        }

        /// <summary>The exe path in a command line written by CommandFor (or any quoted first argument).</summary>
        public static string ExeOf(string command)
        {
            if (string.IsNullOrEmpty(command)) return null;
            var c = command.Trim();
            if (c.StartsWith("\"", StringComparison.Ordinal))
            {
                var end = c.IndexOf('"', 1);
                return end > 1 ? c.Substring(1, end - 1) : null;
            }
            var sp = c.IndexOf(' ');
            return sp > 0 ? c.Substring(0, sp) : c;
        }

        /// <summary>Writes the scheme for exePath. Without force, only when there is no working handler. True when written.</summary>
        public static bool Register(string exePath, bool force, string scheme = Scheme)
        {
            var current = RegisteredCommand(scheme);
            if (!force && current != null)
            {
                var exe = ExeOf(current);
                if (exe != null && File.Exists(exe)) return false; // someone (maybe Elpis) handles it already
            }
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\" + scheme))
            {
                k.SetValue("", "URL:listen:// link (melodica)");
                k.SetValue("URL Protocol", "");
                using (var icon = k.CreateSubKey("DefaultIcon")) icon.SetValue("", "\"" + exePath + "\",0");
                using (var cmd = k.CreateSubKey(@"shell\open\command")) cmd.SetValue("", CommandFor(exePath));
            }
            return true;
        }

        public static bool IsRegisteredTo(string exePath, string scheme = Scheme)
        {
            var exe = ExeOf(RegisteredCommand(scheme));
            return exe != null && string.Equals(Path.GetFullPath(exe), Path.GetFullPath(exePath), StringComparison.OrdinalIgnoreCase);
        }
    }
}
