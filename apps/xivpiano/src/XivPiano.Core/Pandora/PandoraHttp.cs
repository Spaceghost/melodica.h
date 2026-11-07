using System.Net.Security;
using System.Security.Cryptography.X509Certificates;

namespace XivPiano.Core.Pandora;

/// <summary>
/// HTTPS trust for the Pandora client. The plugin builds its own HttpClient and trusts the platform store,
/// as before; nothing here changes the game build. The release smoke test uses <see cref="CreateHandler"/>
/// with XIVPIANO_CA_BUNDLE, a PEM file whose certificates become the only trusted roots, so the released
/// client can be proven against a local Pandora-protocol server that has its own CA. Host name checking
/// is never relaxed.
/// </summary>
public static class PandoraHttp
{
    public const string CaBundleVariable = "XIVPIANO_CA_BUNDLE";

    /// <summary>A handler trusting the platform store, or only the PEM bundle at <paramref name="caBundle"/> (default: XIVPIANO_CA_BUNDLE).</summary>
    public static SocketsHttpHandler CreateHandler(string? caBundle = null)
    {
        caBundle ??= Environment.GetEnvironmentVariable(CaBundleVariable);
        var handler = new SocketsHttpHandler();
        if (string.IsNullOrWhiteSpace(caBundle))
            return handler;
        var roots = new X509Certificate2Collection();
        roots.ImportFromPemFile(caBundle);
        if (roots.Count == 0)
            throw new InvalidOperationException($"{caBundle} holds no certificate.");
        handler.SslOptions.RemoteCertificateValidationCallback = (_, certificate, chain, errors) =>
            certificate != null && Trusted(certificate as X509Certificate2 ?? new X509Certificate2(certificate), chain, errors, roots);
        return handler;
    }

    /// <summary>True when the name matches and the certificate chains to one of <paramref name="roots"/> (the platform store is not consulted).</summary>
    internal static bool Trusted(X509Certificate2 leaf, X509Chain? presented, SslPolicyErrors errors, X509Certificate2Collection roots)
    {
        if ((errors & ~SslPolicyErrors.RemoteCertificateChainErrors) != 0)
            return false; // a name mismatch or no certificate at all
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.AddRange(roots);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        if (presented != null)
        {
            foreach (var element in presented.ChainElements)
                chain.ChainPolicy.ExtraStore.Add(element.Certificate);
        }
        return chain.Build(leaf);
    }
}
