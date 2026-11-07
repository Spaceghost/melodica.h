# Background (MV3 service worker in Chrome, event page in Firefox): owns the
# Pandora session, does every request to Pandora, and relays for the popup, the
# player page and the bridge content script. State that must survive the
# worker being stopped lives in storage.session (storage.local as fallback).

import { Core } from './core.imba'
import { Pandora, PandoraError, QUALITIES } from './pandora.imba'
import { browser, loadSettings, normalizeEndpoint, fromBase64, toBase64 } from './shared.imba'

const METHOD = /^[a-z]+\.[A-Za-z]+$/
const PLAYER_URL = browser.runtime.getURL('player.html')
const session = browser.storage.session or browser.storage.local
const SESSION_KEYS = {session: null, stations: [], nowPlaying: null, playerTabId: null, pendingPlay: null}

let booting = null
let state = null

def boot
	const settings = await loadSettings()
	const url = browser.runtime.getURL('core/melodica_core.wasm')
	const bytes = await (await fetch(url)).arrayBuffer()
	const core = await Core.load(bytes)
	throw new Error('melodica core: key setup failed') unless core.init()
	const client = new Pandora(core, {endpoint: settings.endpoint, log: do(line) console.debug("melodica {line}")})
	const saved = await session.get(SESSION_KEYS)
	client.restore(saved.session)
	if settings.remember and settings.email and settings.password
		client.credentials = {email: settings.email, password: settings.password}
	{core, client, settings, saved}

def ensure
	unless booting
		booting = boot()
		booting.catch(do(e) booting = null)
	state = await booting
	state

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
	switch msg.type
		when 'ping'
			{version: browser.runtime.getManifest().version, core: state.core.version}
		when 'state'
			{
				loggedIn: client.loggedIn
				email: client.user and client.user.email or state.settings.email or ''
				stations: state.saved.stations or []
				nowPlaying: state.saved.nowPlaying
				settings: {endpoint: state.settings.endpoint, quality: state.settings.quality, remember: state.settings.remember}
				version: browser.runtime.getManifest().version
				core: state.core.version
			}
		when 'login'
			const email = String(msg.email or '').trim()
			const password = String(msg.password or '')
			await client.login(email, password)
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
			{pendingPlay: pending, stations: state.saved.stations or [], nowPlaying: state.saved.nowPlaying, settings: state.settings}
		when 'now-playing'
			await remember('nowPlaying', msg.nowPlaying or null)
			broadcast({type: 'now-playing', nowPlaying: msg.nowPlaying or null})
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
		const code = (e and e.code != null) ? e.code : null
		sendResponse({ok: no, error: String((e and e.message) or e), code: code, kind: (e and e.kind) or 'error'})
	handle(msg, sender).then(done, failed)
	yes

# Settings edited on the options page: a new endpoint invalidates the session
# (tokens belong to one server); quality applies to the next playlist.
browser.storage.onChanged.addListener do(changes, area)
	return unless area === 'local' and state
	if changes.endpoint
		const endpoint = normalizeEndpoint(changes.endpoint.newValue)
		if endpoint !== state.client.endpoint
			state.settings.endpoint = endpoint
			state.client.endpoint = endpoint
			state.client.reset()
			await persist()
			await remember('stations', [])
	state.settings.quality = changes.quality.newValue if changes.quality and QUALITIES.includes(changes.quality.newValue)
	if changes.remember or changes.password or changes.email
		const s = await loadSettings()
		Object.assign(state.settings, s)
		state.client.credentials = s.remember and s.email and s.password ? {email: s.email, password: s.password} : null

browser.runtime.onInstalled.addListener do(details)
	console.info("melodica-extension {browser.runtime.getManifest().version} {details.reason}")
