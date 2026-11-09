# Spaceghost Scrobbles (docs/ACCOUNT.md "Scrobbling"): what a listen looks like,
# when a play counts, and the recent-listens list. Pure functions only, so
# tests/scrobble.test.mjs can run them in Node; bg.imba does the I/O.

export const SCROBBLE_NOTICE = 'Scrobbling to spacegho.st is on. Turn it off in settings.'
export const RECENT_MAX = 15
export const LEADERBOARD_URL = 'https://spacegho.st/scrobble/leaderboard'
export const SUBMISSION_CLIENT = 'melodica-extension'

export def isAd song
	!!(song and (song.ad or song.kind === 'ad'))

def httpsUrl v
	const s = String(v or '')
	try
		return new URL(s).protocol === 'https:' ? s : ''
	catch e
		return ''

# Only artist, title, album, duration and an https art URL; never an ad.
export def trackMetadata song, duration = 0
	return null if !song or isAd(song) or !song.artist or !song.title
	const info = {submission_client: SUBMISSION_CLIENT}
	const secs = Math.max(Number(song.duration) or 0, Number(duration) or 0)
	info.duration_ms = Math.round(secs * 1000) if secs > 0
	const art = httpsUrl(song.coverArt)
	info.art_url = art if art
	const meta = {artist_name: String(song.artist), track_name: String(song.title), additional_info: info}
	meta.release_name = String(song.album) if song.album
	meta

# A play counts after half the track or 4 minutes, whichever comes first;
# tracks of 30 s or less (or of unknown length) never count.
export def thresholdSeconds duration
	const d = Number(duration) or 0
	return null unless d > 30
	Math.min(d / 2, 240)

export def playingNow meta
	{listen_type: 'playing_now', payload: [{track_metadata: meta}]}

export def single meta, listenedAt
	{listen_type: 'single', payload: [{listened_at: Math.floor(Number(listenedAt) or 0), track_metadata: meta}]}

# The Scrobbles endpoint: the one the server named when it is on the account
# server's origin, else <account server>/scrobble.
export def scrobbleBase endpoint, accountBase
	const fallback = "{accountBase}/scrobble"
	try
		const u = new URL(String(endpoint or ''))
		return fallback unless u.origin === new URL(accountBase).origin
		return u.origin + u.pathname.replace(new RegExp('/+$'), '')
	catch e
		return fallback

export def listenFrom x
	return null unless x and typeof x === 'object' and x.title and x.artist
	const l = {listened_at: Math.floor(Number(x.listened_at) or 0), artist: String(x.artist), title: String(x.title)}
	l.album = String(x.album) if x.album
	l.duration_ms = Math.floor(Number(x.duration_ms)) if Number(x.duration_ms) > 0
	const art = httpsUrl(x.art)
	l.art = art if art
	l

export def recentFrom body
	const list = body and Array.isArray(body.listens) ? body.listens : []
	list.map(listenFrom).filter(Boolean).slice(0, RECENT_MAX)

export def listenOf meta, listenedAt
	listenFrom({listened_at: listenedAt, artist: meta.artist_name, title: meta.track_name, album: meta.release_name, duration_ms: meta.additional_info.duration_ms, art: meta.additional_info.art_url})

export def prependListen list, l
	return (list or []).slice(0, RECENT_MAX) unless l
	[l].concat(list or []).slice(0, RECENT_MAX)

# The offline queue: singles that could not be sent (offline, 429, 5xx), oldest
# first, at most QUEUE_MAX, never the same play twice.
export const QUEUE_MAX = 50
export def enqueue queue, body
	const list = Array.isArray(queue) ? queue.slice() : []
	return list unless body and body.listen_type === 'single'
	const key = do(b) JSON.stringify([b.payload[0].listened_at, b.payload[0].track_metadata.artist_name, b.payload[0].track_metadata.track_name])
	return list if list.some(do(b) key(b) === key(body))
	list.push(body)
	list.slice(-QUEUE_MAX)

# What a Scrobbles answer means for a submission.
export def outcome status
	return 'ok' if status >= 200 and status < 300
	return 'off' if status === 403
	return 'auth' if status === 401 or status === 404
	return 'drop' if status === 400 or status === 413 or status === 422
	'retry'
