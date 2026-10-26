const encoder = new TextEncoder();
const decoder = new TextDecoder();

type TokenPayload = { sub: number; login: string; exp: number };
type GitHubUser = { id: number; login: string };
type RefreshRow = { github_id: number; github_login: string; expires_at: number };
type StateRow = { redirect_uri: string; expires_at: number };
type ClaimRow = { github_id: number; github_login: string; expires_at: number };
type KeyRow = { version: number; ciphertext: string; nonce: string; created_at: number; retired: number };
type PeerRow = { device_id: string; endpoint: string; public_key: string | null; capabilities: string; expires_at: number };

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64url(value);
}

async function sha256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", base64ToBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function issueAccessToken(env: Env, user: GitHubUser): Promise<string> {
  const payload: TokenPayload = {
    sub: user.id,
    login: user.login.toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + Number(env.ACCESS_TOKEN_SECONDS),
  };
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SIGNING_KEY), encoder.encode(body));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

async function verifyAccessToken(env: Env, token: string): Promise<TokenPayload | null> {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) return null;
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(env.SESSION_SIGNING_KEY),
    base64ToBytes(signature), encoder.encode(body));
  if (!valid) return null;
  try {
    const payload = JSON.parse(decoder.decode(base64ToBytes(body))) as TokenPayload;
    if (!Number.isInteger(payload.sub) || typeof payload.login !== "string" || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

function hasVaultAccess(env: Env, login: string): boolean {
  const users = env.VAULT_GITHUB_USERS.split(",").map((value) => value.trim().toLowerCase());
  return users.includes(login.toLowerCase());
}

function unavailable(): Response {
  return json({ error: "not found" }, 404);
}

function validRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) ||
      url.protocol === "melodica:";
  } catch {
    return false;
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

async function requireUser(request: Request, env: Env): Promise<TokenPayload | Response> {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const payload = await verifyAccessToken(env, token);
  return payload || json({ error: "unauthorized" }, 401);
}

async function issueSession(env: Env, user: GitHubUser): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const refreshToken = randomToken(48);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO refresh_tokens(token_hash, github_id, github_login, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(await sha256(refreshToken), user.id, user.login.toLowerCase(), now + 180 * 86400, now).run();
  return { access_token: await issueAccessToken(env, user), refresh_token: refreshToken,
    expires_in: Number(env.ACCESS_TOKEN_SECONDS) };
}

async function oauthLogin(request: Request, env: Env): Promise<Response> {
  const redirect = new URL(request.url).searchParams.get("redirect_uri") || "";
  if (!validRedirect(redirect)) return json({ error: "invalid redirect_uri" }, 400);
  const state = randomToken();
  await env.DB.prepare("INSERT INTO oauth_states(state_hash, redirect_uri, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(state), redirect, Math.floor(Date.now() / 1000) + 600).run();
  const target = new URL("https://github.com/login/oauth/authorize");
  target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  target.searchParams.set("redirect_uri", `${env.PUBLIC_ORIGIN}/auth/callback`);
  target.searchParams.set("state", state);
  target.searchParams.set("scope", "read:user");
  return Response.redirect(target.toString(), 302);
}

async function oauthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const row = await env.DB.prepare("SELECT redirect_uri, expires_at FROM oauth_states WHERE state_hash = ?")
    .bind(await sha256(state)).first<StateRow>();
  await env.DB.prepare("DELETE FROM oauth_states WHERE state_hash = ?").bind(await sha256(state)).run();
  if (!code || !row || row.expires_at < Date.now() / 1000) return json({ error: "invalid OAuth state" }, 400);
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json", "User-Agent": "melodica-cloud" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
  });
  const tokenData: unknown = await tokenResponse.json();
  if (!tokenData || typeof tokenData !== "object" || !("access_token" in tokenData) ||
      typeof tokenData.access_token !== "string") return json({ error: "GitHub OAuth exchange failed" }, 502);
  const userResponse = await fetch("https://api.github.com/user", {
    headers: { "Accept": "application/vnd.github+json", "Authorization": `Bearer ${tokenData.access_token}`,
      "User-Agent": "melodica-cloud", "X-GitHub-Api-Version": "2022-11-28" },
  });
  const userData: unknown = await userResponse.json();
  if (!userData || typeof userData !== "object" || !("id" in userData) || !("login" in userData) ||
      typeof userData.id !== "number" || typeof userData.login !== "string") {
    return json({ error: "GitHub identity lookup failed" }, 502);
  }
  const claim = randomToken(32);
  await env.DB.prepare("INSERT INTO auth_claims(claim_hash, github_id, github_login, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(claim), userData.id, userData.login.toLowerCase(), Math.floor(Date.now() / 1000) + 90).run();
  const redirect = new URL(row.redirect_uri);
  redirect.searchParams.set("claim", claim);
  return Response.redirect(redirect.toString(), 302);
}

