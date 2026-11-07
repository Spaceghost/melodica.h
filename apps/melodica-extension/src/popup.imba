# The toolbar popup: sign in, pick a station, see and steer what the player
# page is playing. Playback itself lives in player.html so it outlives the popup.

import { browser, send } from './shared.imba'
import { Login, StationList, NowPlaying, Transport, Gate, UpdateBanner, gateAllowed, gateLine } from "./ui.imba"

tag Popup
	prop view = 'loading'
	prop email = ''
	prop stations = []
	prop now = null
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
		if msg and msg.type === 'now-playing'
			now = msg.nowPlaying
			imba.commit()
		if msg and msg.type === 'gate'
			gate = msg.gate
			pickView()
			imba.commit()
		if msg and msg.type === 'update'
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
			now = s.nowPlaying
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
		now = null
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

	def select e
		const station = e.detail
		try
			await send({type: 'open-player', stationToken: station.token})
			toast("Playing {station.name} in the player tab.", 'info')
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
			await send({type: 'control', action: e.detail})
		catch err
			toast(String(err.message or err), 'error')

	def openPlayer
		await send({type: 'open-player'})

	def openOptions
		browser.runtime.openOptionsPage()

	def toast text, k = ''
		message = text
		kind = k

	css
		.wrap
			padding: 12px
			display: grid
			gap: 12px
		header
			display: flex
			align-items: baseline
			justify-content: space-between
			gap: 8px
		h1
			margin: 0
			font-size: 16px
			color: var(--gold-2)
			letter-spacing: 0.02em
		h1 small
			color: var(--muted)
			font-weight: 400
			margin-left: 6px
		nav
			display: flex
			gap: 6px
		nav button
			padding: 4px 8px
			font-size: 12px
		.account
			display: flex
			justify-content: space-between
			align-items: center
			gap: 8px
			color: var(--muted)
			font-size: 12px
		.gate-status
			color: var(--muted)
			font-size: 12px
			margin: 0
		.stations
			max-height: 260px
			overflow: auto
		.panel
			background: var(--panel)
			border: 1px solid var(--line)
			border-radius: 12px
			padding: 10px

	def render
		<self>
			<main#app.wrap data-view=view>
				<header>
					<h1>
						"melodica"
						<small#version> version
					<nav>
						<button#open-player type="button" title="Open the player tab" @click=openPlayer> "Player"
						<button#open-options type="button" title="Options" @click=openOptions> "Options"
				<UpdateBanner update=update @reload=reloadExtension>
				if view === 'loading'
					<p.message#status> "Loading…"
				elif view === 'error'
					<p.message.error#status> message
				elif view === 'gate'
					<Gate gate=gate busy=busy message=(kind === 'error' ? message : '') @signin=githubSignin @check=gateCheck @signout=githubSignout>
				elif view === 'login'
					<p#gate-status.gate-status> gateLine(gate)
					<Login busy=busy message=message kind=kind @login=login>
				else
					<div.account>
						<span#signed-in> email
						<span#gate-status.gate-status> gateLine(gate)
						<button#logout type="button" @click=logout> "Sign out"
					<section.panel>
						<NowPlaying now=now compact=yes>
						<Transport now=now @control=control>
					<section.stations>
						<StationList stations=stations active=(now and now.station and now.station.token) compact=yes @select=select @refresh=reload @delete=remove>
					<p.message#player-message .error=(kind === 'error') .info=(kind === 'info')> message

imba.mount <Popup>
