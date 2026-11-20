# melodica-web: the song this device played last, so a reload, a back/forward or a
# new visit shows it paused where it was with Resume (docs/BRIDGE.md 5.2), and a copy
# of its audio for when its link has expired.
#
# The record lives in the encrypted store (web/vault.js, record "last"), written only
# by the device that plays. On that same device an explicit extension bridge
# export can mirror its actual play and cached bytes; remotes never fetch its media.
# Copies are in the Cache API, keyed by track token: the playing song and the next one
# at most; a copy is deleted when its song finishes. A full disk (quota) only means no
# copy.
export const LAST_ID = 'last'
# Pandora's audio links carry no expiry the client can read; they are treated as
# stale this long after the playlist that brought them (an estimate, on the safe side).
export const AUDIO_URL_MS = (50 * 60000)
export const QUEUE_MAX = 8
const CACHE = 'melodica-audio-v1'
const SONG_FIELDS = [
	'trackToken',
	'title',
	'artist',
	'album',
	'coverArt',
	'audioUrl',
	'audioFormat',
	'duration',
	'fileGain',
	'rating',
	'quality',
	'fetchedAt',
	'stationId',
	'detailUrl',
	'songDetailUrl',
	'artistDetailUrl',
	'albumDetailUrl',
	'musicId',
	'trackGain'
]

export def songRecord(song)
	const out = {}
	for k of SONG_FIELDS
		if song[k] !== undefined && song[k] !== null
			out[k] = song[k]
	return out

# {v, station: {id, name}, song, position, queue, savedAt}: the station's own songs only.
export def lastRecord({station, song, position, queue, now = Date.now()})
	if !station || !song || song.isInsert || !song.trackToken
		return null
	return {
		v: 1,
		station: {id: station.id, name: station.name || ''},
		song: songRecord(song),
		position: Math.max(0, Number(position) || 0),
		queue: (queue || []).filter((do(s) s && !s.isInsert && s.trackToken)).slice(0, QUEUE_MAX).map(songRecord),
		savedAt: now
	}

export def validLast(rec)
	return !!(rec && rec.v === 1 && rec.station && rec.station.id && rec.song && rec.song.trackToken)

export def urlExpired(song, now = Date.now())
	return !song || !song.audioUrl || !(Number(song.fetchedAt) > 0) || now > Number(song.fetchedAt) + AUDIO_URL_MS

