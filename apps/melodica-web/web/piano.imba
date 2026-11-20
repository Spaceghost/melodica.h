# melodica-web: thin JS wrapper around the melodica.h wasm module.
# Works in browsers and Node (no DOM use here). The protocol, including the
# Blowfish encryption of request bodies, runs inside the wasm; this file only
# moves strings across the boundary and performs HTTP through the relay.
import createMelodica from './melodica.js'

export const PIANO_RPC_PREFIX = '/services/json/?'

# Human-readable messages for Pandora error codes (the "code" field) and
# libpiano status values.
const CODE_MESSAGES = {
	0: 'Pandora reported an internal error. Try again in a moment.',
	1: 'Pandora is in maintenance mode. Try again later.',
	12: 'Pandora is only available in the US; the relay could not reach it from where it runs.',
	13: 'Insufficient connectivity between the relay and Pandora.',
	1000: 'Pandora is in read-only mode. Try again later.',
	1001: 'Your session expired. Signing in again.',
	1002: 'Invalid partner login (the client identity was rejected by Pandora).',
	1003: 'This listener is not authorized.',
	1004: 'This user is not authorized.',
	1005: 'You have reached the maximum number of stations.',
	1006: 'That station no longer exists.',
	1008: 'Pandora refused this call.',
	1009: 'Device not found.',
	1010: 'Partner not authorized.',
	1011: 'Invalid username.',
	1012: 'Invalid password.',
	1034: 'This device is disabled.',
	1035: 'Daily trial limit reached.',
	1039: 'Pandora is rate limiting this relay. Wait a minute and try again.'
}
const STATUS_MESSAGES = {
	0: 'Unknown error.',
	2: 'Pandora sent a response the client could not parse.',
	4: 'Out of memory.',
	5: 'Wrong email address or password.',
	6: 'The selected audio quality is not available for this station.'
}

export class PianoError < Error
	def constructor(reply, extra)
		super(PianoError.describe(reply, extra))
		this.name = 'PianoError'
		this.status = reply.status
		this.code = reply.code
		this.raw = reply.error
		this.kind = extra && extra.kind ? extra.kind : 'pandora'
	static def describe(reply, extra)
		if extra && extra.message
			return extra.message
		if reply.code !== null && reply.code !== undefined && CODE_MESSAGES[reply.code]
			return CODE_MESSAGES[reply.code]
		if STATUS_MESSAGES[reply.status]
			return STATUS_MESSAGES[reply.status]
		if reply.code !== null && reply.code !== undefined
			return ''.concat('Pandora error ', reply.code, ': ', reply.error || 'no message')
		return reply.error || 'Unknown error.'
	# 1001: Pandora session expired. 'access-expired': the relay's access token
	# (x-melodica-access, 12 h) is missing or expired; a fresh login renews it.
	get needsRelogin
		return this.code === 1001 || this.kind === 'access-expired'
	get badCredentials
		return this.status === 5 || this.code === 1011 || this.code === 1012

# The relay's allow-list answers (docs/ACCOUNT.md: HTTP 401/403 with
# {"stat":"fail","code":-1,"message":…}) throw with that message, shown as is.
# Other 401/403 bodies return and are handled as before.
def accessFailure(status, text, client)
	let body = null
	try
		body = JSON.parse(text)
	catch _
		return
	if !body || body.stat !== 'fail' || body.code !== -1 || typeof body.message !== 'string'
		return
	if status === 401
		client.accessToken = ''
	throw new PianoError({status: 0, code: null, error: body.message}, {
		kind: status === 401 ? 'access-expired' : 'access',
		message: body.message
	})

# The Pandora method of a libpiano URL path ('auth.userLogin', ...), or ''.
export def relayMethod(urlPath)
	const m = /[?&]method=([^&]*)/.exec(urlPath || '')
	return m ? decodeURIComponent(m[1]) : ''

