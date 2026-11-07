# Background (MV3 service worker in Chrome, background page in Firefox): owns
# the Pandora session, does every request to Pandora, owns the playback state
# and relays for the popup, the player page and the bridge content script.
# State that must survive the worker being stopped lives in storage.session
# (storage.local as fallback).
#
# Playback runs without any tab. The engine (engine.imba) lives in an offscreen
# document in Chromium (offscreen.imba; created here on the first play command,
# kept alive by Chrome while audio plays) and in this background page itself in
# Firefox, which has no offscreen API (the gecko manifest marks the background
# persistent). Either way this file holds `player`, the single source of truth,
# persists it in storage.session, broadcasts every change as `player-state`,
# and takes the commands; the popup, the player tab, the options page and the
# web player over the bridge are views of it.

import { Core } from './core.imba'
import { Pandora, PandoraError, QUALITIES } from './pandora.imba'
import { browser, loadSettings, normalizeEndpoint, fromBase64, toBase64, SETTINGS_DEFAULTS } from './shared.imba'
import { normalizeAccountBase, randomString, pkceChallenge, authorizeUrl, parseRedirect, tokenForm, storedTokens, accessFresh, policyFrom, accountLabel, jwtClaims, CLIENT_ID, TAB_CLIENT_ID, TAB_REDIRECT, POLICY_DEFAULT } from './account.imba'
import { feedUrl, latestVersion, bannerState, compareVersions, STORE_URL } from './update.imba'
import { Engine } from './engine.imba'

const METHOD = /^[a-z]+\.[A-Za-z]+$/
const PLAYER_URL = browser.runtime.getURL('player.html')
const session = browser.storage.session or browser.storage.local
# Safari (iPhone, iPad): no offscreen API, and a background page Safari unloads when
# idle (dist/safari's manifest says `persistent: false`, scripts/safari.mjs), so the
# engine lives in the player tab instead: dist/safari's player.html also loads
# offscreen.js, and the background opens that tab on the first play command.
const TAB_ENGINE = !browser.offscreen and (browser.runtime.getManifest().background or {}).persistent === false
# Safari has no identity API either: its spacegho.st sign-in runs in a tab that comes
# back to the web app page, where a content script hands over the redirect address.
const SIGNIN_PENDING_FOR = 10 * 60 * 1000
let engineWaiters = []
const SESSION_KEYS = {session: null, stations: [], player: null, log: [], melodica: null}
const PLAYER_IDLE = {status: 'idle', station: null, track: null, position: 0, duration: 0, volume: 80, quality: 'high', queueLength: 0, error: '', history: [], changedAt: 0}
const PLAYER_ACTIONS = new Set(['play', 'resume', 'pause', 'toggle', 'next', 'love', 'ban', 'tired', 'sleep', 'stop', 'volume', 'quality'])
const LOG_MAX = 200
# The spacegho.st account's policy is asked again at least this often while the
# extension is in use (every boot, every page open past this age).
const ACCOUNT_MAX_AGE = 60 * 60 * 1000

let booting = null
let state = null
let logLines = []
# Playback: the last state the engine reported (persisted in storage.session),
# plus the engine itself when it runs in this document (Firefox).
let player = Object.assign({}, PLAYER_IDLE)
let engine = null
let offscreenReady = null
# Tabs whose page subscribed over the bridge (docs/BRIDGE.md layer 2). Content
# scripts do not receive runtime.sendMessage broadcasts, so state goes to each
# by tabs.sendMessage; the set is kept in storage.session so a restarted service
# worker still knows them.
let subscribers = null
# The optional spacegho.st account (docs/ACCOUNT.md): {signedIn, label, email, sub,
# spots, checkedAt, error}. Compatibility defaults apply without a verified response. Tokens
# live in storage.local `account` ({access, refresh, accessExp, idToken}).
let account = {signedIn: no, label: '', email: '', sub: '', spots: yes, checkedAt: 0, error: ''}
let accountChecking = null
let accountBooted = no
# melodica access: the spacegho.st answer for the Pandora login email, asked at
# https://spacegho.st/oauth/melodica/access before auth.userLogin, then again at
# boot and hourly (docs/ACCOUNT.md). The answer's `spots` is obeyed; nothing shows it.
const ACCESS_MAX_AGE = 60 * 60 * 1000
const ACCESS_RETRY = 5 * 60 * 1000
const ACCESS_DENIED = 'melodica access is by allow-list. Your request has been sent.'
const ACCESS_UNAVAILABLE = 'The melodica access check is unavailable right now. Try again in a moment.'
let access = {email: '', allowed: no, spots: yes, checkedAt: 0, message: '', error: ''}
# docs/ACCOUNT.md: after the Pandora login, /oauth/melodica/login-ok returns a verified
# melodica access token (12 h); with it (or the spacegho.st account's token)
# /oauth/melodica/me names the user and /oauth/melodica/username changes the name.
# Kept in session storage; never logged; no email is kept here.
const MELODICA_IDLE = {token: '', exp: 0, username: '', chosen: no, suggested: '', notice: '', later: no}
const MELODICA_TOKEN_FOR = 11 * 60 * 60 * 1000
let melodica = Object.assign({}, MELODICA_IDLE)
let melodicaAsking = null
let accessChecking = null
let accessBooted = no
# Updates: the store feed is read at most every UPDATE_EVERY (on boot, then
# whenever a page asks and the last look is older); on Chromium the browser is
# also asked to run its own update check, and an update it has fetched
# (runtime.onUpdateAvailable) is installed by runtime.reload() as soon as
# nothing is playing. Firefox updates add-ons itself from gecko.update_url.
const UPDATE_EVERY = 6 * 60 * 60 * 1000
let update = {current: browser.runtime.getManifest().version, latest: null, available: null, checkedAt: 0, error: '', feed: ''}
let updateChecking = null
let updateBooted = no