async function githubTokenSession(request: Request, env: Env): Promise<Response> {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("GitHub ") ? authorization.slice(7) : "";
  if (token.length < 20 || token.length > 512) return json({ error: "invalid GitHub token" }, 400);
  const userResponse = await fetch("https://api.github.com/user", {
    headers: { "Accept": "application/vnd.github+json", "Authorization": `Bearer ${token}`,
      "User-Agent": "melodica-cloud", "X-GitHub-Api-Version": "2022-11-28" },
  });
  const userData: unknown = await userResponse.json();
  if (!userResponse.ok || !userData || typeof userData !== "object" || !("id" in userData) || !("login" in userData) ||
      typeof userData.id !== "number" || typeof userData.login !== "string") return json({ error: "GitHub authentication failed" }, 401);
  return json(await issueSession(env, { id: userData.id, login: userData.login }));
}

async function claimSession(request: Request, env: Env): Promise<Response> {
  const body: unknown = await request.json();
  if (!body || typeof body !== "object" || !("claim" in body) || typeof body.claim !== "string") {
    return json({ error: "invalid claim" }, 400);
  }
  const hash = await sha256(body.claim);
  const row = await env.DB.prepare("SELECT github_id, github_login, expires_at FROM auth_claims WHERE claim_hash = ?")
    .bind(hash).first<ClaimRow>();
  await env.DB.prepare("DELETE FROM auth_claims WHERE claim_hash = ?").bind(hash).run();
  if (!row || row.expires_at < Date.now() / 1000) return json({ error: "expired claim" }, 401);
  return json(await issueSession(env, { id: row.github_id, login: row.github_login }));
}

async function refreshSession(request: Request, env: Env): Promise<Response> {
  const body: unknown = await request.json();
  if (!body || typeof body !== "object" || !("refresh_token" in body) || typeof body.refresh_token !== "string") {
    return json({ error: "invalid refresh token" }, 400);
  }
  const hash = await sha256(body.refresh_token);
  const row = await env.DB.prepare("SELECT github_id, github_login, expires_at FROM refresh_tokens WHERE token_hash = ?")
    .bind(hash).first<RefreshRow>();
  if (!row || row.expires_at < Date.now() / 1000) return json({ error: "expired refresh token" }, 401);
  await env.DB.prepare("DELETE FROM refresh_tokens WHERE token_hash = ?").bind(hash).run();
  return json(await issueSession(env, { id: row.github_id, login: row.github_login }));
}

async function rootKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", base64ToBytes(env.ROOT_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function rotateKey(user: TokenPayload, env: Env): Promise<Response> {
  if (user.login !== env.OWNER_GITHUB_USER.toLowerCase()) return unavailable();
  const secret = JSON.stringify({ password: randomToken(32), password2: randomToken(32) });
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await rootKey(env), encoder.encode(secret));
  await env.DB.prepare("UPDATE library_keys SET retired = 1 WHERE retired = 0").run();
  const result = await env.DB.prepare(
    "INSERT INTO library_keys(ciphertext, nonce, created_at, retired) VALUES (?, ?, ?, 0)"
  ).bind(bytesToBase64(new Uint8Array(ciphertext)), bytesToBase64(nonce), Math.floor(Date.now() / 1000)).run();
  return json({ version: result.meta.last_row_id });
}

