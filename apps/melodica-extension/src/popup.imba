# The toolbar popup: sign in, pick a station, see and steer what is playing.
# Playback itself runs in the background (bg.imba) and needs no tab; this
# page is a view of the background's player state and sends it commands.

import { browser, send } from './shared.imba'
import { Login, StationList, NowPlaying, Transport, AccountLine, UpdateBanner, Top, Foot, UsernamePick } from "./ui.imba"

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

	def mount
		self.notice = do(msg, sender, sendResponse) onNotice(msg, sender, sendResponse)
		browser.runtime.onMessage.addListener(self.notice)
		refresh()

	def unmount
		browser.runtime.onMessage.removeListener(self.notice)

	def onNotice msg
		return no unless msg and typeof msg === 'object'
		if msg.type === 'player-state'
			player = msg.state
			stations = msg.state.stations if Array.isArray(msg.state.stations) and msg.state.stations.length
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
			imba.commit()
		if msg.type === 'account'
			account = msg.account
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

	def pickView
		view = loggedIn ? 'player' : 'login'

	def refresh
		try
			const s = await send({type: 'state'})
			email = s.email
			stations = s.stations
			player = s.player
			version = s.version
			account = s.account
			update = s.update
			loggedIn = s.loggedIn
			pickView()
			accessMessage(s.access) unless s.loggedIn
			if s.loggedIn and stations.length === 0
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
		const station = e.detail
		try
			player = (await send({type: 'player', action: 'play', stationToken: station.token})).state
			toast("Playing {station.name}.", 'info')
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
		try
			player = (await send({type: 'player', action: e.detail})).state
		catch err
			toast(String(err.message or err), 'error')

	def openPlayer
		await send({type: 'open-player'})

	def openOptions
		browser.runtime.openOptionsPage()

	def toast text, k = ''
		message = text
		kind = k

	get user
		player and player.user or {}

	get now
		return null unless player and player.track
		{song: player.track, station: player.station, paused: player.status !== 'playing', position: player.position, duration: player.duration}

	get statusText
		return '' unless player
		switch player.status
			when 'playing' then "Playing in the background"
			when 'paused' then "Paused"
			when 'loading' then "Loading…"
			when 'error' then player.error
			else "Pick a station"

	def render
		<self.ext-root>
			<Top label="extension">
				<nav.ext-nav>
					<button#open-player.pill type="button" title="Open the full-size player tab (optional; the music plays without it)" @click=openPlayer> "Player"
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
					elif view === 'login'
						<Login busy=busy message=message kind=kind @login=login>
					else
						<div.ext-account>
							<span#signed-in> (user.username or "Signed in")
							<button#logout type="button" @click=logout> "Sign out"
						if user.prompt
							<UsernamePick user=user>
						<div.card.now.ext-compact>
							<NowPlaying now=now compact=yes>
							<Transport now=now @control=control>
							<p#player-status.ext-state> statusText
						<StationList stations=stations active=(player and player.station and player.station.token) compact=yes @select=select @refresh=reload @delete=remove>
						<p.message#player-message .error=(kind === 'error') .info=(kind === 'info')> message
			<Foot version=version>
				<AccountLine account=account busy=accountBusy message=accountError @signin=accountAction('account-signin') @signout=accountAction('account-signout')>

imba.mount <Popup>