# The background log: console.debug plus a ring of the last LOG_MAX lines kept
# in session storage, which the options page's "Copy diagnostics" reads (the
# background console is hard to reach in Firefox). Lines carry no tokens: the
# client logs method names, sizes, codes and the clock offset only.
def note line
	const text = "{new Date().toISOString()} {line}"
	console.debug("melodica {line}")
	logLines.push(text)
	logLines.splice(0, logLines.length - LOG_MAX) if logLines.length > LOG_MAX
	session.set({log: logLines}).catch(do(e) null)

def boot
	const settings = await loadSettings()
	const url = browser.runtime.getURL('core/melodica_core.wasm')
	const bytes = await (await fetch(url)).arrayBuffer()
	const core = await Core.load(bytes)
	throw new Error('melodica core: key setup failed') unless core.init()
	const client = new Pandora(core, {endpoint: settings.endpoint, log: note, userAgent: await clientUserAgent(settings.endpoint)})
	const saved = await session.get(SESSION_KEYS)
	logLines = Array.isArray(saved.log) ? saved.log : []
	const manifest = browser.runtime.getManifest()
	note("boot melodica-extension {manifest.version_name or manifest.version} core {core.version} ({bytes.byteLength} bytes) endpoint {settings.endpoint} session-storage={browser.storage.session ? 'yes' : 'no (storage.local)'}")
	note("ua {navigator.userAgent}")
	try
		const perms = await browser.permissions.getAll()
		note("permissions {(perms.permissions or []).join(' ')}; origins {(perms.origins or []).join(' ') or '(none)'}")
	catch e
		note("permissions.getAll failed: {e and e.message or e}")
	note("restored session for {client.user.email}") if client.restore(saved.session)
	melodica = Object.assign({}, MELODICA_IDLE, saved.melodica) if saved.melodica and typeof saved.melodica === 'object'
	if settings.remember and settings.email and settings.password
		client.credentials = {email: settings.email, password: settings.password}
	if saved.player and typeof saved.player === 'object'
		player = Object.assign({}, PLAYER_IDLE, saved.player)
		# A worker restart mid-song in Chromium keeps the offscreen document and its
		# audio; it reports again on the next command. Anything else is at best paused.
		player.status = 'paused' if player.status === 'playing' and !browser.offscreen and !TAB_ENGINE
	player.volume = Number(settings.volume) or player.volume
	player.quality = settings.quality
	{core, client, settings, saved}

# The User-Agent for the endpoint: the client's own when the extension holds a
# host permission for that origin (Pandora's, or an optional one the user
# granted), none (the browser's) when the endpoint is reached through CORS,
# where a custom User-Agent would fail the preflight. See pandora.imba USER_AGENT.
def clientUserAgent endpoint
	let origin = ''
	try
		origin = new URL(endpoint).origin
	catch e
		return null
	let granted = no
	try
		granted = await browser.permissions.contains({origins: ["{origin}/*"]})
	catch e
		granted = no
	note("endpoint {origin}: host permission {granted ? 'granted, requests carry the client User-Agent' : 'not granted, CORS request with the browser User-Agent'}")
	granted ? "melodica-extension/{browser.runtime.getManifest().version} (+https://github.com/Spaceghost/melodica-extension)" : null

def ensure
	unless booting
		booting = boot()
		booting.catch(do(e) booting = null)
	state = await booting
	unless accountBooted
		accountBooted = yes
		checkAccount(yes).catch(do(e) null)
	unless accessBooted
		accessBooted = yes
		const kept = (await browser.storage.local.get({access: null})).access
		access = Object.assign({}, access, kept) if kept and typeof kept === 'object'
		checkAccess(yes).catch(do(e) null)
	unless updateBooted
		updateBooted = yes
		checkUpdate(yes).catch(do(e) null)
	state

# --- Updates ---------------------------------------------------------------

def updateState
	Object.assign({}, update, {banner: bannerState(update.current, update.latest, update.available), store: STORE_URL, canReload: !!(browser.runtime.reload)})

def checkUpdate force = no
	return await updateChecking if updateChecking
	return updateState() if !force and update.checkedAt and Date.now() - update.checkedAt < UPDATE_EVERY
	updateChecking = runUpdateCheck()
	try
		await updateChecking
	catch e
		note("update check failed: {e and e.message or e}")
	finally
		updateChecking = null
	updateState()

def runUpdateCheck
	const manifest = browser.runtime.getManifest()
	const url = feedUrl(manifest)
	update.feed = url
	update.checkedAt = Date.now()
	# Chromium: ask the browser to look at update_url now (no-op for an unpacked load).
	if browser.runtime.requestUpdateCheck
		try
			const r = await browser.runtime.requestUpdateCheck()
			const status = Array.isArray(r) ? r[0] : (r and r.status)
			const details = Array.isArray(r) ? r[1] : (r and r.details)
			note("requestUpdateCheck: {status}{details and details.version ? ' ' + details.version : ''}")
			update.available = details.version if status === 'update_available' and details and details.version
		catch e
			note("requestUpdateCheck failed: {e and e.message or e}")
	try
		const res = await fetch(url, {credentials: 'omit', cache: 'no-store'})
		throw new Error("HTTP {res.status}") unless res.ok
		update.latest = latestVersion(await res.json())
		update.error = ''
		note("update feed {url}: latest {update.latest or 'unknown'}, running {update.current}")
	catch e
		update.error = "could not read {url} ({e and e.message or e})"
		note("update feed: {update.error}")
	broadcast({type: 'update', update: updateState()})
	update

# Install an update the browser has fetched, unless something is playing; the
# engine's next "no track" report retries.
def maybeReload why
	return unless update.available
	if player.track and player.status !== 'stopped'
		note("update {update.available} fetched; reload deferred, playing")
		return no
	note("update {update.available} fetched; reloading ({why})")
	browser.runtime.reload()
	yes

if browser.runtime.onUpdateAvailable
	browser.runtime.onUpdateAvailable.addListener do(details)
		update.available = details and details.version or update.available or 'new'
		note("onUpdateAvailable {update.available}")
		broadcast({type: 'update', update: updateState()})
		maybeReload('onUpdateAvailable')

