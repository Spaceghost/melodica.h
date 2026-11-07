# Background (MV3 service worker in Chrome, event page in Firefox): owns the
# Pandora session, does every request to Pandora, and relays for the popup, the
# player page and the bridge content script. State that must survive the
# worker being stopped lives in storage.session (storage.local as fallback).

import { Core } from './core.imba'
import { Pandora, PandoraError, QUALITIES } from './pandora.imba'
import { browser, loadSettings, normalizeEndpoint, fromBase64, toBase64, SETTINGS_DEFAULTS } from './shared.imba'
import { parseToken, expired, tokenFromRedirect, normalizeAuthBase, startUrl, meUrl } from './github.imba'
import { feedUrl, latestVersion, bannerState, compareVersions, STORE_URL } from './update.imba'

const METHOD = /^[a-z]+\.[A-Za-z]+$/
const PLAYER_URL = browser.runtime.getURL('player.html')
const session = browser.storage.session or browser.storage.local
const SESSION_KEYS = {session: null, stations: [], nowPlaying: null, playerTabId: null, pendingPlay: null, log: []}
const LOG_MAX = 200
# The GitHub gate is re-checked at least this often while the extension is in use
# (every boot, every popup/player open past this age, the player's timer).
const GATE_MAX_AGE = 60 * 60 * 1000
# Message types that reach Pandora (or the player) and so need the gate open.
const GATED = new Set(['login', 'stations', 'playlist', 'rate', 'tired', 'explain', 'search', 'create-station', 'delete-station', 'open-player', 'bridge'])

let booting = null
let state = null
let logLines = []
# The GitHub gate: {mode, reason, login, exp, checkedAt}. Modes: `off` (not applied:
# the endpoint is not Pandora's, or the auth server says it is not configured),
# `anon` (no GitHub sign-in), `allowed` (the auth server allows the login), `denied`
# (signed in, not allowed), `error` (the auth server could not be asked).
let gate = {mode: 'anon', reason: 'not signed in with GitHub', login: '', exp: null, checkedAt: 0}
let checking = null
let gateBooted = no
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
	if settings.remember and settings.email and settings.password
		client.credentials = {email: settings.email, password: settings.password}
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
	unless gateBooted
		gateBooted = yes
		await checkGate(yes)
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
# player's next "now-playing: nothing" message retries.
def maybeReload why
	return unless update.available
	const now = state and state.saved and state.saved.nowPlaying
	if now and now.song
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

# --- The GitHub gate -------------------------------------------------------

def gateAllowed g = gate
	g.mode === 'off' or g.mode === 'allowed'

# What a refused caller is told; the popup shows the same words on its gate screen.
def gateText g
	switch g.mode
		when 'denied'
			"melodica is not available for your GitHub account ({g.login})."
		when 'error'
			"Could not check the GitHub gate: {g.reason}. Press Check again."
		else
			"Sign in with GitHub first."

# The auth server: the melodica-site Worker, or the `authBase` storage key (the
# Firefox smoke points it at a fake; README "GitHub gate").
def authBase
	const got = await browser.storage.local.get({authBase: ''})
	normalizeAuthBase(got.authBase)

def setGate next
	const was = gateAllowed(gate)
	gate = Object.assign({login: '', exp: null, reason: ''}, next, {checkedAt: Date.now()})
	note("gate {gate.mode}{gate.login ? ' ' + gate.login : ''}{gate.reason ? ': ' + gate.reason : ''}")
	if was and !gateAllowed(gate)
		try
			const tab = await playerTab()
			await browser.tabs.sendMessage(tab.id, {type: 'control', action: 'stop'}) if tab
		catch e
			null
	broadcast({type: 'gate', gate})
	gate

# The current gate, re-checked when forced, when it was never checked, or when the
# last check is older than GATE_MAX_AGE. One check runs at a time.
def checkGate force = no
	return await checking if checking
	return gate if !force and gate.checkedAt and Date.now() - gate.checkedAt < GATE_MAX_AGE
	checking = runGateCheck()
	try
		await checking
	catch e
		note("gate check failed: {e and e.message or e}")
	finally
		checking = null
	gate

