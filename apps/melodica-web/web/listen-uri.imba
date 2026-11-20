# listen:// URIs (docs/LISTEN-URI.md): parse and build. The same rules are implemented by
# every client; this module is the reference and is what the tests pin.
#
# listen://artist/<name>            listen://genre/<name>
# listen://station/<id or token>    listen://track/<id>?t=<seconds>
# listen://map/<land>[/<province>]  listen://user/<username>
# listen://listens                  listen://leaderboard
#
# Also accepted with the same paths: web+listen://… (the browser alias) and
# https://spacegho.st/listen/… (the shareable link).
export const HTTPS_BASE = 'https://spacegho.st/listen/'
const MAX_TEXT = 200
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const USERNAME = /^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$/
const STATION = /^[A-Za-z0-9]{1,64}$/
const TRACK = /^(?:[0-9a-f]{64}|[A-Za-z0-9]{1,64})$/

# target -> [segment rules], allowed query keys
const TARGETS = {
	artist: {segs: ['text'], query: []},
	genre: {segs: ['text'], query: []},
	station: {segs: ['station'], query: []},
	track: {segs: ['track'], query: ['t']},
	map: {segs: ['slug', 'slug?'], query: []},
	user: {segs: ['username'], query: []},
	listens: {segs: [], query: []},
	leaderboard: {segs: [], query: []}
}
const FIELD = {
	artist: ['name'],
	genre: ['name'],
	station: ['station'],
	track: ['track'],
	map: ['land', 'province'],
	user: ['username'],
	listens: [],
	leaderboard: []
}

def decodeSeg(raw)
	if !/^[A-Za-z0-9\-._~%!$&'()*+,;=:@]*$/.test(raw)
		return null
	let s
	try
		s = decodeURIComponent(raw)
	catch
		return null
	if !s || s.length > MAX_TEXT || /[\u0000-\u001f\u007f/\\]/.test(s) || s !== s.trim()
		return null
	if s === '.' || s === '..'
		return null
	# never a path step in the https form
	return s.normalize('NFC')

def checkSeg(rule, v)
	switch rule.replace('?', '')
		when 'text'
			return v
		when 'slug'
			return SLUG.test(v) ? v : null
		when 'username'
			return USERNAME.test(v) ? v : null
		when 'station'
			return STATION.test(v) ? v : null
		when 'track'
			return TRACK.test(v) ? v : null
		else
			return null

# {target, name?|station?|track?|land?|province?|username?, t?, uri, web, https} or null.
export def parseListenUri(input)
	if typeof input !== 'string' || input.length > 1024
		return null
	let rest
	const m = /^(listen|web\+listen):\/\/(.*)$/i.exec(input)
	if m
		rest = m[2]
	elif input.toLowerCase().startsWith(HTTPS_BASE)
		rest = input.slice(HTTPS_BASE.length)
	else
		return null
	if rest.includes('#')
		return null
	const q = rest.indexOf('?')
	const path = q >= 0 ? rest.slice(0, q) : rest
	const query = q >= 0 ? rest.slice(q + 1) : ''
	const parts = path.replace(/\/$/, '').split('/')
	const target = parts.shift().toLowerCase()
	const spec = Object.hasOwn(TARGETS, target) ? TARGETS[target] : null
	if !spec
		return null
	const required = spec.segs.filter((do(r) !r.endsWith('?'))).length
	if parts.length < required || parts.length > spec.segs.length
		return null
	const out = {target}
	let i = 0
	while i < parts.length
		const v = decodeSeg(parts[i])
		const ok = v === null ? null : checkSeg(spec.segs[i], v)
		if ok === null
			return null
		out[FIELD[target][i]] = ok
		i++
	if query
		for pair of query.split('&')
			const [k, v = ''] = pair.split('=')
			if !spec.query.includes(k) || Object.hasOwn(out, k)
				return null
			if k === 't'
				if !/^\d{1,5}$/.test(v) || Number(v) > 86400
					return null
				out.t = Number(v)
	return {...out, ...forms(out)}

# The three forms of a parsed target.
def forms(o)
	const segs = FIELD[o.target].filter((do(f) o[f] !== undefined)).map((do(f) encodeURIComponent(o[f])))
	const path = [o.target, ...segs].join('/') + (o.t !== undefined ? ''.concat('?t=', o.t) : '')
	return {uri: ''.concat('listen://', path), web: ''.concat('web+listen://', path), https: ''.concat(HTTPS_BASE, path)}

# Build from {target, ...fields}; null when it would not parse back.
export def listenUri(o)
	if !o || !Object.hasOwn(TARGETS, o.target)
		return null
	const f = forms(o)
	return parseListenUri(f.uri) ? f : null

# Where spacegho.st sends each target (the shell route; clients may handle it in place).
export def routeOf(p)
	switch p.target
		when 'artist', 'genre'
			return ''.concat('/melodica/app/?seed=', p.target, ':', encodeURIComponent(p.name))
		when 'station'
			return ''.concat('/melodica/app/?station=', encodeURIComponent(p.station))
		when 'track'
			return ''.concat('/melodica/listens/?track=', encodeURIComponent(p.track), p.t !== undefined ? ''.concat('&t=', p.t) : '')
		when 'map'
			return ''.concat('/melodica/map/?land=', encodeURIComponent(p.land), p.province ? ''.concat('&province=', encodeURIComponent(p.province)) : '')
		when 'user'
			return ''.concat('/melodica/leaderboard/?user=', encodeURIComponent(p.username))
		when 'listens'
			return '/melodica/listens/'
		when 'leaderboard'
			return '/melodica/leaderboard/'
		else
			return '/melodica/'