# --- The spacegho.st account (optional) ------------------------------------

def accountBase
	normalizeAccountBase((await browser.storage.local.get({accountBase: ''})).accountBase)

def accountView
	Object.assign({}, account)

def setAccount patch
	const joined = patch.signedIn === yes and !account.signedIn
	account = Object.assign({}, account, patch, {checkedAt: Date.now()})
	# Signing in with GitHub can rename the user (the GitHub login): ask again.
	refreshMe(no).catch(do(e) null) if joined and state and state.client.loggedIn
	broadcast({type: 'account', account: accountView()})
	playerChanged(player)
	account

def storedAccount
	(await browser.storage.local.get({account: null})).account

def form url, fields
	const res = await fetch(url, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: tokenForm(fields), credentials: 'omit', cache: 'no-store'})
	let body = null
	try
		body = await res.json()
	catch e
		body = null
	{status: res.status, body}

# Refresh tokens rotate: every refresh returns a new one and the old one stops working.
def refreshAccount tokens
	const base = await accountBase()
	const r = await form("{base}/oauth/token", {grant_type: 'refresh_token', refresh_token: tokens.refresh, client_id: tokens.clientId or CLIENT_ID})
	const next = r.status === 200 ? storedTokens(r.body) : null
	unless next
		if r.status === 400 or r.status === 401
			note("account: refresh refused ({r.body and r.body.error or r.status}); signed out")
			await browser.storage.local.remove('account')
			return null
		throw new Error("token refresh HTTP {r.status}")
	next.clientId = tokens.clientId or CLIENT_ID
	await browser.storage.local.set({account: next})
	note('account: tokens refreshed')
	next

def accountGet path, tokens
	const base = await accountBase()
	const res = await fetch("{base}{path}", {headers: {authorization: "Bearer {tokens.access}"}, credentials: 'omit', cache: 'no-store'})
	let body = null
	try
		body = await res.json()
	catch e
		body = null
	{status: res.status, body}

# Ask the policy for the stored account (refreshing first when the access token is
# stale, and once more on a 401). Any failure means the default policy.
def checkAccount force = no
	return await accountChecking if accountChecking
	return account if !force and account.checkedAt and Date.now() - account.checkedAt < ACCOUNT_MAX_AGE
	accountChecking = runAccountCheck()
	try
		await accountChecking
	catch e
		note("account check failed: {e and e.message or e}")
		setAccount({spots: POLICY_DEFAULT.spots, error: String(e and e.message or e)})
	finally
		accountChecking = null
	account

def runAccountCheck
	let tokens = await storedAccount()
	unless tokens and tokens.refresh
		return setAccount({signedIn: no, label: '', email: '', sub: '', spots: POLICY_DEFAULT.spots, error: ''})
	tokens = await refreshAccount(tokens) unless accessFresh(tokens)
	return setAccount({signedIn: no, label: '', email: '', sub: '', spots: POLICY_DEFAULT.spots, error: 'signed out by spacegho.st; sign in again'}) unless tokens
	let pol = await accountGet('/oauth/melodica/policy', tokens)
	if pol.status === 401
		tokens = await refreshAccount(tokens)
		return setAccount({signedIn: no, label: '', email: '', sub: '', spots: POLICY_DEFAULT.spots, error: 'signed out by spacegho.st; sign in again'}) unless tokens
		pol = await accountGet('/oauth/melodica/policy', tokens)
	const policy = policyFrom(pol.status, pol.body)
	let info = null
	try
		const ui = await accountGet('/oauth/userinfo', tokens)
		info = ui.status === 200 ? ui.body : null
	catch e
		info = null
	const claims = jwtClaims(tokens.access) or {}
	note("account: policy HTTP {pol.status}")
	setAccount({signedIn: yes, label: accountLabel(policy, info or jwtClaims(tokens.idToken)), email: info and info.email or '', sub: String(claims.sub or ''), spots: policy.spots, error: pol.status === 200 ? '' : "policy HTTP {pol.status}"})

# Step one of a sign-in: a PKCE verifier and state kept in session storage, and the
# authorize URL. `launchWebAuthFlow` (or a Safari tab, or a test) opens it.
def accountBegin tab = no
	const base = await accountBase()
	const verifier = randomString(32)
	const st = randomString(16)
	const clientId = tab ? TAB_CLIENT_ID : CLIENT_ID
	const redirectUri = tab ? TAB_REDIRECT : browser.identity.getRedirectURL('oauth')
	await session.set({accountPending: {verifier, state: st, clientId, redirectUri, base, at: Date.now()}})
	{url: authorizeUrl(base, {clientId, redirectUri, challenge: await pkceChallenge(verifier), state: st}), redirectUri}

# Step two: the redirect address that came back; exchange the code, then ask the policy.
def accountFinish url
	const got = (await session.get({accountPending: null})).accountPending
	throw new PandoraError('No spacegho.st sign-in is pending.', null, 0, 'account') unless got and Date.now() - got.at < SIGNIN_PENDING_FOR
	const back = parseRedirect(url, {state: got.state, issuer: got.base})
	throw new PandoraError("spacegho.st sign-in did not finish: {back.error}", null, 0, 'account') if back.error
	await session.set({accountPending: null})
	const r = await form("{got.base}/oauth/token", {grant_type: 'authorization_code', code: back.code, redirect_uri: got.redirectUri, client_id: got.clientId, code_verifier: got.verifier})
	const tokens = r.status === 200 ? storedTokens(r.body) : null
	throw new PandoraError("spacegho.st did not accept the sign-in ({r.body and r.body.error or 'HTTP ' + r.status}).", null, 0, 'account') unless tokens
	tokens.clientId = got.clientId
	await browser.storage.local.set({account: tokens})
	note('account: signed in')
	await checkAccount(yes)

