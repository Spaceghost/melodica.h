# The player page: an optional full-size view of the background's playback
# (bg.imba owns the state and the engine). Opening it starts nothing; closing
# it stops nothing. It renders `player-state` and sends `player` commands.

import { browser, send } from './shared.imba'
import { StationList, NowPlaying, Transport, Gate, UpdateBanner, gateAllowed, gateLine } from './ui.imba'

# While this page is open the background is asked for the gate this often; it
# re-checks with the auth server once its last check is an hour old.
const GATE_POLL = 15 * 60 * 1000

tag Player
	prop stations = []
	prop player = null
	prop message = ''
	prop kind = ''
	prop loggedIn = yes
	prop version = ''
	prop traits = null
	prop gate = null
	prop gateBusy = no
	prop gateError = ''
	prop update = null

	def mount
		self.listener = do(msg, sender, sendResponse) onMessage(msg, sender, sendResponse)
		browser.runtime.onMessage.addListener(self.listener)
		version = browser.runtime.getManifest().version
		try
			const r = await send({type: 'player-get'})
			apply(r.state)
			gate = r.gate or null
			update = r.update or null
			self.gateTimer = setInterval((do pollGate()), GATE_POLL)
			if stations.length === 0 and loggedIn and gateAllowed(gate)
				await reload()
		catch e
			if e.kind === 'auth'
				loggedIn = no
			elif e.kind === 'gate'
				await pollGate()
			else
				toast(String(e.message or e), 'error')
		imba.commit()

	def unmount
		browser.runtime.onMessage.removeListener(self.listener)
		clearInterval(self.gateTimer) if self.gateTimer

	def apply state
		return unless state
		player = state
		stations = state.stations if Array.isArray(state.stations) and (state.stations.length or stations.length === 0)
		loggedIn = !!state.loggedIn
		document.title = state.track ? "{state.track.title} – {state.track.artist} · melodica" : 'melodica'

	# Pushes from the background.
	def onMessage msg, sender, sendResponse
		return no unless msg and typeof msg === 'object'
		if msg.type === 'player-state'
			apply(msg.state)
			imba.commit()
		elif msg.type === 'gate'
			applyGate(msg.gate)
		elif msg.type === 'update'
			update = msg.update
			imba.commit()
		no

	def reloadExtension
		try
			await send({type: 'update-reload'})
		catch e
			toast(String(e.message or e), 'error')

	def pollGate
		try
			applyGate((await send({type: 'gate'})).gate)
			update = (await send({type: 'update'})).update
		catch e
			null

	def applyGate g
		gate = g
		imba.commit()

	def gateAction type
		gateBusy = yes
		gateError = ''
		imba.commit()
		try
			applyGate((await send({type})).gate)
		catch e
			gateError = String(e.message or e)
		gateBusy = no
		imba.commit()

	def githubSignin
		gateAction('github-signin')

	def gateCheck
		gateAction('gate-check')

	def githubSignout
		gateAction('github-signout')

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
			elif e.kind === 'gate'
				await pollGate()
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
			elif e.kind === 'gate'
				await pollGate()
			toast(String(e.message or e), 'error')
		imba.commit()

	def select e
		traits = null
		command({action: 'play', stationToken: e.detail.token})

	def control action
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

	get now
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

	css
		.layout
			display: grid
			grid-template-columns: 280px 1fr
			min-height: 100vh
		aside
			border-right: 1px solid var(--line)
			padding: 16px
			background: var(--panel)
			overflow: auto
		.main
			padding: 24px
			display: grid
			gap: 20px
			align-content: start
		header
			display: flex
			justify-content: space-between
			align-items: baseline
		h1
			margin: 0 0 12px
			font-size: 18px
			color: var(--gold-2)
		h1 small
			color: var(--muted)
			font-weight: 400
			margin-left: 6px
		.panel
			background: var(--panel)
			border: 1px solid var(--line)
			border-radius: 14px
			padding: 16px
		.controls
			display: flex
			gap: 16px
			align-items: center
			flex-wrap: wrap
		.volume
			display: flex
			gap: 8px
			align-items: center
			color: var(--muted)
			font-size: 12px
		.volume input
			width: 140px
		.quality
			display: flex
			gap: 6px
			align-items: center
			color: var(--muted)
			font-size: 12px
		.quality select
			width: auto
		.history
			list-style: none
			margin: 0
			padding: 0
			display: grid
			gap: 6px
		.history li
			display: grid
			grid-template-columns: 1fr auto
			gap: 8px
			color: var(--muted)
		.history .t
			color: var(--text)
		.traits
			color: var(--muted)
		.signin
			display: grid
			gap: 8px
			justify-items: start
		.account
			display: flex
			justify-content: space-between
			gap: 8px
			margin-bottom: 12px
			font-size: 12px
			color: var(--muted)
		.gate-status
			margin: 0 0 12px
			font-size: 12px
			color: var(--muted)
		.state
			color: var(--muted)
			font-size: 13px
			margin: 0

	def render
		const song = player and player.track
		<self @keydown=onKey tabindex="-1">
			<div#app.layout data-view=(gate and !gateAllowed(gate) ? 'gate' : (loggedIn ? 'player' : 'login')) data-status=(player and player.status or '')>
				<aside>
					<h1>
						"melodica"
						<small#version> version
					<div.account>
						<span#status> (loggedIn ? "Signed in" : "Not signed in")
						if loggedIn
							<button#logout type="button" @click=logout> "Sign out"
					<p#gate-status.gate-status> gateLine(gate)
					<UpdateBanner update=update @reload=reloadExtension>
					if gate and !gateAllowed(gate)
						<Gate gate=gate busy=gateBusy message=gateError @signin=githubSignin @check=gateCheck @signout=githubSignout>
					elif loggedIn
						<StationList stations=stations active=(player and player.station and player.station.token) @select=select @refresh=reload @delete=remove>
					else
						<div.signin>
							<p.message> "Sign in from the toolbar popup, then pick a station."
							<button#open-login type="button" @click=openPopupLogin> "Open sign-in"
				<section.main>
					<section.panel>
						<NowPlaying now=now>
						<p#player-status.state> statusLine
					<section.controls>
						<Transport now=now @control=control(e.detail)>
						<button#explain type="button" disabled=!song title="Why this song?" @click=explain> "Why?"
						<label.volume>
							"Volume"
							<input#volume type="range" min="0" max="100" value=(player and player.volume or 80) @change=setVolume(e.target.value)>
						<label.quality>
							"Quality"
							<select#quality value=(player and player.quality or 'high') @change=setQuality(e.target.value)>
								<option value="high"> "high"
								<option value="medium"> "medium"
								<option value="low"> "low"
					<p.message#player-message .error=(kind === 'error') .info=(kind === 'info')> message
					if traits
						<p.traits#explain-panel> (traits.length ? "Because it features {traits.join(', ')}." : "Pandora gave no explanation.")
					if player and player.history and player.history.length
						<section.panel>
							<h2> "Play log"
							<ol.history#history>
								for h in player.history
									<li>
										<span.t> "{h.title} – {h.artist}"
										<span> (song and h.trackToken === song.trackToken ? 'now playing' : (h.rating === 1 ? 'loved' : (h.rating === 2 ? 'banned' : (h.rating === 3 ? 'tired' : ''))))

imba.mount <Player>
