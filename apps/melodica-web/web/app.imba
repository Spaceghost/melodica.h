# Browser player and route shell. Compiled as native ES modules.
# Protocol: ./piano.js (melodica.h in wasm). Audio: the <audio> element.
import { PianoClient, PianoError, resolveApiBase } from './piano.js'
import { BridgeTransport, bridgeAllowed } from './bridge.js'
import { Vault } from './vault.js'
import { TabPlayer } from './tabs.js'
import { AudioCopies, LAST_ID, lastRecord, validLast, urlExpired } from './lastplay.js'
import { Account, USERNAME_RE, USERNAME_FORMAT, normalizeUsername } from './account.js'
import { Scrobbles, ListenTracker, listenThreshold, PAGE_SIZE, genomeTraits, trackMetadata } from './scrobble.js'
import { parseListenUri, listenUri, routeOf as listenRoute } from './listen-uri.js'
import { createRoomHost, isRoomsPath, roomIdFromPath, roomPositionMs, roomBlocksSource, roomTrack, roomHistory } from './rooms.js'
import { LyricPanel } from './lyrics.js'

const VERSION = '__MELODICA_WEB_VERSION__'
const lyricElement = document.getElementById('song-lyrics')
const lyrics = lyricElement && new LyricPanel(lyricElement,VERSION)
const STORAGE = {
	email: 'melodica.email',
	password: 'melodica.password',
	revoked: 'melodica.revoked',
	accountSignout: 'melodica.account.signout',
	volume: 'melodica.volume',
	quality: 'melodica.quality',
	station: 'melodica.station',
	shortcuts: 'melodica.shortcuts',
	rememberOff: 'melodica.rememberOff'
}
# localStorage may throw (blocked cookies, sandboxed frame): degrade to session-only settings.
const store = {
	get: (do(k)
		try
			return localStorage.getItem(k)
		catch _
			return null
	),
	set: (do(k, v)
		try
			localStorage.setItem(k, v)
		catch _
			# unavailable
	),
	remove: (do(k)
		try
			localStorage.removeItem(k)
		catch _
			# unavailable
	)
}
const HISTORY_MAX = 20
const UP_NEXT_MAX = 4
const IDLE_TITLE = 'melodica — Pandora in the browser'
const RATING_WORD = {1: 'loved', 2: 'banned', 3: 'tired'}
const QUALITIES = ['high', 'medium', 'low']