def runGateCheck
	const endpoint = state.settings.endpoint
	if endpoint !== SETTINGS_DEFAULTS.endpoint
		return await setGate({mode: 'off', reason: "endpoint is {endpoint}, not Pandora's"})
	const got = await browser.storage.local.get({github: null})
	const token = got.github and typeof got.github.token === 'string' ? got.github.token : ''
	const claims = token ? parseToken(token) : null
	if token and !claims
		await browser.storage.local.remove('github')
		return await setGate({mode: 'anon', reason: 'the stored GitHub token was malformed; sign in again'})
	if claims and expired(claims)
		await browser.storage.local.remove('github')
		return await setGate({mode: 'anon', reason: "the GitHub sign-in for {claims.sub} expired; sign in again"})
	const base = await authBase()
	const url = meUrl(base)
	const headers = {}
	headers.authorization = "Bearer {token}" if token
	let res
	try
		res = await fetch(url, {headers, credentials: 'omit', cache: 'no-store'})
	catch e
		const reason = "could not reach {url} ({e and e.message or e})"
		# An allowed account stays allowed through a network blip (the next check is in an hour);
		# anyone else sees the error and a Check again button.
		return await setGate(gate.mode === 'allowed' ? Object.assign({}, gate, {stale: reason}) : {mode: claims ? 'error' : 'anon', reason, login: claims ? claims.sub : '', exp: claims ? claims.exp : null})
	if res.status === 503
		let body = {}
		try
			body = await res.json()
		catch e
			body = {}
		return await setGate({mode: 'off', reason: "auth not configured at {base} yet ({body.error or 'HTTP 503'})", login: claims ? claims.sub : '', exp: claims ? claims.exp : null})
	unless claims
		return await setGate({mode: 'anon', reason: 'not signed in with GitHub'})
	if res.status === 401
		await browser.storage.local.remove('github')
		return await setGate({mode: 'anon', reason: "{base} no longer accepts the GitHub sign-in for {claims.sub} (HTTP 401); sign in again"})
	unless res.ok
		return await setGate({mode: 'error', reason: "{url} answered HTTP {res.status}", login: claims.sub, exp: claims.exp})
	let me
	try
		me = await res.json()
	catch e
		return await setGate({mode: 'error', reason: "{url} did not answer JSON", login: claims.sub, exp: claims.exp})
	if typeof me.token === 'string' and me.token !== token and parseToken(me.token)
		await browser.storage.local.set({github: {token: me.token}})
		note('gate: refreshed token stored')
	const login = typeof me.login === 'string' and me.login ? me.login : claims.sub
	const exp = typeof me.exp === 'number' ? me.exp : claims.exp
	# The Worker's `friend` field is the allow flag.
	if me.friend === yes
		await setGate({mode: 'allowed', reason: '', login, exp})
	else
		await setGate({mode: 'denied', reason: 'not available for this GitHub account', login, exp})

def requireGate
	const g = await checkGate()
	return if gateAllowed(g)
	throw new PandoraError(gateText(g), null, 0, 'gate')

# "Sign in with GitHub": the browser's identity flow against the Worker's /start,
# which asks GitHub for identity only (no scopes) and redirects back to the
# extension's own redirect URL with the token in the fragment. The flow runs here
# rather than in the popup because the popup closes when the auth window opens.
def githubSignin
	throw new PandoraError('This browser has no identity API for the GitHub sign-in.', null, 0, 'gate') unless browser.identity and browser.identity.launchWebAuthFlow
	const redirect = browser.identity.getRedirectURL('melodica')
	const base = await authBase()
	const url = startUrl(base, redirect)
	note("github sign-in: launchWebAuthFlow {url}")
	let back
	try
		back = await browser.identity.launchWebAuthFlow({url, interactive: yes})
	catch e
		throw new PandoraError("GitHub sign-in did not finish: {e and e.message or e}", null, 0, 'gate')
	const token = tokenFromRedirect(back)
	throw new PandoraError('GitHub sign-in came back without a token.', null, 0, 'gate') unless token
	await browser.storage.local.set({github: {token}})
	note("github sign-in: token for {parseToken(token).sub}")
	await checkGate(yes)

def githubSignout
	await browser.storage.local.remove('github')
	await checkGate(yes)

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

def playerTab
	const tabs = await browser.tabs.query({url: PLAYER_URL + '*'})
	tabs[0] or null

