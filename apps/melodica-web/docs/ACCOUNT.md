<!-- Copy of the spacegho.st accounts client contract (kept in sync by hand). -->

# spacegho.st accounts: client contract

How melodica clients (melodica-web, melodica-extension, the Safari/iOS build) check
access, and optionally sign a user in with a spacegho.st account to read the playback
policy.

**melodica access is by allow-list.** The iden## Summary

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
3. **Ads.** Obey `ads` from `/oauth/melodica/access`, or from `/oauth/melodica/policy`.
   The web player gets it from the policy endpoint using the `x-melodica-access` token as
   the bearer. Anything unexpected means `ads: true`.
4. **Optional spacegho.st sign-in** (OAuth 2.1 code + PKCE, below). It is not needed to
   use melodica. With an access token, send it as the bearer to `/oauth/melodica/access`
   and `/oauth/melodica/policy`.

## Access check (extension)

```
POST https://spacegho.st/oauth/melodica/access
Content-Type: application/json
Authorization: Bearer <spacegho.st access token>     (optional)

{"email":"<exactly what the user typed as the Pandora username>","client":"extension"}
```

`client` is `"extension"`, `"ios"` or `"web"`.

- 200 `{"allowed":true,"ads":false|true,"token":"<jwt>"}`: log in to Pandora.
  `token` is a melodica access token (12 h) usable as the bearer for `/oauth/melodica/policy`.
- 200 `{"allowed":false,"ads":true,"message":"…"}`: do not log in; show `message`.
- 400 `{"error":"invalid_request"}`: not an email address.
- Network error or 5xx: do not log in; say the access check is unavailable and to try again.
- Emails are compared lowercased and trimmed.

## Relay (web)

- `POST https://spacegho.st/melodica/api/?method=…` with the body melodica.h built, as before.
- `auth.partnerLogin` and `test.checkLicensing` need no token.
- `auth.userLogin`: 403 (not allowed, shape above) or Pandora's answer; on `stat: "ok"`
  read `x-melodica-access` from the response headers (exposed via CORS
  `Access-Control-Expose-Headers`).
- Everything else: send `x-melodica-access: <token>`; 401 without a valid one.
- An `Authorization` header is ignored by the relay.

token, `GET https://spacegho.st/oauth/melodica/policy` and obey
   `playback.ads`. Anything other than a 200 with that shape means `ads: true`.
4. The Pandora login is still required in every case; the spacegho.st account only
   changes the policy.

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

CORS: `token`, `userinfo`, `revoke`, `policy`, `access`, `jwks` and discovery answer
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

   `invalid_grant` means the user must sign in again; until then, use `ads: true`.

## Policy

```
GET https://spacegho.st/oauth/melodica/policy
Authorization: Bearer <OAuth access token, or a melodica access token>
```

```json
{"playback":{"ads":true},"display":{"name":"alice"}}
```

- `playback.ads` (boolean): `true` → play Pandora's audio ads as Pandora sends them;
  `false` → the client may skip them. The client does not know or show why.
- `display.name` (string or null): a name to show for the signed-in account.
- No `Authorization` header: 200 `{"playback":{"ads":true},"display":{"name":null}}`.
- Invalid or expired token: 401 `{"error":"invalid_token"}`; refresh and retry once, else
  treat as `ads: true`.
- With a melodica access token, `display.name` is null.
- Network errors, 5xx, or an unexpected body: `ads: true`.
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