# Pandora hands out album-art links with an http:// scheme; the page is https and its
# CSP only allows https images, so upgrade them (the image hosts all serve https).
def artUrl(song)
	const u = song && song.coverArt || ''
	# Only on an https page: a plain-http page (local dev, the CI smoke) can load http art as is.
	return location.protocol === 'https:' ? u.replace(/^http:\/\//i, 'https://') : u

# Scrobbles keeps a copy of every album art URL it is sent (melodica-scrobble
# docs/CLIENTS.md "Album art"): /scrobble/art/<sha256 hex of the URL as Pandora gave it>.
const artCopies = new Map()
def artCachedUrl(song)
	const u = song && song.coverArt || ''
	if !u || !/^https?:\/\//i.test(u) || !crypto.subtle
		return Promise.resolve('')
	if !artCopies.has(u)
		artCopies.set(u, crypto.subtle.digest('SHA-256', new TextEncoder().encode(u)).then((do(d)
			return ''.concat(location.origin, '/scrobble/art/', [...new Uint8Array(d)].map((do(b) b.toString(16).padStart(2, '0'))).join(''))
		), (do '')))
	return artCopies.get(u)

# Keep the existing image's identity hooks while the shared UI owns its fallbacks.
def showArt(img, song, fallback, onFinal, onLoad)
	const gen = img.__artGen = (img.__artGen || 0) + 1
	const src = artUrl(song) || fallback
	Promise.all([import(UI_MODULE), (song)?.art_cached || artCachedUrl(song)]).then((do([mod, cached])
		if img.__artGen !== gen || !img.isConnected
			return
		const next = mod.cover(src, img.className, cached || null)
		for attr of img.attributes
			if !['src', 'loading', 'decoding'].includes(attr.name)
				next.setAttribute(attr.name, attr.value)
		next.__artGen = gen
		next.addEventListener('error', (do
			if !next.isConnected
				return
			if next.getAttribute('src') === 'data:,'
				next.src = fallback
				if onFinal
					onFinal()
		))
		if onLoad
			next.addEventListener('load', (do
				if next.isConnected
					onLoad(next.currentSrc || next.src)
			))
		for key of ['cover', 'barCover']
			if el[key] === img
				el[key] = next
		img.replaceWith(next)
	)).catch((do(err)
		if img.__artGen !== gen || !img.isConnected
			return
		img.src = fallback
		if onFinal
			onFinal()
		console.debug('[art]', describeError(err))
	))

# Fallback cover: a gold record on ink, used whenever Pandora sends no art.
const FALLBACK_COVER = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">' + '<rect width="120" height="120" fill="#111622"/>' + '<g fill="none" stroke="#d8b26a" stroke-width="1.2">' + '<circle cx="60" cy="60" r="50"/><circle cx="60" cy="60" r="38" stroke-opacity="0.6"/><circle cx="60" cy="60" r="26" stroke-opacity="0.4"/>' + '</g><circle cx="60" cy="60" r="7" fill="#f0d9a4"/></svg>')

def byId(id)
	document.getElementById(id)
const el = {
	app: byId('app'),
	status: byId('status'),
	viewLogin: byId('view-login'),
	viewPlayer: byId('view-player'),
	viewError: byId('view-error'),
	remoteSignin: byId('remote-signin'),
	remoteSigninOpen: byId('remote-signin-open'),
	remoteSigninHelp: byId('remote-signin-help'),
	accountLine: byId('account-line'),
	accountSignin: byId('account-signin'),
	loginGithub: byId('login-github'),
	accountSigned: byId('account-signed'),
	accountName: byId('account-name'),
	accountSignout: byId('account-signout'),
	accountMenuLine: byId('account-menu-line'),
	accountMenuName: byId('account-menu-name'),
	accountMenuSignout: byId('account-menu-signout'),
	loginForm: byId('login-form'),
	email: byId('login-email'),
	password: byId('login-password'),
	remember: byId('login-remember'),
	rememberMenu: byId('remember-menu'),
	loginButton: byId('login-button'),
	loginMessage: byId('login-message'),
	fatal: byId('fatal-message'),
	stationList: byId('station-list'),
	stationFilter: byId('station-filter'),
	stationEmpty: byId('station-empty'),
	stationCount: byId('station-count'),
	refreshStations: byId('refresh-stations'),
	logout: byId('logout'),
	account: byId('account'),
	signedIn: byId('signed-in'),
	signedInFull: byId('signed-in-full'),
	searchForm: byId('search-form'),
	searchInput: byId('search-input'),
	searchResults: byId('search-results'),
	stage: document.querySelector('.stage'),
	wash: byId('wash'),
	cover: byId('cover'),
	title: byId('np-title'),
	artist: byId('np-artist'),
	album: byId('np-album'),
	station: byId('np-station'),
	hint: byId('np-hint'),
	qualityChip: byId('np-quality'),
	miniTitle: byId('mini-title'),
	miniArtist: byId('mini-artist'),
	timeCur: byId('time-cur'),
	timeLen: byId('time-len'),
	progress: byId('progress'),
	play: byId('btn-play'),
	next: byId('btn-next'),
	love: byId('btn-love'),
	ban: byId('btn-ban'),
	tired: byId('btn-tired'),
	explain: byId('btn-explain'),
	volume: byId('volume'),
	quality: byId('quality'),
	playerMessage: byId('player-message'),
	explainPanel: byId('explain-panel'),
	explainText: byId('explain-text'),
	explainClose: byId('explain-close'),
	upNext: byId('up-next'),
	upNextEmpty: byId('up-next-empty'),
	upNextCount: byId('up-next-count'),
	history: byId('history'),
	historyEmpty: byId('history-empty'),
	shortcuts: byId('shortcuts'),
	shortcutsOpen: byId('shortcuts-open'),
	shortcutsClose: byId('shortcuts-close'),
	shortcutsEnabled: byId('shortcuts-enabled'),
	confirm: byId('confirm'),
	confirmText: byId('confirm-text'),
	usernamePick: byId('username-pick'),
	usernamePickForm: byId('username-pick-form'),
	usernamePickInput: byId('username-pick-input'),
	usernamePickMessage: byId('username-pick-message'),
	usernamePickCurrent: byId('username-pick-current'),
	usernamePickNotice: byId('username-pick-notice'),
	usernamePickLater: byId('username-pick-later'),
	usernamePickSave: byId('username-pick-save'),
	usernameChange: byId('username-change'),
	usernameChangeInput: byId('username-change-input'),
	usernameChangeMessage: byId('username-change-message'),
	usernameChangeSave: byId('username-change-save'),
	listensPanel: byId('listens-panel'),
	listens: byId('listens'),
	listensEmpty: byId('listens-empty'),
	listensMore: byId('listens-more'),
	scrobbleSettings: byId('scrobble-settings'),
	scrobbleOn: byId('scrobble-on'),
	scrobbleBoard: byId('scrobble-board'),
	scrobbleMessage: byId('scrobble-message'),
	scrobbleCrewWrap: byId('scrobble-crew-wrap'),
	scrobbleNotice: byId('scrobble-notice'),
	listensFallback: byId('listens-fallback'),
	liveState: byId('live-state'),
	siteNav: byId('site-nav'),
	bar: byId('bar'),
	barCover: byId('bar-cover'),
	barProgress: byId('bar-progress'),
	barVolume: byId('bar-volume'),
	barSignin: byId('bar-signin'),
	barExpand: byId('bar-expand'),
	routeView: byId('route-view'),
	routeBody: byId('route-body'),
	barResume: byId('bar-resume'),
	barResumeAt: byId('bar-resume-at'),
	deployFeedback: byId('deploy-feedback'),
	audio: byId('audio'),
	playerRooms: byId('player-rooms'),
	roomCurrent: byId('player-room-current'),
	roomLink: byId('player-room-link'),
	roomStatus: byId('player-room-status'),
	roomSource: byId('player-room-source'),
	roomStopDj: byId('player-room-stop-dj'),
	roomLeave: byId('player-room-leave'),
	roomBrowse: byId('player-rooms-browse'),
	roomList: byId('player-rooms-list'),
	historyContext: byId('history-context')
}

const clamp = (do(n, lo, hi) Math.max(lo, Math.min(hi, n)))

# Stored settings are validated: a stray value must never leave the volume NaN
# or send an unknown quality to the relay.
def readVolume()
	const raw = store.get(STORAGE.volume)
	if raw === null || raw.trim() === ''
		return 80
	const n = Number(raw)
	return Number.isFinite(n) ? clamp(Math.round(n), 0, 100) : 80
def readQuality()
	const q = store.get(STORAGE.quality)
	return QUALITIES.includes(q) ? q : 'high'
const lowerQuality = (do(q) QUALITIES[Math.min(QUALITIES.indexOf(q) + 1, QUALITIES.length - 1)])

# The server's playback flags; the defaults until the policy endpoint answers
# (refreshPolicy). Nothing is cached between page loads.
def readPolicy()
	return {inserts: true}

const state = {
	client: null,
	tabs: null,
	engineReady: false,
	bridge: null,
	account: null,
	accountReady: Promise.resolve(),
	accountNavigating: false,
	policyReady: Promise.resolve(),
	remote: false,
	vault: null,
	saved: null,
	savedReady: Promise.resolve(),
	remember: false,
	sessionMeta: null,
	extSid: '',
	remoteState: null,
	apiBase: '',
	apiFromQuery: false,
	stations: [],
	pendingStation: null,
	station: null,
	queue: [],
	song: null,
	history: [],
	quality: readQuality(),
	volume: readVolume(),
	policy: readPolicy(),
	shortcutsOn: store.get(STORAGE.shortcuts) !== '0',
	explaining: false,
	playGen: 0,
	fetching: null,
	consecutiveAudioErrors: 0,
	keepMessage: false,
	scrobbles: null,
	scrobble: null,
	copies: null,
	resume: null,
	resuming: false,
	blobUrl: '',
	tap: null
}

# ---------------------------------------------------------------- helpers
def show(view)
	for v of [el.viewLogin, el.viewPlayer, el.viewError]
		v.hidden = v !== view
	if view !== el.viewError && typeof mark === 'function'
		mark('visible')
	el.app.dataset.view = view.id.replace('view-', '')
	el.account.hidden = view !== el.viewPlayer
	el.account.open = false
	updateBar()

# The player bar (pinned to the bottom of the viewport on every route): the player's
# controls, or a slim "Sign in to play" while nobody is signed in.
def updateBar()
	if !el.bar
		return
	const signin = !state.remote && !(state.rooms)?.active() && el.app.dataset.view !== 'player'
	el.bar.dataset.state = signin ? 'signin' : 'player'
	el.barSignin.hidden = !signin

def setStatus(text, isError = false)
	el.status.textContent = text
	el.status.classList.toggle('error', isError)

# "direct via melodica extension 0.1.0" or "via spacegho.st relay", then the
# module and page versions once the wasm is up.
def extensionName()
	const b = state.bridge
	return ''.concat((b.name || 'melodica extension').replace(/^melodica-extension$/, 'melodica extension'), ' ', b.version || '').trim()
def transportLabel()
	if state.remote
		return ''.concat('playing in ', extensionName())
	let host = state.apiBase
	try
		host = new URL(state.apiBase).host
	catch _
		# keep the raw string
	return ''.concat('via ', host, ' relay', state.apiFromQuery ? ' (?api=)' : '')
def updateStatus()
	const mod = state.remote ? ''.concat('web ', VERSION) : state.client && state.client.version ? ''.concat('melodica.h ', state.client.version, ' · web ', VERSION) : 'loading melodica.h…'
	setStatus(''.concat(transportLabel(), ' · ', mod))

# One timer per message target so a login message never clears a toast.
const messageTimers = new Map()
def message(target, text, kind = 'info', ttl = 8000)
	target.textContent = text || ''
	target.className = ''.concat(target === el.playerMessage ? 'toast' : 'message', ' ', text ? kind : '').trim()
	clearTimeout(messageTimers.get(target))
	if text && ttl
		messageTimers.set(target, setTimeout((do
			if target.textContent === text
				message(target, '')
		), ttl))
const playerMessage = (do(t, k, ttl) message(el.playerMessage, t, k, ttl))
const loginMessage = (do(t, k) message(el.loginMessage, t, k, 0))

def describeError(err)
	return err && err.message ? err.message : String(err)

def fmtTime(seconds)
	if !Number.isFinite(seconds) || seconds < 0
		return '0:00'
	const m = Math.floor(seconds / 60)
	const s = Math.floor(seconds % 60)
	return ''.concat(m, ':', s < 10 ? '0' : '', s)

# Relay precedence: a trusted ?api= in the page URL (it also disables the
# extension bridge), else data-api on the script tag, else ../api/.
def apiBaseFromPage()
	const params = new URLSearchParams(location.search)
	const tag = document.querySelector('script[type="module"][src$="app.js"]')
	let explicit = params.get('api') || ''
	# A crafted link must not route credentials elsewhere: ?api= is honoured only
	# for the page's own origin (or on a local dev host).
	if explicit && !trustedApiParam(explicit)
		explicit = ''
	const fromQuery = !!explicit
	if !explicit
		explicit = tag && tag.dataset.api || ''
	return {apiBase: resolveApiBase(explicit, document.baseURI), fromQuery}
def trustedApiParam(value)
	if /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
		return true
	try
		return new URL(value, location.href).origin === location.origin
	catch _
		return false

# The play-log rating buttons reuse the transport bar's icons.
const cloneIcon = (do(button) button.querySelector('svg').cloneNode(true))

def lastStation()
	return state.station || state.stations.find((do(s) s.id === store.get(STORAGE.station))) || state.stations[0] || null

# Dialogs: a click on the ::backdrop (outside the sheet's box) closes them;
# a click in the sheet's own padding does not.
def closeOnBackdrop(dialog, close)
	dialog.addEventListener('click', (do(ev)
		if ev.target !== dialog
			return
		const r = dialog.getBoundingClientRect()
		if ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom
			close()
	))

# In-app confirmation sheet; falls back to window.confirm where <dialog> is unsupported.
def confirmDialog(text)
	if typeof el.confirm.showModal !== 'function'
		return Promise.resolve(window.confirm(text))
	return new Promise((do(resolve)
		el.confirmText.textContent = text
		el.confirm.returnValue = ''
		const onClose = (do
			el.confirm.removeEventListener('close', onClose)
			resolve(el.confirm.returnValue === 'yes')
		)
		el.confirm.addEventListener('close', onClose)
		el.confirm.showModal()
	))

# ---------------------------------------------------------------- stations
# Rebuild the list (after load/create/delete). Moving the highlight alone is
# markActiveStation(), so a station click never destroys focus or scroll.
def buildStations()
	if stationTools
		stationTools.render()
	if phone
		queueMicrotask(do phone.sync())
	if el.app.dataset.ready === 'true'
		saveSnapshot()
	el.stationList.replaceChildren()
	const sorted = [...state.stations].sort((do(a, b)
		if stationTools && stationTools.rank(a.id) !== stationTools.rank(b.id)
			return stationTools.rank(a.id) - stationTools.rank(b.id)
		if a.isQuickMix !== b.isQuickMix
			return a.isQuickMix ? -1 : 1
		return (a.name || '').localeCompare(b.name || '', undefined, {sensitivity: 'base'})
	))
	for st of sorted
		const name = st.name || ''
		# the wasm reply emits null for a missing C string
		const li = document.createElement('li')
		li.dataset.id = st.id
		li.dataset.name = name.toLowerCase()
		const b = document.createElement('button')
		b.type = 'button'
		b.className = 'station'
		b.textContent = name
		b.title = name
		b.addEventListener('click', (do playStation(st)))
		li.append(b)
		if !st.isQuickMix && !state.remote
			const d = document.createElement('button')
			d.type = 'button'
			d.className = 'delete'
			d.title = ''.concat('Delete station "', st.name, '"')
			d.setAttribute('aria-label', ''.concat('Delete station ', st.name))
			d.textContent = '×'
			d.addEventListener('click', (do(ev)
				ev.stopPropagation()
				deleteStation(st)
			))
			li.append(d)
		el.stationList.append(li)
	markActiveStation()
	filterStations()
	updateHint()

def markActiveStation()
	const prev = el.stationList.querySelector('li.active')
	const next = state.station ? el.stationList.querySelector(''.concat('li[data-id="', CSS.escape(String(state.station.id)), '"]')) : null
	if prev && prev !== next
		prev.classList.remove('active')
		prev.querySelector('button.station').removeAttribute('aria-current')
	if next
		next.classList.add('active')
		next.querySelector('button.station').setAttribute('aria-current', 'true')

def filterStations()
	const q = el.stationFilter.value.trim().toLowerCase()
	let shown = 0
	for li of el.stationList.children
		const folder = (stationTools)?.folder
		const hit = (!q || (li.dataset.name || '').includes(q)) && (!folder || stationTools.prefs.folders[li.dataset.id] === folder)
		li.hidden = !hit
		if hit
			shown += 1
	const total = el.stationList.children.length
	el.stationEmpty.hidden = shown > 0 || total === 0
	el.stationCount.textContent = total ? q ? ''.concat(shown, ' of ', total) : String(total) : ''

def visibleStationButton()
	return el.stationList.querySelector('li.active:not([hidden]) button.station') || el.stationList.querySelector('li:not([hidden]) button.station')

def loadStations()
	state.stations = await state.client.stations()
	buildStations()

def deleteStation(st)
	if !await confirmDialog(''.concat('Delete the station "', st.name, '" from your Pandora account?'))
		return
	try
		state.stations = await state.client.deleteStation(st.id)
		if state.station && state.station.id === st.id
			stopPlayback('Station deleted.')
		buildStations()
		# The delete button that opened the dialog is gone; keep keyboard focus in the rail.
		(visibleStationButton() || el.stationFilter).focus()
	catch err
		playerMessage(describeError(err), 'error')

# ---------------------------------------------------------------- now playing display
def setCover(song)
	showArt(el.cover, song, FALLBACK_COVER, (do
		el.wash.src = 'data:,'
	), (do(src)
		if src !== FALLBACK_COVER && src !== 'data:,'
			el.wash.src = src
	))
	showArt(el.barCover, song, FALLBACK_COVER)
	el.wash.src = artUrl(song) || 'data:,'

def setPlayIcon(playing)
	if (phone)?.ui
		queueMicrotask(do phone.sync())
	if (walkJournal)?.active
		queueMicrotask(do walkJournal.sample())
	el.play.dataset.state = playing ? 'playing' : 'paused'
	el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play')

# Progress row: only touch the DOM when the displayed value changes.
let lastLen = -1
def setProgress(cur, len)
	(lyrics)?.tick(cur)
	const curText = fmtTime(cur)
	const lenChanged = len !== lastLen
	if lenChanged
		lastLen = len
		el.progress.max = len || 1
		el.timeLen.textContent = fmtTime(len)
	el.progress.value = cur
	el.barProgress.max = el.progress.max
	el.barProgress.value = cur
	if lenChanged || curText !== el.timeCur.textContent
		el.timeCur.textContent = curText
		el.progress.setAttribute('aria-valuetext', ''.concat(curText, ' of ', fmtTime(len)))

def showIdle()
	(lyrics)?.track(null)
	el.stage.classList.add('idle')
	el.title.textContent = 'Pick a station'
	el.artist.textContent = el.album.textContent = el.station.textContent = ''
	el.miniTitle.textContent = el.miniArtist.textContent = ''
	el.qualityChip.hidden = true
	el.cover.alt = ''
	setCover('')
	lastLen = -1
	setProgress(0, 0)
	el.explainPanel.hidden = true
	updateHint()
	document.title = IDLE_TITLE

# Idle hint under the title: names the next action (and the station space resumes).
def updateHint()
	if state.song
		el.hint.textContent = ''
		return
	const last = lastStation()
	el.hint.textContent = last ? ''.concat('Press play to resume ', last.name, ', or choose a station from the list.') : 'Choose a station from the list to start listening.'

# The chip names the quality the playing song was fetched at, not the current setting.
def updateQualityChip()
	const song = state.song
	if !song
		el.qualityChip.hidden = true
		return
	const q = song.quality || state.quality
	const fmt = song.audioFormat ? String(song.audioFormat).replace(/_/g, ' ') : ''
	el.qualityChip.textContent = song.isInsert ? '' : fmt ? ''.concat(q, ' · ', fmt) : q
	el.qualityChip.hidden = false

let upNextKey = ''
let upNextGen = 0
def renderUpNext()
	const songs = state.remote ? Array.isArray((state.remoteState)?.queue) ? state.remoteState.queue.filter(Boolean).map(remoteSong) : [] : state.queue
	const total = state.remote ? Math.max(songs.length, Number((state.remoteState)?.queueLength) || 0) : songs.length
	const key = JSON.stringify([songs, total, !!state.song, state.remote])
	if key === upNextKey
		return
	upNextKey = key
	const gen = ++upNextGen
	el.upNext.replaceChildren()
	const peek = songs.slice(0, UP_NEXT_MAX)
	for s of peek
		const li = document.createElement('li')
		const img = document.createElement('img')
		img.className = 'queue-cover'
		img.alt = ''
		img.src = FALLBACK_COVER
		const t = document.createElement('span')
		t.className = 't'
		t.textContent = s.title || ''
		t.title = t.textContent
		const a = document.createElement('span')
		a.className = 'a'
		a.textContent = s.isInsert ? '' : s.artist || ''
		const album = document.createElement('span')
		album.className = 'queue-album'
		album.textContent = s.isInsert ? '' : s.album || ''
		li.append(img, t, a, album)
		el.upNext.append(li)
		Promise.all([import(UI_MODULE), artCachedUrl(s)]).then((do([mod, cached])
			if gen !== upNextGen
				return
			img.replaceWith(mod.cover(artUrl(s) || FALLBACK_COVER, 'queue-cover', s.art_cached || cached || null))
		)).catch((do(err) console.debug('[queue art]', describeError(err))))
	const more = peek.length ? total - peek.length : 0
	el.upNextCount.textContent = more > 0 ? ''.concat('+', more, ' more') : ''
	el.upNextEmpty.hidden = peek.length > 0
	if peek.length === 0
		el.upNextEmpty.textContent = state.remote && total ? ''.concat(total, ' song', total === 1 ? '' : 's', ' queued in the extension.') : state.song ? 'Last song of this playlist; Pandora sends more when it ends.' : 'Nothing queued yet.'

def ratingClasses(button, kind, rating)
	button.classList.toggle('on', kind === 'love' && rating === 1)
	button.classList.toggle('off', kind === 'ban' && rating === 2)
	button.setAttribute('aria-pressed', String(kind === 'love' ? rating === 1 : rating === 2))

def historyRatingText(song)
	return sameSong(song, state.song) ? 'now playing' : RATING_WORD[song.rating] || ''

def renderHistory()
	el.history.replaceChildren()
	for song of state.history
		const li = document.createElement('li')
		li.className = 'hist'
		li.dataset.rating = String(song.rating || 0)
		li.dataset.token = song.trackToken || ''
		if sameSong(song, state.song)
			li.classList.add('now')
		const img = document.createElement('img')
		img.className = 'hist-cover'
		img.alt = ''
		img.loading = 'lazy'
		showArt(img, song, FALLBACK_COVER)
		const meta = document.createElement('div')
		meta.className = 'hist-meta'
		const t = document.createElement('span')
		t.className = 'hist-title'
		t.textContent = song.title || ''
		t.title = song.title || ''
		const a = document.createElement('span')
		a.className = 'hist-artist'
		a.textContent = song.artist || ''
		const r = document.createElement('span')
		r.className = 'hist-rating'
		r.textContent = historyRatingText(song)
		meta.append(t, a, r)
		const rate = document.createElement('div')
		rate.className = 'hist-rate'
		for kind of ['love', 'ban']
			const b = document.createElement('button')
			b.type = 'button'
			b.className = kind
			b.setAttribute('aria-label', ''.concat(kind === 'love' ? 'Love' : 'Ban', ' ', song.title || 'this song'))
			b.append(cloneIcon(kind === 'love' ? el.love : el.ban))
			b.disabled = !!(state.rooms)?.active() || state.remote && !sameSong(song, state.song)
			ratingClasses(b, kind, song.rating)
			b.addEventListener('click', (do rateSong(song, kind)))
			rate.append(b)
		li.append(img, meta, rate)
		el.history.append(li)
	el.historyEmpty.hidden = state.history.length > 0

# Refresh one play-log row in place so a rating keeps focus on its button.
def updateHistoryItem(song)
	if !song || !song.trackToken
		renderHistory()
		return
	const li = el.history.querySelector(''.concat('li[data-token="', CSS.escape(song.trackToken), '"]'))
	if !li
		return
	li.dataset.rating = String(song.rating || 0)
	li.querySelector('.hist-rating').textContent = historyRatingText(song)
	for b of li.querySelectorAll('.hist-rate button')
		ratingClasses(b, b.classList.contains('love') ? 'love' : 'ban', song.rating)

def rememberSong(song)
	state.history = [song, ...state.history.filter((do(s) s !== song))].slice(0, HISTORY_MAX)
	renderHistory()

# ---------------------------------------------------------------- playback
def stopPlayback(reason)
	clearResume()
	revokeBlob()
	el.audio.pause()
	el.audio.removeAttribute('src')
	el.audio.load()
	state.playGen += 1
	state.song = null
	state.queue = []
	state.station = null
	state.keepMessage = false
	showIdle()
	updateRatingButtons()
	markActiveStation()
	renderUpNext()
	renderHistory()
	if reason
		playerMessage(reason)

def playStation(st, {duringRestore = false} = {})
	if roomBlocksSource((state.rooms)?.getState())
		playerMessage('Leave the room before changing stations.', 'info')
		return
	if el.app.dataset.ready !== 'true' && !duringRestore
		# Pressed on the first paint: once the restore is done (as a remote or on its own).
		playerMessage(''.concat('Loading ', st.name, '…'), 'info', 0)
		await readyPromise
		if !state.remote && !(state.client && state.client.fn && state.client.session())
			playerMessage('')
			return
		st = state.stations.find((do(x) x.id === st.id)) || st
	if state.remote
		playerMessage(''.concat('Loading ', st.name, '…'), 'info', 0)
		await remoteCommand('play', {station: {token: st.id, name: st.name}})
		if (((state.rooms)?.getState())?.state)?.play
			playerMessage(''.concat(st.name, ' queued for your next DJ track.'))
		return
	if (((state.rooms)?.getState())?.state)?.play
		state.pendingStation = st
		checkpointEngine(true)
		if (state.tabs)?.owner
			state.tabs.publish()
		playerMessage(''.concat(st.name, ' queued for your next DJ track.'))
		return
	state.pendingStation = null
	state.station = st
	state.queue = []
	state.playGen += 1
	state.consecutiveAudioErrors = 0
	state.keepMessage = false
	store.set(STORAGE.station, st.id)
	markActiveStation()
	renderUpNext()
	playerMessage(''.concat('Loading ', st.name, '…'), 'info', 0)
	await nextSong()

# Resolves to the playable songs, or null when the request was superseded
# (station switched, stopped, quality changed) or one is already in flight.
def fetchPlaylist()
	const station = state.station
	const gen = state.playGen
	if !station
		return null
	if state.fetching === gen
		return null
	# let the first request finish
	state.fetching = gen
	let quality = state.quality
	try
		let songs
		try
			try
				songs = await state.client.playlist(station.id, quality)
			catch err
				if state.playGen !== gen
					return null
				# superseded: neither retry nor touch the setting
				if !(err instanceof PianoError && err.status === 6 && quality !== 'low')
					throw err
				# Quality unavailable for this station: step down and retry once.
				quality = lowerQuality(quality)
				setQuality(quality)
				playerMessage(''.concat('Quality not available; using ', quality, '.'))
				songs = await state.client.playlist(station.id, quality)
		catch err
			if state.playGen !== gen
				return null
			# nobody is waiting for this answer
			throw err
		if state.playGen !== gen
			return null
		const at = Date.now()
		return (songs || []).filter((do(s) s && (s.isInsert ? state.policy.inserts : s.audioUrl))).map((do(s) (s.quality = quality, s.fetchedAt = at, s)))
	finally
		if state.fetching === gen
			state.fetching = null

def nextSong()
	if state.pendingStation
		state.station = state.pendingStation
		state.pendingStation = null
		state.queue = []
		state.playGen += 1
		store.set(STORAGE.station, state.station.id)
		markActiveStation()
		renderUpNext()
	if !state.station
		return
	const gen = state.playGen
	try
		# Songs whose links have gone stale (a long pause, a resumed queue) are passed over.
		while state.queue.length && !state.queue[0].isInsert && urlExpired(state.queue[0])
			state.queue.shift()
		if state.queue.length === 0
			const songs = await fetchPlaylist()
			if songs === null
				return
			state.queue = songs
			if songs.length === 0
				playerMessage('Pandora returned no playable songs for this station.', 'error')
				renderUpNext()
				return
		if state.playGen !== gen
			return
		const song = state.queue.shift()
		if song.isInsert
			const ins = await loadInsert(song)
			if state.playGen !== gen
				return
			if !ins
				renderUpNext()
				nextSong()
				return
			playSong(ins)
			renderUpNext()
			return
		playSong(song)
		renderUpNext()
	catch err
		if (err instanceof PianoError) && err.badCredentials
			stopPlayback()
			showLogin()
			loginMessage(describeError(err), 'error')
		else
			playerMessage(describeError(err), 'error', 0)
	finally
		state.keepMessage = false
		# consumed by playSong, or moot after a failure

# A playlist insert becomes a playable "song", or null when it has no audio
# (then it is passed over).
def loadInsert(item)
	try
		const meta = await state.client.insertInfo(item.insertToken, item.quality || state.quality)
		if !meta || !meta.audioUrl
			return null
		return {
			isInsert: true,
			insertToken: item.insertToken,
			stationId: item.stationId || state.station && state.station.id || '',
			title: meta.title || '',
			artist: meta.artist || '',
			album: '',
			coverArt: meta.imageUrl || '',
			audioUrl: meta.audioUrl,
			audioFormat: meta.audioFormat || '',
			trackingTokens: Array.isArray(meta.trackingTokens) ? meta.trackingTokens : [],
			link: meta.link || '',
			trackToken: '',
			duration: 0,
			rating: 0,
			quality: item.quality,
			registered: false
		}
	catch err
		console.debug('[insert]', ''.concat('info failed: ', describeError(err)))
		return null

# Sent once, when the insert's audio actually started.
def insertPlayedOnce(song)
	if !song || !song.isInsert || song.registered
		return
	song.registered = true
	state.client.insertPlayed(song.stationId, song.trackingTokens).then((do console.debug('[insert]', 'played'))).catch((do(err) console.debug('[insert]', ''.concat('played failed: ', describeError(err)))))

def applyVolume()
	# User volume scaled by the track's replay gain, like pianobar does.
	const gain = state.song ? Math.pow(10, (state.song.fileGain || 0) / 20) : 1
	el.audio.volume = clamp(state.volume / 100 * Math.min(1, gain) * ((phone)?.duck || 1), 0, 1)

def playSong(song)
	clearResume()
	displaySong(song)
	applyVolume()
	revokeBlob()
	el.audio.src = song.audioUrl
	keepCopies(song)
	const p = el.audio.play()
	if p && p.catch
		p.catch((do(err)
			if err && err.name === 'NotAllowedError'
				playerMessage('Press play to start (the browser blocks autoplay).', 'info', 0)
				state.tap = {
					label: ''.concat('Play ', state.station ? state.station.name : 'the station'),
					run: (do
						return el.audio.play().catch((do
							return
						))
					)
				}
				updateResumeUi()
				setPlayIcon(false)
				if Reflect.has(navigator, 'mediaSession')
					navigator.mediaSession.playbackState = 'paused'
		))
	updateMediaSession(song)

# Everything about a new song except playing it (shared with remote mode).
def displaySong(song, {shown = false, remember = true} = {})
	state.song = song
	(lyrics)?.track(song)
	if song.isInsert
		el.app.dataset.insert = 'true'
	else
		delete el.app.dataset.insert
	el.stage.classList.remove('idle')
	el.title.textContent = song.title || ''
	el.artist.textContent = song.artist || ''
	el.album.textContent = song.album || ''
	el.station.textContent = state.station ? ''.concat('on ', state.station.name) : ''
	el.miniTitle.textContent = song.title || ''
	el.miniArtist.textContent = song.artist || ''
	setCover(song)
	el.cover.alt = song.coverArt && song.album ? ''.concat('Cover of ', song.album) : ''
	lastLen = -1
	setProgress(0, song.duration || 0)
	el.explainPanel.hidden = true
	updateHint()
	updateQualityChip()
	updateRatingButtons()
	if remember && !song.isInsert
		rememberSong(song)
	if shown
		# shown paused for Resume: nothing is playing yet
	elif !state.remote
		scrobbleStart(song)
		loadGenome(song)
	else
		scheduleListensRefresh()
	if state.keepMessage
		state.keepMessage = false
	else
		playerMessage('')
	saveSnapshot()
	const label = [song.title, song.artist].filter(Boolean).join(' – ')
	document.title = label ? ''.concat(label, ' · melodica') : IDLE_TITLE

def updateRatingButtons()
	const r = state.song ? state.song.rating : 0
	el.love.classList.toggle('on', r === 1)
	el.ban.classList.toggle('off', r === 2)
	el.tired.classList.toggle('off', r === 3)
	el.love.setAttribute('aria-pressed', String(r === 1))
	el.ban.setAttribute('aria-pressed', String(r === 2))
	const has = !!state.song
	const ins = has && !!state.song.isInsert
	# plays through: no skip, rating or explain
	for b of [el.next, el.love, el.ban, el.tired, el.explain]
		b.disabled = !has || ins

def skip(reason)
	if (state.rooms)?.active()
		state.rooms.command('room-skip').catch((do(e) playerMessage(e.message, 'error')))
		return
	if state.remote
		remoteCommand('next')
		return
	if state.song && state.song.isInsert
		return
	# plays through
	if reason
		playerMessage(reason)
		state.keepMessage = true
	if state.song && !reason
		crewGame('skip', {artist_name: String(state.song.artist || ''), track_name: String(state.song.title || '')})
	el.audio.pause()
	nextSong()

# Rate the current song (ban skips) or any song from the play log via its trackToken.
def rateSong(song, kind)
	const room = ((state.rooms)?.getState())?.state
	if (state.rooms)?.active()
		if !(room)?.play || !sameSong(song, state.song)
			return
		await state.rooms.command('room-command', {body: {action: 'react', play_id: room.play.id, reaction: kind === 'love' ? 'like' : 'dislike'}}).catch((do(e) playerMessage(e.message, 'error')))
		return
	if !song || song.isInsert
		return
	if state.remote
		if song !== state.song
			playerMessage('Only the playing song can be rated while the extension plays.')
			return
		const r = await remoteCommand(kind)
		if r && r.ok
			playerMessage(kind === 'ban' ? 'Banned. Skipping.' : 'Loved.')
		return
	try
		const r = await state.client.rate(song, kind)
		song.rating = r.rating
		crewThumb(kind === 'love' ? 'up' : 'down', song)
		updateHistoryItem(song)
		if song === state.song
			updateRatingButtons()
			if kind === 'ban'
				skip('Banned. Skipping.')
			else
				playerMessage('Loved.')
		else
			playerMessage(kind === 'ban' ? ''.concat('Banned ', song.title, '.') : ''.concat('Loved ', song.title, '.'))
	catch err
		playerMessage(describeError(err), 'error')

def rate(kind)
	return rateSong(state.song, kind)

def tired()
	if (state.rooms)?.active()
		return
	const room = ((state.rooms)?.getState())?.state
	if (room)?.play && room.play.dj !== room.you
		await state.rooms.command('room-command', {body: {action: 'react', play_id: room.play.id, reaction: 'dislike'}}).catch((do(e) playerMessage(e.message, 'error')))
		return
	const song = state.song
	if !song || song.isInsert
		return
	if state.remote
		const r = await remoteCommand('tired')
		if r && r.ok
			playerMessage('Pandora will rest this song for a month.')
		return
	try
		await state.client.tired(song)
		song.rating = 3
		updateHistoryItem(song)
		skip('Pandora will rest this song for a month.')
	catch err
		playerMessage(describeError(err), 'error')

def explain()
	if (state.rooms)?.active()
		return
	const room = ((state.rooms)?.getState())?.state
	if (room)?.play && room.play.dj !== room.you
		playerMessage('This song is streamed from the DJ’s player.')
		return
	const song = state.song
	if !song || song.isInsert || state.explaining
		return
	# the e key bypasses the disabled button
	if state.remote
		playerMessage('“Why this song?” is not available while the extension plays.')
		return
	state.explaining = true
	el.explain.disabled = true
	el.explain.setAttribute('aria-busy', 'true')
	playerMessage('Asking Pandora…', 'info', 0)
	try
		const text = await state.client.explain(song)
		if state.song !== song
			return
		# stale answer for a song that has moved on
		el.explainText.textContent = text || 'Pandora gave no explanation for this song.'
		el.explainPanel.hidden = false
		playerMessage('')
		# Move focus to the panel so assistive tech reads the answer.
		el.explainPanel.focus({preventScroll: true})
		el.explainPanel.scrollIntoView({block: 'nearest'})
	catch err
		if state.song === song
			playerMessage(describeError(err), 'error')
	finally
		state.explaining = false
		el.explain.removeAttribute('aria-busy')
		el.explain.disabled = !state.song
		if el.playerMessage.textContent === 'Asking Pandora…'
			playerMessage('')

def togglePlay(fromPhone = false)
	if !fromPhone && el.play.dataset.state === 'playing' && phone
		phone.manualPause()
	if (state.rooms)?.active()
		const a = (state.rooms.getState())?.audio
		state.rooms.command((a)?.paused || !['listening', 'broadcasting'].includes((a)?.state) ? 'room-resume' : 'room-pause').catch((do(e) playerMessage(e.message, 'error')))
		return
	if state.remote
		const rs = state.remoteState || {}
		if !state.song && !rs.station
			const st = lastStation()
			if st
				playStation(st)
			return
		remoteCommand(remoteResumable() ? 'resume' : 'toggle')
		return
	if state.resume
		resumeLast()
		return
	if !state.song
		const st = lastStation()
		if st
			playStation(st)
		return
	if el.audio.paused
		el.audio.play().catch((do
			return
		))
	else
		el.audio.pause()

def setQuality(q)
	state.quality = q
	el.quality.value = q
	store.set(STORAGE.quality, q)

# Volume applies immediately; the stored value is written once the slider settles.
let volumeSaveTimer = 0
def saveVolume()
	clearTimeout(volumeSaveTimer)
	store.set(STORAGE.volume, String(state.volume))
def setVolume(v)
	state.volume = clamp(Math.round(v), 0, 100)
	el.volume.value = el.barVolume.value = String(state.volume)
	applyVolume()
	clearTimeout(volumeSaveTimer)
	volumeSaveTimer = setTimeout(saveVolume, 400)
	if state.remote
		remoteVolumeBusy += 1
		clearTimeout(remoteVolumeTimer)
		remoteVolumeTimer = setTimeout((do
			try
				const roomId = ((state.rooms)?.getState())?.id
				await remoteCommand(roomId ? 'room-volume' : 'volume', {value: state.volume, ...roomId ? ({roomId}) : ({})})
			finally
				remoteVolumeBusy = 0
		), 150)
	elif (state.rooms)?.active()
		state.rooms.command('room-volume', {value: state.volume}).catch((do(e) playerMessage(e.message, 'error')))
let remoteVolumeTimer = 0
let remoteVolumeBusy = 0
# > 0 while a slider move has not been answered by the extension
# ---------------------------------------------------------------- media session
def updateMediaSession(song)
	if !(Reflect.has(navigator, 'mediaSession'))
		return
	try
		navigator.mediaSession.metadata = new MediaMetadata({
			title: song.title || '',
			artist: song.artist || '',
			album: song.album || '',
			artwork: artUrl(song) ? [{src: artUrl(song)}] : []
		})
		navigator.mediaSession.playbackState = 'playing'
	catch _
		# ignore

def installMediaSession()
	if !(Reflect.has(navigator, 'mediaSession'))
		return
	const set = (do(action, fn)
		try
			navigator.mediaSession.setActionHandler(action, fn)
		catch _
			# unsupported
	)
	set('play', (do
		return state.remote && !(state.rooms)?.active() ? remoteCommand('resume') : ((state.rooms)?.active() ? state.rooms.command('room-resume').catch((do(e) playerMessage(e.message, 'error'))) : el.audio.play().catch((do
			return
		)))
	))
	set('pause', (do
		return state.remote && !(state.rooms)?.active() ? remoteCommand('pause') : (state.rooms)?.active() ? state.rooms.command('room-pause').catch((do(e) playerMessage(e.message, 'error'))) : el.audio.pause()
	))
	set('nexttrack', (do skip()))
	set('previoustrack', null)
	set('stop', (do
		return state.remote && !(state.rooms)?.active() ? remoteCommand('pause') : (state.rooms)?.active() ? state.rooms.command('room-pause').catch((do(e) playerMessage(e.message, 'error'))) : stopPlayback()
	))

# ---------------------------------------------------------------- search
def renderSearch(results)
	el.searchResults.replaceChildren()
	const items = []
	for a of results.artists || []
		if a && a.musicId
			items.push({kind: 'artist', label: a.name || 'Unnamed artist', token: a.musicId})
	for s of results.songs || []
		if s && s.musicId
			items.push({kind: 'song', label: [s.title, s.artist].filter(Boolean).join(' — ') || 'Untitled', token: s.musicId})
	if items.length === 0
		const li = document.createElement('li')
		li.textContent = 'No matches.'
		el.searchResults.append(li)
	for it of items.slice(0, 30)
		const li = document.createElement('li')
		const b = document.createElement('button')
		b.type = 'button'
		b.title = ''.concat('Create a station from ', it.label)
		const k = document.createElement('span')
		k.className = 'kind'
		k.textContent = it.kind
		b.append(k, document.createTextNode(it.label))
		b.addEventListener('click', (do createStation(it.token, it.label)))
		li.append(b)
		el.searchResults.append(li)
	el.searchResults.hidden = false
	if items.length
		playerMessage(''.concat(items.length, ' result', items.length === 1 ? '' : 's', '; pick one to create a station.'))
	else
		playerMessage('')
	# the list already says "No matches."

def createStation(token, label, type)
	try
		playerMessage(''.concat('Creating station from ', label, '…'), 'info', 0)
		const before = new Set(state.stations.map((do(s) s.id)))
		state.stations = await state.client.createStation(token,type)
		el.searchResults.hidden = true
		el.searchInput.value = ''
		buildStations()
		playerMessage('Station created.')
		# The clicked result is gone from the DOM: land focus on the new station.
		const created = state.stations.find((do(s) !before.has(s.id)))
		const btn = created ? el.stationList.querySelector(''.concat('li[data-id="', CSS.escape(String(created.id)), '"] button.station')) : null
		(btn || el.searchInput).focus()
	catch err
		playerMessage(describeError(err), 'error')

# ---------------------------------------------------------------- remote mode
# When the melodica extension (0.3.0+) answers on this page, its background player is
# the only player: this page is a view of that playback and a remote for it (same UI,
# driven by the state the extension pushes; controls send commands; no local <audio>,
# no Pandora login here). The switch happens whenever the extension appears, also
# after the page started on its own. Without the extension the page plays on its own
# through the relay.
const CONNECTING = 'Connecting to the melodica extension…'
# Released extensions (0.5.x) do not push every change (not their login; a resume has
# been seen to arrive seconds late), so while the page is visible it also asks for the
# current state every second: the view is never more than about a second behind.
const REMOTE_REFRESH_MS = 1000

def remoteCommand(action, fields = {})
	try
		const r = await state.bridge.command(action, fields)
		if r.state
			renderRemote(r.state)
		if !r.ok
			playerMessage(r.error || ''.concat('The extension could not ', action, '.'), 'error')
		return r
	catch err
		playerMessage(describeError(err), 'error')
		return null

let sessionSyncedFor = ''
def onBridgeChange(bridge)
	if bridge.gone
		extensionWentAway(bridge)
		return
	updateStatus()
	if bridge.active && bridge.player && !state.remote
		pendingRoomImport = (state.rooms)?.getState()
		pendingPlaybackImport = localPlayback()
		enterRemote()
	if state.remote
		el.logout.hidden = !bridge.session
	# Once per extension (and version): exchange sessions (docs/BRIDGE.md 4.3).
	if bridge.active && bridge.player && bridge.session && sessionSyncedFor !== bridge.label
		sessionSyncedFor = bridge.label
		syncWithExtension().then(transferRoomToExtension).catch((do(e) console.debug('[bridge]', describeError(e))))

def openExtensionLogin()
	let r = null
	try
		r = await state.bridge.command('open-login', {}, 3000)
	catch _
		r = null
	# Older extensions do not know the command; then say where the login is.
	el.remoteSigninHelp.hidden = !!(r && r.ok)

def remoteSong(t)
	return {
		title: t.title || '',
		artist: t.artist || '',
		album: t.album || '',
		coverArt: t.coverArt || t.art || '',
		art_cached: typeof t.art_cached === 'string' ? t.art_cached : '',
		trackToken: t.trackToken || '',
		rating: t.rating || 0,
		duration: t.duration || 0,
		quality: t.quality || '',
		audioFormat: t.audioFormat || '',
		roomPlayId: t.roomPlayId || '',
		kind: t.kind || ''
	}

# A cold-started extension can restore its Pandora session without loading the
# station list (seen with 0.8.1 after a browser restart: loggedIn, no stations, for
# as long as nothing asks). Ask for the list then, at most every 3 s.
let remoteStationsAsked = 0
def askRemoteStations()
	const now = Date.now()
	if now - remoteStationsAsked < 3000
		return
	remoteStationsAsked = now
	state.bridge.command('stations').then((do(r)
		if r && r.state
			renderRemote(r.state)
	), (do(err) console.debug('[bridge]', ''.concat('stations: ', describeError(err)))))

let remoteStationsKey = ''
let remoteChangedAt = 0
let remoteNotice = ''
let remoteHistoryKey = ''
const songIdentity = (do(song) (song)?.roomPlayId ? ''.concat('room:', song.roomPlayId) : (song)?.trackToken || '')
const sameSong = (do(a, b) !!a && !!b && (a === b || !!songIdentity(a) && songIdentity(a) === songIdentity(b)))
def renderRemote(rs)
	# Command replies are not ordered against the extension's pushes: never draw a state
	# older than the one on screen (docs/BRIDGE.md 2, changedAt).
	const at = Number(rs && rs.changedAt)
	if Number.isFinite(at) && at > 0
		if at < remoteChangedAt
			return
		remoteChangedAt = at
	state.remoteState = rs
	(state.rooms)?.updateRemote(rs.room)
	if (state.bridge)?.kind === 'tab' && (rs.scrobble)?.loaded
		if !state.scrobbles
			state.scrobbles = new Scrobbles({origin: location.origin, token: scrobbleToken})
		state.scrobble = {...state.scrobble || newScrobbleState(), ...rs.scrobble}
		renderScrobbleSettings()
		startUi()
	markReady()
	if rs.loggedIn === false
		forgetSnapshot()
	else
		saveSnapshot()
	# Stations: rebuilt only when the list itself changed (keeps focus and scroll).
	const stations = (Array.isArray(rs.stations) ? rs.stations : []).filter((do(s) s && s.token)).map((do(s) ({id: s.token, name: s.name || '', isQuickMix: !!s.isQuickMix})))
	const key = JSON.stringify(stations)
	if key !== remoteStationsKey
		remoteStationsKey = key
		state.stations = stations
		buildStations()
	const cur = rs.station && rs.station.token ? rs.station : null
	state.station = cur ? state.stations.find((do(s) s.id === cur.token)) || {id: cur.token, name: cur.name || ''} : null
	if cur
		store.set(STORAGE.station, cur.token)
	markActiveStation()

	# Now playing.
	# Nothing loaded in the extension: the song it played last, paused, with Resume.
	const roomSnapshot = (state.rooms)?.getState()
	const inRoom = !!(roomSnapshot)?.id && !(roomSnapshot.state)?.closed_at
	const t = inRoom ? roomTrack((roomSnapshot.state)?.play) : rs.track && (rs.track.title || rs.track.trackToken) ? rs.track : rs.last && rs.last.trackToken ? rs.last : null
	const history = inRoom ? roomHistory(roomSnapshot) : Array.isArray(rs.history) ? rs.history.filter(Boolean).map(remoteSong) : null
	let songChanged = false
	if t
		const song = remoteSong(t)
		const metadataKey = (do(value)
			return JSON.stringify([
				songIdentity(value),
				(value)?.title,
				(value)?.artist,
				(value)?.album,
				(value)?.coverArt,
				(value)?.duration,
				(value)?.quality,
				(value)?.audioFormat
			])
		)
		if metadataKey(state.song) !== metadataKey(song)
			const known = !inRoom && state.history.find((do(s) s.trackToken && s.trackToken === t.trackToken))
			displaySong(known ? Object.assign(known, song) : song, {remember: !history})
			updateMediaSession(state.song)
			songChanged = true
		elif state.song.rating !== (t.rating || 0)
			state.song.rating = t.rating || 0
			updateRatingButtons()
			updateHistoryItem(state.song)
		el.station.textContent = state.station ? ''.concat('on ', state.station.name) : ''
	elif state.song
		state.song = null
		songChanged = true
		showIdle()
		updateRatingButtons()
		renderHistory()
	if history
		const key = JSON.stringify(history)
		if key !== remoteHistoryKey || songChanged
			remoteHistoryKey = key
			state.history = history.map((do(song) sameSong(song, state.song) ? state.song : song))
			renderHistory()
	setPlayIcon(rs.status === 'playing')
	if Reflect.has(navigator, 'mediaSession')
		navigator.mediaSession.playbackState = rs.status === 'playing' ? 'playing' : 'paused'
	const len = Number(rs.duration) || t && Number(t.duration) || 0
	const onLast = t && t === rs.last
	setProgress(Number(onLast ? rs.last.position : rs.position) || 0, len)
	updateResumeUi()
	if pendingSeed && rs.loggedIn === true
		playSeed(pendingSeed)
	if rs.notice && rs.notice !== remoteNotice
		playerMessage(rs.notice)
	remoteNotice = rs.notice || ''

	# Settings the extension owns.
	if Number.isFinite(Number(rs.volume)) && !remoteVolumeBusy
		state.volume = clamp(Math.round(Number(rs.volume)), 0, 100)
		el.volume.value = el.barVolume.value = String(state.volume)
	if QUALITIES.includes(rs.quality)
		state.quality = rs.quality
		el.quality.value = rs.quality

	renderUpNext()

	# No Pandora session in the extension: say where to sign in (the page has no login).
	const needsLogin = !inRoom && rs.loggedIn === false && (state.bridge)?.kind !== 'tab'
	if !inRoom && rs.loggedIn === true && !stations.length && rs.status !== 'loading' && (state.bridge)?.kind !== 'tab'
		askRemoteStations()
	if el.remoteSignin.hidden === needsLogin
		el.remoteSignin.hidden = !needsLogin
		if !needsLogin
			el.remoteSigninHelp.hidden = true
	if needsLogin
		el.hint.textContent = ''
	elif !state.song
		updateHint()
	if !inRoom && (state.bridge)?.kind === 'tab' && rs.loggedIn === false
		show(el.viewLogin)
	elif (state.bridge)?.kind === 'tab'
		show(el.viewPlayer)
	if el.playerMessage.textContent === CONNECTING
		playerMessage('')
	if rs.status === 'error' && rs.error && !needsLogin
		playerMessage(rs.error, 'error', 0)
	elif rs.status === 'loading'
		playerMessage('Loading…', 'info', 0)
	elif el.playerMessage.textContent === 'Loading…' || /^Loading .*…$/.test(el.playerMessage.textContent)
		playerMessage('')
	# The extension's username (0.5.4+ sends user: {username, …}); never an email.
	const name = !needsLogin && rs.user && typeof rs.user.username === 'string' ? rs.user.username : ''
	el.signedIn.textContent = name || extensionName()
	const place = (state.bridge)?.kind === 'tab' ? 'another melodica tab' : 'the melodica extension'
	el.signedInFull.textContent = ''.concat('Playing in ', place, name ? ''.concat(' as ', name) : '')
	paintRoomPlayback()

def enterRemote()
	if state.remote
		return
	(state.rooms)?.suspend()
	# The page may have started on its own: stop that and forget its Pandora session.
	if state.song || el.audio.getAttribute('src')
		stopPlayback()
	try
		if state.client && state.client.fn
			state.client.logout()
	catch _
		# not loaded yet
	state.remote = true
	if (state.tabs)?.owner
		state.engineReady = true
	el.app.dataset.mode = 'remote'
	markReady()
	# A remote never downloads or keeps audio: the extension's engine plays (and saves) it.
	if state.copies && (state.bridge)?.kind !== 'tab'
		copyMirrors.clear()
		copiesClearing = state.copies.clear()
	updateBar()
	el.audio.pause()
	el.audio.removeAttribute('src')
	el.audio.load()
	el.searchForm.hidden = true
	el.searchResults.hidden = true
	el.logout.hidden = !state.bridge.session
	# with the session layer, signing out here signs out both
	closeUsernamePick()
	el.usernameChange.hidden = true
	# the extension's account is the extension's to name
	el.signedIn.textContent = 'melodica extension'
	el.signedInFull.textContent = 'Playing in the melodica extension'
	show(el.viewPlayer)
	playerMessage(CONNECTING, 'info', 0)
	updateStatus()
	state.bridge.subscribe((do(st) renderRemote(st)))
	setInterval((do
		if document.visibilityState === 'visible' && state.bridge.gotState
			state.bridge.post({type: 'subscribe'})
	), REMOTE_REFRESH_MS)
	addEventListener('pagehide', (do state.bridge && state.bridge.unsubscribe()))
	(visibleStationButton())?.focus()

# ---------------------------------------------------------------- spacegho.st account
# Optional. The policy endpoint is asked with the account's token when signed in,
# else with the relay's access token from the Pandora login; without either the
# policy is the default (web/account.js, docs/ACCOUNT.md). No text explains it.
# Re-read the policy (after a login, a renewed relay token, sign-in or sign-out).
def refreshPolicy()
	const a = state.account
	state.policyReady = (a ? a.policy(state.client.accessToken) : Promise.resolve({inserts: true})).then((do(p)
		state.policy = p
	), (do
		state.policy = {inserts: true}
	))
	return state.policyReady

# The account line on the login card and the entries in the account menu.
def updateAccountLine()
	const a = state.account
	const available = !!(a && a.config)
	el.accountLine.hidden = !available
	const signedIn = available && a.signedIn
	el.accountSignin.hidden = signedIn
	el.loginGithub.hidden = !available
	el.accountSigned.hidden = !signedIn
	el.accountName.textContent = signedIn ? a.label : ''
	el.accountMenuLine.hidden = !signedIn
	el.accountMenuName.textContent = signedIn ? a.label : ''
	el.accountMenuSignout.hidden = !signedIn

# Discovery, a finished sign-in round trip, the policy and the profile.
# A panel route without any sign-in: a silent spacegho.st sign-in (prompt=none) so a
# visitor already signed in on spacegho.st with GitHub sees the panel with no click. At
# most once per route visit and never in a loop: the flag is set before leaving and
# cleared by Try again (and by a sign-in that completes). Returns true when navigating.
const PANEL_SILENT_KEY = 'melodica.account.panel-silent'
def silentPanelSignIn(name, {force = false} = {})
	const a = state.account
	if name === 'aquarium' || !a || !a.config || a.signedIn || state.remote || !PANES[name] && name !== 'rooms' || routeOf(location.pathname) !== name
		return false
	await state.savedReady
	if state.saved || state.remote
		return false
	if !force && a.session.get(PANEL_SILENT_KEY) === '1'
		return false
	a.session.set(PANEL_SILENT_KEY, '1')
	a.session.set(RETURN_KEY, name === 'rooms' ? location.pathname : ROUTE_PATH[name] || location.pathname)
	state.accountNavigating = true
	el.app.dataset.accountReady = 'false'
	try
		location.assign(await a.startUrl({prompt: 'none'}))
		return true
	catch _
		state.accountNavigating = false
		el.app.dataset.accountReady = 'true'
		a.session.remove(RETURN_KEY)
		return false

def setupAccount()
	const a = state.account
	if !(await a.discover())
		return
	const back = await a.finishRedirect(location, history)
	if back.done && !back.error
		store.remove(STORAGE.accountSignout)
	# signed in again: nothing to deliver
	# login_required answers a silent sign-in (prompt=none) when there is no spacegho.st session.
	if back.error && back.error !== 'login_required'
		loginMessage(''.concat('spacegho.st sign-in did not complete (', back.error, ').'), 'error')
	# Back from a round trip started on a panel route: return there (the redirect URI is the player).
	const ret = a.session.get(RETURN_KEY)
	if ret !== null && back.done
		a.session.remove(RETURN_KEY)
		if a.signedIn
			a.session.remove(PANEL_SILENT_KEY)
		if ret.startsWith(SHELL_BASE) && ret !== location.pathname
			history.replaceState(history.state, '', ret)
			renderRoute(routeOf(ret))
	# A panel route without any sign-in is handled by silentPanelSignIn (also when the
	# visitor arrives on the player and moves to a panel route later).
	if !back.done && (PANES[routeOf(location.pathname)] || isRoomsPath(location.pathname)) && (await silentPanelSignIn(routeOf(location.pathname)))
		return
	await refreshPolicy()
	if a.signedIn
		await a.profile()
	updateAccountLine()

def githubSignIn(ev)
	ev.preventDefault()
	try
		location.assign(await state.account.githubUrl())
	catch err
		loginMessage(describeError(err), 'error')

def accountSignIn(ev)
	ev.preventDefault()
	try
		location.assign(await state.account.startUrl())
	catch err
		loginMessage(describeError(err), 'error')

# Signing out of spacegho.st here signs the extension out of it too (docs/BRIDGE.md 4.6):
# at once when it is there, else at the next handshake.
def accountSignOut()
	if ((state.rooms)?.getState())?.id
		try
			await state.rooms.command('room-leave')
		catch e
			console.debug('[rooms]', describeError(e))
		finally
			state.rooms.leave({leave: false})
	await state.account.signOut()
	await refreshPolicy()
	updateAccountLine()
	store.set(STORAGE.accountSignout, '1')
	deliverAccountSignout()
	scrobblesAfterAccountChange()

# The spacegho.st account went away: the Scrobbles views start again with whatever
# token remains (the relay's), or close when none does.
def scrobblesAfterAccountChange()
	if !state.scrobble
		return
	clearScrobbles()
	if await scrobbleToken()
		loadScrobbles()

def deliverAccountSignout()
	const b = state.bridge
	if store.get(STORAGE.accountSignout) !== '1' || !b || !b.active || !b.session
		return
	let r = null
	try
		r = await b.accountSignout()
	catch _
		r = null
	if r && r.ok
		store.remove(STORAGE.accountSignout)

# The extension signed out of spacegho.st: so does this page, and no silent sign-in follows.
def onExtensionAccountSignout()
	const a = state.account
	if !a
		return
	a.session.set(SILENT_KEY, '1')
	if !a.signedIn
		return
	await a.signOut()
	await refreshPolicy()
	updateAccountLine()
	scrobblesAfterAccountChange()

# ---------------------------------------------------------------- username
# docs/ACCOUNT.md, Usernames: after the Pandora login the page asks
# /oauth/melodica/me (bearer: the spacegho.st account's token when signed in, else
# the relay's access token). The account chip shows the username, a generated
# listener-… until one is chosen, and never the email; names go in as text only.
# While the name is generated, "Pick a username" opens once per login; "Not now"
# keeps it closed for the rest of this browser session.
const USERNAME_LATER_KEY = 'melodica.username.later'

def showUsername(name)
	el.signedIn.textContent = name || 'Signed in'
	el.signedInFull.textContent = name ? ''.concat('Signed in as ', name) : 'Signed in to Pandora'
	el.usernameChange.hidden = !name
	if !name
		message(el.usernameChangeMessage, '', '', 0)
	if document.activeElement !== el.usernameChangeInput
		el.usernameChangeInput.value = name || ''

# A 401 invalid_token or 404 unknown_user (docs/ACCOUNT.md, Revoked tokens): the
# account's tokens are forgotten; a relay token that no longer counts ends the
# Pandora login too, and the login card says so.
def usernameAuthFailed(r)
	const revoked = r.status === 401 && r.error === 'invalid_token' || r.status === 404 && r.error === 'unknown_user'
	if !revoked
		return false
	if r.bearer === 'account'
		state.account.forget()
		updateAccountLine()
		refreshPolicy()
		return false
		# the relay token may still name the user: the caller asks again
	logout()
	loginMessage('Your melodica session has ended; log in again.', 'error')
	return true

def refreshMe({prompt = false} = {})
	const a = state.account
	if !a || state.remote || !state.client
		return
	let attempt = 0
	while attempt < 2
		const token = state.client.accessToken
		const me = await a.me(token)
		if state.remote || state.client.accessToken !== token || el.app.dataset.view !== 'player'
			return
		# logged out or moved on meanwhile
		if me.ok
			showUsername(me.username)
			if prompt && !me.chosen && a.session.get(USERNAME_LATER_KEY) !== '1'
				openUsernamePick(me)
			return
		if me.status === 0 || (await usernameAuthFailed(me))
			return
		if me.bearer !== 'account'
			return
		attempt++

def openUsernamePick(me)
	el.usernamePickCurrent.textContent = me.username
	el.usernamePickNotice.hidden = me.notice !== 'renamed_github'
	el.usernamePickInput.value = me.suggested || ''
	message(el.usernamePickMessage, '', '', 0)
	if typeof el.usernamePick.showModal === 'function'
		if !el.usernamePick.open
			el.usernamePick.showModal()
	else
		el.usernamePick.setAttribute('open', '')
	el.usernamePickInput.focus()
def closeUsernamePick()
	if !el.usernamePick.open
		return
	if typeof el.usernamePick.close === 'function'
		el.usernamePick.close()
	else
		el.usernamePick.removeAttribute('open')

# Checks the format here (the rest is the server's: reserved, taken, locked, rate
# limits) and shows the server's error_description next to the field.
def saveUsername(input, msgEl, button)
	const name = normalizeUsername(input.value)
	if !USERNAME_RE.test(name)
		message(msgEl, USERNAME_FORMAT, 'error', 0)
		input.focus()
		return false
	button.disabled = true
	message(msgEl, 'Saving…', 'info', 0)
	try
		const r = await state.account.setUsername(name, state.client.accessToken)
		if r.ok
			showUsername(r.username)
			message(msgEl, '', '', 0)
			return true
		if await usernameAuthFailed(r)
			return false
		message(msgEl, r.message, 'error', 0)
		input.focus()
		return false
	finally
		button.disabled = false

# ---------------------------------------------------------------- remembered session
# docs/BRIDGE.md 5: "Remember me on this device" keeps the Pandora session (and the
# relay token, and the credential for when the session has expired) encrypted in
# web/vault.js; nothing secret in localStorage. Off, logout or a revoked session wipes it.
def randomSid()
	const a = new Uint8Array(18)
	crypto.getRandomValues(a)
	return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '')