export class PianoClient
	def constructor(options = {})
		this.apiBase = options.apiBase
		# URL string ending in '/'
		this.fetch = options.fetch || globalThis.fetch.bind(globalThis)
		this.log = options.log || ((do
			return
		))
		# The relay's access token from the last auth.userLogin (docs/ACCOUNT.md); sent as
		# x-melodica-access on every later relay call. onAccess(token) hears each new one.
		this.accessToken = ''
		this.onAccess = options.onAccess || null
		this.accessAt = 0
		# when accessToken was handed out (ms)
		# onSession() hears every new Pandora login (first login and each re-login),
		# so the page can store the new session (docs/BRIDGE.md 5).
		this.onSession = options.onSession || null
		this.module = null
		this.credentials = null
		this.busy = Promise.resolve()
	def load(moduleOptions = {})
		this.module = await createMelodica(moduleOptions)
		const m = this.module
		this.fn = {
			init: m.cwrap('mw_init', 'number', []),
			begin: m.cwrap('mw_begin', 'number', ['number']),
			cont: m.cwrap('mw_continue', 'number', []),
			finish: m.cwrap('mw_finish', 'number', ['number']),
			free: m.cwrap('mw_free', null, ['number']),
			version: m.cwrap('mw_version', 'string', []),
			loggedIn: m.cwrap('mw_logged_in', 'number', []),
			session: m.cwrap('mw_session', 'number', []),
			restore: m.cwrap('mw_restore', 'number', ['number']),
			stations: m.cwrap('mw_stations', 'number', [])
		}
		const rc = this.fn.init()
		if rc !== 0
			throw new Error(''.concat('mw_init failed with status ', rc))
		this.version = this.fn.version()
		return this
	# Pass a JS string into C as a malloc'd UTF-8 buffer (never the wasm stack;
	# station lists and playlists are larger than the default stack).
	def withCString(str, fn)
		const m = this.module
		const len = m.lengthBytesUTF8(str) + 1
		const ptr = m._malloc(len)
		try
			m.stringToUTF8(str, ptr, len)
			return fn(ptr)
		finally
			m._free(ptr)
	def takeJson(ptr)
		const text = this.module.UTF8ToString(ptr)
		this.fn.free(ptr)
		return JSON.parse(text)
	def begin(request)
		const context = this
		return this.takeJson(this.withCString(JSON.stringify(request), (do(p) context.fn.begin(p))))
	def continueRequest()
		return this.takeJson(this.fn.cont())
	def finish(body)
		const context = this
		return this.takeJson(this.withCString(body, (do(p) context.fn.finish(p))))
	get loggedIn
		return this.fn ? this.fn.loggedIn() === 1 : false
	def cachedStations()
		return this.takeJson(this.fn.stations()).stations
	def relayUrl(urlPath)
		const query = urlPath.startsWith(PIANO_RPC_PREFIX) ? urlPath.slice(PIANO_RPC_PREFIX.length) : urlPath
		return ''.concat(this.apiBase, '?', query)
	# Every libpiano request goes through the relay. (With the melodica extension the
	# page does not run this client at all: it is a remote of the extension's player.)
	def post(req)
		return this.postRelay(req)
	def postRelay(req)
		const url = this.relayUrl(req.urlPath)
		const method = relayMethod(req.urlPath)
		const headers = {'content-type': 'text/plain'}
		if this.accessToken && !method.startsWith('auth.') && method !== 'test.checkLicensing'
			headers['x-melodica-access'] = this.accessToken
		let res
		try
			res = await this.fetch(url, {method: 'POST', headers, body: req.postData})
		catch err
			throw new PianoError({status: 0, code: null, error: String(err)}, {
				kind: 'network',
				message: ''.concat('Could not reach the relay at ', this.apiBase, ' (', err && err.message ? err.message : err, ').')
			})
		const text = await res.text()
		if res.status === 401 || res.status === 403
			accessFailure(res.status, text, this)
		if !res.ok && !text.startsWith('{')
			throw new PianoError({status: 0, code: null, error: text.slice(0, 200)}, {
				kind: 'relay',
				message: ''.concat('The relay at ', this.apiBase, ' answered HTTP ', res.status, '.')
			})
		if method === 'auth.userLogin' && res.ok
			const token = res.headers && res.headers.get ? res.headers.get('x-melodica-access') : null
			if token
				this.accessToken = token
				this.accessAt = Date.now()
				if this.onAccess
					try
						this.onAccess(token)
					catch _
						# a listener must not break the login
		return text
	# One libpiano request/response cycle, including the two-step login.
	def callOnce(request)
		let req = this.begin(request)
		let i = 0
		while i < 4
			if !req.ok
				throw new PianoError(req)
			this.log(''.concat('-> ', req.urlPath.split('&')[0].replace(PIANO_RPC_PREFIX, '')))
			const body = await this.post(req)
			const reply = this.finish(body)
			if !reply.ok
				throw new PianoError(reply)
			if !reply.continue
				return reply.result
			req = this.continueRequest()
			i++
		throw new Error('Request did not settle after four round trips.')
	# Serialised: the C side holds one request at a time. Re-logs in once on
	# an expired session (Pandora code 1001), like pianobar does.
	def call(request)
		const context = this
		const run = (do
			try
				return await context.callOnce(request)
			catch err
				if err instanceof PianoError && err.needsRelogin && request.action !== 'login' && context.credentials
					context.log('session expired; signing in again')
					await context.callOnce({action: 'login', ...context.credentials})
					context.sessionChanged()
					if request.action !== 'stations' && request.action !== 'login'
						await context.callOnce({action: 'stations'})
					return await context.callOnce(request)
				throw err
		)
		const next = this.busy.then(run, run)
		this.busy = next.catch((do
			return
		))
		return next
	def login(user, password)
		const result = await this.call({action: 'login', user, password})
		this.credentials = {user, password}
		this.sessionChanged()
		return result
	def logout()
		this.credentials = null
		this.accessToken = ''
		this.accessAt = 0
		this.fn.init()
		return
	def sessionChanged()
		if !this.onSession
			return
		try
			this.onSession()
		catch _
			# a listener must not break the login
		return
	# The Pandora session (docs/BRIDGE.md 4.1, without sid/email/createdAt, which the
	# page keeps), or null when not logged in.
	def session()
		if !this.fn || !this.loggedIn
			return null
		const s = this.takeJson(this.fn.session())
		if !s
			return null
		return {
			partner: {authToken: s.partnerAuthToken, id: Number(s.partnerId)},
			user: {authToken: s.userAuthToken, id: s.userId},
			syncOffset: Number(s.syncOffset) | 0
		}
	# Restores a session from session() or the extension. true when it was accepted
	# (well formed); whether Pandora still honours it shows on the next call (1001).
	def restore(s, stations = null)
		const context = this
		if !this.fn || !s || !s.partner || !s.user
			return false
		const flat = {
			partnerAuthToken: String(s.partner.authToken || ''),
			partnerId: String(Number(s.partner.id) | 0),
			userAuthToken: String(s.user.authToken || ''),
			userId: String(s.user.id || ''),
			syncOffset: String(Number(s.syncOffset) | 0),
			...Array.isArray(stations) ? ({stations}) : ({})
		}
		this.fn.init()
		return this.withCString(JSON.stringify(flat), (do(p) context.fn.restore(p))) === 0
	# The relay token kept with a stored session (docs/BRIDGE.md 5).
	def restoreAccess(token, at)
		this.accessToken = String(token || '')
		this.accessAt = this.accessToken ? Number(at) || Date.now() : 0
		return
	def setCredentials(c)
		this.credentials = c && c.user && c.password ? ({user: String(c.user), password: String(c.password)}) : null
		return
	def stations()
		return this.call({action: 'stations'}).then((do(r) r.stations))
	# Songs in order, with each insert as {isInsert: true, insertToken} at its place.
	def playlist(stationId, quality = 'high')
		return this.call({action: 'playlist', stationId, quality}).then((do(r)
			const songs = Array.isArray(r.songs) ? r.songs.slice() : []
			const inserts = Array.isArray(r.inserts) ? r.inserts : []
			for ins of [...inserts].sort((do(a, b) b.position - a.position))
				if ins && ins.token
					songs.splice(Math.min(Math.max(0, Number(ins.position) || 0), songs.length), 0, {isInsert: true, insertToken: ins.token, stationId})
			return songs
		))
	# {title, artist, imageUrl, link, audioUrl, audioFormat, trackingTokens}
	def insertInfo(token, quality = 'high')
		return this.call({action: 'insertInfo', token, quality})
	# Sent once its audio started playing.
	def insertPlayed(stationId, trackingTokens)
		return this.call({action: 'insertPlayed', stationId, trackingTokens})
	def rate(song, rating)
		return this.call({action: 'rate', trackToken: song.trackToken, stationId: song.stationId, rating})
	def tired(song)
		return this.call({action: 'tired', trackToken: song.trackToken, stationId: song.stationId})
	def explain(song)
		return this.call({action: 'explain', trackToken: song.trackToken, stationId: song.stationId}).then((do(r) r.explanation))
	def search(query)
		return this.call({action: 'search', query})
	def createStation(token, type)
		return this.call({action: 'createStation', token, type}).then((do(r) r.stations))
	def deleteStation(stationId)
		return this.call({action: 'deleteStation', stationId}).then((do(r) r.stations))

# Resolve the relay base URL: explicit value, else `../api/` relative to the
# page (https://host/melodica/app/ -> https://host/melodica/api/).
export def resolveApiBase(explicit, pageUrl)
	const base = new URL(explicit || '../api/', pageUrl)
	if !base.pathname.endsWith('/')
		base.pathname += '/'
	base.search = ''
	base.hash = ''
	return base.toString()