# "Sign in with spacegho.st": the browser's identity window (its own cookie jar on
# some browsers, so the sign-in page offers GitHub and email there), or a tab on Safari.
def accountSignin
	unless browser.identity and browser.identity.launchWebAuthFlow
		const t = await accountBegin(yes)
		note('account: sign-in tab')
		await browser.tabs.create({url: t.url})
		return account
	const started = await accountBegin(no)
	note('account: launchWebAuthFlow')
	let back
	try
		back = await browser.identity.launchWebAuthFlow({url: started.url, interactive: yes})
	catch e
		throw new PandoraError("spacegho.st sign-in did not finish: {e and e.message or e}", null, 0, 'account')
	await accountFinish(back)

# Safari: the content script on the web app page forwards the redirect address.
def accountCode msg, sender
	const from = String(sender and (sender.url or (sender.tab and sender.tab.url)) or '')
	throw new PandoraError('The sign-in did not come back to the web app page.', null, 0, 'account') unless from.startsWith(TAB_REDIRECT)
	await accountFinish(String(msg.url or from))

def accountSignout
	const tokens = await storedAccount()
	await browser.storage.local.remove('account')
	if tokens and tokens.refresh
		try
			await form("{await accountBase()}/oauth/revoke", {token: tokens.refresh, client_id: tokens.clientId or CLIENT_ID})
		catch e
			note("account: revoke failed: {e and e.message or e}")
	note('account: signed out')
	setAccount({signedIn: no, label: '', email: '', sub: '', spots: POLICY_DEFAULT.spots, error: ''})

# Engine playlist items follow verified compatibility state.
# Slot handling follows verified access and account compatibility state.
def adsOn
	!((access.allowed and access.spots === no) or (account.signedIn and account.spots === no))

def playable items
	(items or []).filter(do(x) x.kind !== 'ad' or adsOn())

# --- melodica access ---------------------------------------------------------

def accessView
	{allowed: !!access.allowed, message: access.allowed ? '' : String(access.message or ''), checkedAt: access.checkedAt, error: String(access.error or '')}

# A fresh spacegho.st access token when signed in (sent as the bearer), else ''.
def accountBearer
	let tokens = await storedAccount()
	return '' unless tokens and tokens.refresh
	try
		tokens = await refreshAccount(tokens) unless accessFresh(tokens)
	catch e
		return ''
	tokens ? String(tokens.access or '') : ''

def accessAsk email
	const base = await accountBase()
	const headers = {'content-type': 'application/json'}
	const bearer = await accountBearer()
	headers.authorization = "Bearer {bearer}" if bearer
	let res = null
	let body = null
	try
		res = await fetch("{base}/oauth/melodica/access", {method: 'POST', headers, body: JSON.stringify({email, client: 'extension'}), credentials: 'omit', cache: 'no-store'})
	catch e
		note("access check: unreachable ({e and e.message or e})")
		throw new PandoraError(ACCESS_UNAVAILABLE, null, 0, 'access')
	try
		body = await res.json()
	catch e
		body = null
	const known = res.status === 200 and body and typeof body.allowed === 'boolean'
	note("access check: HTTP {res.status}{known ? (body.allowed ? ', allowed' : ', not allowed') : ''}")
	throw new PandoraError('Enter the email address of your Pandora account.', null, 0, 'access') if res.status === 400
	throw new PandoraError(ACCESS_UNAVAILABLE, null, 0, 'access') unless known
	{allowed: body.allowed, spots: body.plus === yes ? no : yes, message: body.allowed ? '' : String(body.message or ACCESS_DENIED)}

def setAccess email, r
	access = {email, allowed: !!r.allowed, spots: r.spots === no ? no : yes, checkedAt: Date.now(), message: r.message or '', error: ''}
	await browser.storage.local.set({access: {email, allowed: access.allowed, spots: access.spots, checkedAt: access.checkedAt, message: access.message}})
	broadcast({type: 'access', access: accessView()})
	playerChanged(player)
	access

# Boot and hourly: ask again for the login email. No longer allowed: stop the
# music and sign out of Pandora; the login card shows the answer's message.
def checkAccess force = no
	return await accessChecking if accessChecking
	return access if !force and access.checkedAt and Date.now() - access.checkedAt < ACCESS_MAX_AGE
	accessChecking = runAccessCheck()
	try
		await accessChecking
	catch e
		# Unreachable: keep the last answer and ask again in a few minutes.
		access.error = String(e and e.message or e)
		access.checkedAt = Date.now() - ACCESS_MAX_AGE + ACCESS_RETRY
		note("access re-check failed: {access.error}")
	finally
		accessChecking = null
	access

def runAccessCheck
	const client = state and state.client
	return access unless client and client.loggedIn
	const email = (client.user and client.user.email) or access.email or state.settings.email or ''
	return access unless email
	const r = await accessAsk(email)
	await setAccess(email, r)
	await denyAccess() unless r.allowed
	access

def denyAccess
	note('access: not allowed; signing out of Pandora')
	await stopPlayback('melodica access withdrawn')
	state.client.logout()
	await setMelodica(MELODICA_IDLE)
	await browser.storage.local.set({password: '', remember: no})
	Object.assign(state.settings, {password: '', remember: no})
	await persist()
	await remember('stations', [])
	playerChanged(player)

# ---- the melodica username (docs/ACCOUNT.md, Usernames)

const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/
const USERNAME_FORMAT = 'Use 3 to 24 letters, digits, - or _, starting and ending with a letter or digit.'

def userView
	{username: melodica.username, chosen: !!melodica.chosen, suggested: melodica.suggested, notice: melodica.notice, prompt: !!melodica.username and !melodica.chosen and !melodica.later}

def setMelodica patch
	melodica = Object.assign({}, melodica, patch)
	await session.set({melodica}).catch(do(e) null)
	playerChanged(player)

# POST /oauth/melodica/login-ok with the Pandora session just accepted; spacegho.st
# checks it with Pandora and returns the verified melodica token and the username.
def melodicaLogin email, prompt = no
	return await melodicaAsking if melodicaAsking
	melodicaAsking = runMelodicaLogin(email, prompt)
	try
		return await melodicaAsking
	finally
		melodicaAsking = null

