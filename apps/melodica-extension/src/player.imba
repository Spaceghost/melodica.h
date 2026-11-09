# The player page: an optional full-size view of the background's playback
# (bg.imba owns the state and the engine). Opening it starts nothing; closing
# it stops nothing. It renders `player-state` and sends `player` commands.

import { browser, send, FALLBACK_COVER } from './shared.imba'
import { StationList, NowPlaying, Transport, AccountLine, UpdateBanner, Top, Foot, UsernamePick, ScrobbleNotice, ListenPrompt, CopyListen } from './ui.imba'
import { parseListenUri, routeOf } from './listen-uri.js'
import { MELODICA_PAGES } from './scrobble.imba'

# The shared Scrobbles UI (melodica-scrobble ui/, docs/CLIENTS.md), vendored into the
# extension at a pinned commit (scrobble-ui.pin) and loaded from the package.
let sui = null
let roomSnapshot = null
let roomConnection = null
let roomAudio = null
let roomView = null
let roomClient = null
let roomUiId = null
def scrobbleUi
	return sui if sui
	const sheet = document.createElement('link')
	sheet.rel = 'stylesheet'
	sheet.href = 'scrobble-ui/scrobble-ui.css'
	document.head.appendChild(sheet)
	const mod = await import(browser.runtime.getURL('scrobble-ui/scrobble-ui.js'))
	const client = mod.createClient({base: 'https://spacegho.st', token: do (await send({type: 'scrobble-token'})).token})
	sui = {mod, client, live: client.live()}
	sui

# While this page is open the background is asked for the account's policy this
# often; it asks spacegho.st again once its last answer is an hour old.
const ACCOUNT_POLL = 15 * 60 * 1000