def revokedList()
	try
		const v = JSON.parse(store.get(STORAGE.revoked) || '[]')
		return Array.isArray(v) ? v.filter((do(x) typeof x === 'string')) : []
	catch _
		return []
def addRevoked(sid)
	if !sid
		return
	store.set(STORAGE.revoked, JSON.stringify([...revokedList().filter((do(x) x !== sid)), sid].slice(-8)))

def syncRemember()
	el.remember.checked = state.remember
	el.rememberMenu.checked = state.remember

def loadSaved()
	const plain = store.get(STORAGE.password)
	if plain !== null
		# Versions before 0.8.0 kept the password as plain text: move it, then erase it.
		const email = store.get(STORAGE.email) || ''
		store.remove(STORAGE.password)
		if plain && email
			await state.vault.write({session: null, credential: {email, password: plain}, relay: null})
	state.saved = await state.vault.read()
	state.remember = !!state.saved || store.get(STORAGE.rememberOff) !== '1'

def forgetSaved()
	state.saved = null
	checkpointEpoch++
	if state.tabs
		state.tabs.handoff = null
	if state.copies
		state.copies.clear()
	await checkpointWrite
	await state.vault.wipe()

def writeSaved(rec)
	state.saved = rec
	try
		await state.vault.write(rec)
	catch err
		console.debug('[vault]', describeError(err))

# The wasm client has a new Pandora session (a login or a re-login): a new sid, and
# stored when remembered.
def onClientSession()
	const c = state.client.credentials
	state.sessionMeta = {sid: randomSid(), email: c ? c.user : '', createdAt: Date.now()}
	persistSession()

def currentRecord()
	const s = state.client.session()
	if !s || !state.sessionMeta
		return null
	const c = state.client.credentials
	return {
		session: {...state.sessionMeta, ...s},
		credential: c ? ({email: c.user, password: c.password}) : null,
		relay: state.client.accessToken ? ({token: state.client.accessToken, at: state.client.accessAt}) : null
	}

def persistSession()
	if !state.remember || state.remote
		return
	const rec = currentRecord()
	if rec
		writeSaved(rec)

# The checkbox on the login card or in the account menu.
def rememberChoice(on)
	state.remember = !!on
	if state.remember
		store.remove(STORAGE.rememberOff)
	else
		store.set(STORAGE.rememberOff, '1')
def setRemember(on)
	if (state.bridge)?.kind === 'tab'
		remoteCommand('remember', {value: !!on})
		return
	rememberChoice(on)
	syncRemember()
	if !state.remember
		forgetSaved()
		return
	if state.remote
		if state.extSid
			syncWithExtension(true)
	else
		persistSession()

const RELAY_TOKEN_MS = 11 * 3600000
# the relay's tokens last 12 h
# Until when a relay token may be sent: its exp claim less 5 min (read, not verified:
# the relay verifies), else 11 h after it was received.
def relayTokenUntil(relay)
	if !relay || !relay.token
		return 0
	try
		const part = relay.token.split('.')[1]
		const exp = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))).exp
		if Number.isFinite(exp)
			return exp * 1000 - 300000
	catch _
		# not a JWT: the age rule below
	return (Number(relay.at) || 0) + RELAY_TOKEN_MS

# Resume the stored Pandora session; its credential is used only when Pandora or the
# relay no longer honour it (PianoClient re-logs in on 1001 / relay 401).
def resumeSaved()
	const s = state.saved
	if !s || !s.session || !state.client.restore(s.session)
		return false
	state.sessionMeta = {sid: s.session.sid, email: s.session.email, createdAt: s.session.createdAt}
	state.client.setCredentials(s.credential ? ({user: s.credential.email, password: s.credential.password}) : null)
	const fresh = s.relay && s.relay.token && Date.now() < relayTokenUntil(s.relay)
	state.client.restoreAccess(fresh ? s.relay.token : '', fresh ? s.relay.at : 0)
	if fresh
		refreshPolicy()
	el.loginButton.disabled = true
	loginMessage('Signing in…', 'info')
	try
		await state.policyReady
		if state.remote
			return true
		if s.session.email
			store.set(STORAGE.email, s.session.email)
		await enterPlayer()
		loginMessage('')
		persistSession()
		# a re-login meanwhile, or a new relay token
		return true
	catch err
		state.client.logout()
		state.sessionMeta = null
		if state.remote
			return false
		# An expired session without a stored password: sign in again (nothing is wiped).
		loginMessage(s.credential ? describeError(err) : 'Your Pandora session ended; sign in again.', s.credential ? 'error' : 'info')
		return false
	finally
		el.loginButton.disabled = false

# ---------------------------------------------------------------- sessions with the extension
# docs/BRIDGE.md 4: signed in on either side is signed in on both; signing out on
# either side signs out both. No prompt.
def accountView()
	const a = state.account
	return a && a.signedIn ? ({signedIn: true, username: a.name || '', github: null}) : ({signedIn: false, username: '', github: null})

def syncWithExtension(force = false)
	await state.savedReady
	let m
	try
		m = await state.bridge.sessionGet()
	catch err
		console.debug('[bridge]', describeError(err))
		return
	await applyExtensionSession(m, true, force)
	await transferPlaybackToExtension()
	startExtensionHandoff()
	deliverAccountSignout()

# m: {session, credential, account, revoked} from the extension (answer or push).
def applyExtensionSession(m, initial, force = false)
	await state.savedReady
	const mine = state.saved && state.saved.session
	if m.session
		if revokedList().includes(m.session.sid)
			# Signed out here while the extension was away: sign it out too.
			try
				await state.bridge.sessionLogout(m.session.sid)
			catch _
				# tried
			return
		if state.extSid && state.extSid !== m.session.sid
			lastExtensionPlayback = null
		state.extSid = m.session.sid
		const same = mine && mine.sid === m.session.sid
		const credential = m.credential || (state.saved && state.saved.credential && state.saved.credential.email === m.session.email ? state.saved.credential : null)
		const newAccess = !!m.access && !(state.saved && state.saved.relay && state.saved.relay.token === m.access)
		if !same || force || newAccess || JSON.stringify(credential) !== JSON.stringify(state.saved && state.saved.credential)
			# A copy in this page's own store, so it stays signed in without the extension.
			state.remember = true
			syncRemember()
			const relay = m.access ? ({token: m.access, at: Date.now()}) : same && state.saved ? state.saved.relay : null
			await writeSaved({session: m.session, credential, relay})
			if m.session.email
				store.set(STORAGE.email, m.session.email)
	else
		const mirrored = mine && (m.revoked.includes(mine.sid) || mine.sid === state.extSid)
		state.extSid = ''
		if mirrored
			(state.tabs)?.cache.clear()
			lastExtensionPlayback = null
			pendingPlaybackImport = null
			await forgetSaved()
			syncRemember()
			clearScrobbles()
		elif mine && initial
			let r = null
			try
				r = await state.bridge.sessionOffer({
					session: mine,
					credential: state.saved.credential || undefined,
					account: accountView(),
					playback: pendingPlaybackImport,
					stations: (pendingPlaybackImport)?.stations || state.stations,
					relay: state.saved.relay
				})
			catch _
				r = null
			if r && (r.outcome === 'revoked' || r.outcome === 'invalid')
				await forgetSaved()
			elif r && r.ok
				state.extSid = mine.sid
	applyExtensionAccount(m.account)
	if state.remote
		loadScrobbles()
	# the copy's token (or the account) reads the listens
	if state.extSid
		transferPlaybackToExtension()
		startExtensionHandoff()

# spacegho.st: the extension signed in and this page not -> a silent sign-in (prompt=none,
# once per browser session); the extension signed out after being signed in -> sign out.
const SILENT_KEY = 'melodica.account.silent'
const RETURN_KEY = 'melodica.account.return'
# the shell route a round trip started on
def applyExtensionAccount(acc)
	const a = state.account
	if !acc || !a || !a.config
		return
	if acc.signedIn && !a.signedIn && a.session.get(SILENT_KEY) !== '1'
		a.session.set(SILENT_KEY, '1')
		a.startUrl({prompt: 'none'}).then((do(u) location.assign(u)), (do
			return
		))

# Sign out from the remote: the extension signs out (and so does this page's copy).
def remoteLogout(sid)
	el.account.open = false
	try
		await state.bridge.sessionLogout(state.extSid || sid)
	catch err
		playerMessage(describeError(err), 'error')

# ---------------------------------------------------------------- login
def showLogin()
	if phone
		queueMicrotask(do phone.sync())
	el.audio.pause()
	playerMessage('')
	show(el.viewLogin)
	updateAccountLine()
	el.email.value = store.get(STORAGE.email) || ''
	el.password.value = ''
	syncRemember()
	(el.email.value ? el.password : el.email).focus()

def login(email, password)
	if (state.bridge)?.kind === 'tab'
		const result = await remoteCommand('login', {email, password, remember: el.remember.checked})
		if !(result)?.ok
			loginMessage((result)?.error || 'The player tab could not sign in.', 'error')
		return !!(result)?.ok
	el.loginButton.disabled = true
	loginMessage('Signing in…', 'info')
	try
		await state.accountReady
		# the playback policy is known before anything plays
		rememberChoice(el.remember.checked)
		if !state.remember
			await forgetSaved()
		await state.client.login(email, password)
		# onSession stores the session when remembered
		await state.policyReady
		# asked with the relay's new access token (onAccess)
		if store.get(STORAGE.email) !== email
			# A different account: its predecessor's play log (and rate tokens) must not carry over.
			state.history = []
			renderHistory()
		store.set(STORAGE.email, email)
		loginMessage('')
		await enterPlayer()
		checkpointEngine(true)
		return true
	catch err
		loginMessage(describeError(err), 'error')
		return false
	finally
		el.loginButton.disabled = false

# The player after a login or a resumed session.
def enterPlayer({quiet = false} = {})
	if !quiet
		showUsername('')
	# never the Pandora email: "Signed in" until /oauth/melodica/me names the user
	await loadStations()
	show(el.viewPlayer)
	updateHint()
	renderUpNext()
	if !quiet
		(visibleStationButton())?.focus()
	refreshMe({prompt: true})
	# not awaited: the username never holds up playback
	loadScrobbles()
	if pendingSeed
		playSeed(pendingSeed)
		return
	await offerResume()

# Signing out here signs out the extension too (docs/BRIDGE.md 4.4).
def logout()
	if linkedPlayer
		linkedPlayer.close('Signed out. Devices disconnected.')
	if !state.remote
		(state.rooms)?.leave()
	(state.tabs)?.cache.clear()
	forgetSnapshot()
	const sid = state.sessionMeta ? state.sessionMeta.sid : state.saved && state.saved.session ? state.saved.session.sid : ''
	if sid
		addRevoked(sid)
	state.sessionMeta = null
	forgetSaved()
	clearScrobbles()
	if (state.bridge)?.kind === 'tab'
		remoteCommand('logout')
		return
	if state.remote
		remoteLogout(sid)
		return
	closeUsernamePick()
	showUsername('')
	if state.account && !state.account.signedIn
		state.account.name = ''
	stopPlayback()
	state.client.logout()
	state.history = []
	renderHistory()
	# Nothing from this account may carry into the next one's session.
	el.searchResults.replaceChildren()
	el.searchResults.hidden = true
	el.searchInput.value = ''
	el.stationFilter.value = ''
	filterStations()
	showLogin()

# ---------------------------------------------------------------- scrobbling
# Spacegho.st Scrobbles (web/scrobble.js): on by default for a signed-in user, off in
# the account menu. The page submits only while its own audio plays; in remote mode
# the extension submits and the page only shows the listens (docs/BRIDGE.md 3).
const SCROBBLE_NOTICE_KEY = 'melodica.scrobble.noticeSeen'
const LISTENS_REFRESH_MS = 4000

def newScrobbleState()
	return {
		gen: 0,
		loaded: false,
		settings: null,
		crew: false,
		cursor: null,
		loading: false,
		tracker: null,
		retry: [],
		inflight: new Set(),
		ids: new Set()
	}

