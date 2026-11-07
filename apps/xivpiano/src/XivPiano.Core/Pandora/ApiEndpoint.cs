namespace XivPiano.Core.Pandora;

/// <summary>
/// An alternative host (and port) for Pandora's JSON API, for proving the client against a server that
/// speaks the protocol (the release smoke test's melodica-tuner). The native bridge still builds
/// https://host/services/json/?... itself; only the host name goes to it, the port is applied to the URL
/// it returns. HTTPS stays required: a plain-HTTP server cannot be named here.
/// </summary>
public sealed record ApiEndpoint(string Host, int Port = 0)
{
    public const string Variable = "XIVPIANO_API_HOST";

    /// <summary>The endpoint named by XIVPIANO_API_HOST, or null when it is unset (the production hosts).</summary>
    public static ApiEndpoint? FromEnvironment() => Parse(Environment.GetEnvironmentVariable(Variable));

    /// <summary>"host" or "host:port"; null or blank is no override.</summary>
    public static ApiEndpoint? Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return null;
        text = text.Trim();
        var port = 0;
        var colon = text.LastIndexOf(':');
        if (colon >= 0)
        {
            if (!int.TryParse(text[(colon + 1)..], out port) || port is < 1 or > 65535)
                throw new FormatException($"{Variable} must be host or host:port, not '{text}'.");
            text = text[..colon];
        }
        if (text.Length == 0 || !text.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '.'))
            throw new FormatException($"{Variable} names a host with letters, digits, '-' and '.', not '{text}'.");
        return new ApiEndpoint(text, port);
    }

    /// <summary>The same partner identity answering on this host.</summary>
    public Partner Apply(Partner partner) => partner with { Host = Host };

    /// <summary>The request the bridge built, on this port (the host is already in it).</summary>
    public Uri Apply(Uri url) => Port == 0 ? url : new UriBuilder(url) { Port = Port }.Uri;

    public override string ToString() => Port == 0 ? Host : $"{Host}:{Port}";
}
