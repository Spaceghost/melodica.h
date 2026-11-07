# The player page: an extension tab that owns the <audio> element so playback
# survives the popup closing. Protocol calls go through the background.

import { browser, send, loadSettings } from './shared.imba'
import { StationList, NowPlaying, Transport, Gate, UpdateBanner, gateAllowed, gateLine } from './ui.imba'

const HISTORY_MAX = 20
# While the player tab is open the background is asked for the gate this often; it
# re-checks with the auth server once its last check is an hour old.
const GATE_POLL = 15 * 60 * 1000

tag Player
	prop stations = []
	prop station = null
	prop queue = []
	prop song = null
	prop paused = yes
	prop position = 0
	prop duration = 0
	prop history = []
	prop message = ''
	prop kind = ''
	prop quality = 'high'
	prop volume = 80
	prop loggedIn = yes
	prop version = ''
	prop traits = null
	prop fetching = no
	prop generation = 0
	prop gate = null
	prop gateBusy = no
	prop gateError = ''
	prop update = null

	get audio
		document.getElementById('audio')

	def mount
		self.listener = do(msg, sender, sendResponse) onMessage(msg, sender, sendResponse)
		browser.runtime.onMessage.addListener(self.listener)
		const s = await loadSettings()
		quality = s.quality
		volume = Number(s.volume) or 80
		applyVolume()
		try
			const hello = await send({type: 'player-hello'})
			stations = hello.stations or []
			gate = hello.gate or null
			update = hello.update or null
			version = hello.settings and hello.settings.version or browser.runtime.getManifest().version
			self.gateTimer = setInterval((do pollGate()), GATE_POLL)
			if hello.pendingPlay
				const st = stations.find(do(x) x.token === hello.pendingPlay)
				play(st or {token: hello.pendingPlay, name: ''})
			if stations.length === 0
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

	# The gate as the background knows it (re-checked hourly); a closed gate stops
	# playback and shows the gate screen in the sidebar.
	def pollGate
		try
			applyGate((await send({type: 'gate'})).gate)
			update = (await send({type: 'update'})).update
		catch e
			null

	def applyGate g
		gate = g
		if gate and !gateAllowed(gate) and (song or station)
			stop(gate.mode === 'denied' ? "Stopped: melodica is not available for your GitHub account ({gate.login})." : 'Stopped: sign in with GitHub to keep listening.')
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

	# Messages from the background (relayed popup commands).
	def onMessage msg, sender, sendResponse
		return no unless msg and typeof msg === 'object'
		if msg.type === 'play'
			const st = stations.find(do(x) x.token === msg.stationToken) or {token: msg.stationToken, name: ''}
			play(st)
			sendResponse({ok: yes})
			return no
		if msg.type === 'control'
			const done = do sendResponse({ok: yes})
			const failed = do(e) sendResponse({ok: no, error: String(e.message or e)})
			control(msg.action).then(done, failed)
			return yes
		if msg.type === 'gate'
			applyGate(msg.gate)
			return no
		if msg.type === 'update'
			update = msg.update
			imba.commit()
			return no
		no

	def reloadExtension
		try
			await send({type: 'update-reload'})
		catch e
			toast(String(e.message or e), 'error')

	def toast text, k = ''
		message = text
		kind = k
		imba.commit()

	def report
		const nowPlaying = song ? {song, station, paused, position, duration} : null
		send({type: 'now-playing', nowPlaying}).catch(do(e) null)

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

	def select e
		play(e.detail)

	def play st
		station = st
		queue = []
		generation += 1
		toast("Loading {st.name or 'station'}…", 'info')
		await next()

	def next
		return unless station
		const gen = generation
		try
			if queue.length === 0
				fetching = yes
				const r = await send({type: 'playlist', stationToken: station.token, quality})
				fetching = no
				return if gen !== generation
				queue = r.songs
				if queue.length === 0
					toast('Pandora returned no playable songs for this station.', 'error')
					return
			return if gen !== generation
			startSong(queue.shift())
		catch e
			fetching = no
			if e.kind === 'gate'
				toast(String(e.message or e), 'error')
				await pollGate()
			elif e.kind === 'auth' or e.code === 1002
				loggedIn = no
				toast(String(e.message or e), 'error')
			else
				toast(String(e.message or e), 'error')
		imba.commit()

	def startSong s
		song = s
		position = 0
		duration = s.duration or 0
		traits = null
		toast('')
		history.unshift(s)
		history = history.slice(0, HISTORY_MAX)
		document.title = "{s.title} – {s.artist} · melodica"
		applyVolume()
		audio.src = s.audioUrl
		const p = audio.play()
		if p and p.catch
			p.catch do(err)
				if err and err.name === 'NotAllowedError'
					toast('Press play to start (the browser blocks autoplay).', 'info')
					paused = yes
					report()
		updateMediaSession()

	def applyVolume
		const gain = song ? Math.pow(10, (song.gain or 0) / 20) : 1
		audio.volume = Math.max(0, Math.min(1, (volume / 100) * Math.min(1, gain)))

	def setVolume v
		volume = Math.max(0, Math.min(100, Number(v) or 0))
		applyVolume()
		browser.storage.local.set({volume})

	def toggle
		return (station ? next() : null) unless song
		audio.paused ? audio.play() : audio.pause()

	def skip reason = ''
		toast(reason) if reason
		audio.pause()
		next()

	def stop reason = ''
		audio.pause()
		audio.removeAttribute('src')
		audio.load()
		song = null
		queue = []
		station = null
		generation += 1
		document.title = 'melodica'
		toast(reason)
		report()

	def control action
		switch action
			when 'toggle' then toggle()
			when 'skip' then skip()
			when 'love' then await rate(song, yes)
			when 'ban' then await rate(song, no)
			when 'tired' then await tired()
			when 'stop' then stop('Signed out.')
			else throw new Error("Unknown control {action}")

	def rate target, positive
		return unless target
		try
			await send({type: 'rate', trackToken: target.trackToken, positive})
			target.rating = positive ? 1 : 2
			if target === song
				if positive then toast('Loved.') else skip('Banned. Skipping.')
			else
				toast(positive ? "Loved {target.title}." : "Banned {target.title}.")
			report()
		catch e
			toast(String(e.message or e), 'error')
		imba.commit()

	def tired
		return unless song
		try
			await send({type: 'tired', trackToken: song.trackToken})
			song.rating = 3
			skip('Tired of it. Skipping.')
		catch e
			toast(String(e.message or e), 'error')

	def explain
		return unless song
		try
			traits = (await send({type: 'explain', trackToken: song.trackToken})).traits
		catch e
			toast(String(e.message or e), 'error')
		imba.commit()

	def setQuality q
		quality = q
		browser.storage.local.set({quality: q})
		queue = []

	def remove e
		const st = e.detail
		return unless window.confirm("Delete the station \"{st.name}\" from your Pandora account?")
		try
			stations = (await send({type: 'delete-station', stationToken: st.token})).stations
			stop('Station deleted.') if station and station.token === st.token
		catch err
			toast(String(err.message or err), 'error')
		imba.commit()

	def logout
		await send({type: 'logout'})
		stop('Signed out.')
		loggedIn = no
		imba.commit()

	def openPopupLogin
		# The popup holds the login form; opening it as a tab works everywhere.
		window.open(browser.runtime.getURL('popup.html'), '_blank')

	def updateMediaSession
		return unless 'mediaSession' in navigator and song
		try
			navigator.mediaSession.metadata = new MediaMetadata({title: song.title, artist: song.artist, album: song.album, artwork: song.coverArt ? [{src: song.coverArt}] : []})
			navigator.mediaSession.setActionHandler('play', do toggle())
			navigator.mediaSession.setActionHandler('pause', do toggle())
			navigator.mediaSession.setActionHandler('nexttrack', do skip())
		catch e
			null

	def onPlay
		paused = no
		report()
		imba.commit()

	def onPause
		paused = yes
		report()
		imba.commit()

	def onTime
		position = audio.currentTime
		duration = audio.duration if Number.isFinite(audio.duration) and audio.duration > 0
		imba.commit()

	def onEnded
		next()

	def onError
		toast("Could not play {song and song.title or 'this song'}; skipping.", 'error')
		next()

	def onKey e
		return if e.target and (e.target.tagName === 'INPUT' or e.target.tagName === 'SELECT' or e.target.tagName === 'TEXTAREA')
		switch e.key
			when ' '
				e.preventDefault()
				toggle()
			when 'n' then skip()
			when '+' then rate(song, yes)
			when '-' then rate(song, no)
			when 't' then tired()
			when 'e' then explain()

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

	def render
		<self @keydown=onKey tabindex="-1">
			<div#app.layout data-view=(gate and !gateAllowed(gate) ? 'gate' : (loggedIn ? 'player' : 'login'))>
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
						<StationList stations=stations active=(station and station.token) @select=select @refresh=reload @delete=remove>
					else
						<div.signin>
							<p.message> "Sign in from the toolbar popup, then pick a station."
							<button#open-login type="button" @click=openPopupLogin> "Open sign-in"
				<section.main>
					<section.panel>
						<NowPlaying now=(song ? {song, station, paused, position, duration} : null)>
					<section.controls>
						<Transport now=(song ? {song, station, paused} : null) @control=control(e.detail)>
						<button#explain type="button" disabled=!song title="Why this song?" @click=explain> "Why?"
						<label.volume>
							"Volume"
							<input#volume type="range" min="0" max="100" value=volume @input=setVolume(e.target.value)>
						<label.quality>
							"Quality"
							<select#quality value=quality @change=setQuality(e.target.value)>
								<option value="high"> "high"
								<option value="medium"> "medium"
								<option value="low"> "low"
					<p.message#player-message .error=(kind === 'error') .info=(kind === 'info')> message
					if traits
						<p.traits#explain-panel> (traits.length ? "Because it features {traits.join(', ')}." : "Pandora gave no explanation.")
					if history.length
						<section.panel>
							<h2> "Play log"
							<ol.history#history>
								for h in history
									<li>
										<span.t> "{h.title} – {h.artist}"
										<span> (h === song ? 'now playing' : (h.rating === 1 ? 'loved' : (h.rating === 2 ? 'banned' : (h.rating === 3 ? 'tired' : ''))))
				<audio#audio preload="auto" @play=onPlay @pause=onPause @timeupdate=onTime @ended=onEnded @error=onError>

imba.mount <Player>