# The bearer: the relay's access token (here, or the extension's kept with the shared
# session), else the spacegho.st account's token.
def scrobbleToken()
	if (state.bridge)?.kind === 'tab'
		await state.savedReady
	if !state.remote && state.client && state.client.accessToken
		return state.client.accessToken
	const relay = state.saved && state.saved.relay
	if state.remote && relay && relay.token && relayTokenUntil(relay) > Date.now()
		return relay.token
	const a = state.account
	if a && a.signedIn
		try
			return await a.accessToken()
		catch _
			return ''
	return ''

def scrobbleOn()
	const sc = state.scrobble
	return !!(sc && sc.loaded && !sc.privateSession && sc.settings && sc.settings.scrobbling)

def renderScrobbleSettings()
	const sc = state.scrobble
	el.scrobbleSettings.hidden = !(sc && sc.loaded)
	const privacy = byId('private-session')
	privacy.textContent = (sc)?.privateSession ? 'End private session' : 'Start private session'
	privacy.disabled = !(sc)?.privacyKey || state.remote
	el.listensPanel.hidden = !(sc && sc.loaded)
	if sc && sc.loaded
		setNavCrew(!!sc.crew)
	remountOnAuth()
	if !sc || !sc.loaded
		return
	const links = state.scrobbles.links
	# on this page's origin
	byId('scrobble-dashboard').href = links.dashboard
	byId('scrobble-leaderboard').href = links.leaderboard
	byId('scrobble-crew').href = links.crew
	el.scrobbleOn.disabled = !!sc.privateSession
	el.scrobbleOn.checked = !!(sc.settings && sc.settings.scrobbling)
	el.scrobbleBoard.checked = !!(sc.settings && sc.settings.leaderboard)
	el.scrobbleBoard.disabled = !el.scrobbleOn.checked
	el.scrobbleCrewWrap.hidden = !sc.crew

def listenRow(l)
	const li = document.createElement('li')
	li.className = 'hist listen'
	li.dataset.id = String(l.id || '')
	const img = document.createElement('img')
	img.className = 'hist-cover'
	img.alt = ''
	img.loading = 'lazy'
	showArt(img, {coverArt: l.art || '', art_cached: l.art_cached || ''}, FALLBACK_COVER)
	const meta = document.createElement('div')
	meta.className = 'hist-meta'
	const t = document.createElement('span')
	t.className = 'hist-title'
	t.textContent = l.title || ''
	t.title = l.title || ''
	const a = document.createElement('span')
	a.className = 'hist-artist'
	a.textContent = l.artist || ''
	meta.append(t, a)
	if l.deployment
		import(UI_MODULE).then((do(mod)
			if !li.isConnected
				return
			const chip = mod.deployChip(l.deployment, ''.concat(location.origin, '/melodica/map/'))
			if chip
				meta.classList.add('sui')
				meta.append(chip)
		)).catch((do(err) console.debug('[deployment]', describeError(err))))
	const when = document.createElement('time')
	when.className = 'hist-when'
	const ms = Number(l.listened_at) * 1000
	if Number.isFinite(ms) && ms > 0
		const d = new Date(ms)
		when.dateTime = d.toISOString()
		const today = new Date().toDateString() === d.toDateString()
		when.textContent = today ? d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : d.toLocaleDateString([], {month: 'short', day: 'numeric'})
	li.append(img, meta, when)
	return li

# Adds listens (newest first) at the end, or at the top when fresh.
def addListens(list, fresh = false)
	const sc = state.scrobble
	const rows = []
	for l of Array.isArray(list) ? list : []
		if !l || sc.ids.has(l.id)
			continue
		sc.ids.add(l.id)
		rows.push(listenRow(l))
	if fresh
		el.listens.prepend(...rows)
	else
		el.listens.append(...rows)
	el.listensEmpty.hidden = el.listens.children.length > 0
	el.listensMore.hidden = !sc.cursor

# Settings and the last PAGE_SIZE listens, after a login, a resume or a shared session.
def loadScrobbles()
	if !state.scrobbles
		state.scrobbles = new Scrobbles({origin: location.origin, token: scrobbleToken})
	if !state.scrobble
		state.scrobble = newScrobbleState()
	const sc = state.scrobble
	if sc.loaded || sc.loading
		return
	const gen = sc.gen
	sc.loading = true
	try
		const me = await state.scrobbles.me()
		if state.scrobble !== sc || sc.gen !== gen
			return
		sc.settings = me.settings || {}
		const listener = (me.account)?.github || (((state.client)?.session())?.user)?.id || (state.sessionMeta)?.email || ''
		sc.storageKey = listener ? 'melodica.listens.pending.'+listener : ''
		sc.privacyKey = listener ? 'melodica.listens.private.'+listener : ''
		sc.privateSession = !!sc.privacyKey && store.get(sc.privacyKey) !== null
		if sc.storageKey && sc.settings.scrobbling
			try
				const saved = JSON.parse(store.get(sc.storageKey) || '[]')
				sc.retry = Array.isArray(saved) ? saved.filter(do(it) it && it.song && typeof it.song.title === 'string' && Number.isFinite(it.at)) : []
			catch _
				sc.retry = []
		sc.crew = !!me.crew_viewer
		sc.cursor = me.next_cursor || null
		sc.loaded = true
		el.listens.replaceChildren()
		sc.ids.clear()
		addListens((me.recent || []).slice(0, PAGE_SIZE))
		renderScrobbleSettings()
		startUi()
		if scrobbleOn() && !state.remote
			showScrobbleNotice()
		# A song already playing (a resume) still counts from here.
		if !state.remote && state.song && !sc.tracker
			scrobbleStart(state.song)
		flushScrobbleRetry()
	catch err
		console.debug('[scrobble]', describeError(err))
	finally
		sc.loading = false

def moreListens()
	const sc = state.scrobble
	if !sc || !sc.loaded || !sc.cursor || sc.paging
		return
	sc.paging = true
	const gen = sc.gen
	try
		const r = await state.scrobbles.listens(sc.cursor)
		if state.scrobble !== sc || sc.gen !== gen
			return
		sc.cursor = r.next_cursor || null
		addListens(r.listens)
	catch err
		console.debug('[scrobble]', describeError(err))
	finally
		sc.paging = false

# Newest listens on top (after a submit here, or a track change in the extension).
let listensTimer = 0
def scheduleListensRefresh()
	clearTimeout(listensTimer)
	listensTimer = setTimeout((do
		const sc = state.scrobble
		if !sc || !sc.loaded
			return
		const gen = sc.gen
		try
			const r = await state.scrobbles.listens('', PAGE_SIZE)
			if state.scrobble === sc && sc.gen === gen
				addListens(r.listens, true)
		catch err
			console.debug('[scrobble]', describeError(err))
	), LISTENS_REFRESH_MS)

def showScrobbleNotice()
	if store.get(SCROBBLE_NOTICE_KEY) === '1'
		return
	store.set(SCROBBLE_NOTICE_KEY, '1')
	if el.usernamePick.open
		return
	# next time, not over the username dialog
	if typeof el.scrobbleNotice.showModal === 'function'
		if !el.scrobbleNotice.open
			el.scrobbleNotice.showModal()
	else
		el.scrobbleNotice.setAttribute('open', '')

# A 403 scrobbling_off: the server's setting is off (changed elsewhere).
def scrobbleRefused(err)
	if !err || err.status !== 403 || err.code !== 'scrobbling_off'
		return false
	const sc = state.scrobble
	if sc && sc.settings
		sc.settings.scrobbling = false
	if sc
		sc.tracker = null
		sc.retry = []
	renderScrobbleSettings()
	return true

# A new song plays here: "playing now", and a tracker for the listen. Never an insert.
def scrobbleStart(song)
	const sc = state.scrobble
	if !sc
		return
	sc.tracker = null
	if !song || song.isInsert || state.remote || !scrobbleOn()
		return
	sc.tracker = new ListenTracker(song, Date.now() / 1000, Number(song.duration) || 0)
	sc.tracker.restore(song.melodicaPlay, (state.sessionMeta)?.sid || '')
	const len = el.audio.duration
	sc.tracker.setDuration(Number.isFinite(len) ? len : 0)
	sc.tracker.stationName = state.station ? String(state.station.name || '') : ''
	song.melodicaPlay = sc.tracker.snapshot((state.sessionMeta)?.sid || '')
	state.scrobbles.submit('playing_now', song, sc.tracker.duration, undefined, sc.tracker.stationName).catch((do(err)
		if !scrobbleRefused(err)
			console.debug('[scrobble]', describeError(err))
	))

def scrobbleTick()
	const sc = state.scrobble
	const tr = sc && sc.tracker
	if !tr || state.remote || tr.song !== state.song
		return
	if Number.isFinite(el.audio.duration)
		tr.setDuration(el.audio.duration)
	tr.tick(el.audio.currentTime, !el.audio.paused && !el.audio.ended)
	tr.song.melodicaPlay = tr.snapshot((state.sessionMeta)?.sid || '')
	if !tr.due() || !scrobbleOn()
		return
	tr.sent = true
	tr.song.melodicaPlay = tr.snapshot((state.sessionMeta)?.sid || '')
	sendListen({song: tr.song, duration: tr.duration, at: tr.startedAt, station: tr.stationName || ''})

def queueKey(item)
	return JSON.stringify([Math.floor(item.at),item.song.artist,item.song.title,item.song.album || ''])
def retryListensSoon(sc)
	if sc.retryTimer || !scrobbleOn()
		return
	sc.retryDelay = Math.min(300000,Math.max(5000,(sc.retryDelay || 0) * 2))
	sc.retryTimer = setTimeout((do
		sc.retryTimer = null
		if state.scrobble === sc
			flushScrobbleRetry()
	),sc.retryDelay)
def saveListenQueue(sc)
	if sc.storageKey
		store.set(sc.storageKey,JSON.stringify(sc.retry))

def sendListen(item)
	const sc = state.scrobble
	if !sc || !scrobbleOn() || state.remote
		return
	const key = queueKey(item)
	if sc.inflight.has(key)
		return
	if !sc.retry.some(do(other) queueKey(other) === key)
		const s = item.song
		sc.retry.push({song:{artist:s.artist,title:s.title,album:s.album,coverArt:s.coverArt,genome:s.genome},duration:item.duration,at:item.at,station:item.station})
		saveListenQueue(sc)
	sc.inflight.add(key)
	let finished = false
	try
		const result = await state.scrobbles.submit('single', item.song, item.duration, item.at, item.station || '')
		finished = true
		if sc === state.scrobble
			if (sc.tracker)?.song === item.song && sc.tracker.startedAt === item.at
				sc.tracker.saved = true
			reefReceipts.dispatchEvent(new Event('listen'))
			showDeployment(result.deployment)
			scheduleListensRefresh()
	catch err
		if sc === state.scrobble && scrobbleRefused(err)
			finished = true
		elif err.status >= 400 && err.status < 500 && ![401,408,429].includes(err.status)
			finished = true
	finally
		sc.inflight.delete(key)
		if !finished && sc === state.scrobble
			retryListensSoon(sc)
		if finished && sc === state.scrobble
			sc.retryDelay = 0
			sc.retry = sc.retry.filter(do(other) queueKey(other) !== key)
			saveListenQueue(sc)

def flushScrobbleRetry()
	const sc = state.scrobble
	if sc && sc.retry.length && scrobbleOn() && !state.remote
		for item of sc.retry.slice()
			await sendListen(item)
			if sc !== state.scrobble || !scrobbleOn()
				return

def togglePrivate()
	const sc = state.scrobble
	if !sc || !sc.privacyKey || state.remote || sc.privateBusy
		return
	sc.privateBusy = true
	const wasPrivate = sc.privateSession
	try
		if wasPrivate
			const restore = store.get(sc.privacyKey) === 'on'
			if restore
				sc.settings = await state.scrobbles.setSettings({scrobbling:true})
			store.remove(sc.privacyKey)
			sc.privateSession = false
			if sc === state.scrobble && scrobbleOn() && state.song
				scrobbleStart(state.song)
		else
			const wasOn = !!sc.settings.scrobbling
			if (state.rooms)?.active()
				if !await confirmDialog('Leave this room to start a private session?')
					return
				await state.rooms.leave()
			sc.privateSession = true
			sc.tracker = null
			try
				sc.settings = await state.scrobbles.setSettings({scrobbling:false})
			catch e
				sc.privateSession = false
				throw e
			store.set(sc.privacyKey,wasOn ? 'on' : 'off')
		if sc === state.scrobble
			message(el.scrobbleMessage,sc.privateSession ? 'Private session on. Account activity and submissions are paused.' : 'Private session ended.','info')
	catch e
		message(el.scrobbleMessage,e.message,'error')
	finally
		sc.privateBusy = false
		renderScrobbleSettings()

def setScrobbleSetting(patch)
	if (state.bridge)?.kind === 'tab'
		await remoteCommand('scrobble-settings', {patch})
		return
	const sc = state.scrobble
	if !sc || !sc.loaded
		return
	el.scrobbleOn.disabled = el.scrobbleBoard.disabled = true
	message(el.scrobbleMessage, 'Saving…', 'info', 0)
	try
		const r = await state.scrobbles.setSettings(patch)
		if state.scrobble !== sc
			return
		sc.settings = Object.assign(sc.settings || {}, r && typeof r === 'object' ? r : patch)
		message(el.scrobbleMessage, '', '', 0)
		if Reflect.has(patch, 'scrobbling')
			if !sc.settings.scrobbling
				sc.tracker = null
				sc.retry = []
				saveListenQueue(sc)
			elif !state.remote && state.song
				scrobbleStart(state.song)
	catch err
		message(el.scrobbleMessage, err && err.message ? err.message : 'Could not save.', 'error')
	finally
		el.scrobbleOn.disabled = false
		renderScrobbleSettings()

# Logout (here or in the extension): nothing of this listener stays on the page.
def clearScrobbles()
	stopUi()
	clearTimeout(listensTimer)
	if state.scrobble
		clearTimeout(state.scrobble.retryTimer)
		state.scrobble.gen += 1
	state.scrobble = null
	setNavCrew(true)
	el.listens.replaceChildren()
	el.listensEmpty.hidden = false
	el.listensMore.hidden = true
	message(el.scrobbleMessage, '', '', 0)
	renderScrobbleSettings()

# ---------------------------------------------------------------- scrobbles panels
# The shared Scrobbles UI (melodica-scrobble ui/, contract v1 in its docs/CLIENTS.md),
# fetched pinned into vendor/scrobble-ui/ at build time: Your listens (live), Leaderboard
# and, for the GitHub crew, the Map. It loads after the first /scrobble/api/me answer;
# without it the listens list above (v0.9.0) is the fallback.
const UI_MODULE = './vendor/scrobble-ui/scrobble-ui.js'
let resolveAccountStarted
const accountStarted = new Promise((do(resolve)
	resolveAccountStarted = resolve
))
def accountForPanels()
	# The shell mounts while the engine opens its vault. Wait for the actual account
	# startup promise, rather than the resolved placeholder used by remote tabs.
	if (state.tabs)?.owner
		await accountStarted
	await state.accountReady
const PANES = {
	listens: 'mountListens',
	leaderboard: 'mountLeaderboard',
	map: 'mountMap',
	garden: 'mountGarden',
	aquarium: 'mountAquarium'
}
def visualizerPlaybackBlob(signal)
	# Reuse the authenticated audio-copy path when a CDN blocks Web Audio.
	# Visualizers read the bytes in parallel with the unchanged player source.
	const song = state.song
	if state.remote || (song)?.isInsert || !(song)?.audioUrl || !state.copies
		return null
	return state.copies.readBlob(song, {signal})

const reefReceipts = new EventTarget()

def listenProgress(tracker, duration)
	const target = listenThreshold(duration)
	if !tracker || !Number.isFinite(target)
		return null
	return {played: Math.min(target, tracker.played), target, saved: tracker.saved === true}

def reefPlayback()
	if state.remote
		const remoteState = state.remoteState
		const track = (remoteState)?.track
		if !(track)?.artist || track.isInsert || track.kind === 'insert' || (remoteState.status !== 'playing' && remoteState.status !== 'paused')
			return null
		let progress = remoteState.reefProgress
		const exported = lastExtensionPlayback
		if !progress && (exported)?.sid === state.extSid && track.trackToken && (exported.song)?.trackToken === track.trackToken
			progress = listenProgress(exported.song.melodicaPlay, exported.song.duration)
		return {artist: track.artist, title: track.title, playing: remoteState.status === 'playing', progress}
	const song = state.song
	if !(song)?.artist || song.isInsert || state.resume
		return null
	const tracker = (state.scrobble)?.tracker
	return {
		artist: song.artist,
		title: song.title,
		playing: !el.audio.paused && !el.audio.ended,
		disabled: (state.scrobble)?.loaded && !scrobbleOn(),
		progress: (tracker)?.song === song ? listenProgress(tracker, tracker.duration) : null
	}

let ui = null
# {mod, client, live, views, crew}
let uiPane = 'listens'
let deploymentView = null
const shownDeployments = new Set()

# Both the submit answer and the owner's live event describe the same listen.
# Show it once whichever arrives first; listeners on other devices still receive
# the live feedback. No player or song state is persisted from these events.
def showDeployment(deployment)
	if !deployment || !Array.isArray(deployment.listens) || !deployment.listens.length
		return
	const sc = state.scrobble
	let mod
	try
		mod = await import(UI_MODULE)
	catch err
		console.debug('[deployment]', describeError(err))
		return
	if !sc || state.scrobble !== sc
		return
	# A play can grow the reef even when it earns no Conquest armies.
	if !deployment.counted && (route === 'aquarium' || (route === 'app' && uiPane === 'aquarium'))
		return
	const key = JSON.stringify([deployment.season, deployment.listens.map((do(l) [l.listened_at, l.artist_name, l.track_name, l.counted, l.units, l.reason]))])
	if shownDeployments.has(key)
		return
	shownDeployments.add(key)
	if shownDeployments.size > 100
		shownDeployments.delete(shownDeployments.values().next().value)
	if !deploymentView
		deploymentView = mod.mountDeployToast(el.deployFeedback)
	deploymentView.show(deployment)

def watchDeployments(mine)
	const live = mine.live
	live.addEventListener('deploy', (do(ev)
		if ui === mine
			showDeployment((ev.detail)?.deployment)
	))
	live.addEventListener('retreat', (do(ev)
		if ui !== mine
			return
		if !deploymentView
			deploymentView = mine.mod.mountDeployToast(el.deployFeedback)
		if deploymentView
			deploymentView.retreat((ev.detail)?.retreat)
	))

# Here the relay token first (as for submitting); in remote mode the spacegho.st account
# first. null means the spacegho.st session cookie, when there is one.
def uiToken()
	if state.remote
		const a = state.account
		if a && a.signedIn
			try
				const t = await a.accessToken()
				if t
					return t
			catch _
				# below
	return (await scrobbleToken()) || null

def uiLiveState(st)
	el.liveState.textContent = st === 'open' ? 'live' : st === 'polling' ? 'updating' : ''
	el.liveState.dataset.state = st || ''

def watchAccountLive(live)
	for type of ['playing', 'listen']
		live.addEventListener(type, (do(ev) (state.tabs)?.updateScrobbles(ev.detail)))

def startUi()
	if ui
		return
	const mine = ui = {views: {}, crew: !!(state.scrobble && state.scrobble.crew)}
	let mod
	try
		mod = await import(UI_MODULE)
	catch err
		console.debug('[scrobble-ui]', describeError(err))
		if ui === mine
			el.listensFallback.hidden = false
		return
	if ui !== mine
		return
	# signed out meanwhile
	mine.mod = mod
	mine.client = mod.createClient({base: location.origin, token: uiToken})
	mine.live = mine.client.live()
	watchAccountLive(mine.live)
	watchDeployments(mine)
	mine.live.addEventListener('state', (do(e) uiLiveState(e.detail && e.detail.state || e.state)))
	el.listensFallback.hidden = true
	byId('tab-map').hidden = !mine.crew
	if uiPane === 'map' && !mine.crew
		uiPane = 'listens'
	showPane(uiPane, false)

def showPane(name, focus = true)
	# One map: the player's Map tab is the /melodica/map/ route of the shell.
	if ['map', 'garden', 'aquarium'].includes(name) && location.pathname.startsWith(SHELL_BASE)
		go(name)
		return
	uiPane = name
	for tab of el.listensPanel.querySelectorAll('[role="tab"]')
		const on = tab.dataset.pane === name
		tab.setAttribute('aria-selected', String(on))
		tab.tabIndex = on ? 0 : -1
		if on && focus
			tab.focus()
	for k of Object.keys(PANES)
		const pane = byId(''.concat('pane-', k))
		if pane
			pane.hidden = k !== name
	if !ui || !ui.mod || ui.views[name]
		return
	const host = byId(''.concat('sui-', name))
	if !host
		return
	try
		const opts = {client: ui.client, live: ui.live}
		if name === 'listens'
			opts.pageSize = 25
			opts.scrollRoot = host
		# scrolls inside its own box (0.9.1)
		if name === 'leaderboard'
			opts.window = '7d'
		if name === 'map'
			opts.onStation = stationFromSeeds
		if ['map', 'garden', 'aquarium'].includes(name)
			opts.onPlay = playSeed
		if name === 'garden' || name === 'aquarium'
			opts.audio = el.audio
			opts.loadPlayback = visualizerPlaybackBlob
		if name === 'aquarium'
			opts.getPlayback = reefPlayback
			opts.receipts = reefReceipts
		ui.views[name] = ui.mod[PANES[name]](host, opts)
	catch err
		console.debug('[scrobble-ui]', describeError(err))

def stopUi()
	const mine = ui
	ui = null
	uiPane = 'listens'
	if deploymentView
		deploymentView.unmount()
	deploymentView = null
	shownDeployments.clear()
	if mine
		for v of Object.values(mine.views)
			try
				v.unmount()
			catch _
				# gone
		try
			if mine.live
				mine.live.close()
		catch _
			# closed
	for k of Object.keys(PANES)
		(byId(''.concat('sui-', k)))?.replaceChildren()
	byId('tab-map').hidden = true
	el.listensFallback.hidden = true
	uiLiveState('')
	showPane('listens', false)

