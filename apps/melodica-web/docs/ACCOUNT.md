<!-- Copy of the spacegho.st accounts client contract (kept in sync by hand). -->

# spacegho.st accounts: client contract

How melodica clients (melodica-web, melodica-extension, the Safari/iOS build) check
access, and optionally sign a user in with a spacegho.st account to read the playback
policy.

**melodica access is by allow-list.** The identity is the Pandora login email
(lowercased and trimmed). Every confirmed login is recorded (email, first and last
login, number of logins, client, Cloudflare country code; never an IP address) for the
admin's Users list, and listens go to Spaceghost Scrobbles unless the user turns that
off (see Scrobbling).

## Summary

1. **Web player (relay).** Log in to Pandora through the relay as before. The relay checks
   the login email: if it is not allowed, `auth.userLogin` fails with HTTP 403 and
   `{"stat":"fail","code":-1,"message":"melodica access is by allow-list. Your request has been sent."}`
   (Pandora is not contacted). If it is allowed and Pandora accepts the login, the
   response has a header `x-melodica-access: <token>`. Send that header on **every**
   later relay call; without it the relay answers HTTP 401 with
   `{"stat":"fail","code":-1,"message":"melodica access is by allow-list; signing in sends your email to the admin as an access request."}`.
   The token lasts 12 hours; when a call gets that 401, log in again (`auth.partnerLogin`
   + `auth.userLogin`) to get a new one.
2. **Extension (direct to Pandora).** Before `auth.userLogin`, `POST /oauth/melodica/access`
   with the same email string. If `allowed` is false, do not log in; show the
   allow-list wording above (the request has been sent).
3. **Compatibility.** Obey `plus` from `/oauth/melodica/access` or `/oauth/melodica/login-ok`, or
   from `/oauth/melodica/policy`. The web player gets it from the policy endpoint using
   the `x-melodica-access` token as the bearer. Anything unexpected means `plus: false`.
4. **Login proof and scrobbling.** Knowing an allowed email proves nothing, so nothing
   personal is handed out before Pandora has accepted the password. Web: the relay sees
   Pandora's real answer, records the login and adds `x-melodica-scrobble: <token>` next to
   `x-melodica-access`. Extension: right after Pandora's stat ok to `auth.userLogin`,
   `POST /oauth/melodica/login-ok` with the Pandora session; spacegho.st checks it with
   Pandora and only then returns a verified melodica access token and the Spaceghost
   Scrobbles client token (while scrobbling is on, the default). See Scrobbling.
5. **Optional spacegho.st sign-in** (OAuth 2.1 code + PKCE, below). It is not needed to
   use melodica. With an access token, send it as the bearer to `/oauth/melodica/access`,
   `/oauth/melodica/login-ok` and `/oauth/melodica/policy`.

## Access check (extension)

```
POST https://spacegho.st/oauth/melodica/access
Content-Type: application/json
Authorization: Bearer <spacegho.st access token>     (optional)

{"email":"<exactly what the user typed as the Pandora username>","client":"extension"}
```

`client` is `"extension"`, `"ios"` or `"web"`.

- 200 `{"allowed":true,"plus":false|true}`: log in to Pandora, then call login-ok.
  Nothing else comes back: no access token, no scrobble token, no history link.
- An allowed check counts as a login attempt; `last_login` moves only with login-ok.
- 200 `{"allowed":false,"plus":false,"message":"…"}`: do not log in; show `message`.
- 400 `{"error":"invalid_request"}`: not an email address.
- Network error or 5xx: do not log in; say the access check is unavailable and to try again.
- Emails are compared lowercased and trimmed.

## Relay (web)

- `POST https://spacegho.st/melodica/api/?method=…` with the body melodica.h built, as before.
- `auth.partnerLogin` and `test.checkLicensing` need no token.
- `auth.userLogin`: 403 (not allowed, shape above) or Pandora's answer; on `stat: "ok"`
  read `x-melodica-access` and, when present, `x-melodica-scrobble` (a Scrobbles client
  token) from the response headers (both exposed via CORS
  `Access-Control-Expose-Headers`). Send the Scrobbles token you already hold as the
  request header `x-melodica-scrobble` on `auth.userLogin` to keep it; a missing response
  header means scrobbling is off or Scrobbles was unreachable.
- Everything else: send `x-melodica-access: <token>`; 401 without a valid one.
- An `Authorization` header is ignored by the relay.

## Login confirmation (extension)

