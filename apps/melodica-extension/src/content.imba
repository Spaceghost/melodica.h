# Bridge content script for https://spacegho.st/melodica/* (document_start). Two layers
# (docs/BRIDGE.md): the relay, which lets the web client route its own Pandora
# calls through the extension, and since 0.3.0 the remote control, which lets a
# page that sends `subscribe` show and steer the extension's own background
# playback instead of running its own loop. A page that never subscribes gets
# the relay exactly as before.
#
# Protocol (window.postMessage, same window, same origin, data.melodica === 1):
#   ext  -> {melodica:1, type:'present', name, version}   (once, at injection)
#   page -> {melodica:1, type:'hello'}
#   ext  -> {melodica:1, type:'ready', name:'melodica-extension', version, player:true, rooms:1 on supported engines}
#   page -> {melodica:1, type:'request', id, search:'?method=…', body:Uint8Array}
#   ext  -> {melodica:1, type:'response', id, ok, status, body:Uint8Array, error}
#   page -> {melodica:1, type:'subscribe'} | {type:'unsubscribe'}
#   ext  -> {melodica:1, type:'state', state}            (on subscribe and on every change)
#   page -> {melodica:1, type:'command', id, action, …}  (play/pause/toggle/next/love/ban/tired/stop/volume/quality/stations/openLogin, also spelled open-login; play-seed {kind, name} or seed {seed: {kind, name}}, kind 'artist'|'genre')
#   ext  -> {melodica:1, type:'result', id, ok, error, state}
# The extension also announces 'ready' once when it loads. Only searches whose
# method matches /^[a-z]+\.[A-Za-z]+$/ are forwarded; the background POSTs the
# body to <endpoint><search> with content-type text/plain and no cookies.

import { browser, toBase64, fromBase64 } from './shared.imba'

const NAME = 'melodica-extension'
const VERSION = browser.runtime.getManifest().version
const NATIVE_ROOMS = (browser.runtime.getManifest().background or {}).persistent !== false
const METHOD = /^[a-z]+\.[A-Za-z]+$/
# melodica-web docs/BRIDGE.md section 1: messages go to and come from this exact
# origin only, under /melodica/.
const ORIGIN = 'https://spacegho.st'
const PATH = '/melodica/'

# A https://spacegho.st/listen/ link (docs/LISTEN-URI.md) loaded as a page: the
# extension's player tab takes it over (it offers Play; nothing starts by itself).
if location.pathname.startsWith('/listen/')
	browser.runtime.sendMessage({type: 'listen-open', uri: location.href.split('#')[0]}).catch(do(e) null)

let subscribed = no
let invalidated = no
let runtimeWatch = null
let activeRoomId = null

# An unanswered request can be a sleeping background; it says nothing about
# whether audio still plays. Only the browser invalidating this extension
# context permits the page to reclaim its playback engine.
def runtimeGone error = null
	return yes if invalidated
	let gone = /extension context invalidated/i.test(String(error and error.message or error or ''))
	try
		gone = yes unless browser.runtime.id
	catch e
		gone = yes if /extension context invalidated/i.test(String(e and e.message or e))
	return no unless gone
	invalidated = yes
	subscribed = no
	clearInterval(runtimeWatch) if runtimeWatch
	window.postMessage({melodica: 1, type: 'gone', reason: 'runtime-invalidated', name: NAME, version: VERSION}, ORIGIN)
	yes

runtimeWatch = setInterval((do runtimeGone()), 500)

def announce
	return if runtimeGone()
	const ready = {melodica: 1, type: 'ready', name: NAME, version: VERSION, player: yes, session: 1}
	ready.rooms = 1 if NATIVE_ROOMS
	window.postMessage(ready, ORIGIN)

# The page never sees audio URLs (the track's or the play log's).
def strip song
	return song unless song
	const t = Object.assign({}, song)
	delete t.audioUrl
	t

def publicState state
	return state unless state and typeof state === 'object'
	Object.assign({}, state, {track: strip(state.track), history: Array.isArray(state.history) ? state.history.map(strip) : [], queue: Array.isArray(state.queue) ? state.queue.map(strip) : []})

