# Full-tab room lobby and room controller. Shared Imba UI renders the room; the
# background owns auth/API checks and the offscreen engine owns every connection.
import { browser, send } from './shared.imba'

const host = document.createElement('main')
host.id = 'rooms-app'
document.body.append(host)

const params = new URLSearchParams(location.search)
const roomId = String(params.get('room') or '').replace(/\/+$/, '')
let roomUi = null
let lastRoom = null
let lastAudio = {state: 'idle'}
let connection = null
let audio = null
let notice = null

def acceptRoom value
	return unless value and typeof value === 'object'
	const info = value.room and value.room.id ? value.room : (value.state and value.state.room and value.state.room.id ? value.state.room : null)
	return unless info
	return if info.id and roomId and info.id !== roomId
	lastRoom = info.state or null
	lastAudio = info.audio or lastAudio
	connection.dispatchEvent(new CustomEvent('state', {detail: lastRoom})) if lastRoom
	audio.dispatchEvent(new CustomEvent('state', {detail: lastAudio}))
	imba.commit()

def acceptClock value
	const info = value and value.room and typeof value.room === 'object' ? value.room : null
	const nextPlay = info and info.state and info.state.play
	const currentPlay = lastRoom and lastRoom.play
	return unless info and info.id === roomId and currentPlay and nextPlay and nextPlay.id === currentPlay.id
	return unless Number.isSafeInteger(nextPlay.position_ms) and nextPlay.position_ms >= 0
	return unless Number.isSafeInteger(nextPlay.server_time) and nextPlay.server_time > (currentPlay.server_time or 0)
	lastRoom = Object.assign({}, lastRoom, {play: Object.assign({}, currentPlay, {position_ms: nextPlay.position_ms, server_time: nextPlay.server_time})})
	connection.dispatchEvent(new CustomEvent('clock', {detail: {play_id: nextPlay.id, position_ms: nextPlay.position_ms, server_time: nextPlay.server_time}})) if connection

def onMessage msg
	if msg and msg.type === 'player-state' and msg.state and msg.state.room
		acceptRoom({room: msg.state.room})
	elif msg and msg.type === 'room-clock'
		acceptClock(msg)
	no

def setupRoomProxy
	connection = new EventTarget()
	connection.getState = do lastRoom
	connection.open = do
		send({type: 'room-join', roomId}).then(do(result) acceptRoom(result)).catch(do(error)
			connection.dispatchEvent(new CustomEvent('error', {detail: {message: error.message, code: error.code}}))
		)
	connection.refresh = do
		send({type: 'room-get'}).then(do(result) acceptRoom(result)).catch(do(error)
			connection.dispatchEvent(new CustomEvent('error', {detail: {message: error.message, code: error.code}}))
		)
	connection.command = do(command)
		const result = await send({type: 'room-command', roomId, command})
		acceptRoom(result)
		result.state
	connection.close = do(options = {})
		if options.leave
			send({type: 'room-leave', roomId}).then(do(result) acceptRoom(result)).catch(do(e) null)
	connection.setAudio = do(value) null

	audio = new EventTarget()
	audio.getState = do lastAudio
	audio.listen = do changeAudio('listen')
	audio.pause = do changeAudio('pause')
	audio.resume = do changeAudio('resume')
	audio.skip = do changeAudio('skip')
	audio.setVolume = do(value) changeAudio('volume', value)
	audio.unmount = do null
	audio.stop = do null
	no

def changeAudio action, value = null
	const result = await send({type: 'room-audio-command', roomId, action, value})
	acceptRoom(result)
	result.room

def api path, options = {}
	if options.body and options.body.action === 'invite'
		const result = await send({type: 'room-command', roomId, command: options.body})
		acceptRoom(result)
		return result.state or result.room and result.room.state
	const result = await send({type: 'room-api', roomId: roomId or null, path, body: options.body})
	result.result

def recentRoomIds
	try
		(await send({type: 'room-recent'})).recentRoomIds or []
	catch e
		[]

def searchRooms options = {}
	const result = await send({type: 'room-search', query: options.query or '', cursor: options.cursor or null, recentIds: options.recentIds or []})
	{rooms: result.rooms or [], recent: result.recent or [], next_cursor: result.next_cursor or null}

def mount
	const nav = document.createElement('nav')
	nav.id = 'rooms-nav'
	host.append(nav)
	try
		const ui = await import(browser.runtime.getURL('scrobble-ui/scrobble-ui.js'))
		if !ui.mountRooms or !ui.mountRoom
			throw new Error('Rooms are not available until the shared Scrobbles UI has its Rooms components.')
		ui.mountNav(nav, {base: 'https://spacegho.st', active: 'app', crew: no}) if ui.mountNav
		const container = document.createElement('div')
		container.id = 'rooms-content'
		host.append(container)
		if roomId
			setupRoomProxy()
			browser.runtime.onMessage.addListener(notice)
			const client = {api}
			const roomOptions = {id: roomId, client, connection, audio, ownsAudio: no, recordListens: no, lobbyHref: browser.runtime.getURL('rooms.html'), roomBase: browser.runtime.getURL('rooms.html?room=')}
			roomUi = ui.mountRoom(container, roomOptions)
			const current = await send({type: 'room-get'})
			acceptRoom(current)
		else
			const client = {api}
			roomUi = ui.mountRooms(container, {client, roomBase: browser.runtime.getURL('rooms.html?room='), lobbyHref: browser.runtime.getURL('rooms.html'), recentRoomIds, searchRooms})
	catch e
		const message = document.createElement('p')
		message.setAttribute('role', 'alert')
		message.textContent = String(e and e.message or e)
		host.append(message)

notice = do(msg) onMessage(msg)
await mount()
window.addEventListener('pagehide', do
	browser.runtime.onMessage.removeListener(notice) if notice
	roomUi.unmount() if roomUi and roomUi.unmount
)
