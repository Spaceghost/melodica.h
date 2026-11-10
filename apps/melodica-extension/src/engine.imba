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
# The "last playing" record (host.remember) is written this often while playing,
# and on pause, stop and teardown.
const REMEMBER_EVERY = 2000
# A restored playlist remainder older than this is dropped (its links expire).
const QUEUE_FRESH_MS = 30 * 60 * 1000
# The audio copy of the song this engine plays (Cache Storage, one entry per track).
const AUDIO_CACHE = 'melodica-audio'
const cacheKey = do(token) "https://melodica.invalid/audio/{encodeURIComponent(token)}"

export def dropAudioCopies keep = null
	return unless globalThis.caches
	try
		const c = await globalThis.caches.open(AUDIO_CACHE)
		for req in await c.keys()
			await c.delete(req) unless keep and req.url === cacheKey(keep)
	catch e
		null

export class Engine
	def constructor host
		self.api = host.api
		self.report = host.report or (do(s) null)
		self.log = host.log or (do(s) null)
		self.rememberHost = host.remember or (do(r) null)
		self.roomControl = host.roomControl or null
		self.roomSnapshot = null
		self.lastRemember = 0
		self.transferredPending = no
		# The current track came from a saved record: {cacheTried, url}.
		self.restored = null
		self.copyUrl = null
		self.copyTask = null
		self.copyToken = null
		self.preparingSource = null
		self.restoring = null
		# Said once on the song after a saved one could not be played again.
		self.continueNotice = ''
		# Paused by the user: a track that finishes loading afterwards stays paused.
		self.held = no
		self.doc = host.document or document
		self.state = {
			status: 'idle', station: null, pendingStation: null, track: null, position: 0, duration: 0,
			volume: 80, quality: 'high', queueLength: 0, queue: [], error: '', notice: '', history: [], changedAt: 0, played: no
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
		# Teardown (Chrome closing the offscreen document, a closed tab or page): save where it was.
		globalThis.addEventListener('pagehide', do saveLast()) if globalThis.addEventListener

	# --- the "last playing" record -------------------------------------------

	def lastRecord
		const t = state.track
		return null unless t and !t.ad and state.station and t.trackToken
		{station: state.station, pendingStation: state.pendingStation, track: t, position: Number(audio.currentTime) or state.position or 0, duration: state.duration or t.duration or 0, quality: state.quality, queue: queue.filter(do(x) x and x.kind !== 'spot' and !x.ad).slice(0, 4), savedAt: Date.now()}

	def saveLast urgent = yes
		return if transferredPending or !state.played
		const r = lastRecord()
		lastRemember = Date.now()
		rememberHost(r, urgent) if r

	# While this engine plays a song it keeps a copy of its audio bytes, so a resume
	# can play it after its link expired. Only the song playing is kept; quota and
	# network errors leave no copy.
	def keepCopy song
		return unless globalThis.caches and song and !song.ad and song.audioUrl and song.trackToken
		try
			await dropAudioCopies(song.trackToken)
			const c = await globalThis.caches.open(AUDIO_CACHE)
			return if await c.match(cacheKey(song.trackToken))
			const res = await globalThis.fetch(song.audioUrl, {credentials: 'omit', cache: 'no-store'})
			return log("audio copy: HTTP {res.status}") unless res.ok and res.status === 200
			const blob = await res.blob()
			return unless state.track and state.track.trackToken === song.trackToken
			await c.put(cacheKey(song.trackToken), new Response(blob, {headers: {'content-type': blob.type or 'audio/mp4'}}))
			log("audio copy kept ({Math.round(blob.size / 1024)} KiB)")
		catch e
			log("audio copy not kept: {e and e.name or e} {e and e.message or ''}")

	# DJ capture must use origin-clean bytes, while ordinary radio must remain
	# playable when Pandora's CDN does not send CORS headers. Reuse the bounded
	# current-track cache and switch this same element without changing position.
	def preparePlayerAudioForCapture
		const song = state.track
		throw new Error('There is no current song to broadcast.') unless song and !song.ad and song.trackToken
		return if copyUrl and audio.src === copyUrl
		const token = song.trackToken
		const gen = generation
		if copyToken !== token or !copyTask
			copyToken = token
			copyTask = keepCopy(song)
		let timer = null
		try
			await Promise.race([copyTask, new Promise do(resolve, reject)
				timer = setTimeout((do reject(new Error('The room audio copy is taking too long. Private playback can continue.'))), 10000)
			])
		finally
			clearTimeout(timer) if timer
		throw new Error('The player changed tracks before its audio copy was ready.') if generation !== gen or !state.track or state.track.trackToken !== token
		const cleanUrl = await copyOf(token)
		let captureUrl = cleanUrl
		if !captureUrl
			const controller = new AbortController()
			const abortCopy = do controller.abort()
			const timer = setTimeout(abortCopy, 10000)
			try
				const res = await globalThis.fetch(song.audioUrl, {credentials: 'omit', cache: 'no-store', signal: controller.signal})
				if res.ok and res.status === 200
					const blob = await res.blob()
					captureUrl = URL.createObjectURL(blob) if blob.size > 0
			finally
				clearTimeout(timer)
		throw new Error('Could not prepare origin-clean audio for the room. Private playback can continue.') unless captureUrl
		if generation !== gen or !state.track or state.track.trackToken !== token
			URL.revokeObjectURL(captureUrl)
			throw new Error('The player changed tracks before audio capture was ready.')
		const position = Number(audio.currentTime) or Number(state.position) or 0
		const wasPlaying = !audio.paused and !held
		audio.pause() if wasPlaying
		preparingSource = captureUrl
		audio.src = captureUrl
		audio.load()
		copyUrl = captureUrl
		const deadline = Date.now() + 10000
		while (audio.readyState < 2 and !audio.error and Date.now() < deadline)
			if generation !== gen or !state.track or state.track.trackToken !== token
				preparingSource = null if preparingSource === captureUrl
				throw new Error('The player changed tracks before audio capture was ready.')
			await new Promise(do(resolve) setTimeout(resolve, 50))
		if generation !== gen or !state.track or state.track.trackToken !== token
			preparingSource = null if preparingSource === captureUrl
			throw new Error('The player changed tracks before audio capture was ready.')
		if audio.error or audio.readyState < 2
			preparingSource = null
			copyUrl = null
			URL.revokeObjectURL(captureUrl)
			audio.src = song.audioUrl
			audio.load()
			const restoreDeadline = Date.now() + 5000
			while audio.readyState < 1 and Date.now() < restoreDeadline
				if generation !== gen or !state.track or state.track.trackToken !== token
					throw new Error('The player changed tracks before private audio could be restored.')
				await new Promise(do(resolve) setTimeout(resolve, 50))
			if generation !== gen or !state.track or state.track.trackToken !== token
				throw new Error('The player changed tracks before private audio could be restored.')
			try audio.currentTime = position if audio.readyState >= 1 catch e null
			await audio.play() if wasPlaying and !held
			throw new Error('Origin-clean room audio could not be loaded. Private playback was restored.')
		try audio.currentTime = Math.min(position, Math.max(0, (Number(audio.duration) or position) - 0.1)) catch e null
		preparingSource = null
		if wasPlaying and !held
			await audio.play()
			throw new Error('The player changed tracks before audio capture was ready.') if generation !== gen or !state.track or state.track.trackToken !== token

	def copyOf token
		return null unless globalThis.caches and token
		try
			const c = await globalThis.caches.open(AUDIO_CACHE)
			const res = await c.match(cacheKey(token))
			return null unless res
			URL.createObjectURL(await res.blob())
		catch e
			null

	def releaseCopyUrl
		URL.revokeObjectURL(copyUrl) if copyUrl
		copyUrl = null

	# Seek once the element knows the media (setting it earlier may not stick).
	def seekWhenReady position
		const pos = Math.max(0, Number(position) or 0)
		const go = do
			try
				audio.currentTime = pos
			catch e
				null
		if audio.readyState >= 1 then go() else audio.addEventListener('loadedmetadata', go, {once: yes})

	# A saved record: the song paused at its position, the station and what was queued.
	def restore r
		return no unless r and r.track and r.track.trackToken and r.station
		generation += 1
		held = yes
		transferredPending = no
		state.played = yes
		releaseCopyUrl()
		state.pendingStation = r.pendingStation or null
		state.station = r.station
		state.track = r.track
		state.position = Number(r.position) or 0
		state.duration = Number(r.duration) or r.track.duration or 0
		state.quality = r.quality if r.quality
		state.status = 'paused'
		state.error = ''
		queue = (Date.now() - (Number(r.savedAt) or 0) < QUEUE_FRESH_MS and Array.isArray(r.queue)) ? r.queue.slice() : []
		restored = {cacheTried: no}
		applyVolume()
		# The copy is the exact bytes and never expires; the link is the fallback.
		copyUrl = await copyOf(r.track.trackToken)
		restored.cacheTried = !!copyUrl
		audio.src = copyUrl or r.track.audioUrl
		log("restored the last song at {Math.round(state.position)} s ({copyUrl ? 'from its audio copy' : 'from its link'})")
		seekWhenReady(state.position)
		emit()
		yes

	get snapshot
		Object.assign({}, state, {history: state.history.slice()})

	# Direct command result only: ordinary snapshots never carry this private queue.
	def exportPlayback
		const r = lastRecord()
		return null unless r
		{v: 1, at: Date.now(), station: {id: r.station.token, name: r.station.name}, song: r.track, queue: queue.filter(do(x) x and x.kind !== 'spot' and !x.ad).slice(0, 20), position: r.position, duration: r.duration, quality: state.quality, volume: state.volume, status: audio.paused ? 'paused' : 'playing', played: state.played === yes}

	# A validated live engine transfer loads exactly the handed-over media/queue;
	# it never asks for a playlist and never saves an unheard paused transfer.
	def importPlayback p
		generation += 1
		held = yes
		audio.pause()
		releaseCopyUrl()
		restored = {cacheTried: no}
		state.pendingStation = null
		state.station = {token: p.station.id, name: p.station.name}
		state.track = p.song
		state.played = p.played === yes
		transferredPending = !state.played
		state.position = p.position
		state.duration = p.duration
		state.quality = p.quality
		state.volume = p.volume
		state.status = 'paused'
		state.error = ''
		queue = p.queue.slice()
		applyVolume()
		copyUrl = await copyOf(p.song.trackToken)
		audio.src = copyUrl or p.song.audioUrl
		seekWhenReady(p.position)
		emit()
		await resume() if p.status === 'playing'

	# Internal smoke helper: expire metadata without downloading another song.
	def expireAudioLink url
		return unless state.track and !state.track.ad
		state.track = Object.assign({}, state.track, {audioUrl: url, fetchedAt: Date.now() - 24 * 60 * 60 * 1000})
		saveLast()
		emit()

	def emit force = no
		# Command replies and reports may cross within the same millisecond. Give
		# every state a distinct order so an earlier Playing cannot replace Paused.
		state.changedAt = Math.max(Date.now(), (Number(state.changedAt) or 0) + 1)
		state.queueLength = queue.length
		# Up next (docs/BRIDGE.md `queue`): songs only, in order, never an audio URL.
		state.queue = queue.filter(do(x) x and x.kind !== 'spot' and !x.ad and x.title).map(do(x) {title: x.title, artist: x.artist or '', album: x.album or '', coverArt: x.coverArt or '', art: x.coverArt or '', duration: Number(x.duration) or 0, trackToken: x.trackToken or ''})
		report(snapshot)

	def set patch
		Object.assign(state, patch)
		emit()

	# --- commands -------------------------------------------------------

	# Start (or restart) a station; the first track plays as soon as the playlist is in.
	def queueStation station
		return unless station and station.token
		set({pendingStation: {token: station.token, name: station.name or ''}})
		saveLast()

	def play station
		return resume() if !station and state.station
		return unless station
		held = no
		transferredPending = no
		generation += 1
		queue = []
		set({station: {token: station.token, name: station.name or ''}, pendingStation: null, track: null, position: 0, duration: 0, status: 'loading', error: ''})
		await next()

	# One diagnostics line per transport change (src presence only, never the URL).
	def trace what
		log("{what}: status {state.status}, track {state.track ? (state.track.ad ? 'spot' : 'song') : 'none'}, src {audio.src ? 'set' : 'none'}, paused {audio.paused}, ended {audio.ended}, ready {audio.readyState}, held {held}, fetching {fetching}")

	def resume
		await restoring if restoring
		trace('resume')
		held = no
		if (audio.ended or fetching) and state.station
			# Between tracks: the next one is on its way and starts playing when it is in
			# (held is off); the finished one is not restarted.
			set({status: 'loading', error: ''})
		elif state.track and audio.src
			# Report "playing" at once (views and the web page update without
			# waiting for the element's play event); a refused play reverts it.
			set({status: 'playing', error: ''}) if audio.paused
			const p = audio.play()
			if p and p.catch
				p.catch do(e)
					log("resume play() refused: {e and e.name}")
					set({status: 'paused'}) if audio.paused and state.status === 'playing'
		elif state.station
			await next()
		else
			null

	# Reported at once (the reply and the views say paused without waiting for the
	# element's pause event); the element's own events agree with it afterwards.
	def pause
		trace('pause')
		held = yes
		audio.pause()
		set({status: 'paused'}) if state.track and (state.status === 'playing' or state.status === 'loading')
		saveLast()

	# By the reported status, not the element: between two tracks the element has ended
	# (paused) while the station is still playing and the next track is loading.
	def toggle
		await restoring if restoring
		if state.status === 'playing' or state.status === 'loading'
			pause()
		else
			await resume()

	def next
		if state.pendingStation
			generation += 1
			queue = []
			set({station: state.pendingStation, pendingStation: null})
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
			if item and item.kind === 'spot' and !item.audioUrl
				# A slot with only a token: fetch what to play. One that cannot be played is passed over.
				let spot = null
				try
					spot = api.spotMetadata ? await api.spotMetadata(item, state.quality) : null
				catch e
					log("slot metadata failed: {e and e.message or e}")
				return if gen !== generation
				return await next() unless spot
				item = spot
			start(item)
		catch e
			fetching = no
			set({status: 'error', error: String(e and e.message or e)})
			log("next failed: {e and e.message or e}")

	def start song
		unless song.ad
			state.history.unshift(song)
			state.history = state.history.slice(0, HISTORY_MAX)
		set({track: song, played: no, position: 0, duration: song.duration or 0, status: 'loading', error: '', notice: continueNotice})
		continueNotice = ''
		applyVolume()
		restored = null
		releaseCopyUrl()
		copyToken = song.trackToken
		copyTask = keepCopy(song)
		audio.src = song.audioUrl
		if held
			set({status: 'paused'})
			updateMediaSession()
			return
		const p = audio.play()
		if p and p.catch
			p.catch do(err)
				if err and err.name === 'NotAllowedError'
					set({status: 'paused', error: 'The browser blocked autoplay; press play.'})
				else
					log("play() failed: {err and err.message or err}")
		updateMediaSession()

	def stop
		saveLast()
		generation += 1
		audio.pause()
		audio.removeAttribute('src')
		audio.load()
		queue = []
		set({status: 'stopped', pendingStation: null, track: null, position: 0, duration: 0, error: ''})

	# Next is not available while `track.ad` is set.
	def skip
		return if state.track and state.track.ad
		held = no
		audio.pause()
		await next()

	# A track finished: a slot is registered with Pandora, then the next one plays.
	def ended
		if roomControl
			try
				return if await roomControl('ended')
			catch e
				log("room owns ended track; private auto-next suppressed ({e and e.message or e})")
				return
		const song = state.track
		restored = null
		releaseCopyUrl()
		await dropAudioCopies()
		if song and song.ad and api.registerSpot
			try
				await api.registerSpot(song)
				song.registered = yes
			catch e
				log("registration failed: {e and e.message or e}")
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
		const last = saved.last
		if last and last.track and (!saved.track or saved.track.trackToken === last.track.trackToken) and saved.status !== 'stopped'
			const pos = saved.track ? Math.max(Number(saved.position) or 0, Number(last.position) or 0) : last.position
			restoring = restore(Object.assign({}, last, {position: pos}))
			const done = await restoring
			restoring = null
			return if done
		state.station = saved.station or null
		state.pendingStation = saved.pendingStation or null
		if saved.track and saved.track.audioUrl and saved.status !== 'stopped' and saved.status !== 'idle'
			state.track = saved.track
			state.played = saved.played === yes or saved.status === 'playing'
			transferredPending = !state.played
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
		# A play request made before Pause can dispatch its event afterwards.
		# The explicit user pause remains authoritative until Resume clears held.
		if held or audio.paused
			audio.pause() unless audio.paused
			set({status: 'paused'}) if state.track
			return
		state.played = yes
		if transferredPending
			transferredPending = no
			saveLast()
			keepCopy(state.track)
		trace('play event') if state.status !== 'playing'
		set({status: 'playing', error: ''})
		updateMediaSession()

	# The element pauses on its own when a track ends; that is not a pause.
	def onPause
		return if audio.ended
		# A pause event queued before a resume arrives after it: the element plays.
		return unless audio.paused
		trace('pause event') if state.status === 'playing'
		set({status: 'paused'}) if state.track and state.status !== 'stopped' and state.status !== 'loading'

	def onTime force = no
		state.position = audio.currentTime
		failures = 0 if audio.currentTime > 0.5
		state.duration = audio.duration if Number.isFinite(audio.duration) and audio.duration > 0
		const now = Date.now()
		if force or now - lastReport >= REPORT_EVERY
			lastReport = now
			emit()
		saveLast(no) if !audio.paused and now - lastRemember >= REMEMBER_EVERY

	# A track that cannot be played is skipped; several in a row stop the station.
	def onError
		return if preparingSource and (audio.currentSrc or audio.src) === preparingSource
		if roomControl
			try
				return if await roomControl('ended')
			catch e
				log("room owns failed track; private auto-next suppressed ({e and e.message or e})")
				return
		const song = state.track
		if restored and song
			# A saved song whose link expired or fails: its audio copy at the same position,
			# else the station goes on.
			const pos = state.position
			unless restored.cacheTried
				restored.cacheTried = yes
				copyUrl = await copyOf(song.trackToken)
				if copyUrl
					log("the saved link failed; playing the audio copy")
					audio.src = copyUrl
					seekWhenReady(pos)
					audio.play().catch(do(e) null) unless held
					return
			log("the saved link failed and there is no audio copy; continuing the station")
			restored = null
			queue = []
			continueNotice = 'The saved song could not be played again; continuing the station.'
			held = no
			return await next()
		failures += 1
		log("audio error {audio.error and audio.error.code} {audio.error and audio.error.message or ''} ({song and song.ad ? 'spot' : 'song'} {song and song.audioFormat or ''}; {failures} in a row)")
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
			navigator.mediaSession.setActionHandler('play', do mediaAction('resume'))
			navigator.mediaSession.setActionHandler('pause', do mediaAction('pause'))
			navigator.mediaSession.setActionHandler('nexttrack', do mediaAction('next'))
		catch e
			null

	def setRoomState snapshot
		roomSnapshot = snapshot and snapshot.id ? snapshot : null
		updateMediaSession()

	def mediaAction action
		if roomControl
			try
				return if await roomControl(action)
			catch e
				log("room owns media action {action}; private action suppressed ({e and e.message or e})")
				return
		if action === 'play' or action === 'resume'
			await resume()
		elif action === 'pause'
			pause()
		elif action === 'next'
			await skip()

	def updateMediaSession
		return unless 'mediaSession' in navigator
		try
			if roomSnapshot
				const play = roomSnapshot.state and roomSnapshot.state.play
				const meta = play and play.track_metadata
				if meta
					const art = meta.additional_info and meta.additional_info.art_url
					navigator.mediaSession.metadata = new MediaMetadata({title: meta.track_name or '', artist: meta.artist_name or '', album: meta.release_name or '', artwork: art ? [{src: art}] : []})
					const duration = (Number(meta.additional_info and meta.additional_info.duration_ms) or Number(play.duration_ms) or 0) / 1000
					let position = (Number(play.position_ms) or 0) / 1000
					position += Math.max(0, (Date.now() - Number(play.server_time)) / 1000) if play.server_time and !play.paused_at
					const paused = !!play.paused_at or !!(roomSnapshot.audio and roomSnapshot.audio.paused)
					const audible = ['listening', 'broadcasting'].includes(String(roomSnapshot.audio and roomSnapshot.audio.state or '')) and !paused
					navigator.mediaSession.playbackState = audible ? 'playing' : 'paused'
					navigator.mediaSession.setPositionState({duration, position: Math.max(0, Math.min(duration, position)), playbackRate: 1}) if duration > 0 and navigator.mediaSession.setPositionState
				else
					navigator.mediaSession.metadata = null
					navigator.mediaSession.playbackState = 'none'
					try navigator.mediaSession.setPositionState({duration: 0, position: 0, playbackRate: 1}) catch e null
				return
			const song = state.track
			unless song
				navigator.mediaSession.metadata = null
				navigator.mediaSession.playbackState = 'none'
				return
			navigator.mediaSession.metadata = new MediaMetadata({title: song.title, artist: song.artist, album: song.album, artwork: song.coverArt ? [{src: song.coverArt}] : []})
			navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing'
			navigator.mediaSession.setPositionState({duration: state.duration, position: Math.max(0, Math.min(state.duration, Number(audio.currentTime) or state.position)), playbackRate: 1}) if state.duration > 0 and navigator.mediaSession.setPositionState
		catch e
			null