# Answers to a subscribe (the page repeats it every few seconds) and the
# background's pushes can cross: a state older than the newest one sent is
# dropped, so a stale "paused" never lands after "playing".
let newest = 0
def pushState state
	const at = state and Number(state.changedAt) or 0
	return if at and at < newest
	newest = at if at > newest
	window.postMessage({melodica: 1, type: 'state', state: publicState(state)}, ORIGIN)

# Right after browser start the background (service worker, offscreen document or
# Firefox background page) may not be listening yet: ask again for up to ~20 s
# before reporting an error. The answer is the state whatever it is: idle,
# signed out (`loggedIn: false`) or playing.
def subscribe
	subscribed = yes
	let last = null
	for wait in [0, 250, 500, 1000, 1000, 2000, 2000, 3000, 5000, 5000]
		await new Promise(do(ok) setTimeout(ok, wait)) if wait
		return unless subscribed
		try
			const r = await browser.runtime.sendMessage({type: 'player-subscribe', on: yes})
			if r and r.ok and r.state
				return pushState(r.state)
			last = r and r.error or 'the extension did not answer'
		catch e
			last = String(e and e.message or e)
	pushState({status: 'error', error: last or 'the extension did not answer', loggedIn: no})

def handleCommand data
	const id = String(data.id)
	const reply = do(fields)
		window.postMessage(Object.assign({melodica: 1, type: 'result', id}, fields), ORIGIN)
	try
		const action = String(data.action or '')
		let r
		if action === 'playback-export' or action === 'playback-import' or action === 'playback-copy'
			r = await browser.runtime.sendMessage({type: action, playback: data.playback, trackToken: data.trackToken, offset: data.offset, limit: data.limit})
			return reply({ok: no, error: r and r.error or 'the extension did not answer'}) unless r and r.ok
			return reply({ok: yes, playback: r.playback, copy: r.copy, state: publicState(r.state)})
		elif ['room-get', 'room-join', 'room-leave'].includes(action)
			r = await browser.runtime.sendMessage({type: action, roomId: data.roomId or activeRoomId, paused: data.paused === yes})
			return reply({ok: no, error: r and r.error or 'the extension did not answer'}) unless r and r.ok
			return reply({ok: yes, room: r.room, state: publicState(r.state)})
		elif action === 'room-command'
			r = await browser.runtime.sendMessage({type: action, roomId: data.roomId or activeRoomId, command: data.command or data.body})
			return reply({ok: no, error: r and r.error or 'the extension did not answer'}) unless r and r.ok
			return reply({ok: yes, room: r.room, state: publicState(r.state)})
		elif action === 'room-audio-command'
			r = await browser.runtime.sendMessage({type: action, roomId: data.roomId or activeRoomId, action: data.roomAction, value: data.value})
			return reply({ok: no, error: r and r.error or 'the extension did not answer'}) unless r and r.ok
			return reply({ok: yes, room: r.room, state: publicState(r.state)})
		elif action === 'room-api'
			r = await browser.runtime.sendMessage({type: 'room-api', path: data.path, roomId: data.roomId, body: data.body})
			return reply({ok: no, error: r and r.error or 'the extension did not answer'}) unless r and r.ok
			return reply({ok: yes, result: r.result, status: r.status})
		elif action === 'room-search'
			r = await browser.runtime.sendMessage({type: 'room-search', query: data.query, cursor: data.cursor, recentIds: data.recentIds})
			return reply({ok: no, error: r and r.error or 'the extension did not answer'}) unless r and r.ok
			return reply({ok: yes, rooms: r.rooms, recent: r.recent, recentRoomIds: r.recentRoomIds, next_cursor: r.next_cursor})
		elif action === 'room-recent'
			r = await browser.runtime.sendMessage({type: 'room-recent'})
			return reply({ok: no, error: r and r.error or 'the extension did not answer'}) unless r and r.ok
			return reply({ok: yes, recentRoomIds: r.recentRoomIds})
		elif ['room-pause', 'room-resume', 'room-skip', 'room-volume'].includes(action)
			const roomAction = {'room-pause': 'pause', 'room-resume': 'resume', 'room-skip': 'skip', 'room-volume': 'volume'}[action]
			r = await browser.runtime.sendMessage({type: 'room-audio-command', roomId: data.roomId or activeRoomId, action: roomAction, value: data.value})
			return reply({ok: no, error: r and r.error or 'the extension did not answer'}) unless r and r.ok
			return reply({ok: yes, room: r.room, state: publicState(r.state)})
		elif action === 'openLogin' or action === 'open-login'
			const o = await browser.runtime.sendMessage({type: 'open-login'})
			return reply({ok: no, error: o and o.error or 'the extension did not answer'}) unless o and o.ok
			r = await browser.runtime.sendMessage({type: 'player-get'})
			return reply({ok: yes, opened: o.opened, state: publicState(r and r.state)}) if r and r.ok
		elif action === 'play-seed' or action === 'seed'
			const seed = data.seed and typeof data.seed === 'object' ? data.seed : data
			r = await browser.runtime.sendMessage({type: 'play-seed', kind: String(seed.kind or ''), name: String(seed.name or '').slice(0, 128)})
			return reply({ok: no, error: r and r.error or 'the extension did not answer', kind: r and r.kind}) unless r and r.ok
			pushState(r.state) if subscribed and r.state
			return reply({ok: yes, station: r.station, created: r.created, state: publicState(r.state)})
		elif action === 'stations'
			r = await browser.runtime.sendMessage({type: 'stations'})
			return reply({ok: no, error: r and r.error or 'extension error'}) unless r and r.ok
			r = await browser.runtime.sendMessage({type: 'player-get'})
		else
			const msg = {type: 'player', action}
			msg.station = {token: String(data.station.token), name: String(data.station.name or '')} if data.station and data.station.token
			msg.value = data.value if data.value !== undefined
			r = await browser.runtime.sendMessage(msg)
		return reply({ok: no, error: 'the extension did not answer'}) unless r
		return reply({ok: no, error: r.error or 'extension error', kind: r.kind}) unless r.ok
		# A reply whose state is older than one already sent carries no state, so the
		# page never draws it over the newer push.
		const at = r.state and Number(r.state.changedAt) or 0
		if at and at < newest
			reply({ok: yes})
		else
			reply({ok: yes, state: publicState(r.state)})
			# The same state as a push, at once (the page need not wait for a broadcast).
			pushState(r.state) if subscribed and r.state
	catch e
		runtimeGone(e)
		reply({ok: no, error: String(e and e.message or e)})

