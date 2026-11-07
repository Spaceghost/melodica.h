# The optional spacegho.st account (docs/ACCOUNT.md): OAuth 2.1 authorization
# code + PKCE (S256), a public client, refresh tokens rotated on every use, and
# the playback policy from /oauth/melodica/policy. Pure functions only, so
# tests/account.test.mjs can run them in Node; bg.imba does the I/O.

export const ACCOUNT_BASE = 'https://spacegho.st'
export const CLIENT_ID = 'melodica-extension'
# Safari opens the sign-in in a tab that comes back to the web app page.
export const TAB_CLIENT_ID = 'melodica-ios'
export const TAB_REDIRECT = 'https://spacegho.st/melodica/app/'
export const SCOPE = 'openid profile email offline_access'
export const POLICY_DEFAULT = {spots: yes, name: null}

# The account server's origin: https, or http on localhost (the Firefox smoke).
export def normalizeAccountBase v
	const s = String(v or '').trim()
	return ACCOUNT_BASE unless s
	try
		const u = new URL(s)
		return ACCOUNT_BASE unless u.protocol === 'https:' or (u.protocol === 'http:' and (u.hostname === 'localhost' or u.hostname === '127.0.0.1'))
		return u.origin
	catch e
		return ACCOUNT_BASE

def b64url bytes
	let s = ''
	for b in bytes
		s += String.fromCharCode(b)
	btoa(s).split('+').join('-').split('/').join('_').replace(new RegExp('=+$'), '')

export def randomString n = 32
	const a = new Uint8Array(n)
	crypto.getRandomValues(a)
	b64url(a)

export def pkceChallenge verifier
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
	b64url(new Uint8Array(digest))

export def authorizeUrl base, o
	const q = new URLSearchParams({response_type: 'code', client_id: o.clientId, redirect_uri: o.redirectUri, code_challenge: o.challenge, code_challenge_method: 'S256', state: o.state, scope: SCOPE})
	q.set('prompt', o.prompt) if o.prompt
	"{base}/oauth/authorize?{q}"

# The redirect back: {code} or {error}; state and iss must match.
export def parseRedirect url, o
	let u
	try
		u = new URL(String(url))
	catch e
		return {error: 'the sign-in came back with no address'}
	const p = u.searchParams
	return {error: 'the sign-in came back for another request'} unless p.get('state') === o.state
	return {error: 'the sign-in came back from another server'} if p.get('iss') and p.get('iss') !== o.issuer
	return {error: p.get('error_description') or p.get('error')} if p.get('error')
	return {error: 'the sign-in came back without a code'} unless p.get('code')
	{code: p.get('code')}

export def tokenForm fields
	new URLSearchParams(fields).toString()

# A token response -> what is stored (storage.local `account`).
export def storedTokens r, now = Date.now()
	return null unless r and typeof r.access_token === 'string' and typeof r.refresh_token === 'string'
	{access: r.access_token, refresh: r.refresh_token, accessExp: now + (Number(r.expires_in) or 3600) * 1000, idToken: typeof r.id_token === 'string' ? r.id_token : ''}

export def accessFresh tokens, now = Date.now()
	!!tokens and !!tokens.access and tokens.accessExp - 60000 > now

# A valid compatibility answer requires a boolean playback.plus value.
export def policyFrom status, body
	return Object.assign({}, POLICY_DEFAULT) unless status === 200 and body and body.playback and typeof body.playback.plus === 'boolean'
	{spots: !body.playback.plus, name: body.display and typeof body.display.name === 'string' and body.display.name ? body.display.name : null}

# What the account chip shows: the display name, else the name or email from
# userinfo, else a neutral label.
export def accountLabel policy, info
	return policy.name if policy and policy.name
	return info.name if info and typeof info.name === 'string' and info.name
	'Signed in'

# Claims of a JWT (display only; the server checks tokens).
export def jwtClaims token
	try
		const part = String(token).split('.')[1]
		const s = atob(part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4))
		JSON.parse(decodeURIComponent(escape(s)))
	catch e
		null
