# The toolbar popup: sign in, pick a station, see and steer what is playing.
# Playback itself runs in the background (bg.imba) and needs no tab; this
# page is a view of the background's player state and sends it commands.

import { browser, send } from './shared.imba'
import { Login, StationList, NowPlaying, Transport, Gate, UpdateBanner, Top, Foot, gateAllowed, gateLine } from "./ui.imba"

tag Popup
	prop view = 'loading'
	prop email = ''
	prop stations = []
	prop player = null
	prop message = ''
	prop kind = ''
	prop busy = no
	prop version = ''
	prop gate = null
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
			imba.commit()
		if msg.type === 'gate'
			gate = msg.gate
			pickView()
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

	# The gate screen whenever the gate is closed; the Pandora login or the player
	# otherwise.
	def pickView
		view = !gateAllowed(gate) ? 'gate' : (loggedIn ? 'player' : 'login')

	def refresh
		try
			const s = await send({type: 'state'})
			email = s.email
			stations = s.stations
			player = s.player
			version = s.version
			gate = s.gate
			update = s.update
			loggedIn = s.loggedIn
			pickView()
			if s.loggedIn and gateAllowed(gate) and stations.length === 0
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
			await gateRefresh() if err.kind === 'gate'
		busy = no
		console.debug("melodica popup login -> view={view} message={message}")
		imba.commit()

	def logout
		await send({type: 'logout'})
		player = null
		stations = []
		loggedIn = no
		pickView()

	def gateRefresh
		try
			gate = (await send({type: 'gate'})).gate
		catch e
			null
		pickView()

	# The three gate actions; the background runs the identity flow itself.
	def gateAction type
		busy = yes
		message = ''
		kind = ''
		imba.commit()
		try
			gate = (await send({type})).gate
		catch err
			message = String(err.message or err)
			kind = 'error'
		busy = no
		pickView()
		imba.commit()

	def githubSignin
		gateAction('github-signin')

	def gateCheck
		gateAction('gate-check')

	def githubSignout
		gateAction('github-signout')

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
					elif view === 'gate'
						<Gate gate=gate busy=busy message=(kind === 'error' ? message : '') @signin=githubSignin @check=gateCheck @signout=githubSignout>
					elif view === 'login'
						<Login busy=busy message=message kind=kind @login=login>
					else
						<div.ext-account>
							<span#signed-in> email
							<button#logout type="button" @click=logout> "Sign out"
						<div.card.now.ext-compact>
							<NowPlaying now=now compact=yes>
							<Transport now=now @control=control>
							<p#player-status.ext-state> statusText
						<StationList stations=stations active=(player and player.station and player.station.token) compact=yes @select=select @refresh=reload @delete=remove>
						<p.message#player-message .error=(kind === 'error') .info=(kind === 'info')> message
			<Foot version=version>
				<span#gate-status.ext-gate-status> gateLine(gate)

imba.mount <Popup>