# State pushes from the background reach a subscribed page; session pushes reach a
# page that has asked for the session at least once.
# Every push is answered: a push left unanswered rejects in the background ("the
# message port closed"), which used to drop this tab from the subscribers until its
# next subscribe, up to a second later.
browser.runtime.onMessage.addListener do(msg, sender, sendResponse)
	if msg and msg.type === 'bridge-ping'
		sendResponse({ok: yes})
		return no
	return no unless msg and (msg.type === 'player-state' or msg.type === 'room-clock' or msg.type === 'session-state' or msg.type === 'session-account-signout')
	if msg.type === 'player-state'
		activeRoomId = msg.state and msg.state.room and msg.state.room.id or null
		pushState(msg.state) if subscribed
	elif msg.type === 'room-clock'
		window.postMessage({melodica: 1, type: 'room-clock', room: msg.room, state: publicState(msg.state)}, ORIGIN) if subscribed
	postSession(msg.view) if sessionAsked and msg.type === 'session-state' and msg.view
	window.postMessage({melodica: 1, type: 'account-signout'}, ORIGIN) if sessionAsked and msg.type === 'session-account-signout'
	sendResponse({ok: yes, subscribed})
	no

# ---- session sharing (BRIDGE.md section 4); the background checks the sender.
let sessionAsked = no

def postSession view, id = undefined
	const m = {melodica: 1, type: 'session', session: view.session or null, access: (view.session and view.access) or null, credential: view.credential or null, account: view.account or null, revoked: view.revoked or []}
	m.id = id if id !== undefined
	window.postMessage(m, ORIGIN)

