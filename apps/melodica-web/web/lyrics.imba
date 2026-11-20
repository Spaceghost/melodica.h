# A listener opens this panel on one device. Use that browser's cancellable
# request before TabPlayer installs its shared-account request transport.
const fetchLyrics = globalThis.fetch.bind(globalThis)
const preference = 'melodica.lyrics.open'
let retryAfter = 0

def normalizeName(value)
	return String(value || '').normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

# Ignore packaging and featured-artist suffixes. Keep live, acoustic, remix and language versions distinct.
def simpleTitle(value)
	return String(value || '').replace(/\s*[(\[]\s*(?:(?:feat\.?|ft\.?|featuring)\s+[^)\]]+|(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?|explicit(?:\s+version)?|album version)\s*[)\]]/gi, '').replace(/\s+[-–—]\s+(?:(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?|album version)$/i, '').trim()

def mainArtist(value)
	return normalizeName(String(value || '').split(/\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0])

def readDuration(value)
	const seconds = Math.round(Number(value))
	return seconds >= 1 && seconds <= 3600 ? seconds : 0

def wordsOf(record)
	return typeof (record)?.plainLyrics === 'string' ? record.plainLyrics.trim() : ''

def contentOf(record)
	const lines = parseLrc((record)?.syncedLyrics)
	return {lines: lines.some(do(line) !!line.text) ? lines : [], plain: wordsOf(record), instrumental: (record)?.instrumental === true}

def searchMatch(records, song)
	const wantedTitle = normalizeName(simpleTitle(song.title))
	const fullTitle = normalizeName(song.title)
	const artist = mainArtist(song.artist)
	const album = normalizeName(song.album)
	const duration = readDuration(song.duration)
	let best = null
	let bestRank = null
	for record of Array.isArray(records) ? records : []
		if !wantedTitle || mainArtist((record)?.artistName) !== artist || normalizeName(simpleTitle((record)?.trackName)) !== wantedTitle
			continue
		const content = contentOf(record)
		if !content.lines.length && !content.plain && !content.instrumental
			continue
		const sameAlbum = !!album && normalizeName(record.albumName) === album
		const length = readDuration(record.duration)
		const gap = duration && length ? Math.abs(length - duration) : Infinity
		# A different edit can still supply the words, but its clock is unreliable.
		if !(gap <= 4 || ((!duration || !length) && sameAlbum))
			if !content.plain
				content.plain = content.lines.map(do(line) line.text).join('\n').trim()
			content.lines = []
		const wording = content.lines.length ? 0 : content.plain ? 1 : 2
		const rank = [wording, Number(normalizeName(record.trackName) !== fullTitle), Number(!sameAlbum), gap]
		const difference = bestRank ? rank.findIndex(do(value, i) value !== bestRank[i]) : -1
		if !bestRank || (difference >= 0 && rank[difference] < bestRank[difference])
			bestRank = rank
			best = content
	return best

def requestRecord(action, params, version, signal)
	if signal.aborted || Date.now() < retryAfter
		throw new Error('Lyrics unavailable')
	const hosted = location.origin === 'https://spacegho.st'
	const url = new URL(action, hosted ? location.origin + '/melodica/lyrics/' : 'https://lrclib.net/api/')
	url.search = params.toString()
	const controller = new AbortController()
	const abort = do controller.abort()
	signal.addEventListener('abort', abort, {once: true})
	const timeout = setTimeout(abort, 10000)
	try
		const headers = hosted ? {} : {'Lrclib-Client': 'Melodica/' + version + ' (https://spacegho.st/melodica/app/)'}
		const reply = await fetchLyrics(url.href, {signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', headers})
		if reply.status === 404
			return null
		if !reply.ok
			const delay = reply.headers.get('retry-after')
			if delay || reply.status === 429
				const retryTime = delay && !/^\d+$/.test(delay) ? Date.parse(delay) : Date.now() + Number(delay || 5) * 1000
				retryAfter = Math.max(retryAfter, (Number.isFinite(retryTime) ? retryTime : Date.now() + 5000) + Math.ceil(Math.random() * 250))
			throw new Error('Lyrics unavailable')
		return await reply.json()
	finally
		clearTimeout(timeout)
		signal.removeEventListener('abort', abort)

def lookup(song, version, signal)
	const params = new URLSearchParams({artist_name: song.artist, track_name: song.title})
	const exact = new URLSearchParams(params)
	if song.album
		exact.set('album_name', song.album)
	const duration = readDuration(song.duration)
	if duration
		exact.set('duration', String(duration))
	let first = null
	let failure = null
	try
		first = contentOf(await requestRecord('get', exact, version, signal))
		if first.lines.length || first.instrumental
			return first
	catch err
		failure = err
	const title = simpleTitle(song.title)
	if title
		params.set('track_name', title)
	const artist = song.artist.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0].trim()
	if artist
		params.set('artist_name', artist)
	try
		const found = searchMatch(await requestRecord('search', params, version, signal), song)
		if (found)?.lines.length
			return found
		if (first)?.plain
			return first
		if found
			return found
	catch err
		if (first)?.plain
			return first
		throw err
	if failure
		throw failure
	return first

# Line timestamps are relative to the recording. A positive LRC offset
# advances the display. Empty timed lines clear the words during breaks.
export def parseLrc(raw)
	if typeof raw !== 'string'
		return []
	const offset = Number((/^\s*\[offset:\s*([+-]?\d+)\]\s*$/im.exec(raw))?.[1] || 0)
	const byTime = new Map()
	for row of raw.split(/\r?\n/)
		const prefix = /^\s*((?:\[\d+:[0-5]\d(?:[.:]\d{1,3})?\]\s*)+)/.exec(row)
		if !prefix
			continue
		const words = row.slice(prefix[0].length).trim()
		for tag of prefix[1].matchAll(/\[(\d+):([0-5]\d)([.:]\d{1,3})?\]/g)
			const fraction = tag[3] ? Number('0.' + tag[3].slice(1)) : 0
			const at = Number(tag[1]) * 60 + Number(tag[2]) + fraction - offset / 1000
			const lines = byTime.get(at) || []
			if words && !lines.includes(words)
				lines.push(words)
			byTime.set(at,lines)
	return Array.from(byTime,do([at,words]) ({at,text:words.join('\n')})).sort(do(a,b) a.at - b.at)

export class LyricPanel
	def constructor(panel,version)
		self.panel = panel
		self.shortcut = document.getElementById('bar-lyrics')
		self.version = version
		self.message = panel.querySelector('[role=status]')
		self.retry = panel.querySelector('button')
		self.words = panel.querySelector('[data-words]')
		self.lines = []
		self.position = 0
		panel.hidden = false
		if self.shortcut
			self.shortcut.hidden = false
		try
			panel.open = globalThis.localStorage.getItem(preference) === '1'
		catch _
			# The panel still works without browser storage.
		panel.addEventListener('toggle',do
			try
				globalThis.localStorage.setItem(preference, panel.open ? '1' : '0')
			catch _
				# The choice lasts for this page.
			if panel.open
				self.load()
				self.tick(self.position)
			else
				self.cancel()
		)
		self.retry.addEventListener('click',do self.load())
		self.track(null)

	def cancel()
		(self.controller)?.abort()
		self.controller = null

	def track(song)
		let key = ''
		if (song)?.artist && song.title && !song.isInsert && song.kind !== 'insert'
			key = JSON.stringify([song.artist,song.title,song.album || '',Math.round(Number(song.duration) || 0)])
		else
			self.message.textContent = !song ? 'Play a song in this player to see its lyrics.' : song.isInsert || song.kind === 'insert' ? 'Lyrics resume after this break.' : 'Waiting for song details…'
		if key === self.key
			return
		self.cancel()
		self.key = key
		self.song = song
		self.lines = []
		self.loaded = false
		self.position = 0
		self.active = null
		if key
			self.message.textContent = ''
		self.words.replaceChildren()
		self.words.scrollTop = 0
		self.words.hidden = true
		self.retry.hidden = true
		if key && self.panel.open
			self.load()

	def load()
		if !self.key || !self.panel.open || self.loaded || self.controller
			return
		const controller = new AbortController()
		self.controller = controller
		self.retry.hidden = true
		self.message.textContent = 'Looking up lyrics on LRCLIB…'
		try
			const result = await lookup(self.song, self.version, controller.signal)
			if self.controller !== controller
				return
			self.lines = (result)?.lines || []
			self.loaded = true
			self.words.hidden = !self.lines.length && !(result)?.plain
			if self.lines.length
				const fragment = document.createDocumentFragment()
				for line of self.lines
					const node = document.createElement('p')
					node.textContent = line.text
					fragment.append(node)
				self.words.replaceChildren(fragment)
				self.message.textContent = ''
			elif (result)?.plain
				self.words.textContent = result.plain
				self.message.textContent = 'Lyrics without timestamps.'
			else
				self.message.textContent = (result)?.instrumental ? 'Instrumental track.' : 'No lyrics found for this recording.'
			self.tick(self.position)
		catch e
			if self.controller === controller
				const seconds = Math.ceil((retryAfter - Date.now()) / 1000)
				self.message.textContent = seconds > 0 ? 'LRCLIB is busy. Try again in ' + seconds + ' seconds.' : 'Could not reach LRCLIB. Try again.'
				self.retry.hidden = false
		finally
			if self.controller === controller
				self.controller = null

	def tick(seconds)
		self.position = Number(seconds) || 0
		if !self.panel.open || !self.lines.length
			return
		let low = 0
		let high = self.lines.length
		while low < high
			const middle = Math.floor((low + high) / 2)
			if self.lines[middle].at <= self.position
				low = middle + 1
			else
				high = middle
		const index = low - 1
		if self.active === index
			return
		if self.active != null
			self.words.children[self.active]?.removeAttribute('aria-current')
		self.active = index
		const node = self.words.children[index]
		if node && node.textContent
			node.setAttribute('aria-current', 'true')
			self.words.scrollTop = node.offsetTop - (self.words.clientHeight - node.offsetHeight) / 2
		elif index < 0
			self.words.scrollTop = 0