```
POST https://spacegho.st/oauth/melodica/login-ok
Content-Type: application/json
Authorization: Bearer <spacegho.st OAuth access token>     (optional, as for /access)

{"email":"<same string as for /access and auth.userLogin>","client":"extension",
 "pandora":{"userAuthToken":"<result.userAuthToken of auth.userLogin>",
            "userId":"<result.userId>","partnerId":"<partnerId from auth.partnerLogin>",
            "syncTimeOffset":<integer seconds: Pandora sync time minus local time, as used for syncTime>},
 "scrobble_token":"<current Scrobbles token, optional>"}
```

Call it right after Pandora answered stat ok to `auth.userLogin`, with that session. The
Worker calls Pandora's `user.getSettings` with it (JSON v5, android partner request key,
`syncTime = now + syncTimeOffset`) and accepts the login only if Pandora answers stat ok
and `result.username` equals the email (lowercased, trimmed). The Pandora token is used
for that one call and never stored or logged. pianobar reads the username from the same
call.

- 200 `{"ok":true,"plus":bool,"token":"<jwt>","scrobbling":bool,"scrobble"?:{"token","endpoint"}}`.
  `token` is the verified melodica access token (12 h): use it as the bearer for
  `/oauth/melodica/policy` and every `/oauth/melodica/scrobbling*` call. `scrobble` is
  present while scrobbling is on and Scrobbles answered. Send the Scrobbles token you
  already hold as `scrobble_token` to keep it; otherwise a new one is issued and older ones
  for this client beyond two are revoked.
- 401 `{"error":"login_not_verified"}`: Pandora did not confirm a login for this email
  (wrong, forged or expired session, or another account). Nothing is issued.
- 403 `{"error":"not_allowed"}`: the email is not (or no longer) on the allow-list.
- 400 `{"error":"invalid_request"}`: email or the `pandora` object missing or malformed.
- 429 `{"error":"rate_limited"}` (20 per hour per address and per email), 503
  `{"error":"temporarily_unavailable"}` (Pandora unreachable): retry later.
- Never block playback on this call; without it there is just no scrobbling, history or
  settings until the next login.

## Scrobbling (Spaceghost Scrobbles)

Listens go to Spaceghost Scrobbles (`https://spacegho.st/scrobble`, ListenBrainz-
compatible) by default. The user can turn this off. Scrobbles gets an opaque identifier,
never the email, and shows the user under a generated handle (`listener-xxxxxx`) until
they pick a display name.

**Submitting.** With `scrobble.token` (or the `x-melodica-scrobble` header):

```
POST https://spacegho.st/scrobble/1/submit-listens
Authorization: Token <scrobble token>
Content-Type: application/json
```

- At track start: `{"listen_type":"playing_now","payload":[{"track_metadata":{…}}]}`.
- Once the track has played for 50% of its duration or 4 minutes, whichever comes
  first (tracks of 30 s or less never count):
  `{"listen_type":"single","payload":[{"listened_at":<unix seconds at track start>,"track_metadata":{…}}]}`.
  Send it once per play.
- `track_metadata` holds only `artist_name`, `track_name`, `release_name` (album) and
  `additional_info: {"duration_ms": <int>, "art_url": "<https cover art URL>", "submission_client": "melodica-web"|"melodica-extension"}`.
  Nothing else: no station, no Pandora ids or tokens, no stream URLs.
- **Never submit inserted audio items** (neither playing_now nor single).
- A 401 means the token was revoked (opt-out, or replaced by a newer login): drop it
  and stop submitting until the next login hands out a token. A 429 or 5xx: retry later.
  Network errors: queue at most a handful and retry; never block playback.
- `GET /scrobble/1/validate-token` answers `{"valid":true,"user_name":"…"}`.

Scrobbling is on for every melodica user, existing ones included, unless that user
turned it off (or Jack did for them). An opt-out is stored explicitly and survives
logins; nothing turns it back on except the user's switch or Jack.

**First-run notice.** Before the first submission, show once, visibly, both on a fresh
install and on the first run after an upgrade to a scrobbling version:
"Scrobbling to spacegho.st is on. Turn it off in settings."

**Recent listens** (to fill the "recently played" list after a reload, the last 15):

```
GET https://spacegho.st/scrobble/1/user/recent?limit=15
Authorization: Token <scrobble token>
```

200 `{"listens":[{"listened_at":<unix s>,"artist":"…","title":"…","album"?:"…","duration_ms"?:<int>,"art"?:"https://…"}]}`,
newest first, completed listens only (`limit` 1–100, default 15). Token-only: history is
private.

**Settings.** The settings screen gets the scrobbling switch, a leaderboard switch, a
display name field, and two links: "Your listening history" and "Leaderboard".

- These calls need a **verified** melodica access token: the relay's `x-melodica-access`
  (web) or the `token` from login-ok (extension). Anything else gets 401
  `{"error":"invalid_token"}`.