def runMelodicaLogin email, prompt
	const client = state and state.client
	return no unless client and client.loggedIn and client.user and client.partner and email
	const base = await accountBase()
	const headers = {'content-type': 'application/json'}
	const bearer = await accountBearer()
	headers.authorization = "Bearer {bearer}" if bearer
	const body = {email, client: 'extension', pandora: {userAuthToken: client.user.authToken, userId: client.user.id, partnerId: String(client.partner.id), syncTimeOffset: Number(state.core.syncOffset) or 0}}
	const res = await fetch("{base}/oauth/melodica/login-ok", {method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store'})
	let out = null
	try
		out = await res.json()
	catch e
		out = null
	note("login-ok: HTTP {res.status}")
	return no unless res.status === 200 and out and typeof out.token === 'string' and out.token
	const patch = {token: out.token, exp: Date.now() + MELODICA_TOKEN_FOR}
	if typeof out.username === 'string' and out.username
		patch.username = out.username
		patch.chosen = out.username_chosen === yes
	patch.later = no if prompt
	await setMelodica(patch)
	await refreshMe(no)
	yes

# The bearer for /me and /username: the spacegho.st account's token when signed in,
# else the melodica token from login-ok (asked again once it is old).
def melodicaBearers
	const out = []
	const own = await accountBearer()
	out.push({kind: 'account', token: own}) if own
	if !(melodica.token and melodica.exp > Date.now()) and state and state.client.loggedIn
		const email = state.client.user and state.client.user.email or ''
		try
			await melodicaLogin(email) if email
		catch e
			null
	out.push({kind: 'melodica', token: melodica.token}) if melodica.token and melodica.exp > Date.now()
	out

def melodicaCall path, init = {}
	const base = await accountBase()
	for b in await melodicaBearers()
		let res = null
		try
			res = await fetch("{base}{path}", Object.assign({}, init, {headers: Object.assign({authorization: "Bearer {b.token}"}, init.headers or {}), credentials: 'omit', cache: 'no-store'}))
		catch e
			return {status: 0, body: null}
		let body = null
		try
			body = await res.json()
		catch e
			body = null
		body = null unless body and typeof body === 'object'
		const gone = (res.status === 401 and body and body.error === 'invalid_token') or (res.status === 404 and body and body.error === 'unknown_user')
		if gone and b.kind === 'melodica'
			await setMelodica({token: '', exp: 0})
		continue if gone and b.kind === 'account'
		return {status: res.status, body}
	{status: 401, body: {error: 'invalid_token'}}

def refreshMe prompt = no
	const r = await melodicaCall('/oauth/melodica/me')
	note("me: HTTP {r.status}")
	const b = r.body
	return no unless r.status === 200 and b and typeof b.username === 'string' and b.username
	const patch = {username: b.username, chosen: b.username_chosen === yes, suggested: typeof b.suggested === 'string' ? b.suggested : '', notice: typeof b.notice === 'string' ? b.notice : ''}
	patch.later = no if prompt or patch.notice
	await setMelodica(patch)
	yes

def setUsername raw
	const name = raw.trim().toLowerCase()
	throw new PandoraError(USERNAME_FORMAT, null, 0, 'username') unless USERNAME_RE.test(name)
	const r = await melodicaCall('/oauth/melodica/username', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({username: name})})
	note("username: HTTP {r.status}")
	const b = r.body or {}
	if r.status === 200 and typeof b.username === 'string' and b.username
		await setMelodica({username: b.username, chosen: yes, notice: '', suggested: '', later: no})
		return userView()
	const text = typeof b.error_description === 'string' and b.error_description ? b.error_description : (r.status === 0 ? 'The username service is unavailable; try again.' : (r.status === 401 or r.status === 404 ? 'Your melodica session has ended; log in again.' : "The username was not saved (HTTP {r.status})."))
	throw new PandoraError(text, null, 0, 'username')

def persist
	await session.set({session: state.client.loggedIn ? state.client.snapshot() : null})

def remember key, value
	state.saved[key] = value
	const patch = {}
	patch[key] = value
	await session.set(patch)

# Fan a notice out to every extension page that is open (none may be).
def broadcast message
	try
		await browser.runtime.sendMessage(message)
	catch e
		null

# A page (the bridge's `openLogin`) asks for the sign-in: the toolbar popup where
# the browser allows opening it, else the popup page in a tab.
def openLogin
	if browser.action and browser.action.openPopup
		try
			await browser.action.openPopup()
			note('login: opened the popup')
			return 'popup'
		catch e
			note("login: openPopup refused ({e and e.message or e}); opening a tab")
	await browser.tabs.create({url: browser.runtime.getURL('popup.html')})
	'tab'

# The player tab is optional: a full-size view of the same state. Opening it
# starts nothing; closing it stops nothing.
def openPlayer
	const tabs = await browser.tabs.query({url: PLAYER_URL + '*'})
	const tab = tabs[0]
	if tab
		await browser.tabs.update(tab.id, {active: yes})
		try
			await browser.windows.update(tab.windowId, {focused: yes})
		catch e
			null
		return {tabId: tab.id}
	const created = await browser.tabs.create({url: PLAYER_URL})
	{tabId: created.id}

# --- Playback -----------------------------------------------------------

# What every view gets: the engine's state plus the session bits a view needs.
def playerView
	Object.assign({}, player, {stations: state and state.saved.stations or [], loggedIn: !!(state and state.client.loggedIn), account: {signedIn: account.signedIn, label: account.label}, user: userView(), access: {allowed: !!access.allowed, message: access.allowed ? '' : String(access.message or '')}})

def publicTrack song
	return null unless song
	const t = Object.assign({}, song)
	delete t.audioUrl
	t

# The engine reported: keep it, persist it, show it on the badge, tell the views.
def playerChanged next
	# The engine's states reach the background two ways (its reports and command
	# replies) and may arrive out of order: an older one never replaces a newer one.
	return if next and next !== player and next.changedAt and player.changedAt and next.changedAt < player.changedAt
	player = Object.assign({}, PLAYER_IDLE, next)
	session.set({player}).catch(do(e) null)
	badge()
	const message = {type: 'player-state', state: playerView()}
	broadcast(message)
	pushSubscribers(message)

def subscriberSet
	return subscribers if subscribers
	let saved = []
	try
		saved = (await browser.storage.session.get('subscribers')).subscribers or []
	catch e
		saved = []
	subscribers ||= new Set(saved)
	subscribers

def saveSubscribers
	try
		await browser.storage.session.set({subscribers: Array.from(subscribers)})
	catch e
		null

def subscribeTab tabId, on
	return unless typeof tabId === 'number'
	const set = await subscriberSet()
	if on
		set.add(tabId)
	else
		set.delete(tabId)
	await saveSubscribers()

def pushSubscribers message
	const set = await subscriberSet()
	for tabId in Array.from(set)
		browser.tabs.sendMessage(tabId, message).catch do(e)
			set.delete(tabId)
			saveSubscribers()

def badge
	try
		const t = player.track
		if t and (player.status === 'playing' or player.status === 'loading')
			await browser.action.setBadgeText({text: '▶'})
			await browser.action.setBadgeBackgroundColor({color: '#d8b26a'})
			await browser.action.setTitle({title: "melodica: {t.title} – {t.artist}{player.station ? ' on ' + player.station.name : ''}"})
		elif t and player.status === 'paused'
			await browser.action.setBadgeText({text: '❚❚'})
			await browser.action.setTitle({title: "melodica (paused): {t.title} – {t.artist}"})
		else
			await browser.action.setBadgeText({text: ''})
			await browser.action.setTitle({title: 'melodica'})
	catch e
		null

# The engine in this document (Firefox: the background page has a DOM).
def localEngine
	return engine if engine
	engine = new Engine({
		document: document
		api: {
			playlist: do(station, quality)
				await ensure()
				const songs = await state.client.playlist(stationByToken(station.token) or station, quality)
				await persist()
				playable(songs)
			rate: do(trackToken, positive) state.client.rate(trackToken, positive)
			tired: do(trackToken) state.client.tired(trackToken)
			adMetadata: do(placeholder, quality) adsOn() ? state.client.adMetadata(placeholder, quality) : null
			registerAd: do(ad) state.client.registerAd(ad.stationId, ad.trackingTokens or [])
		}
		report: do(s) playerChanged(s)
		log: note
	})
	engine.hydrate(player)
	engine

# Chromium: the offscreen document, created on demand. Chrome closes an idle
# AUDIO_PLAYBACK document after a while; the next command recreates it and
# `engine-hello` brings it the saved state.
def ensureOffscreen
	return await offscreenReady if offscreenReady
	offscreenReady = TAB_ENGINE ? ensurePlayerEngine() : createOffscreen()
	try
		await offscreenReady
	finally
		offscreenReady = null

# Safari: the player tab is the engine; open it (in the background) when it is not
# there and wait for its `engine-hello`.
def ensurePlayerEngine
	const tabs = await browser.tabs.query({url: PLAYER_URL + '*'})
	return if tabs.length
	note('opening the player tab (the playback engine on Safari)')
	const hello = new Promise do(resolve, reject)
		engineWaiters.push(resolve)
		setTimeout((do reject(new PandoraError('The player tab did not start.', null, 0, 'player'))), 20000)
	await browser.tabs.create({url: PLAYER_URL, active: no})
	await hello

def createOffscreen
	let exists = no
	try
		const contexts = await browser.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']})
		exists = contexts.length > 0
	catch e
		exists = no
	return if exists
	note('creating the offscreen playback document')
	try
		await browser.offscreen.createDocument({url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'Pandora playback without a visible tab'})
	catch e
		# "Only a single offscreen document may be created": a race with another creator.
		throw e unless /single offscreen/i.test(String(e and e.message or e))

# Run one engine operation wherever the engine lives and return its state.
def engineCall op, args = []
	if typeof document !== 'undefined' and !browser.offscreen and !TAB_ENGINE
		const e = localEngine()
		switch op
			when 'play' then await e.play(args[0])
			when 'resume' then await e.resume()
			when 'pause' then e.pause()
			when 'toggle' then await e.toggle()
			when 'next' then await e.skip()
			when 'stop' then e.stop()
			when 'rate' then await e.rate(!!args[0])
			when 'tired' then await e.tired()
			when 'volume' then e.setVolume(args[0])
			when 'quality' then e.setQuality(args[0])
			when 'hydrate' then e.hydrate(args[0])
			when 'state' then null
			else throw new Error("unknown engine op {op}")
		return e.snapshot
	await ensureOffscreen()
	const r = await browser.runtime.sendMessage({type: 'engine', op, args})
	throw new PandoraError('The playback document did not answer.', null, 0, 'player') unless r
	throw new PandoraError(r.error or 'playback error', null, 0, 'player') unless r.ok
	playerChanged(r.state) if r.state
	r.state

# A command from a view (popup, player tab, options, the web page, a keyboard shortcut).
def playerCommand msg
	const action = String(msg.action or '')
	throw new PandoraError("Unknown player action {action}.", null, 0, 'client') unless PLAYER_ACTIONS.has(action)
	switch action
		when 'play'
			if msg.station or msg.stationToken
				throw new PandoraError('Not signed in.', null, 0, 'auth') unless state.client.loggedIn
				const st = stationByToken(msg.stationToken or msg.station.token) or msg.station or {token: msg.stationToken, name: ''}
				await engineCall('play', [{token: st.token, name: st.name or ''}])
			else
				await engineCall('resume')
		when 'resume' then await engineCall('resume')
		when 'pause' then await engineCall('pause')
		when 'toggle' then await engineCall('toggle')
		when 'next' then await engineCall('next')
		when 'love' then await engineCall('rate', [yes])
		when 'ban' then await engineCall('rate', [no])
		when 'tired' then await engineCall('tired')
		when 'sleep' then await engineCall('tired')
		when 'stop' then await engineCall('stop')
		when 'volume'
			const v = Math.max(0, Math.min(100, Number(msg.value) or 0))
			await browser.storage.local.set({volume: v})
			state.settings.volume = v
			await engineCall('volume', [v])
		when 'quality'
			throw new PandoraError('Unknown quality.', null, 0, 'client') unless QUALITIES.includes(msg.value)
			await browser.storage.local.set({quality: msg.value})
			state.settings.quality = msg.value
			await engineCall('quality', [msg.value])
	{state: playerView()}

def stopPlayback why
	return unless player.track or player.status === 'loading'
	note("stopping playback: {why}")
	try
		await engineCall('stop')
	catch e
		null

def bridge msg
	const search = String(msg.search or '')
	const method = search.startsWith('?') and !search.includes('#') ? new URLSearchParams(search).get('method') : null
	throw new PandoraError('method not allowed', null, 0, 'bridge') unless method and METHOD.test(method)
	# The page's own Pandora login goes straight to Pandora through here, so past the
	# partner login it needs the same access answer as the extension's login.
	# Only an answer that said no refuses; no answer yet is not a refusal.
	if method !== 'auth.partnerLogin' and method !== 'test.checkLicensing' and access.checkedAt and !access.allowed and access.message
		throw new PandoraError(access.message or ACCESS_DENIED, null, 0, 'access')
	let res
	try
		res = await fetch(state.settings.endpoint + search, {
			method: 'POST'
			headers: {'content-type': 'text/plain'}
			body: fromBase64(msg.body)
			credentials: 'omit'
			redirect: 'error'
		})
	catch e
		throw new PandoraError("Could not reach {state.settings.endpoint} ({e and e.message or e}).", null, 0, 'network')
	const body = new Uint8Array(await res.arrayBuffer())
	{fetchOk: res.ok, status: res.status, body: toBase64(body)}

def stationByToken token
	(state.saved.stations or []).find(do(s) s.token === token) or null

def handle msg, sender
	await ensure()
	const client = state.client
	# Stale account and access answers are asked again; player traffic (the views,
	# the bridge) is not held up by those round trips.
	const quick = msg.type === 'player' or msg.type === 'player-get' or msg.type === 'player-subscribe' or msg.type === 'engine-state'
	if !accountChecking and account.checkedAt and Date.now() - account.checkedAt > ACCOUNT_MAX_AGE
		quick ? checkAccount().catch(do(e) null) : await checkAccount()
	if !accessChecking and access.checkedAt and Date.now() - access.checkedAt > ACCESS_MAX_AGE
		quick ? checkAccess().catch(do(e) null) : await checkAccess()
	switch msg.type
		when 'access'
			{access: accessView()}
		when 'access-check'
			{access: accessView(await checkAccess(yes))}
		when 'account'
			{account: accountView()}
		when 'account-check'
			{account: await checkAccount(yes)}
		when 'account-signin'
			{account: await accountSignin()}
		when 'account-begin'
			await accountBegin(!!msg.tab)
		when 'account-finish'
			{account: await accountFinish(String(msg.url or ''))}
		when 'account-code'
			{account: await accountCode(msg, sender)}
		when 'account-signout'
			{account: await accountSignout()}
		when 'ad-metadata'
			{ad: adsOn() ? await client.adMetadata(msg.placeholder or {}, QUALITIES.includes(msg.quality) ? msg.quality : state.settings.quality) : null}
		when 'register-ad'
			const st = (state.saved.stations or []).find(do(x) x.id === msg.stationId) or null
			await client.registerAd(msg.stationId or (st and st.id), Array.isArray(msg.trackingTokens) ? msg.trackingTokens : [])
			note("ad registered ({(msg.trackingTokens or []).length} tracking tokens)")
			{}
		when 'update'
			{update: await checkUpdate()}
		when 'update-check'
			{update: await checkUpdate(yes)}
		when 'update-reload'
			throw new PandoraError('This browser cannot reload the extension from here.', null, 0, 'client') unless browser.runtime.reload
			note('reload requested from a page')
			setTimeout((do browser.runtime.reload()), 100)
			{}
		when 'ping'
			{version: browser.runtime.getManifest().version, core: state.core.version}
		when 'diagnostics'
			let permissions = null
			try
				permissions = await browser.permissions.getAll()
			catch e
				permissions = {error: String(e and e.message or e)}
			const manifest = browser.runtime.getManifest()
			{
				version: manifest.version_name or manifest.version
				core: state.core.version
				ua: navigator.userAgent
				endpoint: state.settings.endpoint
				userAgent: client.userAgent or '(the browser\'s)'
				loggedIn: client.loggedIn
				syncOffset: state.core.syncOffset
				sessionStorage: !!browser.storage.session
				background: manifest.background
				permissions: permissions
				account: accountView()
				accountBase: await accountBase()
				update: updateState()
				player: Object.assign({}, player, {track: publicTrack(player.track), history: player.history.length})
				engine: browser.offscreen ? 'offscreen document' : (TAB_ENGINE ? 'player tab' : 'background page')
				lines: logLines.slice()
			}
		when 'state'
			{
				loggedIn: client.loggedIn
				email: client.user and client.user.email or state.settings.email or ''
				stations: state.saved.stations or []
				player: playerView()
				settings: {endpoint: state.settings.endpoint, quality: state.settings.quality, remember: state.settings.remember, volume: state.settings.volume}
				version: browser.runtime.getManifest().version
				core: state.core.version
				account: accountView()
				access: accessView()
				update: updateState()
			}
		when 'login'
			const email = String(msg.email or '').trim()
			const password = String(msg.password or '')
			note("login requested (email {email.length} chars, password {password.length} chars, remember={!!msg.remember})")
			const allowed = await accessAsk(email)
			await setAccess(email, allowed)
			throw new PandoraError(allowed.message, null, 0, 'access') unless allowed.allowed
			await client.login(email, password)
			note("login ok: user id {client.user.id.length} chars, token {client.user.authToken.length} chars, subscriber={client.user.subscriber}")
			const patch = {email}
			if msg.remember
				patch.remember = yes
				patch.password = password
			else
				patch.remember = no
				patch.password = ''
			await browser.storage.local.set(patch)
			Object.assign(state.settings, patch)
			await persist()
			const stations = await client.stations()
			await remember('stations', stations)
			playerChanged(player)
			# Not awaited: the username never holds up playback.
			melodicaLogin(email, yes).catch(do(e) note("login-ok failed: {e and e.message or e}"))
			{email, stations}
		when 'logout'
			client.logout()
			await setMelodica(MELODICA_IDLE)
			await browser.storage.local.set({password: '', remember: no})
			Object.assign(state.settings, {password: '', remember: no})
			await persist()
			await remember('stations', [])
			await stopPlayback('signed out')
			playerChanged(player)
			{}
		when 'stations'
			const stations = await client.stations()
			await remember('stations', stations)
			await persist()
			playerChanged(player)
			{stations}
		when 'open-login'
			{opened: await openLogin()}
		when 'username-me'
			await refreshMe(no)
			{user: userView()}
		when 'username-set'
			{user: await setUsername(String(msg.username or ''))}
		when 'username-later'
			await setMelodica({later: yes})
			{user: userView()}
		when 'playlist'
			const station = stationByToken(msg.stationToken) or {token: msg.stationToken, name: ''}
			const quality = QUALITIES.includes(msg.quality) ? msg.quality : state.settings.quality
			const songs = playable(await client.playlist(station, quality))
			await persist()
			{songs, quality}
		when 'rate'
			await client.rate(msg.trackToken, !!msg.positive)
			{}
		when 'tired'
			await client.tired(msg.trackToken)
			{}
		when 'explain'
			{traits: await client.explain(msg.trackToken)}
		when 'search'
			{results: await client.search(String(msg.query or ''))}
		when 'create-station'
			const station = await client.createStation(msg.musicToken)
			const stations = await client.stations()
			await remember('stations', stations)
			{station, stations}
		when 'delete-station'
			await client.deleteStation(stationByToken(msg.stationToken) or {token: msg.stationToken})
			const stations = await client.stations()
			await remember('stations', stations)
			{stations}
		when 'open-player'
			await openPlayer()
		when 'player-subscribe'
			await subscribeTab(sender and sender.tab and sender.tab.id, msg.on !== no)
			{state: playerView()}
		when 'player-get'
			{state: playerView(), settings: state.settings, account: accountView(), update: updateState()}
		when 'player'
			await playerCommand(msg)
		when 'engine-hello'
			# The offscreen document (re)started: give it what the last one knew.
			note(TAB_ENGINE ? 'player tab engine up; hydrating' : 'offscreen document up; hydrating')
			const waiting = engineWaiters
			engineWaiters = []
			setTimeout((do waiting.forEach(do(f) f())), 0)
			{saved: player}
		when 'engine-state'
			playerChanged(msg.state) if msg.state and typeof msg.state === 'object'
			maybeReload('playback stopped') if !player.track
			{}
		when 'bridge'
			await bridge(msg)
		else
			throw new PandoraError("Unknown message type {msg.type}.", null, 0, 'client')

browser.runtime.onMessage.addListener do(msg, sender, sendResponse)
	return no unless msg and typeof msg === 'object' and typeof msg.type === 'string'
	const done = do(result) sendResponse(Object.assign({ok: yes}, result or {}))
	const failed = do(e)
		console.warn("melodica {msg.type}: {(e and e.message) or e}")
		note("{msg.type} failed: {(e and e.message) or e}") unless e and e.kind === 'pandora'
		const code = (e and e.code != null) ? e.code : null
		sendResponse({ok: no, error: String((e and e.message) or e), code: code, kind: (e and e.kind) or 'error'})
	handle(msg, sender).then(done, failed)
	yes

# Settings edited on the options page: a new endpoint invalidates the session
# (tokens belong to one server); quality applies to the next playlist.
# A change that lands while boot() is still reading the old settings must not be
# dropped (seen in Brave, whose worker starts later than the options page saves):
# wait for the boot and apply it on top. A worker that has not begun booting
# reads the stored settings when it does.
browser.storage.onChanged.addListener do(changes, area)
	return unless area === 'local' and booting
	try
		await ensure()
	catch e
		return
	if changes.endpoint
		const endpoint = normalizeEndpoint(changes.endpoint.newValue)
		if endpoint !== state.client.endpoint
			state.settings.endpoint = endpoint
			state.client.endpoint = endpoint
			state.client.userAgent = await clientUserAgent(endpoint)
			state.client.reset()
			await persist()
			await remember('stations', [])
			await stopPlayback('endpoint changed')
	# The account tokens or the account server override changed (a sign-in, a
	# sign-out, a test): ask the policy again.
	await checkAccount(yes) if changes.account or changes.accountBase
	state.settings.quality = changes.quality.newValue if changes.quality and QUALITIES.includes(changes.quality.newValue)
	if changes.remember or changes.password or changes.email
		const s = await loadSettings()
		Object.assign(state.settings, s)
		state.client.credentials = s.remember and s.email and s.password ? {email: s.email, password: s.password} : null

browser.runtime.onInstalled.addListener do(details)
	console.info("melodica-extension {browser.runtime.getManifest().version} {details.reason}")

# Keyboard shortcuts (manifest `commands`): play/pause and next, from anywhere.
if browser.commands and browser.commands.onCommand
	browser.commands.onCommand.addListener do(command)
		try
			await ensure()
			await playerCommand({action: command === 'next-song' ? 'next' : 'toggle'})
		catch e
			note("shortcut {command} failed: {e and e.message or e}")

# Firefox: the engine lives here; bring it up with the saved state on boot so a
# paused track survives a restart and the badge is right.
if typeof document !== 'undefined' and !browser.offscreen and !TAB_ENGINE
	ensure().then(do localEngine()).catch(do(e) null)
