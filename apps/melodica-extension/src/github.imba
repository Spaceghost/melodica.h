# The GitHub gate's client half. The melodica-site Worker at
# https://spacegho.st/melodica/auth/ does the OAuth dance (identity only, no
# scopes) and answers whether the signed-in login may use melodica; this file
# only parses what it hands back. Nothing here is verified: the token's second
# segment is an HMAC the Worker checks on every /auth/me call, and the client
# reads the first segment just to show who is signed in and when it expires.
#
# Token: base64url(JSON claims) "." base64url(hmac); claims {sub: GitHub login,
# id, friend: boolean ("allowed" here), iat, exp (seconds), chk}. The Worker's redirect back to the
# extension carries it as `#melodica_token=<token>` in the URL fragment.

export const AUTH_BASE = 'https://spacegho.st/melodica/auth'
export const TOKEN_PARAM = 'melodica_token'

# base64url (RFC 4648 §5, unpadded or padded) to bytes.
export def fromBase64Url text
	let s = String(text or '').replace(/-/g, '+').replace(/_/g, '/')
	return null if /[^A-Za-z0-9+\/=]/.test(s)
	s += '='.repeat((4 - s.length % 4) % 4) if s.length % 4
	let bin
	try
		bin = atob(s)
	catch e
		return null
	const out = new Uint8Array(bin.length)
	let i = 0
	while i < bin.length
		out[i] = bin.charCodeAt(i)
		i += 1
	out

# The claims of a token, or null when it is not shaped like one. `allowed` (the
# Worker's `friend`) is a strict boolean, `exp` must be a number of seconds; everything else is passed on.
export def parseToken token
	return null unless typeof token === 'string'
	const parts = token.split('.')
	return null unless parts.length === 2 and parts[0] and parts[1]
	const bytes = fromBase64Url(parts[0])
	return null unless bytes
	let claims
	try
		claims = JSON.parse(new TextDecoder().decode(bytes))
	catch e
		return null
	return null unless claims and typeof claims === 'object' and !Array.isArray(claims)
	return null unless typeof claims.sub === 'string' and claims.sub.length > 0
	return null unless typeof claims.exp === 'number' and Number.isFinite(claims.exp)
	{
		sub: claims.sub
		id: claims.id
		allowed: claims.friend === yes
		iat: typeof claims.iat === 'number' ? claims.iat : null
		exp: claims.exp
		chk: typeof claims.chk === 'number' ? claims.chk : null
	}

# True when the claims have run out (or are missing). `now` is in seconds.
export def expired claims, now = Date.now() / 1000
	return yes unless claims
	!(claims.exp > now)

# The token from the URL launchWebAuthFlow returns: `#melodica_token=…` in the
# fragment, anywhere among other fragment fields; the query is not looked at.
export def tokenFromRedirect url
	return null unless typeof url === 'string' and url
	let hash = ''
	try
		hash = new URL(url).hash
	catch e
		return null
	return null unless hash.startsWith('#')
	const token = new URLSearchParams(hash.slice(1)).get(TOKEN_PARAM)
	token and parseToken(token) ? token : null

# The auth base with no trailing slash; the default when empty or not a URL.
export def normalizeAuthBase value
	let text = String(value or '').trim().replace(/\/+$/, '')
	return AUTH_BASE unless text
	try
		const u = new URL(text)
		return AUTH_BASE unless u.protocol === 'https:' or u.protocol === 'http:'
		u.search = ''
		u.hash = ''
		u.toString().replace(/\/+$/, '')
	catch e
		AUTH_BASE

export def startUrl base, returnTo
	"{normalizeAuthBase(base)}/start?return_to={encodeURIComponent(returnTo)}"

export def meUrl base
	"{normalizeAuthBase(base)}/me"
