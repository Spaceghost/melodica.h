# The playback engine: owns the <audio> element and the play loop (station,
# playlist fetch, track advance, volume, ratings, tired, the play log). It
# runs where the browser lets an extension keep audio alive without a visible
# tab: an offscreen document in Chromium (src/offscreen.imba), the background
# page itself in Firefox (bg.imba). It never talks to Pandora directly: the
# host hands it an `api` with playlist/rate/tired, and it reports every state
# change through `report`, so the background stays the single source of truth
# and every page (popup, player tab, options, the web player over the bridge)
# is a view of that state.
#
# State: {status: 'idle'|'loading'|'playing'|'paused'|'stopped'|'error',
#         station: {token, name}|null, track: song|null, position, duration,
#         volume (0-100), quality, queueLength, error, history: [song…],
#         changedAt}

const HISTORY_MAX = 20
const REPORT_EVERY = 1000

export class Engine
	def constructor host
		self.api = host.api
		self.report = host.report or (do(s) null)
		self.log = host.log or (do(s) null)
		self.doc = host.document or document
		self.state = {
			status: 'idle', station: null, track: null, position: 0, duration: 0,
			volume: 80, quality: 'high', queueLength: 0, error: '', history: [], changedAt: 0
		}
		self.queue = []
		self.generation = 0
		self.lastReport = 0
		self.fetching = no
		self.failures = 0
		self.audio = self.doc.createElement('audio')
		self.audio.preload = 'auto'
		self.audio.id = 'audio'
		self.doc.body.appendChild(self.audio) if self.doc.body
		self.audio.addEventListener('play', do onPlay())
		self.audio.addEventListener('pause', do onPause())
		self.audio.addEventListener('timeupdate', do onTime())
		self.audio.addEventListener('ended', do ended())
		self.audio.addEventListener('error', do onError())
		self.audio.addEventListener('durationchange', do onTime(yes))
		setupMediaSession()

	get snapshot
		Object.assign({}, state, {history: state.history.slice()})

	def emit force = no
		state.changedAt = Date.now()
		state.queueLength = queue.length
		report(snapshot)

	def set patch
		Object.assign(state, patch)
		emit()

	# --- commands -------------------------------------------------------

	# Start (or restart) a station; the first track plays as soon as the playlist is in.
	def play station
		return resume() if !station and state.station
		return unless station
		generation += 1
		queue = []
		set({station: {token: station.token, name: station.name or ''}, track: null, position: 0, duration: 0, status: 'loading', error: ''})
		await next()

	def resume
		if state.track and audio.src
			# Report "playing" at once (views and the web page update without
			# waiting for the element's play event); a refused play reverts it.
			set({status: 'playing', error: ''}) if audio.paused
			const p = audio.play()
			if p and p.catch
				p.catch do(e)
					set({status: 'paused'}) if audio.paused and state.status === 'playing'
		elif state.station
			await next()
		else
			null

	def pause
		audio.pause()

	def toggle
		if state.track and !audio.paused
			pause()
		else
			await resume()

	def next
		return unless state.station
		const gen = generation
		try
			if queue.length === 0
				return if fetching
				fetching = yes
				set({status: 'loading'})
				const songs = await api.playlist(state.station, state.quality)
				fetching = no
				return if gen !== generation
				queue = songs or []
				if queue.length === 0
					set({status: 'error', error: 'Pandora returned no playable songs for this station.'})
					return
			return if gen !== generation
			let item = queue.shift()
			if item and item.kind === 'ad' and !item.audioUrl
				# An ad slot: fetch what to play. One that cannot be played is passed over.
				let ad = null
				try
					ad = api.adMetadata ? await api.adMetadata(item, state.quality) : null
				catch e
					log("ad metadata failed: {e and e.message or e}")
				return if gen !== generation
				return await next() unless ad
				item = ad
			start(item)
		catch e
			fetching = no
			set({status: 'error', error: String(e and e.message or e)})
			log("next failed: {e and e.message or e}")

	def start song
		unless song.ad
			state.history.unshift(song)
			state.history = state.history.slice(0, HISTORY_MAX)
		set({track: song, position: 0, duration: song.duration or 0, status: 'loading', error: ''})
		applyVolume()
		audio.src = song.audioUrl
		const p = audio.play()
		if p and p.catch
			p.catch do(err)
				if err and err.name === 'NotAllowedError'
					set({status: 'paused', error: 'The browser blocked autoplay; press play.'})
				else
					log("play() failed: {err and err.message or err}")
		updateMediaSession()

	def stop
		generation += 1
		audio.pause()
		audio.removeAttribute('src')
		audio.load()
		queue = []
		set({status: 'stopped', track: null, position: 0, duration: 0, error: ''})

	# Next is not available while an ad plays.
	def skip
		return if state.track and state.track.ad
		audio.pause()
		await next()

	# A track or ad finished: an ad is registered with Pandora, then the next one plays.
	def ended
		const song = state.track
		if song and song.ad and api.registerAd
			try
				await api.registerAd(song)
				song.registered = yes
			catch e
				log("ad registration failed: {e and e.message or e}")
		await next()

	def rate positive
		const song = state.track
		return unless song and !song.ad
		await api.rate(song.trackToken, positive)
		song.rating = positive ? 1 : 2
		emit()
		await skip() unless positive

	def tired
		const song = state.track
		return unless song and !song.ad
		await api.tired(song.trackToken)
		song.rating = 3
		emit()
		await skip()

	def setVolume v
		state.volume = Math.max(0, Math.min(100, Number(v) or 0))
		applyVolume()
		emit()

	def setQuality q
		state.quality = q
		queue = []
		emit()

	# State saved by the background while this document was gone (Chromium
	# closes an idle offscreen document): station, volume, quality, the log
	# and a paused track to pick up where it stopped.
	def hydrate saved
		return unless saved and typeof saved === 'object'
		state.volume = saved.volume if Number.isFinite(saved.volume)
		state.quality = saved.quality if saved.quality
		state.history = Array.isArray(saved.history) ? saved.history.slice(0, HISTORY_MAX) : []
		state.station = saved.station or null
		if saved.track and saved.track.audioUrl and saved.status !== 'stopped' and saved.status !== 'idle'
			state.track = saved.track
			state.position = saved.position or 0
			state.duration = saved.duration or saved.track.duration or 0
			state.status = 'paused'
			applyVolume()
			audio.src = saved.track.audioUrl
			try
				audio.currentTime = state.position
			catch e
				null
		emit()

	# --- audio events ---------------------------------------------------

	def applyVolume
		const gain = state.track ? Math.pow(10, (state.track.gain or 0) / 20) : 1
		audio.volume = Math.max(0, Math.min(1, (state.volume / 100) * Math.min(1, gain)))

	def onPlay
		set({status: 'playing', error: ''})
		updateMediaSession()

	# The element pauses on its own when a track ends; that is not a pause.
	def onPause
		return if audio.ended
		set({status: 'paused'}) if state.track and state.status !== 'stopped' and state.status !== 'loading'

	def onTime force = no
		state.position = audio.currentTime
		failures = 0 if audio.currentTime > 0.5
		state.duration = audio.duration if Number.isFinite(audio.duration) and audio.duration > 0
		const now = Date.now()
		if force or now - lastReport >= REPORT_EVERY
			lastReport = now
			emit()

	# A song or ad that cannot be played is skipped; several in a row stop the station.
	def onError
		const song = state.track
		failures += 1
		log("audio error {audio.error and audio.error.code} {audio.error and audio.error.message or ''} ({song and song.ad ? 'ad' : 'song'} {song and song.audioFormat or ''}; {failures} in a row)")
		if failures >= 3
			audio.pause()
			queue = []
			set({status: 'error', error: "Could not play {failures} songs in a row; stopped."})
			return
		set({status: 'error', error: "Could not play {song and song.title or 'this song'}; skipping."})
		next()

	# --- media keys -----------------------------------------------------

	def setupMediaSession
		return unless 'mediaSession' in navigator
		try
			navigator.mediaSession.setActionHandler('play', do resume())
			navigator.mediaSession.setActionHandler('pause', do pause())
			navigator.mediaSession.setActionHandler('nexttrack', do skip())
		catch e
			null

	def updateMediaSession
		return unless 'mediaSession' in navigator and state.track
		const song = state.track
		try
			navigator.mediaSession.metadata = new MediaMetadata({title: song.title, artist: song.artist, album: song.album, artwork: song.coverArt ? [{src: song.coverArt}] : []})
			navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing'
		catch e
			null