async function keyring(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  if (!hasVaultAccess(env, user.login)) return unavailable();
  const body: unknown = await request.json();
  if (!body || typeof body !== "object" || !("public_key" in body) || typeof body.public_key !== "string" ||
      body.public_key.length > 8192) return json({ error: "invalid public key" }, 400);
  const rows = await env.DB.prepare(
    "SELECT version, ciphertext, nonce, created_at, retired FROM library_keys ORDER BY version"
  ).all<KeyRow>();
  const keys = [];
  for (const row of rows.results) {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(row.nonce) },
      await rootKey(env), base64ToBytes(row.ciphertext));
    keys.push({ version: row.version, created_at: row.created_at, retired: Boolean(row.retired),
      ...JSON.parse(decoder.decode(plaintext)) as { password: string; password2: string } });
  }
  const responseKey = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce },
    await crypto.subtle.importKey("raw", responseKey, "AES-GCM", false, ["encrypt"]), encoder.encode(JSON.stringify(keys)));
  const publicKey = await crypto.subtle.importKey("spki", base64ToBytes(body.public_key),
    { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const wrappedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, responseKey);
  return json({ algorithm: "RSA-OAEP-256+A256GCM", wrapped_key: bytesToBase64(new Uint8Array(wrappedKey)),
    nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(new Uint8Array(encrypted)) });
}