- Scrobbling state: `GET https://spacegho.st/oauth/melodica/scrobbling` with
  `Authorization: Bearer <verified melodica access token>` →
  `{"enabled":bool,"endpoint":"https://spacegho.st/scrobble","history":"https://spacegho.st/oauth/melodica/scrobbling/history","leaderboard":"https://spacegho.st/scrobble/leaderboard"}`.
- Switch: `POST https://spacegho.st/oauth/melodica/scrobbling`, same bearer,
  `{"enabled":false}` or `{"enabled":true,"client":"web"|"extension"|"ios"}`.
  Off revokes every Scrobbles token of the user (they answer 401 from then on), takes the
  user off the leaderboards, and stops new tokens. On returns `scrobble: {token, endpoint}`
  for this client. 503 `{"error":"temporarily_unavailable"}`: nothing changed; say so
  and keep the switch where it was. 404 `{"error":"unknown_user"}`: log in again first.
- Display name and leaderboard (needs a Scrobbles token, so only while scrobbling is on):
  `GET https://spacegho.st/scrobble/1/user/settings` →
  `{"display_name":"","handle":"listener-7f3a2c","name":"listener-7f3a2c","leaderboard":true}`;
  `POST` the same URL with `{"display_name":"…"}` (1–40 characters; no email address or
  link, 400 otherwise; `""` goes back to the handle) and/or `{"leaderboard":false}`.
  Label the switch "Show me on the leaderboard". It starts on for melodica users; turning
  scrobbling back on does not turn it on again.
- "Your listening history": `POST https://spacegho.st/oauth/melodica/scrobbling/history`
  with the bearer → `{"url":"https://spacegho.st/…/ticket?t=…","expires_in":120}`. Open
  `url` in a new tab at once (open the tab synchronously on click, then set its location,
  so popup blockers allow it). The link works once and signs the user in to their
  Scrobbles dashboard for 12 hours, where they can export or delete their history.
- "Leaderboard": link `https://spacegho.st/scrobble/leaderboard` (public).

**Leaderboards.** `https://spacegho.st/scrobble/leaderboard` (HTML) and
`GET https://spacegho.st/scrobble/1/leaderboard?window=7d|30d|all` (JSON, public, CORS
`*`): `{"window","generated_at","songs":[{"artist","title","listens"}],"artists":[{"artist","listens"}],"listeners":[{"name","listens"}]}`,
top 25 each, refreshed every few minutes. Only accounts with the leaderboard switch on
count.

The Scrobbles API sends no CORS headers except on `/1/leaderboard`: the web app calls it same-origin, and the extension needs host permission for `https://spacegho.st/scrobble/*`.

Trust: Scrobbles tokens, verified access tokens, history links, settings and the
opt-out switch are handed out only after Pandora accepted the password, as seen by the
relay (web) or confirmed with Pandora by login-ok (extension). The access check alone
is client-side and only decides whether to try logging in.

## Endpoints

Discovery: `https://spacegho.st/.well-known/openid-configuration` (issuer `https://spacegho.st`).

| What | URL |
| --- | --- |
| authorize | `https://spacegho.st/oauth/authorize` |
| token | `https://spacegho.st/oauth/token` |
| userinfo | `https://spacegho.st/oauth/userinfo` |
| JWKS (ES256) | `https://spacegho.st/oauth/jwks` |
| revoke (refresh tokens) | `https://spacegho.st/oauth/revoke` |
| logout | `https://spacegho.st/oauth/logout` |
| melodica policy | `https://spacegho.st/oauth/melodica/policy` |
| melodica access check | `https://spacegho.st/oauth/melodica/access` |
| melodica login confirmation | `https://spacegho.st/oauth/melodica/login-ok` |
| melodica scrobbling switch | `https://spacegho.st/oauth/melodica/scrobbling` |
| melodica history link | `https://spacegho.st/oauth/melodica/scrobbling/history` |
| Scrobbles API base | `https://spacegho.st/scrobble/1/` |
| Scrobbles leaderboard | `https://spacegho.st/scrobble/leaderboard` |

CORS: `token`, `userinfo`, `revoke`, `policy`, `access`, `login-ok`, `scrobbling`, `jwks` and discovery answer
`Access-Control-Allow-Origin: *` (no cookies are involved).

## Registered clients

| client_id | redirect_uri |
| --- | --- |
| `melodica-web` | `https://spacegho.st/melodica/app/` (exact) |
| `melodica-extension` | `https://<id>.chromiumapp.org/…` or `https://<id>.extensions.allizom.org/…` (what `identity.getRedirectURL()` returns) |
| `melodica-ios` | `https://spacegho.st/melodica/app/` (exact; the Safari build opens the sign-in in a tab and a content script on this page picks up `code` and `state`) |

