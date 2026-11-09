# The player page: an optional full-size view of the background's playback
# (bg.imba owns the state and the engine). Opening it starts nothing; closing
# it stops nothing. It renders `player-state` and sends `player` commands.

import { browser, send, FALLBACK_COVER } from './shared.imba'
import { StationList, NowPlaying, Transport, AccountLine, UpdateBanner, Top, Foot, UsernamePick, ScrobbleNotice } from './ui.imba'

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

	def mount
		self.listener = do(msg, sender, sendResponse) onMessage(msg, sender, sendResponse)
		browser.runtime.onMessage.addListener(self.listener)
		version = browser.runtime.getManifest().version
		try
			const r = await send({type: 'player-get'})
			apply(r.state)
			account = r.account or null
			update = r.update or null
			self.pollTimer = setInterval((do poll()), ACCOUNT_POLL)
			if stations.length === 0 and loggedIn
				await reload()
		catch e
			if e.kind === 'auth'
				loggedIn = no
			else
				toast(String(e.message or e), 'error')
		imba.commit()

	def unmount
		browser.runtime.onMessage.removeListener(self.listener)
		clearInterval(self.pollTimer) if self.pollTimer

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

	get user
		player and player.user or {}

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
					if !loggedIn
						<div.view.login>
							<div.card.login-card>
								<p.eyebrow> "melodica"
								<h2> "Not signed in"
								<p.intro> "Sign in from the toolbar popup, then pick a station."
								<button#open-login.primary type="button" @click=openPopupLogin> "Open sign-in"
					else
						<div.ext-desk>
							<aside.ext-side>
								<StationList stations=stations active=(player and player.station and player.station.token) @select=select @refresh=reload @delete=remove>
							<section.ext-main>
								if player and player.scrobbling and player.scrobbling.notice
									<ScrobbleNotice scrobbling=player.scrobbling>
								if user.prompt
									<UsernamePick user=user>
								<div.card.now>
									<NowPlaying now=now>
									<Transport now=now @control=control(e.detail)>
									<p#player-status.ext-state> statusLine
									<div.deck>
										<label.deck-item for="volume">
											<svg aria-hidden="true" viewBox="0 0 24 24">
												<path d="M11 5 6 9H2v6h4l5 4z">
												<path d="M15.5 8.5a5 5 0 0 1 0 7">
												<path d="M19 5.5a9 9 0 0 1 0 13">
											<span.sr> "Volume"
											<input#volume type="range" min="0" max="100" value=(player and player.volume or 80) aria-label="Volume" @change=setVolume(e.target.value)>
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
