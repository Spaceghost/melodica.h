# Pandora JSON API v5 client. Builds the requests pianobar/libpiano sends (see
# melodica.h compat/piano_base.inc), frames and encrypts them through the wasm
# core, and parses the plain-JSON answers. HTTP is injected so the background
# script can supply its own fetch.

export const DEFAULT_ENDPOINT = 'https://tuner.pandora.com/services/json/'

# Pandora's "android" partner, the identity pianobar ships (settings.c).
export const PARTNER = {
	username: 'android'
	password: 'AC7IBG09A3DTSYM4R41UJWL07VLN8JI7'
	deviceModel: 'android-generic'
	version: '5'
}

export const QUALITIES = ['high', 'medium', 'low']

const CODE_MESSAGES = {
	0: 'Pandora reported an internal error. Try again in a moment.'
	1: 'Pandora is in maintenance mode. Try again later.'
	6: 'Pandora requires https for this call.'
	12: 'Pandora is only available in the US.'
	13: 'Insufficient connectivity to Pandora (clock skew or network).'
	1000: 'Pandora is in read-only mode. Try again later.'
	1001: 'Your session expired.'
	1002: 'Wrong email address or password.'
	1003: 'This listener is not authorized.'
	1004: 'This user is not authorized.'
	1005: 'You have reached the maximum number of stations.'
	1006: 'That station no longer exists.'
	1008: 'Pandora refused this call.'
	1009: 'Device not found.'
	1010: 'Partner not authorized.'
	1011: 'Invalid username.'
	1012: 'Invalid password.'
	1034: 'This device is disabled.'
	1035: 'Daily trial limit reached.'
	1039: 'Pandora is rate limiting this client. Wait a minute and try again.'
}

export def describeCode code, message
	CODE_MESSAGES[code] or (message ? "Pandora error {code}: {message}" : "Pandora error {code}.")

export class PandoraError < Error
	def constructor message, code = null, status = 0, kind = 'pandora'
		super(message)
		self.name = 'PandoraError'
		self.code = code
		self.status = status
		self.kind = kind

	get expired
		self.code === 1001

	get badCredentials
		self.code === 1002 or self.code === 1011 or self.code === 1012

	def toJSON
		{message: self.message, code: self.code, status: self.status, kind: self.kind}

export def nowSeconds
	Math.floor(Date.now() / 1000)

def pickAudio map, quality
	return null unless map
	const order = quality === 'low' ? ['lowQuality', 'mediumQuality', 'highQuality'] : (quality === 'medium' ? ['mediumQuality', 'highQuality', 'lowQuality'] : ['highQuality', 'mediumQuality', 'lowQuality'])
	for key in order
		const entry = map[key]
		return Object.assign({quality: key.replace('Quality', '')}, entry) if entry and entry.audioUrl
	null

export def normalizeStation s
	{
		id: String(s.stationId)
		token: String(s.stationToken or s.stationId)
		name: s.stationName or ''
		isQuickMix: !!s.isQuickMix
		isShared: !!s.isShared
		allowDelete: s.allowDelete !== false
		art: s.artUrl or ''
	}

export def normalizeSong item, quality
	return null unless item and item.trackToken and item.songName
	const audio = pickAudio(item.audioUrlMap, quality)
	return null unless audio
	const gain = Number(item.trackGain)
	{
		trackToken: String(item.trackToken)
		title: item.songName or ''
		artist: item.artistName or ''
		album: item.albumName or ''
		coverArt: item.albumArtUrl or ''
		audioUrl: audio.audioUrl
		audioFormat: "{audio.encoding or ''} {audio.bitrate or ''}".trim()
		quality: audio.quality
		duration: Number(item.trackLength) or 0
		gain: Number.isFinite(gain) ? gain : 0
		rating: Number(item.songRating) or 0
		stationId: String(item.stationId or '')
		detailUrl: item.songDetailUrl or ''
	}