async function r2Credentials(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  if (!hasVaultAccess(env, user.login)) return unavailable();
  if (!env.R2_PARENT_ACCESS_KEY_ID || !env.R2_PARENT_SECRET_ACCESS_KEY) return unavailable();
  const now = Math.floor(Date.now() / 1000);
  const expires = now + Math.min(Math.max(Number(env.R2_CREDENTIAL_SECONDS), 900), 86400);
  const header = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64url(encoder.encode(JSON.stringify({
    sub: env.R2_ACCOUNT_ID, iss: env.R2_PARENT_ACCESS_KEY_ID,
    aud: `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, iat: now, exp: expires,
    bucket: env.R2_BUCKET_NAME, scope: "object-read-write",
  })));
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.R2_PARENT_SECRET_ACCESS_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(unsigned))));
  const token = `${unsigned}.${signature}`;
  const secret = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
  return json({
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, region: "auto",
    bucket: env.R2_BUCKET_NAME, access_key_id: env.R2_PARENT_ACCESS_KEY_ID,
    secret_access_key: Array.from(secret, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    session_token: bytesToBase64(encoder.encode(`jwt/${token}`)), expires_at: expires,
  });
}

function validEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "quic:") && value.length <= 512;
  } catch { return false; }
}

async function announcePeer(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const body: unknown = await request.json();
  if (!body || typeof body !== "object") return json({ error: "invalid announcement" }, 400);
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.swarm !== "string" || candidate.swarm.length < 16 || candidate.swarm.length > 256 ||
      typeof candidate.device_id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(candidate.device_id) ||
      typeof candidate.endpoint !== "string" || !validEndpoint(candidate.endpoint)) {
    return json({ error: "invalid announcement" }, 400);
  }
  const publicKey = typeof candidate.public_key === "string" && candidate.public_key.length <= 8192 ? candidate.public_key : null;
  const capabilities = Array.isArray(candidate.capabilities)
    ? candidate.capabilities.filter((item): item is string => typeof item === "string" && /^[a-z0-9_-]{1,32}$/.test(item)).slice(0, 16)
    : [];
  const now = Math.floor(Date.now() / 1000);
  const expires = now + 300;
  const swarmHash = await sha256(candidate.swarm);
  await env.DB.prepare("DELETE FROM peer_leases WHERE expires_at < ?").bind(now).run();
  await env.DB.prepare(
    `INSERT INTO peer_leases(swarm_hash, github_id, device_id, endpoint, public_key, capabilities, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(swarm_hash, github_id, device_id) DO UPDATE SET endpoint=excluded.endpoint,
       public_key=excluded.public_key, capabilities=excluded.capabilities, expires_at=excluded.expires_at,
       updated_at=excluded.updated_at`
  ).bind(swarmHash, user.sub, candidate.device_id, candidate.endpoint, publicKey,
    JSON.stringify(capabilities), expires, now).run();
  const rows = await env.DB.prepare(
    `SELECT device_id, endpoint, public_key, capabilities, expires_at FROM peer_leases
     WHERE swarm_hash = ? AND expires_at >= ? AND NOT (github_id = ? AND device_id = ?)
     ORDER BY updated_at DESC LIMIT 64`
  ).bind(swarmHash, now, user.sub, candidate.device_id).all<PeerRow>();
  return json({ interval: 180, expires_at: expires, peers: rows.results.map((peer) => ({
    device_id: peer.device_id, endpoint: peer.endpoint, public_key: peer.public_key,
    capabilities: JSON.parse(peer.capabilities) as string[], expires_at: peer.expires_at,
  })) });
}

async function leaveTracker(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  const body: unknown = await request.json();
  if (!body || typeof body !== "object") return json({ error: "invalid leave" }, 400);
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.swarm !== "string" || typeof candidate.device_id !== "string") return json({ error: "invalid leave" }, 400);
  await env.DB.prepare("DELETE FROM peer_leases WHERE swarm_hash = ? AND github_id = ? AND device_id = ?")
    .bind(await sha256(candidate.swarm), user.sub, candidate.device_id).run();
  return new Response(null, { status: 204 });
}

async function pandoraAgent(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (user instanceof Response) return user;
  if (env.PANDORA_AGENT_ENABLED !== "true" || !env.PANDORA_AGENT_ORIGIN) {
    return json({ error: "Pandora credential agent is disabled" }, 503);
  }
  if (!request.body || Number(request.headers.get("Content-Length") || 0) > 262144) return json({ error: "invalid request" }, 400);
  const upstream = await fetch(env.PANDORA_AGENT_ORIGIN, {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.PANDORA_AGENT_SECRET}`, "Content-Type": "application/json",
      "X-Melodica-User": user.login },
    body: request.body,
  });
  return new Response(upstream.body, { status: upstream.status, headers: { "Content-Type": "application/json" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return json({ ok: true });
      if (url.pathname === "/auth/login" && request.method === "GET") return oauthLogin(request, env);
      if (url.pathname === "/auth/callback" && request.method === "GET") return oauthCallback(request, env);
      if (url.pathname === "/auth/github-token" && request.method === "POST") return githubTokenSession(request, env);
      if (url.pathname === "/auth/claim" && request.method === "POST") return claimSession(request, env);
      if (url.pathname === "/auth/refresh" && request.method === "POST") return refreshSession(request, env);
      if (url.pathname === "/v1/keyring" && request.method === "POST") return keyring(request, env);
      if (url.pathname === "/v1/storage/credentials" && request.method === "POST") return r2Credentials(request, env);
      if (url.pathname === "/v1/tracker/announce" && request.method === "POST") return announcePeer(request, env);
      if (url.pathname === "/v1/tracker/leave" && request.method === "POST") return leaveTracker(request, env);
      if (url.pathname === "/v1/admin/rotate" && request.method === "POST") {
        const user = await requireUser(request, env);
        return user instanceof Response ? user : rotateKey(user, env);
      }
      if (url.pathname === "/v1/pandora/rpc" && request.method === "POST") return pandoraAgent(request, env);
      return json({ error: "not found" }, 404);
    } catch (error) {
      console.error(JSON.stringify({ message: "request failed", path: url.pathname,
        error: error instanceof Error ? error.message : String(error) }));
      return json({ error: "internal server error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
