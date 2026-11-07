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
import { parseToken, expired, tokenFromRedirect, normalizeAuthBase, startUrl, meUrl } from './github.imba'
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
# Safari has no identity API either: its GitHub sign-in runs in a tab that the auth
# Worker sends back to the web app page, where safari-auth.js hands over the token.
const WEB_APP_URL = 'https://spacegho.st/melodica/app/'
const SIGNIN_PENDING_FOR = 10 * 60 * 1000
let engineWaiters = []
const SESSION_KEYS = {session: null, stations: [], player: null, log: []}
const PLAYER_IDLE = {status: 'idle', station: null, track: null, position: 0, duration: 0, volume: 80, quality: 'high', queueLength: 0, error: '', history: [], changedAt: 0}
const PLAYER_ACTIONS = new Set(['play', 'resume', 'pause', 'toggle', 'next', 'love', 'ban', 'tired', 'sleep', 'stop', 'volume', 'quality'])
const LOG_MAX = 200
# The GitHub gate is re-checked at least this often while the extension is in use
# (every boot, every popup/player open past this age, the player's timer).
const GATE_MAX_AGE = 60 * 60 * 1000
# Message types that reach Pandora (or the player) and so need the gate open.
const GATED = new Set(['login', 'stations', 'playlist', 'rate', 'tired', 'explain', 'search', 'create-station', 'delete-station', 'bridge', 'player'])

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
		await stopPlayback('the GitHub gate closed')
	broadcast({type: 'gate', gate})
	gate

# The current gate, re-checked when forced, when it was never checked, or when the
# last check is older than GATE_MAX_AGE. One check runs at a time.
# The token the running check read and the one it stored itself (a refresh): a
# forced check that arrives meanwhile reruns only if the stored token is neither,
# i.e. a sign-in, sign-out or test changed it after the running check began.
let checkedToken = null
let refreshedToken = null

def storedToken
	const got = await browser.storage.local.get({github: null})
	got.github and typeof got.github.token === 'string' ? got.github.token : ''

def checkGate force = no
	if checking
		await checking
		return gate unless force
		const now = await storedToken()
		return gate if now === checkedToken or now === refreshedToken
		return await checkGate(yes)
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
	const token = await storedToken()
	checkedToken = token
	refreshedToken = null
	const claims = token ? parseToken(token) : null
	if token and !claims
		refreshedToken = ''
		await browser.storage.local.remove('github')
		return await setGate({mode: 'anon', reason: 'the stored GitHub token was malformed; sign in again'})
	if claims and expired(claims)
		refreshedToken = ''
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
		refreshedToken = ''
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
		refreshedToken = me.token
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
	return await tabSignin() unless browser.identity and browser.identity.launchWebAuthFlow
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

# Safari: open the sign-in in a tab; `github-token` (from safari-auth.js) finishes it.
def tabSignin
	const url = startUrl(await authBase(), WEB_APP_URL)
	await session.set({githubPending: Date.now()})
	note("github sign-in: tab {url}")
	await browser.tabs.create({url})
	gate

def tabSigninDone msg, sender
	const got = await session.get({githubPending: 0})
	const from = String(sender and (sender.url or (sender.tab and sender.tab.url)) or '')
	throw new PandoraError('No GitHub sign-in is pending.', null, 0, 'gate') unless got.githubPending and Date.now() - got.githubPending < SIGNIN_PENDING_FOR
	throw new PandoraError('The GitHub token did not come from the sign-in page.', null, 0, 'gate') unless from.startsWith(WEB_APP_URL)
	const token = typeof msg.token === 'string' and parseToken(msg.token) ? msg.token : null
	throw new PandoraError('GitHub sign-in came back without a token.', null, 0, 'gate') unless token
	await session.set({githubPending: 0})
	await browser.storage.local.set({github: {token}})
	note("github sign-in (tab): token for {parseToken(token).sub}")
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
	Object.assign({}, player, {stations: state and state.saved.stations or [], loggedIn: !!(state and state.client.loggedIn), gate: {mode: gate.mode, login: gate.login, reason: gate.reason}})

def publicTrack song
	return null unless song
	const t = Object.assign({}, song)
	delete t.audioUrl
	t

# The engine reported: keep it, persist it, show it on the badge, tell the views.
def playerChanged next
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
				songs
			rate: do(trackToken, positive) state.client.rate(trackToken, positive)
			tired: do(trackToken) state.client.tired(trackToken)
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
		when 'github-token'
			{gate: await tabSigninDone(msg, sender)}
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
			await stopPlayback('signed out')
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
			await openPlayer()
		when 'player-subscribe'
			await subscribeTab(sender and sender.tab and sender.tab.id, msg.on !== no)
			{state: playerView()}
		when 'player-get'
			{state: playerView(), settings: state.settings, gate: gate, update: updateState()}
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

# Keyboard shortcuts (manifest `commands`): play/pause and next, from anywhere.
if browser.commands and browser.commands.onCommand
	browser.commands.onCommand.addListener do(command)
		try
			await ensure()
			await requireGate()
			await playerCommand({action: command === 'next-song' ? 'next' : 'toggle'})
		catch e
			note("shortcut {command} failed: {e and e.message or e}")

# Firefox: the engine lives here; bring it up with the saved state on boot so a
# paused track survives a restart and the badge is right.
if typeof document !== 'undefined' and !browser.offscreen and !TAB_ENGINE
	ensure().then(do localEngine()).catch(do(e) null)