export class Pandora
	def constructor core, options = {}
		self.core = core
		self.endpoint = options.endpoint or DEFAULT_ENDPOINT
		self.fetch = options.fetch or globalThis.fetch.bind(globalThis)
		self.log = options.log or (do(line) null)
		self.partner = null
		self.user = null
		self.credentials = null

	get loggedIn
		!!(self.user and self.user.authToken)

	# Serialisable session state (tokens and the clock offset), for storage.
	def snapshot
		{partner: self.partner, user: self.user, syncOffset: self.core.syncOffset, endpoint: self.endpoint}

	def restore s
		return false unless s and s.partner and s.user
		return false if s.endpoint and s.endpoint !== self.endpoint
		self.partner = s.partner
		self.user = s.user
		self.core.setSyncOffset(Number(s.syncOffset) or 0)
		true

	def reset
		self.partner = null
		self.user = null
		self.core.setSyncOffset(0)

	def url method, params = {}
		const q = new URLSearchParams
		q.set('method', method)
		for own key, value of params
			q.set(key, String(value)) if value !== undefined and value !== null
		"{self.endpoint}?{q.toString()}"

	def post method, body, params = {}, encrypt = yes
		const text = JSON.stringify(body)
		const payload = encrypt ? self.core.envelope(text, nowSeconds()) : text
		throw new PandoraError('The request could not be framed.', null, 0, 'client') unless payload
		self.log("-> {method}")
		let res
		try
			res = await self.fetch(self.url(method, params), {
				method: 'POST'
				headers: {'content-type': 'text/plain'}
				body: payload
				credentials: 'omit'
			})
		catch e
			throw new PandoraError("Could not reach {self.endpoint} ({e and e.message or e}).", null, 0, 'network')
		const raw = await res.text()
		let json
		try
			json = JSON.parse(raw)
		catch e
			throw new PandoraError("{self.endpoint} answered HTTP {res.status} with something other than JSON.", null, res.status, 'relay')
		if json.stat !== 'ok'
			const code = typeof json.code === 'number' ? json.code : null
			throw new PandoraError(describeCode(code, json.message), code, res.status)
		json.result

	def partnerLogin
		const r = await self.post('auth.partnerLogin', Object.assign({}, PARTNER, {includeUrls: yes}), {}, no)
		const server = self.core.syncParse(String(r.syncTime or ''), nowSeconds())
		throw new PandoraError('Pandora sent an unreadable syncTime.', null, 0, 'client') unless server
		self.partner = {authToken: String(r.partnerAuthToken), id: Number(r.partnerId)}
		self.partner

	def login email, password
		await self.partnerLogin()
		const body = {
			loginType: 'user'
			username: email
			password: password
			partnerAuthToken: self.partner.authToken
			returnStationList: no
			includeStationArtUrl: yes
			returnIsSubscriber: yes
		}
		const r = await self.post('auth.userLogin', body, {auth_token: self.partner.authToken, partner_id: self.partner.id})
		self.user = {authToken: String(r.userAuthToken), id: String(r.userId), email: email, subscriber: !!r.isSubscriber}
		self.credentials = {email, password}
		self.user

	def logout
		self.credentials = null
		self.reset()

	# An authenticated call; one automatic re-login on an expired session when
	# the credentials are known (pianobar does the same).
	def authed method, body = {}
		throw new PandoraError('Not signed in.', null, 0, 'auth') unless self.loggedIn
		const run = do
			self.post(method, Object.assign({}, body, {userAuthToken: self.user.authToken}), {
				auth_token: self.user.authToken
				partner_id: self.partner.id
				user_id: self.user.id
			})
		try
			return await run()
		catch e
			if e isa PandoraError and e.expired and self.credentials
				self.log('session expired; signing in again')
				await self.login(self.credentials.email, self.credentials.password)
				return await run()
			throw e

	def stations
		const r = await self.authed('user.getStationList', {includeStationArtUrl: yes, returnAllStations: yes})
		(r.stations or []).map(normalizeStation)

	def playlist station, quality = 'high'
		const r = await self.authed('station.getPlaylist', {stationToken: station.token, includeTrackLength: yes})
		(r.items or []).map(do(item) normalizeSong(item, quality)).filter(do(s) !!s)

	def rate trackToken, positive
		self.authed('station.addFeedback', {trackToken, isPositive: !!positive})

	def tired trackToken
		self.authed('user.sleepSong', {trackToken})

	def explain trackToken
		const r = await self.authed('track.explainTrack', {trackToken})
		(r.explanations or []).map(do(x) x.focusTraitName).filter(do(x) !!x)

	def search text
		const r = await self.authed('music.search', {searchText: text, includeNearMatches: yes, includeGenreStations: yes})
		const out = []
		for a in (r.artists or [])
			out.push({kind: 'artist', name: a.artistName, token: a.musicToken, score: a.score})
		for s in (r.songs or [])
			out.push({kind: 'song', name: "{s.songName} – {s.artistName}", token: s.musicToken, score: s.score})
		for g in (r.genreStations or [])
			out.push({kind: 'genre', name: g.stationName, token: g.musicToken, score: 0})
		out

	def createStation musicToken
		const r = await self.authed('station.createStation', {musicToken})
		normalizeStation(r)

	def deleteStation station
		await self.authed('station.deleteStation', {stationToken: station.token})
		yes