def sessionMessage data
	const id = String(data.id)
	const result = do(fields)
		window.postMessage(Object.assign({melodica: 1, type: 'result', id}, fields), ORIGIN)
	try
		if data.type === 'session-get'
			sessionAsked = yes
			const r = await browser.runtime.sendMessage({type: 'bridge-session-get', account: data.account or null})
			return result({ok: no, error: r and r.error or 'the extension did not answer'}) unless r and r.ok
			postSession(r, id)
			# A spacegho.st sign-out made while no page was open (BRIDGE.md 4.6).
			window.postMessage({melodica: 1, type: 'account-signout'}, ORIGIN) if r.accountSignout
		elif data.type === 'session-offer'
			sessionAsked = yes
			const r = await browser.runtime.sendMessage({type: 'bridge-session-offer', session: data.session or null, credential: data.credential or null, account: data.account or null, playback: data.playback or null, stations: data.stations})
			return result({ok: no, error: r and r.error or 'the extension did not answer'}) unless r and r.ok
			result({ok: yes, outcome: r.outcome})
		elif data.type === 'account-signout'
			const r = await browser.runtime.sendMessage({type: 'bridge-account-signout'})
			return result({ok: no, error: r and r.error or 'the extension did not answer'}) unless r and r.ok
			result({ok: yes})
		elif data.type === 'session-logout'
			const r = await browser.runtime.sendMessage({type: 'bridge-session-logout', sid: String(data.sid or '')})
			return result({ok: no, error: r and r.error or 'the extension did not answer'}) unless r and r.ok
			result({ok: yes})
	catch e
		runtimeGone(e)
		result({ok: no, error: String(e and e.message or e)})

def methodOf search
	return null unless typeof search === 'string' and search.startsWith('?') and search.length < 4096
	return null if search.includes('#')
	const method = new URLSearchParams(search).get('method')
	method and METHOD.test(method) ? method : null

def bodyBytes body
	return body if body isa Uint8Array
	return new Uint8Array(body) if body isa ArrayBuffer
	return new Uint8Array(body.buffer, body.byteOffset, body.byteLength) if body and ArrayBuffer.isView(body)
	return Uint8Array.from(body) if Array.isArray(body)
	return new TextEncoder().encode(body) if typeof body === 'string'
	new Uint8Array(0)

def handleRequest data
	const id = String(data.id)
	const reply = do(fields)
		window.postMessage(Object.assign({melodica: 1, type: 'response', id}, fields), ORIGIN)
	const failed = do(error, status = 0)
		reply({ok: no, status, body: new Uint8Array(0), error})
	return failed('method not allowed') unless methodOf(data.search)
	try
		const r = await browser.runtime.sendMessage({type: 'bridge', search: data.search, body: toBase64(bodyBytes(data.body))})
		return failed('the extension did not answer') unless r
		return failed(r.error or 'extension error') unless r.ok
		reply({ok: !!r.fetchOk, status: Number(r.status) or 0, body: fromBase64(r.body), error: undefined})
	catch e
		runtimeGone(e)
		failed(String(e and e.message or e))

window.addEventListener 'message', do(event)
	return unless event.source === window and event.origin === ORIGIN and location.pathname.startsWith(PATH)
	return if runtimeGone()
	const data = event.data
	return unless data and typeof data === 'object' and data.melodica === 1
	if data.type === 'hello'
		announce()
	elif data.type === 'request'
		handleRequest(data)
	elif data.type === 'subscribe'
		subscribe()
	elif data.type === 'unsubscribe'
		subscribed = no
		browser.runtime.sendMessage({type: 'player-subscribe', on: no}).catch(do(e) null)
	elif data.type === 'command'
		handleCommand(data)
	elif data.type === 'session-get' or data.type === 'session-offer' or data.type === 'session-logout' or data.type === 'account-signout'
		sessionMessage(data)

# The content script answers on its own: it announces at document_start, again
# once the page's scripts have run, and wakes the background (service worker or
# event page) so the remembered session is restored before the page asks.
# `present` (melodica-web 0.10.3) says "extension here, state pending".
window.postMessage({melodica: 1, type: 'present', name: NAME, version: VERSION}, ORIGIN)
announce()
document.addEventListener('DOMContentLoaded', (do announce()), {once: yes})
window.addEventListener('load', (do announce()), {once: yes})
browser.runtime.sendMessage({type: 'wake'}).catch(do(e) null)