A redirect URI must match exactly (or the pattern above); otherwise the authorize page
shows an error and never redirects.

## Sign-in flow

1. Make a `code_verifier` (43–128 chars of `[A-Za-z0-9._~-]`, e.g. 32 random bytes
   base64url) and `code_challenge = base64url(SHA-256(code_verifier))`. Make a random `state`.
2. Open (web: navigate; extension: `identity.launchWebAuthFlow({interactive: true})`;
   Safari: a tab):

   ```
   https://spacegho.st/oauth/authorize?response_type=code
     &client_id=melodica-web
     &redirect_uri=https%3A%2F%2Fspacegho.st%2Fmelodica%2Fapp%2F
     &code_challenge=<challenge>&code_challenge_method=S256
     &state=<state>&scope=openid%20profile
   ```

   `prompt=none` returns `error=login_required` at once when there is no spacegho.st
   session (useful for a silent check). Other `prompt` values are ignored.
3. The user signs in on spacegho.st (GitHub). The browser comes back to
   `redirect_uri?code=…&state=…&iss=https%3A%2F%2Fspacegho.st`, or
   `?error=…&state=…&iss=…`. Check `state` and `iss`. Remove `code` from the address bar
   (`history.replaceState`).
4. Exchange the code (form-encoded POST):

   ```
   POST https://spacegho.st/oauth/token
   grant_type=authorization_code&code=<code>&redirect_uri=<same redirect_uri>
     &client_id=melodica-web&code_verifier=<verifier>
   ```

   200 →
   `{"access_token","token_type":"Bearer","expires_in":3600,"refresh_token","id_token","scope"}`.
   Codes are single use and live 60 seconds. Errors are 400/401
   `{"error":"invalid_grant"|"invalid_request"|"invalid_client"|"unsupported_grant_type"}`.
5. Refresh when the access token expires (1 hour). Refresh tokens are rotated: every
   refresh returns a new one and the old one stops working. They last 90 days.

   ```
   POST https://spacegho.st/oauth/token
   grant_type=refresh_token&refresh_token=<token>&client_id=melodica-web
   ```

   `invalid_grant` means the user must sign in again; until then, use `plus: false`.

## Policy

```
GET https://spacegho.st/oauth/melodica/policy
Authorization: Bearer <OAuth access token, or a melodica access token>
```

```json
{"playback":{"plus":false},"display":{"name":"alice"}}
```

- `playback.plus` (boolean): compatibility field; false is the default.
  `false` → the client may skip them. The client does not know or show why.
- `display.name` (string or null): a name to show for the signed-in account.
- No `Authorization` header: 200 `{"playback":{"plus":false},"display":{"name":null}}`.
- Invalid or expired token: 401 `{"error":"invalid_token"}`; refresh and retry once, else
  treat as `plus: false`.
- With a melodica access token, `display.name` is null.
- Network errors, 5xx, or an unexpected body: `plus: false`.
- Ask again at app start and after every token refresh. The answer can change.
- Show no text about this flag. In particular, do not tell users that it exists, what it
  depends on, or that it differs between accounts.

## Tokens

Access and ID tokens are ES256 JWTs signed with the key in `/oauth/jwks` (`kid` in the
header). Clients need not verify them: they only send the access token to spacegho.st.
Access token claims: `iss`, `sub` (account id), `aud` = `client_id`, `client_id`, `scope`,
`iat`, `exp`, `jti`; header `typ: at+jwt`. The ID token carries `sub`, `aud`, `iat`, `exp`,
`auth_time`, `nonce` (when sent to authorize), and `name` with the `profile` scope.

Store the refresh token where the platform keeps secrets for the app (extension:
`storage.local`; web: `localStorage` is acceptable for this public client). Never log
tokens or codes.

## Sign out

- Forget the tokens locally and `POST /oauth/revoke` with `token=<refresh_token>`.
- To also end the spacegho.st browser session, open
  `https://spacegho.st/oauth/logout?client_id=<id>&post_logout_redirect_uri=<a registered redirect_uri>`;
  it returns there (with `state` if given), or shows a "Signed out" page without a valid
  redirect.

## Older clients

Clients up to v0.4.x call `https://spacegho.st/melodica/auth/*`; `/auth/me` answers 503
without a token (go to the Pandora login) and 200 for a valid old token. They do not send
`x-melodica-access`, so after login the relay answers 401: the hosted web player must ship
the relay changes above. Old extension builds are not checked (they talk to Pandora
directly).