tag Player
	prop stations = []
	prop player = null
	prop message = ''
	prop kind = ''
	prop loggedIn = yes
	prop version = ''
	prop traits = null
	prop account = null
	prop accountBusy = no
	prop accountError = ''
	prop update = null
	prop panel = 'player'
	prop crew = no
	prop liveState = ''
	prop panelError = ''
	prop listenLink = null

	# ?listen=<listen://, web+listen:// or https://spacegho.st/listen/ link> (Firefox's
	# web+listen handler, the omnibox, a spacegho.st/listen/ page): artist, genre and
	# station links are offered here; the others open their spacegho.st page.
	def takeListen
		const raw = new URLSearchParams(window.location.search).get('listen')
		return unless raw
		window.history.replaceState(null, '', window.location.pathname)
		const link = parseListenUri(raw)
		return panelError = "That link isn't supported." unless link
		if ['artist', 'genre', 'station'].includes(link.target)
			listenLink = link
		else
			window.location.replace("https://spacegho.st{routeOf(link)}")

	def mount
		self.listener = do(msg, sender, sendResponse) onMessage(msg, sender, sendResponse)
		browser.runtime.onMessage.addListener(self.listener)
		version = browser.runtime.getManifest().version
		takeListen()
		try
			const r = await send({type: 'player-get'})
			apply(r.state)
			account = r.account or null
			update = r.update or null
			self.pollTimer = setInterval((do poll()), ACCOUNT_POLL)
			if stations.length === 0 and loggedIn
				await reload()
			loadCrew() if loggedIn
			mountToast() if loggedIn
			show('room') if currentRoom()
		catch e
			if e.kind === 'auth'
				loggedIn = no
			else
				toast(String(e.message or e), 'error')
		imba.commit()

	def loadCrew
		try
			crew = !!(await send({type: 'scrobble-recent'})).recent.crew
			imba.commit()
		catch e
			null

	# The map's "Play in melodica" (melodica-scrobble docs/CLIENTS.md, onPlay): a track
	# seeds its artist; the station plays in this extension.
	def playFromMap play
		const kind = play and play.kind === 'genre' ? 'genre' : 'artist'
		const name = String(play and (play.kind === 'track' ? play.artist_name : play.name) or '').trim()
		throw new Error('Nothing to play.') unless name
		const r = await send({type: 'play-seed', kind, name})
		{station: {name: r.station and r.station.name or name}}

	# Conquest deployments: the shared UI's toast for each listen that deployed units
	# (the owner's live `deploy` and `retreat` events), above the player.
	def mountToast
		return if self.toastView
		try
			const ui = await scrobbleUi()
			const host = self.querySelector('#deploy-toast')
			self.toastView = ui.mod.mountDeployToast(host, {live: ui.live}) if host and ui.mod.mountDeployToast
		catch e
			null

	# Listens, Leaderboard and Map: each is mounted the first time it is shown.
	def show name
		return unless name !== 'room' or currentRoom()
		panel = name
		panelError = ''
		imba.commit()
		return if name === 'player'
		self.views ||= {}
		if name === 'room'
			return if self.views.room and roomUiId === currentRoom().id
			self.views.room.unmount() if self.views.room and self.views.room.unmount
			delete self.views.room if self.views.room
			try
				await mountRoomPanel()
			catch e
				panelError = String(e and e.message or e)
			imba.commit()
			return
		return if self.views[name]
		try
			const ui = await scrobbleUi()
			const host = self.querySelector("#panel-{name}")
			host.addEventListener('sui:error', do(e)
				panelError = String(e.detail and e.detail.message or 'Scrobbles did not answer.')
				imba.commit())
			host.addEventListener('sui:live', do(e)
				liveState = String(e.detail and e.detail.state or '')
				imba.commit())
			const opts = {client: ui.client, live: ui.live}
			if name === 'listens'
				self.views[name] = ui.mod.mountListens(host, Object.assign({pageSize: 25, mapHref: 'https://spacegho.st/melodica/map/'}, opts))
			elif name === 'leaderboard'
				self.views[name] = ui.mod.mountLeaderboard(host, Object.assign({window: '7d'}, opts))
			elif name === 'map'
				self.views[name] = ui.mod.mountMap(host, Object.assign({onPlay: (do(play) playFromMap(play)), onStation: do(station)
					const r = await send({type: 'terrain-station', station})
					throw new Error(r and r.error or 'Pandora did not answer.') unless r and r.ok
					r.station}, opts))
		catch e
			panelError = String(e and e.message or e)
		imba.commit()

	def unmount
		browser.runtime.onMessage.removeListener(self.listener)
		for own k, v of (self.views or {})
			v.unmount()
		roomView.unmount() if roomView and roomView.unmount and (!self.views or !self.views.room)
		self.toastView.unmount() if self.toastView
		roomUiId = null
		sui.live.close() if sui
		clearInterval(self.pollTimer) if self.pollTimer

	def apply state
		return unless state
		const priorRoomId = player and player.room and player.room.id or null
		player = state
		stations = state.stations if Array.isArray(state.stations) and (state.stations.length or stations.length === 0)
		loggedIn = !!state.loggedIn
		const nextRoomId = currentRoom() and currentRoom().id or null
		if nextRoomId
			panel = 'room'
			if roomUiId and roomUiId !== nextRoomId
				roomView.unmount() if roomView and roomView.unmount
				roomView = null
				delete self.views.room if self.views and self.views.room
				roomUiId = null
		elif priorRoomId
			roomView.unmount() if roomView and roomView.unmount
			roomView = null
			delete self.views.room if self.views and self.views.room
			roomUiId = null
			panel = 'player' if panel === 'room'
		document.title = state.track ? "{state.track.title} – {state.track.artist} · melodica" : 'melodica'
		lockPrivateControls()

	def currentRoom
		player and player.room and player.room.id ? player.room : null

	def acceptRoom value
		const info = value and value.room and value.room.id ? value.room : (value and value.state and value.state.room and value.state.room.id ? value.state.room : null)
		return unless info
		return unless currentRoom() and info.id === currentRoom().id
		return if roomUiId and info.id !== roomUiId
		roomSnapshot = info
		if player
			player.room = info
		roomConnection.dispatchEvent(new CustomEvent('state', {detail: info.state})) if info.state and roomConnection
		roomAudio.dispatchEvent(new CustomEvent('state', {detail: info.audio or {state: 'idle'}})) if roomAudio
		imba.commit()

	def mountRoomPanel
		const info = currentRoom()
		return unless info
		const ui = await scrobbleUi()
		throw new Error('Rooms are not available in this extension build.') unless ui.mod.mountRoom
		const host = self.querySelector('#panel-room-content')
		throw new Error('The room panel is not ready.') unless host
		const id = info.id
		roomSnapshot = info
		roomConnection = new EventTarget()
		roomConnection.getState = do roomSnapshot and roomSnapshot.state or null
		roomConnection.open = do
			const result = await send({type: 'room-get'})
			acceptRoom(result)
		roomConnection.refresh = roomConnection.open
		roomConnection.command = do(command)
			const result = await send({type: 'room-command', roomId: id, command})
			acceptRoom(result)
			result.state or result.room and result.room.state
		roomConnection.close = do(options = {})
			if options.leave
				const result = await send({type: 'room-leave', roomId: id})
				acceptRoom(result)
		roomConnection.setAudio = do(value) null
		roomAudio = new EventTarget()
		roomAudio.getState = do roomSnapshot and roomSnapshot.audio or {state: 'idle'}
		roomAudio.listen = do changeRoomAudio('listen', id)
		roomAudio.pause = do changeRoomAudio('pause', id)
		roomAudio.resume = do changeRoomAudio('resume', id)
		roomAudio.skip = do changeRoomAudio('skip', id)
		roomAudio.setVolume = do(value) changeRoomAudio('volume', id, value)
		roomAudio.unmount = do null
		roomAudio.stop = do null
		roomClient = {api: do(path, options = {})
			if options.body and options.body.action === 'invite'
				const result = await send({type: 'room-command', roomId: id, command: options.body})
				acceptRoom(result)
				return result.state or result.room and result.room.state
			const result = await send({type: 'room-api', roomId: id, path, body: options.body})
			result.result
		}
		roomView = ui.mod.mountRoom(host, {id, client: roomClient, connection: roomConnection, audio: roomAudio, ownsAudio: no, recordListens: no, hidePlaybackActions: yes, onLeave: roomLeft, lobbyHref: browser.runtime.getURL('rooms.html'), roomBase: browser.runtime.getURL('rooms.html?room=')})
		roomUiId = id
		self.views.room = roomView

	def changeRoomAudio action, id, value = null
		const result = await send({type: 'room-audio-command', roomId: id, action, value})
		acceptRoom(result)
		result.room

	def roomLeft
		panel = 'player'
		imba.commit()

	def lockPrivateControls
		const room = currentRoom()
		const blocked = !!(room and room.role !== 'dj')
		window.requestAnimationFrame(do
			for control of self.querySelectorAll('#station-list button.station')
				control.disabled = blocked
			for control of self.querySelectorAll('#quality')
				control.disabled = !!(room and (room.locked or room.role !== 'dj'))
			for control of self.querySelectorAll('#station-list button.delete')
				control.disabled = blocked or !!(room and room.locked)
			for control of self.querySelectorAll('#tired')
				control.disabled = !!room
		)

	# Pushes from the background.
	def onMessage msg, sender, sendResponse
		return no unless msg and typeof msg === 'object'
		if msg.type === 'player-state'
			const priorRoomId = currentRoom() and currentRoom().id or null
			apply(msg.state)
			imba.commit()
			if currentRoom()
				acceptRoom({room: currentRoom()})
				show('room') unless self.views and self.views.room and roomUiId === currentRoom().id
			elif priorRoomId and self.views and self.views.room
				self.views.room.unmount() if self.views.room.unmount
				delete self.views.room
		elif msg.type === 'room-clock'
			const activeRoom = currentRoom()
			const info = msg.room and typeof msg.room === 'object' ? msg.room : null
			const nextPlay = info and info.state and info.state.play
			const currentPlay = activeRoom and activeRoom.state and activeRoom.state.play
			if activeRoom and info and info.id === activeRoom.id and currentPlay and nextPlay and nextPlay.id === currentPlay.id
				if Number.isSafeInteger(nextPlay.position_ms) and nextPlay.position_ms >= 0 and Number.isSafeInteger(nextPlay.server_time) and nextPlay.server_time > (currentPlay.server_time or 0)
					roomSnapshot = Object.assign({}, activeRoom, {state: Object.assign({}, activeRoom.state, {play: Object.assign({}, currentPlay, {position_ms: nextPlay.position_ms, server_time: nextPlay.server_time})})})
					player.room = roomSnapshot
					roomConnection.dispatchEvent(new CustomEvent('clock', {detail: {play_id: nextPlay.id, position_ms: nextPlay.position_ms, server_time: nextPlay.server_time}})) if roomConnection
		elif msg.type === 'account'
			account = msg.account
			imba.commit()
		elif msg.type === 'update'
			update = msg.update
			imba.commit()
		no

	def reloadExtension
		try
			await send({type: 'update-reload'})
		catch e
			toast(String(e.message or e), 'error')

	def poll
		try
			account = (await send({type: 'account'})).account
			update = (await send({type: 'update'})).update
		catch e
			null
		imba.commit()

	def accountAction type
		accountBusy = yes
		accountError = ''
		imba.commit()
		try
			account = (await send({type})).account
		catch e
			accountError = String(e.message or e)
		accountBusy = no
		imba.commit()

	def toast text, k = ''
		message = text
		kind = k
		imba.commit()

	def reload
		try
			stations = (await send({type: 'stations'})).stations
			loggedIn = yes
		catch e
			if e.kind === 'auth'
				loggedIn = no
			else
				toast(String(e.message or e), 'error')
		imba.commit()

	def command msg
		try
			apply((await send(Object.assign({type: 'player'}, msg))).state)
			toast('')
		catch e
			if e.kind === 'auth'
				loggedIn = no
			toast(String(e.message or e), 'error')
		imba.commit()

	def select e
		const room = currentRoom()
		return toast('Room listeners cannot start private playback. Leave the room first.', 'error') if room and room.role !== 'dj'
		traits = null
		command({action: 'play', stationToken: e.detail.token})

	def control action
		return toast('Room reactions replace this playback action.', 'error') if currentRoom() and action === 'tired'
		return toast('Leave the room before stopping Pandora playback.', 'error') if currentRoom() and action === 'stop'
		switch action
			when 'toggle' then command({action: 'toggle'})
			when 'next', 'skip' then command({action: 'next'})
			when 'love' then command({action: 'love'})
			when 'ban' then command({action: 'ban'})
			when 'tired' then command({action: 'tired'})
			when 'stop' then command({action: 'stop'})
			else throw new Error("Unknown control {action}")

	def explain
		return unless player and player.track
		try
			traits = (await send({type: 'explain', trackToken: player.track.trackToken})).traits
		catch e
			toast(String(e.message or e), 'error')
		imba.commit()

	def setVolume v
		command({action: 'volume', value: Number(v)})

	def setQuality q
		const room = currentRoom()
		return toast('Room listeners cannot change private playback quality.', 'error') if room and room.role !== 'dj'
		return toast('Your room DJ broadcast is active. Leave the room before changing quality.', 'error') if room and room.locked
		command({action: 'quality', value: q})

	def remove e
		const st = e.detail
		return unless window.confirm("Delete the station \"{st.name}\" from your Pandora account?")
		try
			stations = (await send({type: 'delete-station', stationToken: st.token})).stations
			command({action: 'stop'}) if player and player.station and player.station.token === st.token
		catch err
			toast(String(err.message or err), 'error')
		imba.commit()

	def logout
		await send({type: 'logout'})
		loggedIn = no
		imba.commit()

	def openPopupLogin
		# The popup holds the login form; opening it as a tab works everywhere.
		window.open(browser.runtime.getURL('popup.html'), '_blank')

	def onKey e
		return if e.target and (e.target.tagName === 'INPUT' or e.target.tagName === 'SELECT' or e.target.tagName === 'TEXTAREA')
		switch e.key
			when ' '
				e.preventDefault()
				control('toggle')
			when 'n' then control('next')
			when '+' then control('love')
			when '-' then control('ban')
			when 't' then control('tired')
			when 'e' then explain()

	get user
		player and player.user or {}

	get now
		const activeRoom = currentRoom()
		if activeRoom and activeRoom.state and activeRoom.state.play and activeRoom.state.play.track_metadata
			const p = activeRoom.state.play
			const track = p.track_metadata
			const extra = track.additional_info or {}
			return {song: {title: track.track_name, artist: track.artist_name, album: track.release_name, coverArt: extra.art_url or '', duration: Number(extra.duration_ms or 0) / 1000, rating: p.reaction === 'like' ? 1 : (p.reaction === 'dislike' ? 2 : 0)}, station: {name: activeRoom.state.name or 'Room'}, paused: !['broadcasting', 'listening'].includes(activeRoom.audio and activeRoom.audio.state), position: Number(p.position_ms or 0) / 1000, duration: Number(extra.duration_ms or 0) / 1000}
		return null unless player and player.track
		{song: player.track, station: player.station, paused: player.status !== 'playing', position: player.position, duration: player.duration}

	get statusLine
		return '' unless player
		switch player.status
			when 'playing' then "Playing in the background; this tab is optional."
			when 'paused' then "Paused."
			when 'loading' then "Loading…"
			when 'error' then player.error
			else "Pick a station. The music plays in the background; this tab only shows it."

	def render
		const song = player and player.track
		<self.ext-root @keydown=onKey tabindex="-1">
			<Top label="player">
				if loggedIn
					<div.ext-account>
						<span#status> (user.username or "Signed in")
						<button#logout type="button" @click=logout> "Sign out"
				else
					<span#status.fine> "Not signed in"
			<main#app.app data-view=(loggedIn ? 'player' : 'login') data-status=(player and player.status or '')>
				<div.view>
					<UpdateBanner update=update @reload=reloadExtension>
					if !loggedIn and !currentRoom()
						<div.view.login>
							<div.card.login-card>
								<p.eyebrow> "melodica"
								<h2> "Not signed in"
								<p.intro> "Sign in from the toolbar popup, then pick a station."
								<button#open-login.primary type="button" @click=openPopupLogin> "Open sign-in"
					else
						<nav.ext-panels aria-label="melodica">
							<button#tab-player type="button" aria-pressed=(panel === 'player') @click=show('player')> "Player"
							if currentRoom()
								<button#tab-room type="button" aria-pressed=(panel === 'room') @click=show('room')> "Room"
							<button#tab-listens type="button" aria-pressed=(panel === 'listens') @click=show('listens')> "Listens"
							<button#tab-leaderboard type="button" aria-pressed=(panel === 'leaderboard') @click=show('leaderboard')> "Leaderboard"
							if crew
								<button#tab-map type="button" aria-pressed=(panel === 'map') @click=show('map')> "Map"
							<span.ext-panels-live.fine> (panel !== 'player' and liveState === 'open' ? 'live' : '')
							<a#tab-melodica.ext-panels-link href=MELODICA_PAGES.home target="_blank" rel="noopener"> "spacegho.st/melodica"
						if panel !== 'player' and panelError
							<p#panel-error.message.error role="status"> panelError
						<section#panel-listens.ext-panel.card hidden=(panel !== 'listens')>
						<section#panel-leaderboard.ext-panel.card hidden=(panel !== 'leaderboard')>
						<section#panel-map.ext-panel.card hidden=(panel !== 'map')>
						<section#panel-room.ext-panel.card hidden=(panel !== 'room')>
							if now and now.song
								<div.card.now>
									<p.eyebrow> "ROOM PLAYBACK"
									<p#room-now-title> "{now.song.title} · {now.song.artist}"
									<Transport now=now @control=control(e.detail)>
									<label.deck-item for="room-volume">
										<span.sr> "Room volume"
										<input#room-volume type="range" min="0" max="100" value=(player and Number.isFinite(player.volume) ? player.volume : 80) aria-label="Room volume" @change=setVolume(e.target.value)>
							if player and player.pendingStation
								<p.fine> "{player.pendingStation.name} queued for your next DJ track."
							<p.fine> (currentRoom() and currentRoom().locked ? 'Your DJ broadcast is active. Select a station for your next DJ track.' : (currentRoom() and currentRoom().role === 'dj' ? 'Your DJ turn is ready. Choose a Pandora station from the Player tab to start broadcasting.' : 'You are listening to the room. Leave before starting private playback.'))
							<div#panel-room-content>
						<div.ext-desk hidden=(panel !== 'player')>
							<aside.ext-side>
								<StationList stations=stations active=(player and player.station and player.station.token) @select=select @refresh=reload @delete=remove>
							<section.ext-main>
								if player and player.scrobbling and player.scrobbling.notice
									<ScrobbleNotice scrobbling=player.scrobbling>
								if player and player.scrobbling and player.scrobbling.failing
									<p#scrobble-fail.ext-scrobble-fail role="status"> player.scrobbling.failing
								<div#deploy-toast.ext-deploy-toast>
								if listenLink
									<ListenPrompt link=listenLink @done=(listenLink = null)>
								if user.prompt
									<UsernamePick user=user>
								<div.card.now>
									<NowPlaying now=now>
									<Transport now=now @control=control(e.detail)>
									<CopyListen song=(now and now.song)>
									<p#player-status.ext-state> statusLine
									<div.deck>
										<label.deck-item for="volume">
											<svg aria-hidden="true" viewBox="0 0 24 24">
												<path d="M11 5 6 9H2v6h4l5 4z">
												<path d="M15.5 8.5a5 5 0 0 1 0 7">
												<path d="M19 5.5a9 9 0 0 1 0 13">
											<span.sr> "Volume"
											<input#volume type="range" min="0" max="100" value=(player and Number.isFinite(player.volume) ? player.volume : 80) aria-label="Volume" @change=setVolume(e.target.value)>
										<label.deck-item for="quality">
											<span> "Quality"
											<select#quality value=(player and player.quality or 'high') aria-label="Audio quality" @change=setQuality(e.target.value)>
												<option value="high"> "high"
												<option value="medium"> "medium"
												<option value="low"> "low"
										<button#explain.round type="button" disabled=!song aria-label="Why is this song playing?" title="Why this song? (e)" @click=explain>
											<svg aria-hidden="true" viewBox="0 0 24 24">
												<circle cx="12" cy="12" r="9">
												<path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.8-2.7 2.5-2.7 4">
												<path d="M12 17.3h.01">
								<p.message#player-message .error=(kind === 'error') .info=(kind === 'info')> message
								if traits
									<blockquote#explain-panel.panel.pull>
										<p.pull-text> (traits.length ? "Because it features {traits.join(', ')}." : "Pandora gave no explanation.")
										<footer.pull-foot> "Pandora, on why this song is playing"
								if player and player.queue and player.queue.length
									<section.panel.next>
										<div.panel-head>
											<h3> "Up next"
											<span.fine.nowrap> "{player.queue.length} {player.queue.length === 1 ? 'song' : 'songs'}"
										<ol.up-next#up-next>
											for q in player.queue
												<li>
													<span.t> q.title
													<span.a> "{q.artist}{q.album ? ' · ' + q.album : ''}"
								if player and player.history and player.history.length
									<section.panel.recent>
										<div.panel-head>
											<h3> "Play log"
											<span.fine.nowrap> "this session"
										<ol.history#history>
											for h in player.history
												<li.hist .now=(song and h.trackToken === song.trackToken) data-rating=(h.rating or 0)>
													<img.hist-cover src=(h.coverArt or FALLBACK_COVER) alt="">
													<div.hist-meta>
														<span.hist-title> h.title
														<span.hist-artist> h.artist
														<span.hist-rating> (song and h.trackToken === song.trackToken ? 'now playing' : (h.rating === 1 ? 'loved' : (h.rating === 2 ? 'banned' : (h.rating === 3 ? 'tired' : ''))))
			<Foot version=version>
				<AccountLine account=account busy=accountBusy message=accountError @signin=accountAction('account-signin') @signout=accountAction('account-signout')>
				<span.fine> "Keys: space play/pause · n next · + love · - ban · t tired · e why"

imba.mount <Player>
