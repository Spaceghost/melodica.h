# The toolbar popup: sign in, pick a station, see and steer what is playing.
# Playback itself runs in the background (bg.imba) and needs no tab; this
# page is a view of the background's player state and sends it commands.

import { browser, send } from './shared.imba'
import { roomTimeline, roomNowPlaying } from './room-playback-view.js'
import { Login, StationList, NowPlaying, Transport, AccountLine, UpdateBanner, Top, Foot, UsernamePick, ScrobbleNotice, RecentListens, CopyListen } from "./ui.imba"

tag Popup
	prop view = 'loading'
	prop email = ''
	prop stations = []
	prop player = null
	prop message = ''
	prop kind = ''
	prop busy = no
	prop version = ''
	prop account = null
	prop accountBusy = no
	prop accountError = ''
	prop loggedIn = no
	prop update = null
	prop recent = null
	prop recentRooms = []
	prop foundRooms = []
	prop roomQuery = ''
	prop roomSearchBusy = no
	prop roomSearchError = ''
	prop roomSearchGeneration = 0
	prop roomCursor = null
	prop roomSearchQuery = ''
	prop roomBusy = ''
	prop roomClock = null

	def mount
		self.notice = do(msg, sender, sendResponse) onNotice(msg, sender, sendResponse)
		browser.runtime.onMessage.addListener(self.notice)
		refresh()
		self.progressTimer = setInterval((do imba.commit() if player and player.room and player.room.id), 500)

	def unmount
		clearInterval(self.progressTimer) if self.progressTimer
		browser.runtime.onMessage.removeListener(self.notice)

	def onNotice msg
		return no unless msg and typeof msg === 'object'
		if msg.type === 'player-state'
			const priorRoom = player and player.room and player.room.id or null
			player = msg.state
			roomClock = roomTimeline(roomClock, player and player.room)
			stations = msg.state.stations if Array.isArray(msg.state.stations) and msg.state.stations.length
			loadRooms() if account and account.signedIn and player.room and player.room.id and priorRoom !== player.room.id
			if msg.state.loggedIn === no and loggedIn
				loggedIn = no
				pickView()
				accessMessage(msg.state.access)
			elif msg.state.loggedIn === yes and !loggedIn
				# Signed in elsewhere (the web app handed over its session).
				loggedIn = yes
				message = ''
				kind = ''
				pickView()
				loadRooms()
			imba.commit()
		if msg.type === 'room-clock'
			const room = player and player.room
			const clock = msg.room and msg.room.state and msg.room.state.play
			const current = room and room.state and room.state.play
			if room and msg.room and room.id === msg.room.id and current and clock and current.id === clock.id
				if Number.isSafeInteger(clock.position_ms) and clock.position_ms >= 0 and Number.isSafeInteger(clock.server_time) and clock.server_time > (current.server_time or 0)
					room.state.play = Object.assign({}, current, {position_ms: clock.position_ms, server_time: clock.server_time})
					roomClock = roomTimeline(roomClock, room)
					imba.commit()
		if msg.type === 'scrobble-recent'
			recent = msg.recent
			imba.commit()
		if msg.type === 'account'
			const wasSignedIn = account and account.signedIn
			account = msg.account
			if account and account.signedIn
				loadRooms() unless wasSignedIn
			else
				roomSearchGeneration++
				recentRooms = []
				foundRooms = []
			imba.commit()
		if msg.type === 'update'
			update = msg.update
			imba.commit()
		no

	def reloadExtension
		try
			await send({type: 'update-reload'})
		catch e
			toast(String(e.message or e), 'error')

	# Signed out because melodica access was withdrawn: the login card says so.
	def accessMessage a
		if a and !a.allowed and a.message
			message = a.message
			kind = 'error'

	def loadRecent
		try
			recent = (await send({type: 'scrobble-recent', force: yes})).recent
			imba.commit()
		catch e
			null

	def loadRooms more = no
		return if more and (roomSearchBusy or !roomCursor)
		const query = roomQuery.trim()
		return loadRooms() if more and query !== roomSearchQuery
		const generation = ++roomSearchGeneration
		roomSearchBusy = yes
		roomSearchError = ''
		try
			const ids = (await send({type: 'room-recent'})).recentRoomIds or []
			const result = await send({type: 'room-search', query, cursor: more ? roomCursor : null, recentIds: ids})
			return unless generation === roomSearchGeneration
			recentRooms = result.recent or [] unless more
			const next = result.rooms or []
			foundRooms = more ? Array.from(new Map(foundRooms.concat(next).map(do(r) [r.id, r])).values()) : next
			roomCursor = result.next_cursor or null
			roomSearchQuery = query
			imba.commit()
		catch e
			return unless generation === roomSearchGeneration
			roomSearchError = String(e.message or e)
		finally
			if generation === roomSearchGeneration
				roomSearchBusy = no
				imba.commit()

	def pickView
		view = loggedIn ? 'player' : 'login'

	def refresh
		try
			const s = await send({type: 'state'})
			email = s.email
			stations = s.stations
			player = s.player
			roomClock = roomTimeline(roomClock, player and player.room)
			version = s.version
			account = s.account
			update = s.update
			loggedIn = s.loggedIn
			pickView()
			loadRecent() if loggedIn
			loadRooms() if account and account.signedIn
			accessMessage(s.access) unless s.loggedIn
			if s.loggedIn and stations.length === 0 and (!player.room or !player.room.id or player.room.role === 'dj')
				stations = (await send({type: 'stations'})).stations
		catch e
			view = 'error'
			message = String(e.message or e)
			kind = 'error'
		imba.commit()

	def login e
		const mail = e.detail.email
		const password = e.detail.password
		const remember = e.detail.remember
		busy = yes
		message = 'Signing in…'
		kind = 'info'
		try
			const r = await send({type: 'login', email: mail, password, remember})
			email = r.email
			stations = r.stations
			message = ''
			kind = ''
			loggedIn = yes
			view = 'player'
			loadRooms()
		catch err
			message = String(err.message or err)
			kind = 'error'
		busy = no
		console.debug("melodica popup login -> view={view} message={message}")
		imba.commit()

	def logout
		await send({type: 'logout'})
		player = null
		stations = []
		loggedIn = no
		pickView()

	# The optional spacegho.st sign-in; the background runs the identity flow itself
	# (the popup may close while the window is open; the result arrives as a notice).
	def accountAction type
		accountBusy = yes
		accountError = ''
		imba.commit()
		try
			account = (await send({type})).account
		catch err
			accountError = String(err.message or err)
		accountBusy = no
		imba.commit()

	def reload
		try
			stations = (await send({type: 'stations'})).stations
		catch e
			toast(String(e.message or e), 'error')

	# A station starts playing in the background; no tab opens.
	def select e
		const room = player and player.room
		return toast('Room listeners cannot start private playback. Leave the room first.', 'error') if room and room.id and room.role !== 'dj'
		const station = e.detail
		try
			player = (await send({type: 'player', action: 'play', stationToken: station.token})).state
			toast(room and room.locked ? "{station.name} queued for your next DJ track." : "Playing {station.name}.", 'info')
		catch err
			toast(String(err.message or err), 'error')

	def remove e
		const station = e.detail
		return unless window.confirm("Delete the station \"{station.name}\" from your Pandora account?")
		try
			stations = (await send({type: 'delete-station', stationToken: station.token})).stations
		catch err
			toast(String(err.message or err), 'error')

	def control e
		return toast('Use the room reactions while a room is active.', 'error') if player and player.room and player.room.id and e.detail === 'tired'
		try
			player = (await send({type: 'player', action: e.detail})).state
		catch err
			toast(String(err.message or err), 'error')

	def openPlayer
		await send({type: 'open-player'})

	def openRooms
		await send({type: 'open-rooms'})

	def openRoom id
		await send({type: 'open-rooms', roomId: id})

	def searchRooms e
		e.preventDefault()
		loadRooms()

	def joinRoom id
		return if roomBusy
		return toast('Stop DJing or leave your current room before joining another.', 'error') if player and player.room and player.room.locked
		roomBusy = id
		message = ''
		try
			await send({type: 'room-join', roomId: id})
			player = (await send({type: 'player-get'})).state
			loadRooms()
		catch e
			toast(String(e.message or e), 'error')
		finally
			roomBusy = ''

	def leaveRoom
		return if roomBusy
		roomBusy = 'leave'
		message = ''
		try
			await send({type: 'room-leave', roomId: player.room.id})
			player = (await send({type: 'player-get'})).state
		catch e
			toast(String(e.message or e), 'error')
		finally
			roomBusy = ''

	def djCommand action
		return if roomBusy
		roomBusy = 'dj'
		message = ''
		try
			await send({type: 'room-command', roomId: player.room.id, command: {action}})
			player = (await send({type: 'player-get'})).state
		catch e
			toast(String(e.message or e), 'error')
		finally
			roomBusy = ''

	def roomAudio action, value = null
		try
			player = (await send({type: 'room-audio-command', roomId: player.room.id, action, value})).state
		catch e
			toast(String(e.message or e), 'error')

	def openOptions
		browser.runtime.openOptionsPage()

	def toast text, k = ''
		message = text
		kind = k

	get user
		player and player.user or {}

	get now
		const room = player and player.room
		return roomNowPlaying(room, roomClock) if room and room.id
		return null unless player and player.track
		{song: player.track, station: player.station, paused: player.status !== 'playing', position: player.position, duration: player.duration}

	get statusText
		return '' unless player
		return roomStatus if player.room and player.room.id
		switch player.status
			when 'playing' then "Playing in the background"
			when 'paused' then "Paused"
			when 'loading' then "Loading…"
			when 'error' then player.error
			else "Pick a station"

	get roomStatus
		return "{player.pendingStation.name} queued for your next DJ track." if player and player.pendingStation
		const room = player and player.room
		return '' unless room and room.id
		return 'This room is closed.' if room.state and room.state.closed_at
		return room.role === 'dj' ? 'Choose a station to start your DJ turn.' : 'Waiting for the next DJ.' unless room.state and room.state.play
		return 'Room playback is paused.' if room.audio and room.audio.paused
		const labels = {broadcasting: 'Your DJ broadcast is active.', listening: 'Listening together.', connecting: 'Connecting room audio…', blocked: 'Tap Play to hear the room.', error: 'Room audio needs to reconnect.', unavailable: 'Room audio is unavailable on this device.'}
		labels[room.audio and room.audio.state] or 'Connecting room audio…'

	def render
		const activeRoom = player and player.room and player.room.id ? player.room : null
		const roomState = activeRoom and activeRoom.state
		const listedDj = !!(roomState and (roomState.djs or []).includes(roomState.you))
		const inDjLine = !!(roomState and ((roomState.waiting or []).includes(roomState.you) or (roomState.requests or []).some(do(r) r.account === roomState.you)))
		<self.ext-root>
			<Top label="extension">
				<nav.ext-nav>
					<button#open-player.pill type="button" title="Open the full-size player tab (optional; the music plays without it)" @click=openPlayer> "Player"
					<button#open-rooms.pill type="button" title="Open the shared listening rooms" @click=openRooms> "Rooms"
					<button#open-options.pill type="button" title="Options" @click=openOptions> "Options"
			<main#app.app data-view=view data-status=(player and player.status or '')>
				<div.view>
					<UpdateBanner update=update @reload=reloadExtension>
					if view === 'loading'
						<p.message#status> "Loading…"
					elif view === 'error'
						<div.card>
							<h2> "melodica could not start"
							<p.message.error#status role="alert"> message
					elif view === 'login' and !activeRoom
						<Login busy=busy message=message kind=kind @login=login @github=accountAction('account-signin')>
					else
						if loggedIn
							<div.ext-account>
								<span#signed-in> (user.username or "Signed in")
								<button#logout type="button" @click=logout> "Sign out"
							if player and player.scrobbling and player.scrobbling.notice
								<ScrobbleNotice scrobbling=player.scrobbling>
							if player and player.scrobbling and player.scrobbling.failing
								<p#scrobble-fail.ext-scrobble-fail role="status"> player.scrobbling.failing
							if player and player.scrobbling and player.scrobbling.deployed
								<p#scrobble-deployed.ext-scrobble-deployed role="status"> player.scrobbling.deployed
							if user.prompt
								<UsernamePick user=user>
						<div#popup-player.card.now.ext-compact>
							<NowPlaying now=now compact=yes idleTitle=(activeRoom and activeRoom.role !== 'dj' ? 'Waiting for the DJ' : 'Pick a station')>
							<Transport now=now allowTired=!activeRoom @control=control>
							<CopyListen song=(now and now.song)>
							<p#player-status.ext-state> statusText
							if activeRoom
								<label for="popup-room-volume"> "Room volume"
								<input#popup-room-volume type="range" min=0 max=100 value=(player and Number.isFinite(player.volume) ? player.volume : 80) aria-label="Room volume" @change=roomAudio('volume', Number(e.target.value))>
					if loggedIn and (!activeRoom or activeRoom.role === 'dj')
						<StationList stations=stations active=(player and player.station and player.station.token) compact=yes blocked=(!!activeRoom and activeRoom.role !== 'dj') deleteBlocked=(!!activeRoom and activeRoom.locked) @select=select @refresh=reload @delete=remove>
					if account and account.signedIn
						if player and player.room and player.room.id
							<section#current-room.card>
								<p.eyebrow> "CURRENT ROOM"
								<h3> (player.room.state and player.room.state.name or 'Shared room')
								<p.fine> roomStatus
								<button#current-room-open.quiet type="button" @click=openRoom(player.room.id)> "View room"
								if inDjLine or listedDj
									<button#current-room-stop-dj.quiet type="button" disabled=!!roomBusy @click=djCommand('leave-dj')> (roomBusy === 'dj' ? 'Updating…' : listedDj ? 'Stop DJing' : 'Cancel DJ request')
								elif player.room.state and (player.room.state.mode === 'rotation' or player.room.state.host === player.room.state.you)
									<button#current-room-request-dj.quiet type="button" disabled=!!roomBusy @click=djCommand('request-dj')> (player.room.state.host === player.room.state.you ? 'Start DJing' : 'Request to DJ')
								if player.room.audio and ['blocked', 'error', 'unavailable'].includes(player.room.audio.state)
									<button#current-room-retry.quiet type="button" @click=roomAudio('resume')> "Retry room audio"
								<button#current-room-leave.quiet type="button" disabled=!!roomBusy @click=leaveRoom> "Leave room"
						<section#room-discovery.card aria-busy=String(roomSearchBusy)>
							<h3> "Rooms"
							<form @submit=searchRooms>
								<label for="room-search"> "Find a room"
								<input#room-search type="search" bind=roomQuery maxlength=80 placeholder="Search rooms">
								<button.quiet type="submit" disabled=roomSearchBusy> (roomSearchBusy ? 'Searching…' : 'Search')
							if recentRooms.some(do(r) !activeRoom or r.id !== activeRoom.id)
								<h4> "Recently joined"
								for r in recentRooms
									if !player or !player.room or r.id !== player.room.id
										<button.room-recent-open.quiet type="button" disabled=(!!roomBusy or !!(player and player.room and player.room.locked)) @click=joinRoom(r.id)> "{r.name} · {r.listeners} listeners · {roomBusy === r.id ? 'Joining…' : 'Join'}"
							for r in foundRooms
								if !player or !player.room or r.id !== player.room.id
									<button.room-search-join.quiet type="button" disabled=(!!roomBusy or !!(player and player.room and player.room.locked)) @click=joinRoom(r.id)> "{r.name} · {r.listeners} listeners · {roomBusy === r.id ? 'Joining…' : 'Join'}"
							if player and player.room and player.room.locked
								<p.fine> "Your DJ broadcast has priority. Stop DJing or leave the room to switch rooms."
							if roomCursor
								<button#room-search-more.quiet type="button" disabled=roomSearchBusy @click=loadRooms(yes)> "More rooms"
							if !roomSearchBusy and !recentRooms.length and !foundRooms.length and !roomSearchError
								<p.fine> "No rooms found. Open Rooms to create one."
							<p.message.error role="status"> roomSearchError
					if loggedIn
						if recent
							<RecentListens recent=recent max=5>
					<p.message#player-message .error=(kind === 'error') .info=(kind === 'info') role="status"> message
			<Foot version=version>
				<AccountLine account=account busy=accountBusy message=accountError @signin=accountAction('account-signin') @signout=accountAction('account-signout')>

imba.mount <Popup>