def openPlayer stationToken = null
	const tab = await playerTab()
	if stationToken
		await remember('pendingPlay', stationToken)
	if tab
		await browser.tabs.update(tab.id, {active: yes})
		try
			await browser.windows.update(tab.windowId, {focused: yes})
		catch e
			null
		if stationToken
			try
				await browser.tabs.sendMessage(tab.id, {type: 'play', stationToken})
				await remember('pendingPlay', null)
			catch e
				null
		return {tabId: tab.id}
	const created = await browser.tabs.create({url: PLAYER_URL})
	{tabId: created.id}

def control action
	const tab = await playerTab()
	throw new PandoraError('Nothing is playing. Pick a station first.', null, 0, 'player') unless tab
	await browser.tabs.sendMessage(tab.id, {type: 'control', action})
	{}

def bridge msg
	const search = String(msg.search or '')
	const method = search.startsWith('?') and !search.includes('#') ? new URLSearchParams(search).get('method') : null
	throw new PandoraError('method not allowed', null, 0, 'bridge') unless method and METHOD.test(method)
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
	await requireGate() if GATED.has(msg.type)
	switch msg.type
		when 'gate'
			{gate: await checkGate()}
		when 'gate-check'
			{gate: await checkGate(yes)}
		when 'github-signin'
			{gate: await githubSignin()}
		when 'github-signout'
			{gate: await githubSignout()}
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
				gate: gate
				authBase: await authBase()
				update: updateState()
				lines: logLines.slice()
			}
		when 'state'
			{
				loggedIn: client.loggedIn
				email: client.user and client.user.email or state.settings.email or ''
				stations: state.saved.stations or []
				nowPlaying: state.saved.nowPlaying
				settings: {endpoint: state.settings.endpoint, quality: state.settings.quality, remember: state.settings.remember}
				version: browser.runtime.getManifest().version
				core: state.core.version
				gate: gate
				update: updateState()
			}
		when 'login'
			const email = String(msg.email or '').trim()
			const password = String(msg.password or '')
			note("login requested (email {email.length} chars, password {password.length} chars, remember={!!msg.remember})")
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
			{email, stations}
		when 'logout'
			client.logout()
			await browser.storage.local.set({password: '', remember: no})
			Object.assign(state.settings, {password: '', remember: no})
			await persist()
			await remember('stations', [])
			await remember('nowPlaying', null)
			try
				const tab = await playerTab()
				await browser.tabs.sendMessage(tab.id, {type: 'control', action: 'stop'}) if tab
			catch e
				null
			{}
		when 'stations'
			const stations = await client.stations()
			await remember('stations', stations)
			await persist()
			{stations}
		when 'playlist'
			const station = stationByToken(msg.stationToken) or {token: msg.stationToken, name: ''}
			const quality = QUALITIES.includes(msg.quality) ? msg.quality : state.settings.quality
			const songs = await client.playlist(station, quality)
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
			await openPlayer(msg.stationToken or null)
		when 'player-hello'
			const pending = state.saved.pendingPlay
			await remember('pendingPlay', null)
			await remember('playerTabId', sender and sender.tab and sender.tab.id or null)
			{pendingPlay: pending, stations: state.saved.stations or [], nowPlaying: state.saved.nowPlaying, settings: state.settings, gate: gate, update: updateState()}
		when 'now-playing'
			await remember('nowPlaying', msg.nowPlaying or null)
			broadcast({type: 'now-playing', nowPlaying: msg.nowPlaying or null})
			maybeReload('playback stopped') unless msg.nowPlaying
			{}
		when 'control'
			await control(String(msg.action or ''))
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
			await checkGate(yes)
	# A GitHub token stored or removed (the sign-in, the sign-out, a test), or the
	# auth server override: re-check the gate now.
	await checkGate(yes) if changes.github or changes.authBase
	state.settings.quality = changes.quality.newValue if changes.quality and QUALITIES.includes(changes.quality.newValue)
	if changes.remember or changes.password or changes.email
		const s = await loadSettings()
		Object.assign(state.settings, s)
		state.client.credentials = s.remember and s.email and s.password ? {email: s.email, password: s.password} : null

browser.runtime.onInstalled.addListener do(details)
	console.info("melodica-extension {browser.runtime.getManifest().version} {details.reason}")