def installUiEvents()
	const tabs = (do [...el.listensPanel.querySelectorAll('[role="tab"]')].filter((do(t) !t.hidden)))
	for tab of el.listensPanel.querySelectorAll('[role="tab"]')
		tab.addEventListener('click', (do showPane(tab.dataset.pane)))
		tab.addEventListener('keydown', (do(ev)
			if !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)
				return
			ev.preventDefault()
			const list = tabs()
			const i = list.indexOf(tab)
			const next = ev.key === 'Home' ? list[0] : ev.key === 'End' ? list[list.length - 1] : list[(i + (ev.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length]
			showPane(next.dataset.pane)
		))
	for k of Object.keys(PANES)
		byId(''.concat('sui-', k)).addEventListener('sui:error', (do(ev) console.debug('[scrobble-ui]', k, ev.detail && ev.detail.code)))
		byId(''.concat('sui-', k)).addEventListener('sui:live', (do(ev) uiLiveState(ev.detail && ev.detail.state)))
	# The site nav: same pages on this origin (a self-hosted copy keeps its own host).
	for a of document.querySelectorAll('.top a[data-k]')
		const u = new URL(a.getAttribute('href'))
		a.href = ''.concat(location.origin, u.pathname)

def installScrobbleEvents()
	byId('private-session').onclick = togglePrivate
	window.addEventListener('online',flushScrobbleRetry)
	installUiEvents()
	el.scrobbleOn.addEventListener('change', (do setScrobbleSetting({scrobbling: el.scrobbleOn.checked})))
	el.scrobbleBoard.addEventListener('change', (do setScrobbleSetting({leaderboard: el.scrobbleBoard.checked})))
	el.listensMore.addEventListener('click', (do moreListens()))
	closeOnBackdrop(el.scrobbleNotice, (do el.scrobbleNotice.close()))
	if Reflect.has(window, 'IntersectionObserver')
		new IntersectionObserver((do(entries)
			if entries.some((do(e) e.isIntersecting))
				moreListens()
		), {root: byId('listens-box'), rootMargin: '0px'}).observe(el.listensMore)
		# inside the box only, once it is scrolled to

# ---------------------------------------------------------------- shortcuts sheet
let shortcutsFromMenu = false
def openShortcuts(fromMenu = false)
	shortcutsFromMenu = fromMenu && el.account.open
	el.account.open = false
	if typeof el.shortcuts.showModal === 'function'
		if !el.shortcuts.open
			el.shortcuts.showModal()
	else
		el.shortcuts.setAttribute('open', '')
def closeShortcuts()
	if typeof el.shortcuts.close === 'function'
		el.shortcuts.close()
	else
		el.shortcuts.removeAttribute('open')

# ---------------------------------------------------------------- wiring
def installEvents()
	document.getElementById('bar-lyrics')?.addEventListener('click', do
		if location.pathname.startsWith(SHELL_BASE) && route !== 'app'
			go('app')
		lyricElement.open = true
		lyricElement.querySelector('summary').focus({preventScroll: true})
		lyricElement.scrollIntoView({block: 'center'})
	)
	el.loginForm.addEventListener('submit', (do(ev)
		ev.preventDefault()
		login(el.email.value.trim(), el.password.value)
	))
	el.remember.addEventListener('change', (do setRemember(el.remember.checked)))
	el.rememberMenu.addEventListener('change', (do setRemember(el.rememberMenu.checked)))
	el.shortcutsEnabled.checked = state.shortcutsOn
	el.shortcutsEnabled.addEventListener('change', (do
		state.shortcutsOn = el.shortcutsEnabled.checked
		store.set(STORAGE.shortcuts, state.shortcutsOn ? '1' : '0')
	))
	el.logout.addEventListener('click', logout)
	el.usernamePickForm.addEventListener('submit', (do(ev)
		ev.preventDefault()
		if await saveUsername(el.usernamePickInput, el.usernamePickMessage, el.usernamePickSave)
			closeUsernamePick()
	))
	el.usernamePickLater.addEventListener('click', (do
		state.account.session.set(USERNAME_LATER_KEY, '1')
		closeUsernamePick()
	))
	el.usernamePick.addEventListener('cancel', (do state.account.session.set(USERNAME_LATER_KEY, '1')))
	el.usernameChange.addEventListener('submit', (do(ev)
		ev.preventDefault()
		if await saveUsername(el.usernameChangeInput, el.usernameChangeMessage, el.usernameChangeSave)
			message(el.usernameChangeMessage, 'Saved.', 'info', 4000)
	))
	el.accountSignin.addEventListener('click', accountSignIn)
	el.loginGithub.addEventListener('click', githubSignIn)
	el.remoteSigninOpen.addEventListener('click', openExtensionLogin)
	el.roomLeave.addEventListener('click', (do roomAction('room-leave')))
	el.roomStopDj.addEventListener('click', (do roomAction('room-command', {body: {action: 'leave-dj'}})))
	el.roomBrowse.addEventListener('toggle', (do
		if el.roomBrowse.open
			mountPlayerRooms()
	))
	el.accountSignout.addEventListener('click', accountSignOut)
	el.accountMenuSignout.addEventListener('click', (do
		el.account.open = false
		accountSignOut()
	))
	el.refreshStations.addEventListener('click', (do
		if roomBlocksSource((state.rooms)?.getState())
			return
		if state.remote
			remoteCommand('stations')
			return
		loadStations().catch((do(e) playerMessage(describeError(e), 'error')))
	))
	el.stationFilter.addEventListener('input', filterStations)
	el.stationFilter.addEventListener('keydown', (do(ev)
		if ev.key === 'Enter'
			ev.preventDefault()
			const first = el.stationList.querySelector('li:not([hidden]) button.station')
			if first
				first.click()
		elif ev.key === 'Escape' && el.stationFilter.value
			ev.preventDefault()
			el.stationFilter.value = ''
			filterStations()
	))
	el.searchForm.addEventListener('submit', (do(ev)
		ev.preventDefault()
		const q = el.searchInput.value.trim()
		if !q
			el.searchResults.hidden = true
			return
		try
			renderSearch(await state.client.search(q))
		catch err
			playerMessage(describeError(err), 'error')
	))

	el.play.addEventListener('click', whenReady(togglePlay))
	el.next.addEventListener('click', (do skip()))
	el.love.addEventListener('click', (do rate('love')))
	el.ban.addEventListener('click', (do rate('ban')))
	el.tired.addEventListener('click', tired)
	el.explain.addEventListener('click', explain)
	el.explainClose.addEventListener('click', (do
		el.explainPanel.hidden = true
		el.explain.focus()
	))
	el.volume.addEventListener('input', (do setVolume(Number(el.volume.value))))
	el.volume.addEventListener('change', saveVolume)
	el.barVolume.addEventListener('input', (do setVolume(Number(el.barVolume.value))))
	el.barVolume.addEventListener('change', (do
		saveVolume()
		el.volume.dispatchEvent(new Event('change'))
	))
	el.quality.addEventListener('change', (do
		if (state.rooms)?.active()
			el.quality.value = state.quality
			return
		if state.remote
			remoteCommand('quality', {value: QUALITIES.includes(el.quality.value) ? el.quality.value : 'high'})
			return
		setQuality(QUALITIES.includes(el.quality.value) ? el.quality.value : 'high')
		const wasFetching = state.fetching !== null
		state.queue = []
		state.playGen += 1
		# a playlist in flight at the old quality is dropped
		renderUpNext()
		# Nothing playing (a load was in flight or the playlist ran dry): refetch at the new quality.
		if state.station && (!state.song || el.audio.ended || wasFetching)
			nextSong()
	))
	el.shortcutsOpen.addEventListener('click', (do openShortcuts(true)))
	el.shortcutsClose.addEventListener('click', closeShortcuts)
	el.shortcuts.addEventListener('close', (do
		# The menu item that opened the sheet sits in a collapsed <details>, so the
		# native focus restore lands on <body>; send focus to the menu button instead.
		if shortcutsFromMenu || document.activeElement === document.body || !document.activeElement
			if !el.account.hidden
				el.account.querySelector('summary').focus()
		shortcutsFromMenu = false
	))
	closeOnBackdrop(el.shortcuts, closeShortcuts)
	closeOnBackdrop(el.confirm, (do el.confirm.close('no')))
	document.addEventListener('click', (do(ev)
		if el.account.open && !el.account.contains(ev.target)
			el.account.open = false
	))

	const a = el.audio
	a.addEventListener('playing', (do insertPlayedOnce(state.song)))
	a.addEventListener('play', (do
		if state.remote || (state.rooms)?.active()
			return
		setPlayIcon(true)
		if Reflect.has(navigator, 'mediaSession')
			navigator.mediaSession.playbackState = 'playing'
	))
	a.addEventListener('pause', (do
		if state.remote || (state.rooms)?.active()
			return
		setPlayIcon(false)
		if Reflect.has(navigator, 'mediaSession')
			navigator.mediaSession.playbackState = 'paused'
	))
	a.addEventListener('timeupdate', (do
		if state.remote
			return
		scrobbleTick()
		if (state.rooms)?.active()
			return
		const len = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : state.song ? state.song.duration : 0
		if len
			setProgress(a.currentTime, len)
		else
			(lyrics)?.tick(a.currentTime)
			const t = fmtTime(a.currentTime)
			if t !== el.timeCur.textContent
				el.timeCur.textContent = t
	))
	a.addEventListener('ended', (do
		if state.remote
			return
		state.consecutiveAudioErrors = 0
		if state.song && state.copies
			state.copies.drop(state.song.trackToken)
		# its copy is done with
		if (state.rooms)?.active()
			const room = (state.rooms.getState())?.state
			if ((room)?.play)?.dj === (room)?.you && room.you_broadcasting !== false
				state.rooms.command('room-command', {body: {action: 'end', play_id: room.play.id}}).catch((do(e) playerMessage(e.message, 'error')))
			return
		nextSong()
	))
	a.addEventListener('pause', (do persistLast()))
	a.addEventListener('error', (do
		if (phone)?.offline()
			return
		if state.remote
			return
		if !state.song || state.resuming || state.preparingRoomAudio
			return
		# source preparation handles its own fallback
		if (state.rooms)?.active()
			const room = (state.rooms.getState())?.state
			if (room)?.current_dj === (room)?.you && room.you_broadcasting !== false
				a.pause()
				playerMessage('The broadcast source needs attention. Reconnect room audio or explicitly skip this play.', 'error', 0)
			return
		state.consecutiveAudioErrors += 1
		const code = a.error ? a.error.code : 0
		const why = code === 4 ? ''.concat('this browser cannot play ', state.song.audioFormat, ' audio') : ''.concat('audio error ', code)
		if state.consecutiveAudioErrors >= 2 && state.quality !== 'low'
			setQuality(lowerQuality(state.quality))
			state.queue = []
			renderUpNext()
			playerMessage(''.concat('Skipping: ', why, '. Trying ', state.quality, ' quality.'), 'error')
		elif state.consecutiveAudioErrors >= 4
			playerMessage(''.concat('Giving up: ', why, '.'), 'error', 0)
			return
		else
			playerMessage(''.concat('Skipping: ', why, '.'), 'error')
		state.keepMessage = true
		nextSong()
	))

	document.addEventListener('keydown', (do(ev)
		if el.viewPlayer.hidden
			return
		const t = ev.target
		if t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
			return
		if ev.ctrlKey || ev.metaKey || ev.altKey
			return
		if ev.key === 'Escape'
			if el.account.open
				el.account.open = false
				el.account.querySelector('summary').focus()
			return
		if el.confirm.open
			return
		# the confirm sheet owns the keyboard
		if el.shortcuts.open && ev.key !== '?'
			return
		if !state.shortcutsOn && ev.key !== '?'
			return
		# single-key shortcuts turned off in the sheet
		# Space on a dialog, menu, summary or link activates that control; on the
		# transport and station buttons it toggles playback (as in the original).
		if ev.key === ' ' && t && t.closest && t.closest('dialog, details, summary, a')
			return
		switch ev.key
			when ' '
				ev.preventDefault()
				togglePlay()
			when 'n'
				skip()
			when '+', '='
				rate('love')
			when '-'
				rate('ban')
			when 't'
				tired()
			when 'e'
				explain()
			when ')'
				setVolume(state.volume + 5)
			when '('
				setVolume(state.volume - 5)
			when 's'
				(visibleStationButton())?.focus()
			when '/'
				ev.preventDefault()
				el.stationFilter.focus()
				el.stationFilter.select()
			when '?'
				ev.preventDefault()
				if el.shortcuts.open
					closeShortcuts()
				else
					openShortcuts()
			else
				return
	))

# ---------------------------------------------------------------- Conquest v2 (0.11.0)
# The crew's map (melodica-scrobble): a thumb is a vote for its artist's town, and a
# listen carries the song's Music Genome traits. Neither ever holds up playback; the
# server's 403 (not crew), 404 unknown_town and 429 thumbs_spent are expected answers.
const genomes = new Map()
# trackToken -> traits (or null), one explain per song
def loadGenome(song)
	if !song || song.isInsert || !song.trackToken || song.genome !== undefined
		return
	if genomes.has(song.trackToken)
		song.genome = genomes.get(song.trackToken)
		return
	genomes.set(song.trackToken, null)
	if genomes.size > 200
		genomes.delete(genomes.keys().next().value)
	try
		const traits = genomeTraits(await state.client.explain(song))
		genomes.set(song.trackToken, traits)
		song.genome = traits
	catch err
		console.debug('[genome]', describeError(err))

# game/skip and game/station: the same rules as thumbs (crew only, never blocking).
def crewGame(path, body)
	if state.remote || !state.scrobbles || !state.scrobble || !state.scrobble.crew
		return
	state.scrobbles.game(path, body).catch((do(err)
		if ![403, 404, 429].includes(err && err.status)
			console.debug('[game]', path, describeError(err))
	))

def crewThumb(direction, song)
	if state.remote || !state.scrobbles || !state.scrobble || !state.scrobble.crew || !song || song.isInsert
		return
	state.scrobbles.thumb(direction, song).catch((do(err)
		if ![403, 404, 429].includes(err && err.status)
			console.debug('[thumb]', describeError(err))
	))

# The map's "start a station here": a Pandora station from the town's first seed that
# Pandora finds (a song, else its artist), then played.
def stationFromSeeds(station)
	if state.remote
		throw new Error('The extension is playing: start stations there.')
	if !state.client || !state.client.session()
		throw new Error('Sign in to play first.')
	const seeds = Array.isArray(station && station.seeds) ? station.seeds : []
	const low = (do(v) String(v || '').trim().toLowerCase())
	for seed of seeds
		if !seed || !seed.artist_name
			continue
		const q = seed.track_name ? ''.concat(seed.track_name, ' ', seed.artist_name) : seed.artist_name
		let r
		try
			r = await state.client.search(q)
		catch err
			console.debug('[map]', describeError(err))
			continue
		const songs = (r.songs || []).filter((do(x) x && x.musicId))
		const artists = (r.artists || []).filter((do(x) x && x.musicId))
		const pick = seed.track_name && (songs.find((do(x) low(x.artist) === low(seed.artist_name) && low(x.title) === low(seed.track_name))) || songs.find((do(x) low(x.artist) === low(seed.artist_name)))) || artists.find((do(x) low(x.name) === low(seed.artist_name))) || songs[0] || artists[0]
		if !pick
			continue
		const before = new Set(state.stations.map((do(x) x.id)))
		state.stations = await state.client.createStation(pick.musicId)
		buildStations()
		const created = state.stations.find((do(x) !before.has(x.id))) || state.stations.find((do(x) low(x.name).startsWith(low(seed.artist_name))))
		if created
			playStation(created)
			return {id: created.id, name: created.name}
		return {name: station.name || ''}
	throw new Error('Pandora found none of this town\'s seeds.')

# ---------------------------------------------------------------- first paint (0.11.2)
# What the player showed last, kept unencrypted in localStorage so a reload paints the
# player at once: the mode, the station list (names and ids), the station, the song
# (title, artist, album, art, length, position) and the username. No password,
# session, token or audio link is in it. The restore (extension, vault, wasm) runs
# in parallel behind it and swaps the real state in; the session is checked by the
# first request that needs it, never before the paint.
const SNAP_KEY = 'melodica.snapshot'
let leavingPage = false
const timing = window.__mwTiming = window.__mwTiming || {}
def mark(name)
	if timing[name] === undefined
		timing[name] = performance.now()
def readSnapshot()
	try
		const v = JSON.parse(store.get(SNAP_KEY) || 'null')
		return v && v.v === 1 && Array.isArray(v.stations) ? v : null
	catch _
		return null
let snapTimer = 0
def saveSnapshot()
	if snapTimer
		return
	snapTimer = setTimeout((do
		snapTimer = 0
		writeSnapshot()
	), 400)
def writeSnapshot()
	const rs = state.remoteState
	const signedIn = state.remote ? !!(rs && rs.loggedIn === true) : !!(state.client && state.client.fn && state.client.session())
	if !signedIn
		return
	if !state.song && readSnapshot()
		return
	# keep the last song while background restore is pending
	const song = state.song && !state.song.isInsert ? state.song : null
	const snapshot = {
		v: 1,
		mode: state.remote ? 'remote' : 'standalone',
		at: Date.now(),
		stations: state.stations.slice(0, 250).map((do(x) ({id: x.id, name: x.name || '', isQuickMix: !!x.isQuickMix}))),
		station: state.station ? ({id: state.station.id, name: state.station.name || ''}) : null,
		song: song ? ({
			title: song.title || '',
			artist: song.artist || '',
			album: song.album || '',
			coverArt: song.coverArt || '',
			duration: Number(song.duration) || 0
		}) : null,
		position: state.remote ? Number(rs && rs.position) || 0 : el.audio.currentTime || 0,
		username: el.signedIn.textContent || ''
	}
	store.set(SNAP_KEY, JSON.stringify(snapshot))
def forgetSnapshot()
	clearTimeout(snapTimer)
	snapTimer = 0
	store.remove(SNAP_KEY)

# Synchronous: the player as it was, before anything is loaded. Controls work at once;
# a press before the restore is done waits for it (whenReady).
def paintSnapshot(snap)
	state.stations = snap.stations.map((do(x) ({id: x.id, name: x.name, isQuickMix: !!x.isQuickMix})))
	buildStations()
	if snap.station
		state.station = state.stations.find((do(x) x.id === snap.station.id)) || {...snap.station}
	markActiveStation()
	if snap.song
		const song = snap.song
		(lyrics)?.track(song)
		el.stage.classList.remove('idle')
		el.title.textContent = song.title
		el.artist.textContent = song.artist
		el.album.textContent = song.album
		el.station.textContent = state.station ? ''.concat('on ', state.station.name) : ''
		el.miniTitle.textContent = song.title
		el.miniArtist.textContent = song.artist
		setCover(song)
		setProgress(Number(snap.position) || 0, song.duration || 0)
	setPlayIcon(false)
	if snap.username
		el.signedIn.textContent = snap.username
	el.app.dataset.snapshot = snap.mode
	show(el.viewPlayer)
	mark('visible')

let readyResolve
const readyPromise = new Promise((do(ok)
	readyResolve = ok
))
def markReady()
	if el.app.dataset.ready === 'true'
		return
	el.app.dataset.ready = 'true'
	delete el.app.dataset.snapshot
	mark('interactive')
	readyResolve()
	if (phone)?.ui
		phone.quality()
		phone.sync()
def whenReady(fn)
	return (do(...args) el.app.dataset.ready === 'true' ? fn(...args) : readyPromise.then((do fn(...args))))

# ---------------------------------------------------------------- Play in melodica (0.11.1)
# The map's ▶ Play (onPlay / sui:play) and its link fallback /melodica/app/?seed=
# <artist|genre>:<name>&autoplay=1: a station from that artist or genre, reused when
# one already exists, then played. In remote mode the extension does it.
let pendingSeed = null
let pendingListen = null
def showListenTarget(target)
	pendingListen = target
	const pane = byId('listen-pending')
	pane.hidden = !target
	if target
		byId('listen-pending-name').textContent = target.name || ''.concat('Station ', target.station)

def shareCurrent(kind)
	const snapshot = (state.rooms)?.getState()
	const play = ((snapshot)?.state)?.play
	const song = play ? roomTrack(play) : state.song
	let text = ''
	let url = ''
	if kind === 'room' && (snapshot)?.id
		url = 'https://spacegho.st/melodica/rooms/'+encodeURIComponent(snapshot.id)+'/'
		text = (snapshot.state)?.name || 'Melodica room'
	elif kind === 'song' && song && !song.isInsert
		text = [song.title,song.artist].filter(Boolean).join(' · ')
		try
			const detail = new URL(song.detailUrl || song.songDetailUrl)
			if /(^|\.)pandora\.com$/i.test(detail.hostname)
				detail.protocol = 'https:'
				url = detail.href
		catch _
			# Some room tracks only carry display metadata.
		if !url
			url = 'https://www.pandora.com/search/'+encodeURIComponent([song.artist,song.title].join(' '))+'/tracks'
	else
		playerMessage(kind === 'room' ? 'Join a room before sharing it.' : 'Play a station song first.')
		return
	try
		if globalThis.melodicaDevice
			await globalThis.melodicaDevice.call('share',{text,url})
		elif navigator.share
			await navigator.share({text,url})
		else
			await navigator.clipboard.writeText(text+' '+url)
			playerMessage('Link copied.')
	catch e
		if e.name !== 'AbortError'
			playerMessage(e.message,'error')

def openListenLink(raw)
	const message = byId('listen-message')
	if /^https:\/\/spacegho\.st\/scrobble\/listen\/#[-A-Za-z0-9_]{43}$/.test(raw)
		location.assign(raw)
		return
	const sharedRoom = /^https:\/\/spacegho\.st(\/melodica\/rooms\/[A-Za-z0-9_-]{16,64}\/?)$/.exec(raw)
	if sharedRoom
		go('rooms',{path:sharedRoom[1]})
		return
	const target = parseListenUri(raw)
	if !target
		message.textContent = 'That link isn\'t supported'
		return
	if ['artist', 'genre', 'station'].includes(target.target)
		showListenTarget(target)
		if route !== 'app'
			go('app')
		message.textContent = 'Press Play linked station to start.'
	else
		location.assign(listenRoute(target))

def installListenLinks()
	byId('link-desktop').onclick = do
		const status = byId('listen-message')
		try
			const response = await fetch('/melodica/app/device',{headers:{accept:'text/html'},cache:'no-store'})
			if !response.ok || !(response.headers.get('content-type') || '').includes('text/html')
				throw new Error('Desktop pairing is unavailable at spacegho.st. Your station can still play.')
			location.assign('/melodica/app/device')
		catch e
			status.textContent = e.message
	byId('share-track').onclick = do shareCurrent('song')
	byId('share-room').onclick = do shareCurrent('room')
	const message = (do(s)
		byId('listen-message').textContent = s
	)
	byId('listen-open').addEventListener('submit', (do(ev)
		ev.preventDefault()
		openListenLink(byId('listen-input').value.trim())
	))
	const register = byId('listen-register')
	register.hidden = typeof navigator.registerProtocolHandler !== 'function'
	register.addEventListener('click', (do
		try
			navigator.registerProtocolHandler('web+listen', 'https://spacegho.st/listen/?uri=%s')
			message('Choose melodica in your browser’s link handler prompt.')
		catch _
			message('Open spacegho.st/melodica/ to register links in this browser.')
	))
	for kind of ['artist', 'station']
		byId('listen-share-' + kind).addEventListener('click', (do
			const value = kind === 'artist' ? state.song && state.song.artist : state.station && state.station.id
			if typeof value !== 'string' || !value
				message('Pick a station and song first.')
				return
			const target = kind === 'artist' ? ({target: 'artist', name: value}) : ({target: 'station', station: value})
			const forms = listenUri(target)
			if !forms
				message('Pick a station and song first.')
				return
			try
				await navigator.clipboard.writeText(forms.https)
				message('Link copied.')
			catch _
				byId('listen-input').value = forms.https
				byId('listen-input').select()
				message('Copy the selected link.')
		))
	byId('listen-play').addEventListener('click', (do
		const target = pendingListen
		if !target
			return
		if target.target === 'station'
			const station = state.stations.find((do(s) s.id === target.station))
			if !station
				message('Sign in with the account that owns this station, then press Play.')
				return
			showListenTarget(null)
			await playStation(station)
		else
			const ready = state.remote ? state.remoteState && state.remoteState.loggedIn : state.client && state.client.session()
			if !ready
				message('Sign in, then press Play linked station.')
				return
			showListenTarget(null)
			await playSeed({kind: target.target, name: target.name})
	))
	const q = new URLSearchParams(location.search)
	const station = q.get('station')
	const raw = q.get('seed')
	# Link navigation selects a target; it never creates a station or starts audio.
	# ?autoplay=1 is the existing fallback from a deliberate map Play action.
	if !q.has('autoplay')
		const m = raw && /^(artist|genre):(.{1,200})$/s.exec(raw)
		const forms = station ? listenUri({target: 'station', station}) : m ? listenUri({target: m[1], name: m[2]}) : null
		if forms
			showListenTarget(parseListenUri(forms.uri))
		q.delete('station')
		q.delete('seed')
		history.replaceState(history.state, '', location.pathname + (q.toString() ? ''.concat('?', q) : '') + location.hash)
def seedFromUrl()
	const q = new URLSearchParams(location.search)
	const raw = q.get('seed')
	if !raw
		return null
	q.delete('seed')
	q.delete('autoplay')
	history.replaceState(history.state, '', location.pathname + (q.toString() ? ''.concat('?', q) : '') + location.hash)
	const m = /^(artist|genre):(.{1,200})$/s.exec(raw)
	return m ? ({kind: m[1], name: m[2].trim()}) : null

def playSeed(seed)
	if !seed || !seed.name || !['artist', 'genre', 'track'].includes(seed.kind)
		return Promise.resolve(false)
	if roomBlocksSource((state.rooms)?.getState())
		pendingSeed = null
		playerMessage('Leave the room before starting another station.', 'info')
		return Promise.resolve(false)
	if route !== 'app'
		go('app')
	if state.remote
		if !state.remoteState || state.remoteState.loggedIn !== true
			pendingSeed = seed
			showListenTarget({
				target: seed.kind === 'track' ? 'artist' : seed.kind,
				name: seed.kind === 'track' ? seed.artist_name || seed.name : seed.name
			})
			playerMessage('Sign in to Pandora, then press Play linked station.', 'info')
			return Promise.resolve(false)
		pendingSeed = null
		playerMessage(''.concat('Starting a ', seed.name, ' station…'), 'info', 0)
		const kind = seed.kind === 'track' ? 'artist' : seed.kind
		# the bridge knows artist and genre
		const name = seed.kind === 'track' ? seed.artist_name || seed.name : seed.name
		return remoteCommand('seed', {seed: {kind, name: name.slice(0, 128)}}).then((do(r)
			if r && r.ok
				playerMessage('')
				return true
			playerMessage(''.concat('The extension could not start a ', seed.name, ' station', r && r.error ? ''.concat(': ', r.error) : '', '.'), 'error')
			return false
		))
	if !state.client || !state.client.session() || el.app.dataset.view !== 'player'
		pendingSeed = seed
		showListenTarget({
			target: seed.kind === 'track' ? 'artist' : seed.kind,
			name: seed.kind === 'track' ? seed.artist_name || seed.name : seed.name
		})
		playerMessage('Sign in to Pandora, then press Play linked station.', 'info')
		return Promise.resolve(false)
	pendingSeed = null
	crewGame('station', seed.kind === 'track' ? ({kind: 'track', name: seed.name, artist_name: seed.artist_name || ''}) : ({kind: seed.kind, name: seed.name}))
	return seedStation(seed).then((do true), (do(err)
		playerMessage(describeError(err), 'error')
		return false
	))

def seedStation(seed)
	const low = (do(v) String(v || '').trim().toLowerCase())
	const name = low(seed.name)
	clearResume()
	const have = state.stations.find((do(x) !x.isQuickMix && (low(x.name) === name || low(x.name) === ''.concat(name, ' radio'))))
	# An explicit Play target may run while restore is preparing the controls.
	# Its authenticated session/stations are already installed; waiting for those
	# same controls here would deadlock the restore that is awaiting this action.
	if have
		await playStation(have, {duringRestore: true})
		return have
	playerMessage(''.concat('Starting a ', seed.name, ' station…'), 'info', 0)
	const r = await state.client.search(seed.kind === 'track' && seed.artist_name ? ''.concat(seed.name, ' ', seed.artist_name) : seed.name)
	const artists = (r.artists || []).filter((do(x) x && x.musicId))
	const songs = (r.songs || []).filter((do(x) x && x.musicId))
	const pick = seed.kind === 'track' && (songs.find((do(x) low(x.title) === name && (!seed.artist_name || low(x.artist) === low(seed.artist_name)))) || songs[0]) || (seed.kind === 'artist' ? artists.find((do(x) low(x.name) === name)) || artists[0] : artists.find((do(x) low(x.name) === name))) || artists[0] || songs[0]
	if !pick
		throw new Error(''.concat('Pandora found nothing for ', seed.name, '.'))
	const before = new Set(state.stations.map((do(x) x.id)))
	state.stations = await state.client.createStation(pick.musicId)
	buildStations()
	const created = state.stations.find((do(x) !before.has(x.id))) || state.stations.find((do(x) low(x.name).startsWith(low(pick.name || pick.title))))
	if !created
		throw new Error(''.concat('The ', seed.name, ' station was not created.'))
	await playStation(created, {duringRestore: true})
	return created

# ---------------------------------------------------------------- resume (0.11.0)
# The song this device plays is kept in the encrypted store (record "last": station,
# song with its link, position, the rest of the playlist) every 2 s while playing and
# on pause, pagehide and hidden; a reload, a back/forward or a new visit shows it
# paused there with Resume. Its audio is also copied (the playing song and the next
# one), so Resume still plays it after its link has expired. Only the playing device
# does this: as a remote the extension keeps its own (state.last, docs/BRIDGE.md).
const PERSIST_MS = 2000
let lastWrite = Promise.resolve()

# The encrypted write is asynchronous and may not finish while the page goes away;
# the position at that moment also goes to sessionStorage (this tab only; a token and a
# number), and a reload or back/forward takes it when it names the same song.
const LAST_HINT = 'melodica.lastPosition'
def persistLast({leaving = false} = {})
	if state.remote || !state.remember || state.resume || state.resuming || !state.vault
		return
	const rec = lastRecord({station: state.station, song: state.song, position: el.audio.currentTime, queue: state.queue})
	if !rec
		return
	if leaving
		try
			sessionStorage.setItem(LAST_HINT, JSON.stringify({t: rec.song.trackToken, p: rec.position}))
		catch _
			# unavailable
	lastWrite = lastWrite.then((do state.remember && !state.remote ? state.vault.write(rec, LAST_ID) : null)).catch((do(err) console.debug('[last]', describeError(err))))

def keepCopies(song)
	const c = state.copies
	if !c || state.remote || !state.remember || !song || song.isInsert
		return
	const next = state.queue[0] && !state.queue[0].isInsert ? state.queue[0] : null
	c.keep([song.trackToken, next && next.trackToken])
	c.save(song).then((do
		if next && state.song === song && state.queue[0] === next
			c.save(next)
	))

def revokeBlob()
	cancelRoomSourcePreparation()
	if state.blobUrl
		URL.revokeObjectURL(state.blobUrl)
		state.blobUrl = ''

def remoteResumable()
	const rs = state.remoteState
	if !state.remote || !rs || !rs.last || !rs.last.trackToken
		return false
	const t = rs.track && (rs.track.title || rs.track.trackToken) ? rs.track : null
	return !t || rs.status === 'paused' && t.trackToken === rs.last.trackToken

def updateResumeUi()
	const rs = state.remoteState
	const pos = state.remote ? remoteResumable() ? Number(rs.last.position) || 0 : -1 : state.resume ? state.resume.position : -1
	const on = pos >= 0 || !!state.tap
	el.barResume.hidden = !on
	el.barResume.firstChild.textContent = state.tap && pos < 0 ? state.tap.label : 'Resume'
	el.barResumeAt.textContent = pos >= 1 ? ''.concat(' at ', fmtTime(pos)) : ''
	if on
		el.app.dataset.resume = 'true'
	else
		delete el.app.dataset.resume

def clearResume()
	if !state.resume
		return
	state.resume = null
	updateResumeUi()

# The page's own last-playing record, shown paused at its position (nothing plays).
def offerResume(earlyRecord = null)
	if state.remote || state.song || !state.vault || !state.remember
		return
	let rec = null
	try
		rec = await (earlyRecord || state.vault.read(LAST_ID))
	catch _
		rec = null
	if !validLast(rec) || state.remote || state.song
		return
	try
		const hint = JSON.parse(sessionStorage.getItem(LAST_HINT) || 'null')
		if hint && hint.t === rec.song.trackToken && Number(hint.p) > rec.position
			rec.position = Number(hint.p)
	catch _
		# no hint
	const st = state.stations.find((do(s) s.id === rec.station.id))
	if st
		showResumable(st, rec)

def showResumable(st, rec)
	state.station = st
	store.set(STORAGE.station, st.id)
	markActiveStation()
	state.playGen += 1
	state.queue = rec.queue.slice()
	displaySong({...rec.song}, {shown: true})
	setProgress(rec.position, rec.song.duration || 0)
	setPlayIcon(false)
	state.resume = rec
	updateResumeUi()
	renderUpNext()

# Resolves true once `src` plays from `pos`, 'blocked' (autoplay), or false (an error,
# e.g. an expired link's 403, or nothing within 15 s).
def playFrom(src, pos, {signal, current = (do true), paused = false} = {})
	const a = el.audio
	return new Promise((do(ok)
		let timer = 0
		const done = (do(v)
			clearTimeout(timer)
			a.removeEventListener('playing', onPlaying)
			a.removeEventListener('error', onError)
			a.removeEventListener('loadedmetadata', onMetadata)
			a.removeEventListener('loadeddata', onLoaded)
			(signal)?.removeEventListener('abort', onAbort)
			ok(v)
		)
		const onPlaying = (do done(current()))
		const onError = (do done(false))
		const onAbort = (do done(false))
		const onMetadata = (do
			if !current()
				return done(false)
			try
				if Math.abs(a.currentTime - pos) > 0.5
					a.currentTime = pos
			catch _
				# not seekable
		)
		const onLoaded = (do
			if paused
				done(current())
		)
		if (signal)?.aborted || !current()
			return done(false)
		timer = setTimeout((do done(false)), 15000)
		a.addEventListener('playing', onPlaying)
		a.addEventListener('error', onError)
		a.addEventListener('loadedmetadata', onMetadata)
		a.addEventListener('loadeddata', onLoaded)
		(signal)?.addEventListener('abort', onAbort, {once: true})
		applyVolume()
		a.src = src
		try
			a.currentTime = pos
		catch _
			# after the metadata, above
		if paused
			a.load()
			return
		const p = a.play()
		if p && p.catch
			p.catch((do(err)
				if err && err.name === 'NotAllowedError'
					done('blocked')
			))
	))

def resumeLast()
	const rec = state.resume
	if !rec || state.resuming || state.remote
		return
	const song = state.song
	const gen = state.playGen
	state.resuming = true
	playerMessage('Resuming…', 'info', 0)
	let r = false
	let copy = false
	const current = (do state.playGen === gen && state.song === song && state.resume === rec && !state.remote)
	try
		if !urlExpired(song)
			r = await playFrom(song.audioUrl, rec.position, {current})
		if r !== true && r !== 'blocked' && state.playGen === gen && state.copies
			const u = await state.copies.blobUrl(song.trackToken)
			if u
				r = await playFrom(u, rec.position, {current})
				if r === true
					revokeBlob()
					state.blobUrl = u
					copy = true
				else
					URL.revokeObjectURL(u)
	finally
		state.resuming = false
	if state.playGen !== gen || state.resume !== rec
		return
	if r === 'blocked'
		playerMessage('Press Resume to start (the browser blocks autoplay).', 'info', 0)
		return
	state.resume = null
	updateResumeUi()
	if r === true
		updateMediaSession(song)
		scrobbleStart(song)
		if copy
			# The rest of that playlist has expired links too: the station goes on fresh.
			state.queue = []
			renderUpNext()
			playerMessage('That song\'s link expired; playing this device\'s copy, then continuing the station.')
		else
			playerMessage('')
			keepCopies(song)
		persistLast()
		return
	# Neither its link nor a copy plays: the station goes on with a new playlist.
	el.audio.removeAttribute('src')
	state.queue = []
	renderUpNext()
	playerMessage('That song\'s link expired; continuing the station')
	state.keepMessage = true
	nextSong()

def installResume()
	installListenLinks()
	document.addEventListener('sui:play', (do(ev)
		const d = ev.detail
		if d
			playSeed({kind: d.kind, name: d.name, artist_name: d.artist_name})
	))
	pendingSeed = seedFromUrl()
	state.copies = new AudioCopies({
		relayRequest: (do(u)
			let host = ''
			try
				host = new URL(u).hostname
			catch _
				return null
			if !/(^|\.)(pandora\.com|p-cdn\.us|p-cdn\.com)$/i.test(host)
				return null
			const token = state.client && state.client.accessToken
			return [''.concat(state.apiBase, '?audio=', encodeURIComponent(u)), {credentials: 'omit', headers: token ? ({'x-melodica-access': token}) : ({})}]
		),
		log: (do(m) console.debug('[copies]', m))
	})
	setInterval((do
		if !el.audio.paused && !state.resuming
			persistLast()
			saveSnapshot()
	), PERSIST_MS)
	addEventListener('pagehide', (do
		leavingPage = true
		if el.app.dataset.ready === 'true'
			writeSnapshot()
	))
	addEventListener('pagehide', (do persistLast({leaving: true})))
	document.addEventListener('visibilitychange', (do
		if document.visibilityState === 'hidden'
			persistLast({leaving: true})
	))
	# Back/forward from the page cache: the song as it was, paused, with Resume.
	addEventListener('pageshow', (do(e)
		leavingPage = false
		if !e.persisted || state.remote || !state.song || state.song.isInsert || !el.audio.paused || state.resume
			return
		const rec = lastRecord({station: state.station, song: state.song, position: el.audio.currentTime, queue: state.queue})
		if rec
			state.resume = rec
			setPlayIcon(false)
			updateResumeUi()
	))
	el.barResume.addEventListener('click', (do
		if (state.rooms)?.active()
			state.rooms.command('room-resume').catch((do(e) playerMessage(e.message, 'error')))
			return
		if state.tap && !state.resume && !remoteResumable()
			const t = state.tap
			state.tap = null
			updateResumeUi()
			t.run()
			return
		if state.remote
			remoteCommand('resume')
		else
			resumeLast()
	))
	el.audio.addEventListener('playing', (do
		if state.tap
			state.tap = null
			updateResumeUi()
	))

# ---------------------------------------------------------------- the shell (0.11.0)
let roomMediaKey = ''
let roomCaptureMonitor = null
let roomCaptureResume = null
let roomSourceJob = null

def cancelRoomSourcePreparation()
	if roomSourceJob
		roomSourceJob.controller.abort(Object.assign(new Error('The DJ turn changed before the audio was ready.'), {code: 'dj_turn_ended'}))
		roomSourceJob = null
	state.preparingRoomAudio = false

# Radio can play CDN media without CORS headers. A DJ instead loads readable
# bytes through the existing authenticated audio relay, then captures the same
# player element from a local blob. This does not require Remember me or storage.
def prepareRoomPlayerAudio()
	const song = state.song
	const audio = el.audio
	const generation = state.playGen
	if !song || song.isInsert || state.remote
		throw new Error('Start a radio track before broadcasting.')
	if (roomSourceJob)?.song === song && roomSourceJob.generation === generation
		return roomSourceJob.promise
	if state.blobUrl && audio.getAttribute('src') === state.blobUrl
		return
	cancelRoomSourcePreparation()
	const controller = new AbortController()
	const job = {song, generation, controller, promise: null}
	roomSourceJob = job
	const current = (do
		const room = ((state.rooms)?.getState())?.state
		return roomSourceJob === job && !controller.signal.aborted && state.song === song && state.playGen === generation && !state.remote && !!(room)?.you && !room.closed_at && room.current_dj === room.you && room.you_broadcasting !== false
	)
	job.promise = ((do
		let url = ''
		const timer = setTimeout((do
			return controller.abort(new DOMException('The audio source is taking too long. Press Play to retry.', 'TimeoutError'))
		), 30000)
		try
			const blob = await state.copies.readBlob(song, {signal: controller.signal})
			if !current()
				throw Object.assign(new Error('The DJ turn changed before the audio was ready.'), {code: 'dj_turn_ended'})
			const previous = audio.getAttribute('src')
			const previousBlob = state.blobUrl
			const position = Number(audio.currentTime) || 0
			const paused = audio.paused
			url = URL.createObjectURL(blob)
			state.blobUrl = url
			state.preparingRoomAudio = true
			const loaded = await playFrom(url, position, {signal: controller.signal, current, paused})
			if !current()
				throw Object.assign(new Error('The DJ turn changed before the audio was ready.'), {code: 'dj_turn_ended'})
			if loaded !== true && loaded !== 'blocked'
				# A failed conversion must not discard an otherwise playable radio URL.
				await playFrom(previous, position, {current, paused})
				if current()
					state.blobUrl = previousBlob
				throw new Error('The room could not prepare this track for broadcast. Press Play to retry.')
			if previousBlob
				URL.revokeObjectURL(previousBlob)
			if loaded === 'blocked'
				state.tap = {
					label: 'Play room audio',
					run: (do
						return audio.play().catch((do
							return
						))
					)
				}
				updateResumeUi()
				throw new Error('Press Play to start your room audio.')
		catch error
			if (controller.signal.reason)?.name === 'TimeoutError'
				throw controller.signal.reason
			throw error
		finally
			clearTimeout(timer)
			# A deliberate pause can abort preparation after the blob was installed.
			# Keep that active URL usable for Resume; newer tracks revoke it normally.
			if url && state.blobUrl !== url
				URL.revokeObjectURL(url)
			if roomSourceJob === job
				roomSourceJob = null
				state.preparingRoomAudio = false
	))()
	return await job.promise

def installRooms()
	const metadata = (do
		const s = state.song
		const duration = Number.isFinite(el.audio.duration) ? el.audio.duration : Number((s)?.duration) || 0
		return (s && !s.isInsert && duration > 0) ? trackMetadata(s, duration, (state.station)?.name || '') : null
	)
	const waitPlaying = (do
		return new Promise((do(resolve, reject)
			const finish = (do
				if !metadata() || el.audio.paused || el.audio.readyState < 2
					return
				cleanup()
				resolve({track_metadata: metadata()})
			)
			const timer = setTimeout((do
				cleanup()
				reject(new Error('Start a station, then press Connect room audio to begin your DJ turn.'))
			), 8000)
			const cleanup = (do
				clearTimeout(timer)
				for e of ['playing', 'loadedmetadata', 'timeupdate']
					el.audio.removeEventListener(e, finish)
			)
			for e of ['playing', 'loadedmetadata', 'timeupdate']
				el.audio.addEventListener(e, finish)
			finish()
		))
	)
	state.rooms = createRoomHost({
		loadUi: (do import(UI_MODULE)),
		token: uiToken,
		remote: (do state.remote),
		send: (do(action, fields)
			if (state.bridge instanceof BridgeTransport) && state.bridge.rooms !== 1
				throw Object.assign(new Error('This extension version does not support Rooms. Install the current extension release to join.'), {code: 'extension_update_required'})
			return remoteCommand(action, fields)
		),
		player: {
			currentTrack: metadata,
			positionMs: (do Math.max(0, Math.round(el.audio.currentTime * 1000))),
			startTurn: (do
				await readyPromise
				if !(state.client)?.loggedIn
					throw new Error('Sign in to Pandora in the player before taking a DJ turn.')
				if state.tap && state.song && !state.song.isInsert
					state.tap = null
					await el.audio.play()
				else
					state.station ||= lastStation() || state.stations[0]
					if !state.station
						throw new Error('Choose a station in the player before taking a DJ turn.')
					await nextSong()
				await waitPlaying()
				await prepareRoomPlayerAudio()
				return waitPlaying()
			),
			unlock: (do roomCaptureResume == null ? undefined : roomCaptureResume(el.audio)),
			capture: (do
				await prepareRoomPlayerAudio()
				await waitPlaying()
				const mod = await import(UI_MODULE)
				roomCaptureMonitor = mod.monitorPlayerAudio
				roomCaptureResume = mod.resumePlayerAudio
				await (roomCaptureResume == null ? undefined : roomCaptureResume(el.audio))
				return mod.capturePlayerAudio(el.audio)
			),
			monitor: ((do
				let original
				return (do(enabled)
					if typeof roomCaptureMonitor === 'function'
						return roomCaptureMonitor(el.audio, enabled)
					if enabled && original === undefined
						original = el.audio.muted
						el.audio.muted = true
					elif !enabled && original !== undefined
						el.audio.muted = original
						original = undefined
				)
			))(),
			pause: (do
				cancelRoomSourcePreparation()
				el.audio.pause()
			),
			resume: (do state.resume ? resumeLast() : el.audio.play()),
			setVolume: (do(value)
				state.volume = clamp(Number(value) || 0, 0, 100)
				el.volume.value = el.barVolume.value = String(state.volume)
				applyVolume()
			),
			scrobbling: (do scrobbleOn()),
			volume: (do state.volume)
		},
		onChange: (do
			queueMicrotask(paintRoomPlayback)
			updateBar()
			if (state.tabs)?.owner && !state.remote
				state.tabs.publish()
				checkpointEngine(true)
		),
		onClock: paintRoomProgress
	})
	state.rooms.addEventListener('error', (do(e) playerMessage(e.detail.message, 'error')))
	setInterval(paintRoomProgress, 500)

def paintRoomProgress()
	const snapshot = (state.rooms)?.getState()
	const play = ((snapshot)?.state)?.play
	if play && !snapshot.state.closed_at
		setProgress(roomPositionMs(snapshot) / 1000, play.duration_ms / 1000)

let roomActionBusy = false
let playerRoomsView = null
let playerRoomsMounting = false
def roomAction(action, fields = {})
	const id = ((state.rooms)?.getState())?.id
	if !id || roomActionBusy
		return
	roomActionBusy = true
	paintRoomPlayback()
	try
		await state.rooms.command(action, {...fields, id})
	catch e
		playerMessage(e.message, 'error')
	finally
		roomActionBusy = false
		paintRoomPlayback()
def mountPlayerRooms()
	if playerRoomsView || playerRoomsMounting
		return
	playerRoomsMounting = true
	try
		await state.rooms.api('rooms')
		playerRoomsView = await state.rooms.mount(el.roomList)
	catch e
		el.roomList.textContent = e.message || 'Sign in to spacegho.st to browse rooms.'
	finally
		playerRoomsMounting = false

def paintRoomPlayback()
	const snapshot = (state.rooms)?.getState()
	const room = (snapshot)?.state
	const play = (room)?.play
	const joined = !!(snapshot)?.id && !(room)?.closed_at
	const sourceBlocked = roomBlocksSource(snapshot)
	const member = ((room)?.members)?.find((do(m) m.account === room.you))
	const listedDj = ((room)?.djs || []).includes((room)?.you) || (member)?.role === 'dj' || (room)?.current_dj && room.current_dj === room.you
	const inDjLine = ((room)?.waiting || []).includes((room)?.you) || ((room)?.requests || []).some((do(r) r.account === room.you))
	el.roomCurrent.hidden = !joined
	el.viewPlayer.classList.toggle('room-listener', joined && sourceBlocked)
	el.historyContext.textContent = joined ? 'this room' : 'this session'
	byId('upnext-head').textContent = joined ? 'Your next DJ tracks' : 'Up next'
	el.upNext.closest('.queue').hidden = joined && sourceBlocked
	el.quality.disabled = sourceBlocked || !!(play && joined)
	el.refreshStations.disabled = sourceBlocked
	for button of el.stationList.querySelectorAll('button.station, button.delete')
		const blocked = sourceBlocked || button.classList.contains('delete') && !!play
		if button.disabled !== blocked
			button.disabled = blocked
		if sourceBlocked
			button.title = 'Leave the room before changing stations.'
		elif button.title === 'Leave the room before changing stations.'
			button.removeAttribute('title')
	if joined
		el.roomLink.href = ''.concat('/melodica/rooms/', snapshot.id, '/')
		el.roomLink.textContent = (room)?.name || 'Current room'
		el.roomStatus.textContent = !room ? 'Connecting…' : play ? (snapshot.audio)?.paused || play.paused_at ? 'Paused' : (snapshot.audio)?.state || 'Connecting…' : 'Waiting for the DJ'
		el.roomSource.textContent = sourceBlocked ? 'Playback is controlled by this room’s DJ.' : ((state.remoteState)?.pendingStation)?.name ? ''.concat(state.remoteState.pendingStation.name, ' queued for your next DJ track.') : 'Station selections apply to your next DJ track.'
		el.roomStopDj.hidden = !listedDj && !inDjLine
		el.roomStopDj.textContent = listedDj ? 'Stop DJing' : 'Cancel DJ request'
		el.roomStopDj.disabled = el.roomLeave.disabled = roomActionBusy
		el.remoteSignin.hidden = true
		el.barResume.hidden = true
		el.explainPanel.hidden = true
		el.hint.textContent = ''
		el.qualityChip.hidden = true
		el.tired.disabled = el.explain.disabled = true
		el.next.disabled = el.love.disabled = el.ban.disabled = !play
		el.stage.classList.remove('idle')
	if !joined
		updateRatingButtons()
		if roomMediaKey
			roomMediaKey = ''
			# The remote renderer has already restored the owner's private state.
			if !state.remote
				if state.song
					displaySong(state.song, {shown: true})
					setProgress((state.resume)?.position ?? el.audio.currentTime, state.song.duration || 0)
					updateMediaSession(state.song)
				else
					showIdle()
				updateResumeUi()
				if Reflect.has(navigator, 'mediaSession')
					navigator.mediaSession.playbackState = el.audio.paused ? 'paused' : 'playing'
		return
	if !play
		el.miniTitle.textContent = el.title.textContent = room ? 'Waiting for the DJ' : 'Connecting to room…'
		(lyrics)?.track(null)
		el.miniArtist.textContent = el.artist.textContent = (room)?.name || ''
		el.album.textContent = el.station.textContent = ''
		setPlayIcon(false)
		setProgress(0, 0)
		if roomMediaKey !== snapshot.id + ':waiting'
			roomMediaKey = snapshot.id + ':waiting'
			setCover('')
			el.cover.alt = ''
			updateMediaSession({title: (room)?.name || 'Room', artist: 'Waiting for the DJ'})
		if Reflect.has(navigator, 'mediaSession')
			navigator.mediaSession.playbackState = 'paused'
		return
	const song = roomTrack(play)
	(lyrics)?.track(song)
	el.miniTitle.textContent = el.title.textContent = song.title
	el.miniArtist.textContent = el.artist.textContent = song.artist
	el.album.textContent = song.album
	el.station.textContent = 'in ' + (room.name || 'Room')
	const active = !(snapshot.audio)?.paused && ['listening', 'broadcasting'].includes((snapshot.audio)?.state) && !play.paused_at
	setPlayIcon(active)
	const key = JSON.stringify([snapshot.id, song])
	if roomMediaKey !== key
		roomMediaKey = key
		setCover(song)
		el.cover.alt = song.coverArt && song.album ? ''.concat('Cover of ', song.album) : ''
		updateMediaSession(song)
		document.title = ''.concat(song.title, ' – ', song.artist, ' · melodica')
	if Reflect.has(navigator, 'mediaSession')
		navigator.mediaSession.playbackState = active ? 'playing' : 'paused'
	paintRoomProgress()

# Every /melodica/ page is this one document: the hub, the player, Listens, the
# Leaderboard, the Map, the Account and the Extension page are routes (history.pushState),
# so the <audio> element and the extension link live on across them, and the player bar
# stays pinned to the bottom of the viewport. The site Worker serves this page for each
# route; the hub and the extension page come from it as fragments (?fragment=1).
let walkJournal = null
def walkSong()
	const room = (state.rooms)?.getState()
	if (room)?.id && !(room.state)?.closed_at
		const play = (room.state)?.play
		return play && !play.paused_at && !(room.audio)?.paused && ['listening','broadcasting'].includes((room.audio)?.state) ? roomTrack(play) : null
	let song = null
	if state.remote
		const rs = state.remoteState
		if (rs)?.status === 'playing' && !(rs.track)?.isInsert && (rs.track)?.kind !== 'insert'
			song = rs.track
	elif !state.resume && !(state.song)?.isInsert && !el.audio.paused && !el.audio.ended && !el.audio.seeking && el.audio.readyState >= 3
		song = state.song
	return song ? {...song,stationId:(state.station)?.id,stationName:(state.station)?.name} : null

def walkMusicState()
	const room = (state.rooms)?.active()
	const signedIn = !!(room || (state.remote ? (state.remoteState)?.loggedIn : el.app.dataset.view === 'player'))
	const song = signedIn ? walkSong() : null
	return {
		ready:el.app.dataset.ready === 'true',
		signedIn,
		playing:signedIn && el.play.dataset.state === 'playing',
		song,
		art:artUrl(song) || (song)?.art_cached || '',
		station:signedIn && !room ? lastStation() : null,
		stations:signedIn && !room ? state.stations : [],
		room:!!room
	}

def controlWalkMusic(id, toggle = false)
	if el.app.dataset.ready !== 'true'
		await readyPromise
	const current = walkMusicState()
	if !current.signedIn
		go('app')
		return
	const station = current.stations.find(do(st) st.id === id)
	if station && (station.id !== (state.station)?.id || (!state.song && !state.resume && !state.remote))
		return await playStation(station)
	if current.playing && !toggle
		return
	if !current.room && !state.song && !state.resume && !current.station
		go('app')
		return
	if state.tap
		return await state.tap.run()
	return togglePlay()

def showWalkJournal(gen)
	try
		const [{WalkJournal},{mountWalk}] = await Promise.all([import('./walk-journal.js'),import('./walk-view.js')])
		if gen !== routeGen
			return
		if !walkJournal
			walkJournal = new WalkJournal(walkSong,(do
				const mod = await import(UI_MODULE)
				return mod.createClient({base:location.origin,token:uiToken})
			))
			for event of ['playing','pause','waiting','ended','emptied','seeked']
				el.audio.addEventListener(event,do walkJournal.sample())
		routeUi = {view:mountWalk(el.routeBody,walkJournal,{state:walkMusicState,control:controlWalkMusic})}
	catch err
		if gen === routeGen
			el.routeBody.textContent = 'Walk records could not load. Reload this page to try again.'

const SHELL_BASE = '/melodica/'
const ROUTES = {
	'': 'home',
	'app/': 'app',
	'track/': 'walks',
	'apps/': 'apps',
	'listens/': 'listens',
	'leaderboard/': 'leaderboard',
	'map/': 'map',
	'garden/': 'garden',
	'aquarium/': 'aquarium',
	'account/': 'account',
	'extension/': 'extension'
}
ROUTES['rooms/'] = 'rooms'
const ROUTE_PATH = Object.fromEntries(Object.entries(ROUTES).map((do([p, r]) [r, SHELL_BASE + p])))
const ROUTE_TITLE = {
	home: 'melodica · Pandora players for every device',
	app: 'melodica — Pandora in the browser',
	walks: 'Walk records · melodica',
	apps: 'Melodica apps',
	listens: 'Your listens · melodica',
	leaderboard: 'Leaderboard · melodica',
	rooms: 'Rooms · melodica',
	map: 'Map · melodica',
	garden: 'Mixtape Garden · melodica',
	aquarium: 'Listening Reef · melodica',
	account: 'Account · melodica',
	extension: 'The melodica extension · melodica'
}
const ROUTE_HEAD = {listens: 'Your listens', leaderboard: 'Leaderboard', map: 'Map', garden: 'Mixtape Garden', account: 'Account'}
def routeOf(pathname)
	if isRoomsPath(pathname)
		return 'rooms'
	if !pathname.startsWith(SHELL_BASE)
		return 'app'
	return ROUTES[pathname.slice(SHELL_BASE.length)] || 'app'
let route = ''
let routePath = ''
let routeGen = 0
let routeUi = null
# {live, view} of a Listens/Leaderboard/Map route
let shellNav = null
let navCrew = true
def markNavRoute()
	for [key,label,after] of [['walks','Walks','app'],['apps','Apps','extension']]
		if el.siteNav.querySelector('a[data-k="'+key+'"]')
			continue
		const anchor = el.siteNav.querySelector('a[data-k="'+after+'"]')
		if anchor
			const link = document.createElement('a')
			link.href = ROUTE_PATH[key]
			link.dataset.k = key
			link.textContent = label
			anchor.after(link)
	for a of document.querySelectorAll('.top a[data-k]')
		if a.dataset.k === route
			a.setAttribute('aria-current', 'page')
		else
			a.removeAttribute('aria-current')
	# Keep the current page in the horizontally scrollable phone navigation.
	const active = el.siteNav.querySelector('[aria-current="page"]')
	if active && el.siteNav.scrollWidth > el.siteNav.clientWidth
		const link = active.getBoundingClientRect()
		const nav = el.siteNav.getBoundingClientRect()
		if link.right > nav.right
			el.siteNav.scrollLeft += link.right - nav.right
		elif link.left < nav.left
			el.siteNav.scrollLeft += link.left - nav.left
def setNavCrew(crew)
	if navCrew === crew
		return
	navCrew = crew
	if shellNav
		shellNav.setCrew(crew)
	else
		const map = el.siteNav.querySelector('a[data-k="map"]')
		if map
			map.hidden = !crew
	markNavRoute()
def mountShellNav()
	try
		const mod = await import(UI_MODULE)
		shellNav = mod.mountNav(el.siteNav, {base: location.origin, active: route, crew: navCrew, home: false})
		markNavRoute()
	catch err
		console.debug('[scrobble-ui]', describeError(err))
let accountMenuHome = null
# where the account menu lives when it is not on the Account route
const fragments = new Map()

def leaveRoute()
	const r = routeUi
	routeUi = null
	if r
		try
			if r.view
				r.view.unmount()
		catch _
			# gone
		try
			if r.live
				r.live.close()
		catch _
			# closed
	const menu = el.account.querySelector('.account-menu') || el.routeBody.querySelector('.account-menu')
	if menu && accountMenuHome && menu.parentNode !== accountMenuHome
		accountMenuHome.append(menu)
	el.routeBody.replaceChildren()

def routeHeading(text)
	const h = document.createElement('h2')
	h.className = 'route-title'
	h.textContent = text
	h.tabIndex = -1
	return h

def mountRouteUi(name, host, gen)
	let mod
	try
		mod = await import(UI_MODULE)
	catch err
		console.debug('[scrobble-ui]', describeError(err))
		if gen === routeGen
			routeNotice(host, name, 'not_loaded')
		return
	if gen !== routeGen
		return
	# Arrived on the player and moved here: sign in silently first (once), else mount.
	if name !== 'aquarium' && !(await uiToken())
		await accountForPanels()
		if gen !== routeGen
			return
		if await silentPanelSignIn(name)
			return
	if gen !== routeGen
		return
	# A cold aquarium opens immediately for guests. If the player later restores
	# a bearer from its vault, reopen the reef under that identity.
	const awaitingReefIdentity = name === 'aquarium' && !(await uiToken())
	if gen !== routeGen
		return
	const client = mod.createClient({base: location.origin, token: uiToken})
	let reported = false
	const api = client.api
	client.api = (do(path, ...args)
		const result = await api(path, ...args)
		if gen === routeGen
			if name === 'map' && path === 'game' && !reported
				reported = true
				const viewer = (result.me)?.github || (state.sessionMeta)?.email || (state.account)?.name || (state.scrobble)?.privacyKey
				import('./conquest-report.js').then(do(mod)
					if gen === routeGen
						mod.conquestReport(host,result,viewer)
				).catch(do(err) console.debug('[conquest]',describeError(err)))
			if path === 'me'
				setNavCrew(!!result.crew_viewer)
				if name === 'map' && !result.crew_viewer
					routeNotice(host, name, 'crew_only')
			if path.startsWith('garden?')
				setNavCrew(!!result.crew_available)
			if path === 'game' || path.startsWith('garden?')
				((host.parentNode)?.querySelector(':scope > .route-notice'))?.remove()
		# The home page is a snapshot; keep five real entries per chart and link through
		# to the complete, paged board. The standalone Leaderboard route stays untouched.
		if name === 'leaderboard' && host.classList.contains('hub-board-host') && path.startsWith('leaderboard?')
			return {
				...result,
				songs: (result.songs)?.slice(0, 5) || [],
				artists: (result.artists)?.slice(0, 5) || [],
				listeners: (result.listeners)?.slice(0, 5) || [],
				djs: (result.djs)?.slice(0, 5) || []
			}
		return result
	)
	# The aquarium opens for guests. Its view subscribes after the first authenticated snapshot.
	const live = name === 'aquarium' ? null : client.live()
	if live
		watchAccountLive(live)
	const opts = {client, live}
	if name === 'listens'
		opts.pageSize = 25
		opts.scrollRoot = host
	if name === 'leaderboard'
		opts.window = '7d'
	if name === 'map'
		opts.onStation = stationFromSeeds
	if ['map', 'garden', 'aquarium'].includes(name)
		opts.onPlay = playSeed
	if name === 'garden' || name === 'aquarium'
		opts.audio = el.audio
		opts.loadPlayback = visualizerPlaybackBlob
	if name === 'aquarium'
		opts.getPlayback = reefPlayback
		opts.receipts = reefReceipts
	# Never a blank panel: whatever the panel could not show, say so with a way on. A
	# visitor with only the spacegho.st cookie (no player sign-in) reads with the cookie
	# (token null); without that, or outside the crew, the notice offers GitHub sign-in.
	host.addEventListener('sui:error', (do(ev)
		const code = ev.detail && (ev.detail.code || ev.detail.status)
		console.debug('[scrobble-ui]', name, code)
		if gen === routeGen
			routeNotice(host, name, code)
	))
	# Check identity before mounting the board so a rejected async request cannot
	# leave an empty leaderboard. This does not require crew membership.
	if name === 'leaderboard'
		try
			await client.api('me')
		catch e
			if gen === routeGen
				routeNotice(host, name, e.code || e.status || e.statusCode || 'not_loaded')
			return
		if gen !== routeGen
			return
	let view = null
	try
		view = mod[PANES[name]](host, opts)
		if name === 'listens'
			import('./history-tools.js').then(do(tools)
				if gen === routeGen
					tools.mountHistoryTools(host,client.api,do gen === routeGen)
			).catch(do(err) console.debug('[listens]',describeError(err)))
	catch err
		console.debug('[scrobble-ui]', describeError(err))
	routeUi = {live, view}
	if !view
		routeNotice(host, name, 'mount_failed')
	if view && awaitingReefIdentity
		readyPromise.then((do
			await accountForPanels()
			const restored = await uiToken()
			if restored && gen === routeGen
				remountRoute()
		)).catch((do(err) console.debug('[aquarium]', describeError(err))))

# The panels read with whatever sign-in there is when they mount; when that changes (a
# player session resuming, an account sign-in, the extension appearing) mount them again.
let authKey = ''
def remountOnAuth()
	const sc = state.scrobble
	const a = state.account
	const k = ''.concat(!!(sc && sc.loaded), '|', !!(sc && sc.crew), '|', !!(a && a.signedIn), '|', !!state.remote)
	if k === authKey
		return
	const first = !authKey
	authKey = k
	if first || !route || !PANES[route] && !['home', 'rooms'].includes(route)
		return
	remountRoute()
def remountRoute()
	const r = route
	leaveRoute()
	route = ''
	renderRoute(r)

const SIGNIN_GITHUB = (do(next) ''.concat('/scrobble/auth/start?next=', encodeURIComponent(next)))
def routeNotice(host, name, code)
	const box = host.parentNode
	if !box
		return
	let n = box.querySelector(':scope > .route-notice')
	if !n
		n = document.createElement('div')
		n.className = 'route-notice card'
		box.insertBefore(n, host)
	const signin = ['unauthorized', 'no_session', 'no_token', 'unauthenticated', 401, '401', 'login_required', 'http_401', 'invalid_token', 'sign_in_required'].includes(code)
	const crew = ['forbidden', 'not_crew', 'crew_only', 'not_member', 403, '403', 'http_403'].includes(code)
	const p = document.createElement('p')
	const what = name === 'rooms' ? 'rooms' : name === 'map' ? 'the crew map' : name === 'garden' ? 'your listening garden' : name === 'aquarium' ? 'the aquarium' : name === 'leaderboard' ? 'the leaderboard' : 'your listens'
	p.textContent = signin ? ''.concat('Sign in to see ', what, '.') : crew ? 'The crew map is invite-only. Signed in with another GitHub account? Sign in again with the one the crew knows.' : ''.concat('This panel could not load', code ? ''.concat(' (', code, ')') : '', '.')
	const a = document.createElement('a')
	a.className = 'button'
	a.href = SIGNIN_GITHUB(ROUTE_PATH[name] || ROUTE_PATH.home)
	a.textContent = name === 'map' ? ''.concat('Sign in with GitHub to see ', what) : ''.concat('Sign in to see ', what)
	if code === 'extension_update_required'
		p.textContent = 'Update the Melodica extension to play rooms.'
		a.href = ROUTE_PATH.extension
		a.textContent = 'Get the extension update'
	if name === 'leaderboard' && signin
		p.textContent = 'Sign in to Melodica to see the leaderboard.'
		a.href = ROUTE_PATH.app
		a.textContent = 'Sign in to Melodica'
	const retry = document.createElement('button')
	retry.type = 'button'
	retry.className = 'link'
	retry.textContent = 'Try again'
	retry.addEventListener('click', (do
		const tok = await uiToken()
		if !tok && await silentPanelSignIn(name, {force: true})
			return
		remountRoute()
	))
	n.replaceChildren(p, a, retry)

def fragment(path)
	if !fragments.has(path)
		fragments.set(path, fetch(''.concat(path, '?fragment=1'), {credentials: 'same-origin', headers: {accept: 'text/html'}}).then((do(r) r.ok ? r.text() : Promise.reject(new Error(''.concat('HTTP ', r.status))))))
		fragments.get(path).catch((do fragments.delete(path)))
	return fragments.get(path)

def showFragment(path, gen)
	let html
	try
		html = await fragment(path)
	catch err
		if gen !== routeGen
			return
		const p = document.createElement('p')
		p.className = 'muted'
		p.textContent = ''.concat('This page could not be loaded (', describeError(err), ').')
		el.routeBody.replaceChildren(p)
		return
	if gen !== routeGen
		return
	const doc = new DOMParser().parseFromString(html, 'text/html')
	for n of doc.querySelectorAll('script, style, link, .topbar')
		n.remove()
	el.routeBody.replaceChildren(...[...doc.body.childNodes].map((do(n) document.adoptNode(n))))
	if route === 'apps' && location.hash
		const target = document.getElementById(location.hash.slice(1))
		if target && el.routeBody.contains(target)
			target.scrollIntoView()
	if el.routeBody.querySelector('[data-hub-me]')
		mountHubUi(gen)

def mountHubUi(gen)
	let mod
	try
		mod = await import(UI_MODULE)
	catch err
		console.debug('[scrobble-ui]', describeError(err))
		return
	if gen !== routeGen
		return
	if !(await uiToken())
		await accountForPanels()
		if gen !== routeGen || (await silentPanelSignIn('leaderboard'))
			return
	if gen !== routeGen
		return
	const me = el.routeBody.querySelector('[data-hub-me]')
	const crew = el.routeBody.querySelector('[data-hub-live]')
	const board = el.routeBody.querySelector('[data-hub-board]')
	if !me || !crew || !board
		return
	board.classList.add('hub-board-host')
	const section = board.closest('.hub-board')
	const hub = (section)?.closest('.hub')
	if section && hub
		const title = section.querySelector(':scope > h2')
		if title
			title.textContent = 'Leaderboard'
		section.removeAttribute('aria-labelledby')
		section.setAttribute('aria-label', 'Leaderboard')
		hub.insertBefore(section, hub.querySelector(':scope > .foot'))
	const client = mod.createClient({base: location.origin, token: uiToken})
	const views = []
	let crewView = null
	let live
	const api = client.api
	client.api = (do(path, ...args)
		const result = await api(path, ...args)
		if gen !== routeGen
			return result
		if path === 'me'
			setNavCrew(!!result.crew_viewer)
			if result.crew_viewer && !crewView
				crewView = mod.mountNowPlaying(crew, {client, live})
			if !result.crew_viewer && crewView
				crewView.unmount()
				crewView = null
		if path.startsWith('leaderboard?')
			return {
				...result,
				songs: (result.songs)?.slice(0, 5) || [],
				artists: (result.artists)?.slice(0, 5) || [],
				listeners: (result.listeners)?.slice(0, 5) || [],
				djs: (result.djs)?.slice(0, 5) || []
			}
		return result
	)
	live = client.live()
	watchAccountLive(live)
	routeUi = {
		live,
		view: {
			unmount: (do
				for view of views
					view.unmount()
				(crewView)?.unmount()
			)
		}
	}
	for [host, name] of [[me, 'listens'], [board, 'leaderboard']]
		host.classList.add('sui-host')
		host.addEventListener('sui:error', (do(ev)
			if gen === routeGen
				routeNotice(host, name, (ev.detail)?.code || (ev.detail)?.status)
		))
	# Listening details and chart previews require a known signed-in account.
	let profile = null
	try
		profile = await client.api('me')
	catch _
		# leave the sign-in prompt
	if gen !== routeGen
		return
	if !profile
		const prompt = document.createElement('p')
		prompt.className = 'muted'
		const signIn = document.createElement('a')
		signIn.href = ROUTE_PATH.app
		signIn.textContent = 'Sign in to Melodica'
		prompt.append(signIn, ' to see the leaderboard.')
		board.replaceChildren(prompt)
		return
	views.push(mod.mountListens(me, {client, live, pageSize: 3}))
	((section)?.querySelector(':scope > h2'))?.remove()
	views.push(mod.mountLeaderboard(board, {client, live, window: '7d'}))
	const heading = board.querySelector('.board-head > h1')
	if heading
		const sectionHeading = document.createElement('h2')
		sectionHeading.textContent = heading.textContent
		heading.replaceWith(sectionHeading)
		const all = document.createElement('a')
		all.className = 'hub-board-all'
		all.href = ROUTE_PATH.leaderboard
		all.textContent = 'See full leaderboard'
		sectionHeading.parentNode.append(all)

def renderRoute(next, {focus = false} = {})
	const gen = ++routeGen
	if next !== route || location.pathname !== routePath
		leaveRoute()
	route = next
	routePath = location.pathname
	el.app.dataset.route = next
	document.title = ROUTE_TITLE[next] || ROUTE_TITLE.app
	markNavRoute()
	el.routeView.hidden = next === 'app'
	el.routeView.setAttribute('aria-live', next === 'walks' ? 'off' : 'polite')
	if next === 'app'
		return
	if el.routeBody.childNodes.length
		if next === 'apps' && focus && !location.hash
			scrollTo(0, 0)
		return
	# already drawn (popstate to the same route)
	if next === 'walks'
		showWalkJournal(gen)
	elif next === 'rooms'
		const host = document.createElement('div')
		host.className = 'sui-host'
		el.routeBody.replaceChildren(host)
		host.addEventListener('sui:error', (do(e)
			if gen === routeGen
				routeNotice(host, 'rooms', (e.detail)?.code || (e.detail)?.status)
		))
		Promise.resolve().then((do
			await accountForPanels()
			if gen !== routeGen
				return
			if !(await uiToken()) && (await silentPanelSignIn('rooms'))
				return
			# Public room discovery is still an authenticated app feature. Do not mount
			# the lobby/create form until this API has confirmed the current identity.
			await state.rooms.api('rooms')
			if gen !== routeGen
				return
			const view = await state.rooms.mount(host, roomIdFromPath(location.pathname))
			if gen !== routeGen
				view.unmount()
			else
				routeUi = {view}
		)).catch((do(e)
			if gen === routeGen
				routeNotice(host, 'rooms', e.code || e.status || e.message)
		))
	elif next === 'home' || next === 'extension' || next === 'apps'
		showFragment(ROUTE_PATH[next], gen)
	elif PANES[next]
		const host = document.createElement('div')
		host.className = ''.concat('sui-host', next === 'map' ? ' sui-map-host' : '')
		host.tabIndex = 0
		el.routeBody.replaceChildren(host)
		mountRouteUi(next, host, gen)
	elif next === 'account'
		const menu = el.account.querySelector('.account-menu')
		if menu
			accountMenuHome = el.account
			menu.classList.add('card')
		el.routeBody.replaceChildren(routeHeading(ROUTE_HEAD.account), ...menu ? [menu] : [])
	if focus
		const h = el.routeBody.querySelector('h1, h2')
		if h
			h.tabIndex = -1
			h.focus({preventScroll: true})
	scrollTo(0, 0)

def go(next, {replace = false, path: routePath = ROUTE_PATH[next]} = {})
	if !routePath
		return
	if location.pathname + location.hash !== routePath
		history[replace ? 'replaceState' : 'pushState']({route: next}, '', routePath)
	renderRoute(next, {focus: true})

def installShell()
	if !location.pathname.startsWith(SHELL_BASE)
		return
	# Same-origin links to a route are handled here; anything else (downloads, other
	# sites, a modified click) navigates as usual.
	document.addEventListener('click', (do(e)
		if e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey
			return
		const a = e.target.closest && e.target.closest('a[href]')
		if !a || a.target === '_blank' || a.hasAttribute('download')
			return
		const u = new URL(a.href, location.href)
		if u.origin === location.origin && isRoomsPath(u.pathname) && !u.search
			e.preventDefault()
			go('rooms', {path: u.pathname})
			return
		if u.origin !== location.origin || !(Reflect.has(ROUTES, u.pathname.slice(SHELL_BASE.length))) || !u.pathname.startsWith(SHELL_BASE) || u.search
			return
		if u.hash && u.pathname === location.pathname
			return
		e.preventDefault()
		go(ROUTES[u.pathname.slice(SHELL_BASE.length)], {path: u.pathname + u.hash})
	))
	addEventListener('popstate', (do renderRoute(routeOf(location.pathname))))
	for a of [el.barExpand, el.barSignin]
		a.href = ''.concat(location.origin, ROUTE_PATH.app)
	renderRoute(routeOf(location.pathname))
	mountShellNav()

# ---------------------------------------------------------------- one engine across tabs
const TAB_HANDOFF = 'tab-engine-v1'
let checkpointAt = 0
let checkpointWrite = Promise.resolve()
let checkpointEpoch = 0
const publicTrack = (do(song)
	return song ? Object.fromEntries(['title', 'artist', 'album', 'coverArt', 'art', 'art_cached', 'trackToken', 'rating', 'duration', 'quality', 'audioFormat'].map((do(k) [k, song[k]]))) : null
)

let pendingPlaybackImport = null
let pendingRoomImport = null
let extensionHealth = 0
let extensionHealthBusy = false
let lastExtensionPlayback = null
let copiesClearing = Promise.resolve()
const copyMirrors = new Map()

def localPlayback()
	if !state.song || state.remote
		return null
	return {
		v: 1,
		at: Date.now(),
		sid: (state.sessionMeta)?.sid || '',
		userId: (((state.client)?.session())?.user)?.id || '',
		station: state.station,
		stations: state.stations.slice(),
		song: state.song,
		queue: state.queue,
		position: (state.resume)?.position ?? el.audio.currentTime,
		duration: state.song.duration || 0,
		status: !state.resume && !el.audio.paused ? 'playing' : 'paused',
		quality: state.quality,
		volume: state.volume,
		room: (state.rooms)?.getState() || null
	}

def transferPlaybackToExtension()
	const p = pendingPlaybackImport
	if !p || !state.extSid || !(state.bridge)?.session
		return
	pendingPlaybackImport = null
	const sharedUserId = (((state.saved)?.session)?.user)?.id
	if !p.userId || !sharedUserId || String(p.userId) !== String(sharedUserId)
		return
	# Session sharing chooses the extension's established session when present. A
	# handoff carries that agreed sid; raw URLs travel only in this command reply.
	const song = {...p.song}
	if (song.melodicaPlay)?.sid === p.sid && song.melodicaPlay.trackToken === song.trackToken
		song.melodicaPlay = {...song.melodicaPlay, sid: state.extSid}
	try
		await state.bridge.command('playback-import', {playback: {...p, sid: state.extSid, song}}, 4000)
	catch _
		# older extension

def transferRoomToExtension()
	const room = pendingRoomImport
	if !(room)?.id || !(state.bridge)?.session || !state.remote
		return
	pendingRoomImport = null
	try
		const result = await state.bridge.command('room-join', {roomId: room.id, paused: (room.audio)?.paused === true}, 10000)
		if !(result)?.ok
			playerMessage((result)?.error || 'The extension could not join this room.', 'error')
		elif result.state
			renderRemote(result.state)
	catch e
		playerMessage(e.message, 'error')

def startExtensionHandoff()
	if extensionHealth || !state.tabs.owner || !(state.bridge)?.session || state.bridge.kind === 'tab'
		return
	extensionHealth = setInterval((do
		if extensionHealthBusy || !state.remote || !state.tabs.owner
			return
		extensionHealthBusy = true
		const bridge = state.bridge
		try
			const r = await bridge.command('playback-export', {}, 3000)
			if state.bridge !== bridge || !state.remote || !bridge.active
				return
			const p = (r)?.playback
			if (r)?.ok && (p)?.v === 1 && p.sid === state.extSid && p.song && p.station
				lastExtensionPlayback = p
				const rec = engineRecord(p)
				await state.vault.write(rec, TAB_HANDOFF)
				if !state.remote || bridge.gone
					return
				mirrorExtensionCopy(bridge, p)
				if (p.played === true || p.status === 'playing') && !p.song.isInsert
					const last = lastRecord({station: p.station, song: p.song, position: p.position, queue: p.queue || []})
					if last
						await state.vault.write(last, LAST_ID)
		catch _
			# A timeout does not prove the extension stopped playing. Keep the page a
			# remote until the content script confirms its runtime was invalidated.
			if state.bridge === bridge
				playerMessage(CONNECTING, 'info', 0)
		finally
			extensionHealthBusy = false
	), 1000)

def mirrorExtensionCopy(bridge, playback)
	const token = (playback.song)?.trackToken
	if !token || playback.song.isInsert || !state.remember || !state.copies
		return
	const previous = copyMirrors.get(token)
	if (previous)?.done || (previous)?.busy || (previous)?.retryAt > Date.now()
		return
	const entry = {busy: true, retryAt: Date.now() + 5000, done: false}
	copyMirrors.set(token, entry)
	if copyMirrors.size > 4
		copyMirrors.delete(copyMirrors.keys().next().value)
	const valid = (do
		return state.remote && state.bridge === bridge && bridge.active && state.extSid === playback.sid && (!((state.remoteState)?.track)?.trackToken || state.remoteState.track.trackToken === token)
	)
	try
		await copiesClearing
		if !valid()
			return
		if await state.copies.has(token)
			entry.done = true
			return
		const parts = []
		let offset = 0
		let total = 0
		let mime = ''
		while valid()
			const r = await bridge.command('playback-copy', {trackToken: token, offset, limit: 262144}, 5000)
			const c = (r)?.copy
			if !(r)?.ok || !c || !valid()
				return
			if c.sid !== playback.sid || c.trackToken !== token || c.offset !== offset || !Number.isInteger(c.total) || c.total <= 0 || c.total > 128 * 1024 * 1024 || typeof c.bytes !== 'string' || c.bytes.length > 349536
				return
			if offset === 0
				total = c.total
				mime = String(c.mime || 'audio/mp4')
			if c.total !== total || String(c.mime || 'audio/mp4') !== mime || !mime.startsWith('audio/')
				return
			const binary = atob(c.bytes)
			if !binary.length || binary.length > 262144 || offset + binary.length > total
				return
			parts.push(Uint8Array.from(binary, (do(ch) ch.charCodeAt(0))))
			offset += binary.length
			if c.done
				if offset !== total
					return
				await state.copies.keep([token])
				if !valid()
					return
				entry.done = await state.copies.put(token, new Blob(parts, {type: mime}))
				return
			if offset >= total
				return
	catch err
		console.debug('[bridge-copy]', describeError(err))
	finally
		entry.busy = false

def extensionWentAway(bridge)
	if !state.remote || state.bridge !== bridge || !state.tabs.owner
		return
	clearInterval(extensionHealth)
	extensionHealth = 0
	bridge.unsubscribe()
	sessionSyncedFor = ''
	let rec = (lastExtensionPlayback)?.sid === state.extSid ? engineRecord(lastExtensionPlayback) : null
	if ((state.remoteState)?.room)?.id
		if rec
			rec.room = state.remoteState.room
		else
			rec = {
				...engineRecord(),
				saved: null,
				room: state.remoteState.room,
				tab: 'extension',
				song: null,
				station: null,
				stations: []
			}
	state.remote = false
	state.engineReady = false
	remoteChangedAt = 0
	# Keep the bridge listener: a re-enabled extension can announce itself again.
	if !state.client.fn
		await state.client.load()
	if rec && (await restoreTabEngine(rec))
		return
	await startEngine()

def engineRecord(playback = null)
	const p = playback
	return {
		until: Date.now() + 15000,
		tab: p ? 'extension' : state.tabs.id,
		apiBase: state.apiBase,
		saved: p ? state.saved : currentRecord(),
		remember: state.remember,
		stations: state.stations,
		pendingStation: p ? p.pendingStation || null : state.pendingStation,
		station: p ? p.station : state.station,
		song: p ? p.song : state.song,
		queue: p ? p.queue : state.queue,
		history: state.history,
		position: p ? p.position : (state.resume)?.position ?? el.audio.currentTime,
		playing: p ? p.status === 'playing' : !state.resume && !el.audio.paused,
		quality: p ? p.quality : state.quality,
		volume: p ? p.volume : state.volume,
		policy: state.policy,
		account: {config: (state.account)?.config, name: (state.account)?.name},
		room: p ? p.room || null : (state.rooms)?.getState() || null,
		scrobble: state.scrobble ? ({settings: state.scrobble.settings, crew: state.scrobble.crew, loaded: state.scrobble.loaded}) : null,
		cache: [...state.tabs.cache]
	}

def tabSnapshot()
	if !state.engineReady
		return ((state.tabs)?.current)?.state || null
	if state.remote && (state.bridge)?.kind !== 'tab'
		const rs = state.remoteState
		if !rs
			return null
		return {
			...rs,
			track: publicTrack(rs.track),
			last: rs.last ? ({...publicTrack(rs.last), position: rs.last.position}) : null,
			queue: (rs.queue || []).map(publicTrack)
		}
	const song = state.song
	return {
		scrobble: state.scrobble ? ({loaded: state.scrobble.loaded, crew: state.scrobble.crew, settings: state.scrobble.settings}) : null,
		room: (state.rooms)?.getState() || null,
		changedAt: Date.now(),
		loggedIn: !!(state.client)?.loggedIn,
		status: state.resume || el.audio.paused ? 'paused' : 'playing',
		reefProgress: song && ((state.scrobble)?.tracker)?.song === song ? listenProgress(state.scrobble.tracker, state.scrobble.tracker.duration) : null,
		track: publicTrack(song),
		position: (state.resume)?.position ?? el.audio.currentTime,
		duration: (song)?.duration || 0,
		quality: state.quality,
		volume: state.volume,
		pendingStation: state.pendingStation ? ({token: state.pendingStation.id, name: state.pendingStation.name}) : null,
		station: state.station ? ({token: state.station.id, name: state.station.name}) : null,
		stations: state.stations.map((do(s) ({token: s.id, name: s.name, isQuickMix: s.isQuickMix}))),
		queue: state.queue.filter((do(s) !s.isInsert)).map(publicTrack),
		queueLength: state.queue.length,
		last: state.resume ? ({...publicTrack(song), position: state.resume.position}) : null,
		user: {username: (state.account)?.name || el.signedIn.textContent || ''}
	}

def tabBridge()
	return {
		kind: 'tab',
		name: 'another melodica tab',
		version: '',
		session: 0,
		active: true,
		player: true,
		gotState: !!(state.tabs.current)?.state,
		command: (do(action, fields) state.tabs.command(action, fields)),
		subscribe: (do(fn)
			state.tabs.onState = fn
			if (state.tabs.current)?.state
				fn(state.tabs.current.state)
		),
		unsubscribe: (do
			state.tabs.onState = null
		),
		post: (do
			return
		)
	}

def enterTabRemote()
	(state.rooms)?.suspend()
	state.engineReady = false
	if (state.bridge)?.kind !== 'tab'
		(state.bridge)?.stop()
	state.bridge = tabBridge()
	state.remote = false
	enterRemote()
	el.app.dataset.engine = 'remote'
	setStatus('Playing in another melodica tab')
	# Changes paint before any account discovery, relay restore or wasm bootstrap.
	if (state.tabs.current)?.state
		renderRemote(state.tabs.current.state)

def tabCommand(action, fields = {})
	if !state.engineReady
		return {ok: false, error: 'The player is starting. Try again in a moment.'}
	if state.remote && (state.bridge)?.kind !== 'tab'
		return state.bridge.command(action, fields)
	try
		if action.startsWith('room-')
			const result = await state.rooms.handle(action, fields)
			state.tabs.publish()
			checkpointEngine(true)
			return {...result, state: tabSnapshot()}
		if (state.rooms)?.active() && (['toggle', 'pause', 'resume', 'next', 'volume'].includes(action) || action === 'play' && !fields.station)
			const a = (state.rooms.getState())?.audio
			const command = action === 'toggle' ? (a)?.paused || !['listening', 'broadcasting'].includes((a)?.state) ? 'room-resume' : 'room-pause' : ({play: 'room-resume', resume: 'room-resume', pause: 'room-pause', next: 'room-skip', volume: 'room-volume'})[action]
			const result = await state.rooms.handle(command, fields)
			state.tabs.publish()
			return {...result, state: tabSnapshot()}
		switch action
			when 'login'
				rememberChoice(fields.remember !== false)
				if !await login(String(fields.email || ''), String(fields.password || ''))
					return {ok: false, error: el.loginMessage.textContent}
			when 'logout'
				logout()
			when 'remember'
				setRemember(fields.value)
			when 'scrobble-settings'
				await setScrobbleSetting(fields.patch || {})
			when 'play'
				const st = state.stations.find((do(s) s.id === (fields.station)?.token))
				if st
					await playStation(st)
				elif state.resume
					await resumeLast()
				elif state.song
					await el.audio.play()
			when 'toggle'
				togglePlay()
			when 'resume'
				if state.resume
					await resumeLast()
				else
					await el.audio.play()
			when 'pause'
				el.audio.pause()
			when 'next'
				skip()
			when 'love', 'ban'
				await rateSong(state.song, action)
			when 'tired'
				await tired()
			when 'volume'
				setVolume(fields.value)
			when 'quality'
				if roomBlocksSource((state.rooms)?.getState()) || (((state.rooms)?.getState())?.state)?.play
					return {ok: false, error: 'Leave the room to change your station’s quality.'}
				if QUALITIES.includes(fields.value)
					setQuality(fields.value)
					state.queue = []
					renderUpNext()
			when 'stations'
				break
			when 'seed'
				await playSeed(fields.seed)
			else
				return {ok: false, error: ''.concat('The player does not support ', action, '.')}
		state.tabs.publish()
		checkpointEngine(true)
		return {ok: true, state: tabSnapshot()}
	catch err
		return {ok: false, error: describeError(err)}

def checkpointEngine(force = false)
	if !state.tabs.owner || !state.engineReady || state.remote || !state.vault || !(state.rooms)?.active() && (!state.sessionMeta || !(state.client)?.loggedIn || !state.stations.length) || !force && Date.now() - checkpointAt < 1000
		return
	checkpointAt = Date.now()
	const rec = engineRecord()
	const epoch = checkpointEpoch
	state.tabs.publishHandoff(rec)
	if !state.remember
		return
	checkpointWrite = checkpointWrite.then((do
		return state.tabs.owner && state.remember && epoch === checkpointEpoch ? state.vault.write(rec, TAB_HANDOFF) : null
	)).catch((do(err) console.debug('[tabs]', describeError(err))))

def restoreTabEngine(rec)
	# Reconstitute the live session without user.getStationList, /me or a login.
	const saved = rec.saved
	const roomOnly = !(saved)?.session && !!(rec.room)?.id
	if !roomOnly
		if !(saved)?.session || !Array.isArray(rec.stations) || !rec.stations.length || !state.client.restore(saved.session, rec.stations)
			return false
		state.client.setCredentials(saved.credential ? ({user: saved.credential.email, password: saved.credential.password}) : null)
		state.client.restoreAccess((saved.relay)?.token || '', (saved.relay)?.at || 0)
	state.saved = saved || null
	state.sessionMeta = (saved)?.session || null
	state.remember = rec.remember
	state.policy = rec.policy || {inserts: true}
	state.stations = rec.stations || []
	state.pendingStation = rec.pendingStation || null
	state.station = rec.station
	state.queue = rec.queue || []
	state.history = rec.history || []
	state.quality = rec.quality
	state.volume = rec.volume
	state.account.config = (rec.account)?.config || null
	state.account.name = (rec.account)?.name || ''
	state.scrobbles = new Scrobbles({origin: location.origin, token: scrobbleToken})
	state.scrobble = {...newScrobbleState(), ...rec.scrobble}
	state.engineReady = true
	state.remote = false
	el.app.dataset.mode = 'local'
	el.app.dataset.engine = 'owner'
	el.searchForm.hidden = false
	el.logout.hidden = false
	buildStations()
	showUsername(state.account.name)
	show(roomOnly ? el.viewLogin : el.viewPlayer)
	renderScrobbleSettings()
	syncRemember()
	renderHistory()
	if pendingSeed
		# Station playback waits for ready controls; the restored engine can accept it now.
		markReady()
		await playSeed(pendingSeed)
		updateStatus()
		state.tabs.publish()
		return true
	if !roomOnly && rec.song && rec.station
		# The public view has the latest position even if the asynchronous checkpoint
		# was interrupted by close/reload.
		const view = (state.tabs.current)?.state
		const pos = ((view)?.track)?.trackToken === rec.song.trackToken ? Number(view.position) || rec.position : rec.position
		showResumable(rec.station, {song: rec.song, queue: rec.queue || [], position: pos})
		if rec.playing && rec.tab !== state.tabs.id
			await resumeLast()
	if (rec.room)?.id
		await state.rooms.command('room-join', {id: rec.room.id, paused: rec.tab === state.tabs.id || (rec.room.audio)?.paused === true})
	renderUpNext()
	updateStatus()
	state.tabs.publish()
	markReady()
	return true

def takeTabEngine()
	state.tabs.onState = null
	(state.bridge)?.unsubscribe()
	state.remote = false
	state.bridge = null
	remoteChangedAt = 0
	delete el.app.dataset.mode
	el.app.dataset.engine = 'owner'
	await startEngine()

let startupSnapshot = null
let linkedPlayer = null
def handoffAvailable()
	return !state.remote && !(state.rooms)?.active() && !(state.song)?.isInsert && !state.resuming
def handoffRecord()
	if !handoffAvailable() || !state.song || urlExpired(state.song) || state.queue.some(do(s) s.isInsert)
		return null
	const rec = lastRecord({station:state.station,song:state.song,position:(state.resume)?.position ?? el.audio.currentTime,queue:[]})
	return rec ? {...rec,playing:!el.audio.paused && !state.resume} : null
def acceptHandoff(rec)
	if !handoffAvailable() || !validLast(rec) || !Array.isArray(rec.queue) || !Number.isFinite(rec.position) || rec.position < 0 || urlExpired(rec.song)
		throw new Error('This song is no longer available for transfer.')
	const source = new URL(rec.song.audioUrl)
	if !['https:','http:'].includes(source.protocol) || !/(^|\.)(pandora\.com|p-cdn\.us|p-cdn\.com)$/i.test(source.hostname) || source.username || source.password || source.port
		throw new Error('The song must come from your Pandora station.')
	const st = state.stations.find(do(s) s.id === rec.station.id)
	if !st
		throw new Error('This station is unavailable in the current account.')
	el.audio.pause()
	const copy = lastRecord({station:st,song:rec.song,position:rec.position,queue:[]})
	showResumable(st,copy)
	if rec.playing
		await resumeLast()
		if el.audio.paused || (state.song)?.trackToken !== copy.song.trackToken
			throw new Error('Playback could not start here.')
let stationTools = null
let phone = null
let phoneArtSource = null
let phoneArt = ''
def phonePlayback()
	const room = (state.rooms)?.getState()
	const play = (room)?.state && (room.state)?.play
	const song = play ? roomTrack(play) : state.song
	if phoneArtSource !== ((song)?.coverArt || '')
		phoneArtSource = (song)?.coverArt || ''
		phoneArt = ''
		const current = phoneArtSource
		artCachedUrl(song).then(do(url)
			if phoneArtSource === current && url && phone
				phoneArt = url
				phone.sync()
		)
	return {playing:el.play.dataset.state === 'playing',audible:!!walkSong(),title:(song)?.title || '',artist:(song)?.artist || '',album:(song)?.album || '',art:phoneArt,stationId:(state.station)?.id || '',stationName:(state.station)?.name || '',position:play ? roomPositionMs(room) / 1000 : el.audio.currentTime || 0,duration:(song)?.duration || 0}
def phoneCommand(action)
	if action === 'skip'
		return skip()
	if ['love','ban'].includes(action)
		return rate(action)
	if !['pause','play'].includes(action)
		return
	if (state.rooms)?.active()
		return state.rooms.command(action === 'pause' ? 'room-pause' : 'room-resume').catch(do(e) playerMessage(e.message,'error'))
	if state.remote
		return remoteCommand(action === 'pause' ? 'pause' : 'resume')
	if action === 'pause'
		return el.audio.pause()
	if el.audio.paused || !state.song || state.resume
		return togglePlay(true)
def installStationPanels()
	const [{LinkedPlayer},{StationTools}] = await Promise.all([import('./devices.js'),import('./station-tools.js')])
	linkedPlayer = new LinkedPlayer(document.querySelector('.deck'),{
		identity:(do (((state.client)?.session())?.user)?.id || ''),
		summary:phonePlayback,command:(do(action)
			if action === 'pause' && phone
				phone.manualPause()
			return phoneCommand(action)
		),available:handoffAvailable,record:handoffRecord,accept:acceptHandoff,
		rejected:(do(rec)
			if rec.playing && el.audio.paused && (state.song)?.trackToken === rec.song.trackToken
				playerMessage('The transfer could not finish. Press Play here to continue.','info',0)
		)
	})
	const folderFilter = document.createElement('select')
	folderFilter.hidden = true
	folderFilter.setAttribute('aria-label','Filter stations by folder')
	el.stationFilter.after(folderFilter)
	stationTools = new StationTools(el.stationList.parentElement,{
		folderFilter, stations:(do state.stations),active:(do state.station),track:(do state.song),
		account:(do (((state.saved)?.session)?.user)?.id || (((state.client)?.session())?.user)?.id || ''),
		email:(do (state.sessionMeta)?.email || ''),client:(do state.client),remote:(do state.remote),
		rebuild:buildStations,create:createStation,reload:loadStations,
		changed:(do(id)
			if id && (state.station)?.id === id
				state.queue = []
				state.playGen++
				renderUpNext()
		)
	})
	folderFilter.onchange = do
		stationTools.folder = folderFilter.value
		filterStations()
	buildStations()

def connectPhone()
	const {PhonePlayer} = await import('./mobile.js')
	phone = new PhonePlayer({
		audio:el.audio, playback:phonePlayback, command:phoneCommand, volume:applyVolume, online:flushScrobbleRetry,
		openLink:openListenLink,
		ready:(do el.app.dataset.ready === 'true'),
		stations:(do el.app.dataset.view === 'player' ? state.stations : []), station:(do el.app.dataset.view === 'player' ? state.station : null),
		tune:(do(id) controlWalkMusic(id)),
		eqTrack:(do !state.remote && !(state.rooms)?.active() && !(state.song)?.isInsert ? state.song : null),
		read:(do(song,opt) state.copies.readBlob(song,opt)),
		quality:(do(q)
			if state.quality !== q && !el.quality.disabled
				el.quality.value = q
				el.quality.dispatchEvent(new Event('change'))
		),
		message:(do(msg) playerMessage(msg,'info',0)),
		recover:(do(song,pos,current,attempt)
			if !current()
				return false
			if attempt >= 3 && state.station
				await nextSong()
				return !!state.song && !el.audio.paused
			return await playFrom(song.audioUrl,pos,{current})
		)
	})

def main()
	state.vault = new Vault()
	state.tabs = new TabPlayer({
		snapshot: tabSnapshot,
		command: tabCommand,
		takeover: takeTabEngine,
		lose: enterTabRemote,
		checkpoint: checkpointEngine,
		suspend: (do
			el.audio.pause()
			(state.rooms)?.suspend()
		),
		prepareRequest: (do(request)
			# A remote without a remembered token still reads as the engine's listener.
			# Add its bearer in the engine only; the response shares the engine's cache.
			const url = new URL(request.url)
			if url.origin !== location.origin || !url.pathname.startsWith('/scrobble/api/')
				return request
			const headers = new Headers(request.headers)
			if !headers.has('authorization')
				const token = await scrobbleToken()
				if token
					headers.set('authorization', ''.concat('Bearer ', token))
			return {...request, headers: [...headers]}
		)
	})
	mark('tabsBegin')
	await state.tabs.start()
	mark('tabsReady')
	state.savedReady = loadSaved().catch((do
		state.saved = null
	))
	startupSnapshot = readSnapshot()
	const snap = startupSnapshot
	if snap && state.tabs.owner
		paintSnapshot(snap)
	el.volume.value = el.barVolume.value = String(state.volume)
	el.quality.value = state.quality
	installEvents()
	installRooms()
	installShell()
	installResume()
	installScrobbleEvents()
	installMediaSession()
	if globalThis.melodicaDevice
		connectPhone().catch(do(err) console.debug('[phone]',describeError(err)))
	else
		window.addEventListener('melodica:device-ready',(do connectPhone().catch(do(err) console.debug('[phone]',describeError(err)))),{once:true})
	readyPromise.then(do
		requestAnimationFrame(do setTimeout((do installStationPanels().catch(do(err) console.debug('[stations]',describeError(err)))),0))
	)
	if !snap || !snap.song
		showIdle()
	updateRatingButtons()
	setPlayIcon(false)
	renderUpNext()
	renderHistory()

	if !state.tabs.owner
		enterTabRemote()
		return
	await startEngine()

def startEngine()
	mark('engineStart')
	const snap = startupSnapshot
	let api
	try
		api = apiBaseFromPage()
	catch err
		throw new Error(''.concat('Bad relay address: ', describeError(err)))
	state.apiBase = api.apiBase
	state.apiFromQuery = api.fromQuery
	const log = (do(m) console.debug('[piano]', m))
	state.client = new PianoClient({
		apiBase: api.apiBase,
		log,
		onAccess: (do
			refreshPolicy()
		),
		onSession: onClientSession
	})
	# The optional spacegho.st account: finishes a sign-in round trip and reads the
	# policy while the wasm loads; logins wait for it so the policy is known first.
	const session = {
		get: (do(k)
			try
				return sessionStorage.getItem(k)
			catch _
				return null
		),
		set: (do(k, v)
			try
				sessionStorage.setItem(k, v)
			catch _
				# unavailable
		),
		remove: (do(k)
			try
				sessionStorage.removeItem(k)
			catch _
				# unavailable
		)
	}
	state.account = new Account({origin: location.origin, store, session, log: (do(m) console.debug('[account]', m))})
	# The melodica extension: say hello now (and again for a few seconds) so its content
	# script can answer while the wasm loads; it may also appear later, and the page
	# then switches to remote mode (onBridgeChange). An explicit ?api= means the relay
	# given there, without the extension (the CI smoke relies on that).
	if !api.fromQuery && bridgeAllowed(location)
		state.bridge = new BridgeTransport(window, {
			log,
			onChange: onBridgeChange,
			onSession: (do(m) applyExtensionSession(m, false)),
			onAccountSignout: onExtensionAccountSignout,
			onRoomClock: (do({room})
				if (state.rooms)?.updateClockRemote(room) && state.remoteState
					state.remoteState.room = state.rooms.getState()
			)
		})
		state.bridge.start()
		mark('bridgeStart')
	updateStatus()
	# The wasm loads meanwhile, so the page on its own does not wait for the extension.
	const loading = state.client.load().then((do null), (do(err) err || new Error('load failed')))
	# Discovery and WASM loading run while the encrypted session opens. Adopt a warm
	# handoff's request cache before account validation can make a network request.
	const handoffRead = state.tabs.handoff || state.vault.read(TAB_HANDOFF)
	const lastRead = snap && snap.mode === 'standalone' ? state.vault.read(LAST_ID) : null
	await state.savedReady
	mark('vaultReady')
	const handoff = state.tabs.handoff || (await handoffRead)
	const warm = handoff && handoff.until > Date.now() && handoff.apiBase === state.apiBase
	if warm
		state.tabs.restoreCache(handoff.cache)
	state.accountReady = (warm ? Promise.resolve() : setupAccount().catch((do(err) console.debug('[account]', describeError(err)))).then((do remountOnAuth()))).finally((do
		if !state.accountNavigating
			el.app.dataset.accountReady = 'true'
	))
	resolveAccountStarted()
	# Painted from the snapshot: as a remote, the extension has the full hello window
	# (a dot says "connecting" after 300 ms; nothing is blocked meanwhile); on its own,
	# nothing waits for an extension (one that appears takes over, onBridgeChange).
	# Without a snapshot an installed extension gets 1.5 s before any login shows.
	if state.bridge && snap && snap.mode === 'remote'
		const dot = setTimeout((do
			if !state.remote
				el.app.dataset.connecting = 'true'
		), 300)
		const ok = await state.bridge.waitReady()
		clearTimeout(dot)
		delete el.app.dataset.connecting
		if ok
			return
		delete el.app.dataset.snapshot
	elif state.bridge && !snap
		if await state.bridge.waitReady(1500)
			return
		# onBridgeChange entered remote mode
	const [loadErr] = await Promise.all([loading, state.savedReady])
	if state.remote
		return
	if loadErr
		showFatal(''.concat('Could not load melodica.wasm: ', describeError(loadErr)))
		setStatus('wasm failed to load', true)
		return
	if warm && (await restoreTabEngine(handoff))
		return
	state.engineReady = true
	el.app.dataset.engine = 'owner'
	updateStatus()
	# An extension that said present but not yet ready is waking its background: the
	# page waits for it as a remote (up to the hello window) instead of showing a login.
	if state.bridge && state.bridge.present && !(snap && snap.mode === 'standalone')
		show(el.viewPlayer)
		playerMessage(CONNECTING, 'info', 0)
		if await state.bridge.waitReady()
			return
		playerMessage('')
	# A reload never lands on the login card while a session may exist: the vault is
	# read first, and with something remembered the player shows "Restoring…" while,
	# in order, an extension (3 s, the full hello window when it said present), the
	# remembered session and then the remembered password are tried.
	await state.savedReady
	if state.remote
		return
	const saved = state.saved && (state.saved.session || state.saved.credential) ? state.saved : null
	if saved && saved.session && snap && snap.mode === 'standalone' && (await quickResume(saved,lastRead))
		return
	if !saved
		forgetSnapshot()
		markReady()
		showLogin()
		await state.accountReady
		if state.remote
			return
		updateAccountLine()
		syncRemember()
		return
	showRestoring(true)
	await state.accountReady
	if state.bridge
		await state.bridge.waitReady(state.bridge.present ? undefined : 3000)
	if state.remote
		showRestoring(false)
		return
	updateAccountLine()
	syncRemember()
	let ok = false
	if saved.session
		ok = await resumeSaved()
	if !ok && !state.remote && saved.credential
		ok = await login(saved.credential.email, saved.credential.password)
	showRestoring(false)
	markReady()
	if ok || state.remote
		return
	forgetSnapshot()
	showLogin()
	# keeps the reason in the login message

# The remembered session, put back without a network call: the controls are live at
# once. The station list, the policy and the account refresh behind it; the first
# Pandora request checks the session, and PianoClient logs in again with the remembered
# credential when Pandora or the relay no longer honour it. Only if that fails does the
# login card show.
def quickResume(saved,lastRead)
	const s = saved.session
	if !state.client.restore(s)
		return false
	state.sessionMeta = {sid: s.sid, email: s.email, createdAt: s.createdAt}
	state.client.setCredentials(saved.credential ? ({user: saved.credential.email, password: saved.credential.password}) : null)
	const fresh = saved.relay && saved.relay.token && Date.now() < relayTokenUntil(saved.relay)
	state.client.restoreAccess(fresh ? saved.relay.token : '', fresh ? saved.relay.at : 0)
	if s.email
		store.set(STORAGE.email, s.email)
	updateStatus()
	await offerResume(lastRead)
	if state.remote
		return true
	markReady()
	((do
		if fresh
			refreshPolicy()
		await state.accountReady
		if state.remote
			return
		updateAccountLine()
		syncRemember()
		try
			await enterPlayer({quiet: true})
			persistSession()
			# a re-login meanwhile, or a new relay token
		catch err
			if state.remote || leavingPage || err.name === 'AbortError' || err.status === 0
				return
			state.client.logout()
			state.sessionMeta = null
			forgetSnapshot()
			stopPlayback()
			showLogin()
			loginMessage(saved.credential ? describeError(err) : 'Your Pandora session ended; sign in again.', saved.credential ? 'error' : 'info')
	))()
	return true

const RESTORING = 'Restoring your session…'
def showRestoring(on)
	if on
		show(el.viewPlayer)
		el.app.dataset.restoring = 'true'
		playerMessage(RESTORING, 'info', 0)
	else
		delete el.app.dataset.restoring
		if el.playerMessage.textContent === RESTORING
			playerMessage('')

# The view is unhidden before the alert text is set so it is announced; focus
# moves to the heading so keyboard and screen-reader users land on the error.
def showFatal(text)
	show(el.viewError)
	el.fatal.textContent = text
	const h = el.viewError.querySelector('h2')
	if h
		h.focus()

main().catch((do(err)
	showFatal(describeError(err))
	setStatus('startup failed', true)
))