export class AudioCopies
	# relayRequest(url) -> [url, init] for the relay's audio stream, or null (fetch directly).
	def constructor({
		caches: cacheStore = globalThis.caches,
		fetch: fetchAudio = globalThis.fetch.bind(globalThis),
		relayRequest = (do null),
		origin: originUrl = globalThis.location.origin,
		log = (do
			return
		)
	} = {})
		this.caches = cacheStore
		this.fetch = fetchAudio
		this.relayRequest = relayRequest
		this.origin = originUrl
		this.log = log
		this.inflight = new Map()
		# token -> AbortController
		this.off = !cacheStore
	def key(token)
		return ''.concat(this.origin, '/melodica/__audio/', globalThis.encodeURIComponent(token))
	def open()
		return await this.caches.open(CACHE)
	# Use the same authenticated Pandora audio proxy as persistent copies. Some
	# Pandora CDN responses omit CORS headers, so direct page fetches cannot read
	# those bytes. `signal` belongs to this read and is not tied to the cache.
	def fetchAudio(song, signal)
		if !(song)?.audioUrl
			throw new Error('This track has no audio URL.')
		const via = this.relayRequest(song.audioUrl)
		const url = via ? via[0] : song.audioUrl
		const init = via ? via[1] : ({mode: 'cors', credentials: 'omit'})
		return await this.fetch(url, {...init, ...signal ? ({signal}) : ({})})
	def has(token)
		if this.off || !token
			return false
		try
			return !!(await (await this.open()).match(this.key(token)))
		catch _
			return false
	# Downloads the song's audio once; true when a copy is kept.
	def save(song)
		if this.off || !song || song.isInsert || !song.trackToken || !song.audioUrl
			return false
		const token = song.trackToken
		if this.inflight.has(token) || (await this.has(token))
			return true
		const ctl = new AbortController()
		this.inflight.set(token, ctl)
		try
			const r = await this.fetchAudio(song, ctl.signal)
			if !r.ok
				return false
			const blob = await r.blob()
			if !this.inflight.has(token) || this.inflight.get(token) !== ctl
				return false
			# dropped meanwhile
			await (await this.open()).put(this.key(token), new Response(blob, {
				headers: {'content-type': blob.type || r.headers.get('content-type') || 'audio/mp4', 'content-length': String(blob.size)}
			}))
			return true
		catch err
			this.log(err && err.name === 'QuotaExceededError' ? 'no room for a copy' : ''.concat('copy failed: ', err && err.message))
			return false
		finally
			if this.inflight.get(token) === ctl
				this.inflight.delete(token)
	# Import bytes already cached by this device's extension. No media request.
	def put(token, blob)
		if this.off || !token || !blob || !blob.size
			return false
		try
			await (await this.open()).put(this.key(token), new Response(blob, {
				headers: {
					'content-type': blob.type || 'audio/mp4',
					'content-length': String(blob.size)
				}
			}))
			return true
		catch err
			this.log(''.concat('copy import failed: ', err && err.message))
			return false
	def drop(token)
		const ctl = this.inflight.get(token)
		if ctl
			this.inflight.delete(token)
			ctl.abort()
		if this.off || !token
			return
		try
			await (await this.open()).delete(this.key(token))
		catch _
			# gone
		return
	# Keeps the copies of these tokens only (and stops any other download).
	def keep(tokens)
		const context = this
		const want = new Set(tokens.filter(Boolean).map((do(t) context.key(t))))
		for [t, ctl] of this.inflight
			if !want.has(this.key(t))
				this.inflight.delete(t)
				ctl.abort()
		if this.off
			return
		try
			const c = await this.open()
			for req of await c.keys()
				if !want.has(req.url)
					await c.delete(req)
		catch _
			# nothing kept
		return
	# Everything, e.g. on sign-out or when this page becomes a remote.
	def clear()
		for ctl of this.inflight.values()
			ctl.abort()
		this.inflight.clear()
		if this.off
			return
		try
			await this.caches.delete(CACHE)
		catch _
			# none
		return
	# A blob: URL of the copy, or ''.
	def blobUrl(token)
		if this.off || !token
			return ''
		try
			const r = await (await this.open()).match(this.key(token))
			return r ? URL.createObjectURL(await r.blob()) : ''
		catch _
			return ''
	# Read playable bytes for a live consumer such as the Rooms DJ. This is
	# deliberately independent of Cache API availability and the user's
	# persistent-copy preference: room broadcasting needs bytes now, but does
	# not need to retain them on disk.
	def readBlob(song, {signal} = {})
		if !song || song.isInsert || !song.trackToken
			throw new Error('This track cannot be shared to a Room.')
		if !song.audioUrl
			throw new Error('This track has no audio URL.')
		if (signal)?.aborted
			throw signal.reason || new DOMException('The operation was aborted.', 'AbortError')

		if !this.off
			try
				const cached = await (await this.open()).match(this.key(song.trackToken))
				if cached
					const blob = await cached.blob()
					if (signal)?.aborted
						throw signal.reason || new DOMException('The operation was aborted.', 'AbortError')
					if blob.size
						return blob
			catch err
				if (signal)?.aborted
					throw signal.reason || err
				# Cache failure is not a reason to block one-time room playback.

		const response = await this.fetchAudio(song, signal)
		if response.type === 'opaque' || response.type === 'opaqueredirect'
			throw new Error('The audio response is not readable. Retry through the authenticated audio relay.')
		if !response.ok
			const detail = response.statusText ? ''.concat(' ', response.statusText) : ''
			throw new Error(''.concat('Audio request failed with HTTP ', response.status, detail, '.'))
		const blob = await response.blob()
		if (signal)?.aborted
			throw signal.reason || new DOMException('The operation was aborted.', 'AbortError')
		if !blob.size
			throw new Error('The audio response was empty.')
		return blob
