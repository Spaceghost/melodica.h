# Bridge content script for https://spacegho.st/melodica/app/*. Two layers
# (docs/BRIDGE.md): the relay, which lets the web client route its own Pandora
# calls through the extension, and since 0.3.0 the remote control, which lets a
# page that sends `subscribe` show and steer the extension's own background
# playback instead of running its own loop. A page that never subscribes gets
# the relay exactly as before.
#
# Protocol (window.postMessage, same window, same origin, data.melodica === 1):
#   page -> {melodica:1, type:'hello'}
#   ext  -> {melodica:1, type:'ready', name:'melodica-extension', version, player:true}
#   page -> {melodica:1, type:'request', id, search:'?method=…', body:Uint8Array}
#   ext  -> {melodica:1, type:'response', id, ok, status, body:Uint8Array, error}
#   page -> {melodica:1, type:'subscribe'} | {type:'unsubscribe'}
#   ext  -> {melodica:1, type:'state', state}            (on subscribe and on every change)
#   page -> {melodica:1, type:'command', id, action, …}  (play/pause/toggle/next/love/ban/tired/stop/volume/quality/stations/openLogin, also spelled open-login)
#   ext  -> {melodica:1, type:'result', id, ok, error, state}
# The extension also announces 'ready' once when it loads. Only searches whose
# method matches /^[a-z]+\.[A-Za-z]+$/ are forwarded; the background POSTs the
# body to <endpoint><search> with content-type text/plain and no cookies.

import { browser, toBase64, fromBase64 } from './shared.imba'

const NAME = 'melodica-extension'
const VERSION = browser.runtime.getManifest().version
const METHOD = /^[a-z]+\.[A-Za-z]+$/

let subscribed = no

def announce
	window.postMessage({melodica: 1, type: 'ready', name: NAME, version: VERSION, player: yes}, location.origin)

# The page never sees audio URLs (the track's or the play log's).
def strip song
	return song unless song
	const t = Object.assign({}, song)
	delete t.audioUrl
	t

def publicState state
	return state unless state and typeof state === 'object'
	Object.assign({}, state, {track: strip(state.track), history: Array.isArray(state.history) ? state.history.map(strip) : []})

def pushState state
	window.postMessage({melodica: 1, type: 'state', state: publicState(state)}, location.origin)

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
		window.postMessage(Object.assign({melodica: 1, type: 'result', id}, fields), location.origin)
	try
		const action = String(data.action or '')
		let r
		if action === 'openLogin' or action === 'open-login'
			const o = await browser.runtime.sendMessage({type: 'open-login'})
			return reply({ok: no, error: o and o.error or 'the extension did not answer'}) unless o and o.ok
			r = await browser.runtime.sendMessage({type: 'player-get'})
			return reply({ok: yes, opened: o.opened, state: publicState(r and r.state)}) if r and r.ok
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
		reply({ok: yes, state: publicState(r.state)})
		# Push the same state at once so a subscribed page need not wait for
		# the background's next broadcast (the resume lag).
		pushState(r.state) if subscribed and r.state
	catch e
		reply({ok: no, error: String(e and e.message or e)})

# State pushes from the background reach a subscribed page.
browser.runtime.onMessage.addListener do(msg)
	pushState(msg.state) if subscribed and msg and msg.type === 'player-state'
	no

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
		window.postMessage(Object.assign({melodica: 1, type: 'response', id}, fields), location.origin)
	const failed = do(error, status = 0)
		reply({ok: no, status, body: new Uint8Array(0), error})
	return failed('method not allowed') unless methodOf(data.search)
	try
		const r = await browser.runtime.sendMessage({type: 'bridge', search: data.search, body: toBase64(bodyBytes(data.body))})
		return failed('the extension did not answer') unless r
		return failed(r.error or 'extension error') unless r.ok
		reply({ok: !!r.fetchOk, status: Number(r.status) or 0, body: fromBase64(r.body), error: undefined})
	catch e
		failed(String(e and e.message or e))

window.addEventListener 'message', do(event)
	return unless event.source === window and event.origin === location.origin
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

announce()
