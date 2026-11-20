# A listener opens this panel on one device. Use that browser's cancellable
# request before TabPlayer installs its shared-account request transport.
const fetchLyrics = globalThis.fetch.bind(globalThis)

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
		self.version = version
		self.message = panel.querySelector('[role=status]')
		self.retry = panel.querySelector('button')
		self.words = panel.querySelector('[data-words]')
		self.lines = []
		self.position = 0
		panel.addEventListener('toggle',do
			if panel.open
				self.load()
				self.tick(self.position)
			else
				self.cancel()
		)
		self.retry.addEventListener('click',do self.load())

	def cancel()
		(self.controller)?.abort()
		self.controller = null

	def track(song)
		let key = ''
		if (song)?.artist && song.title && !song.isInsert && song.kind !== 'insert'
			key = JSON.stringify([song.artist,song.title,song.album || '',Math.round(Number(song.duration) || 0)])
		if key === self.key
			return
		self.cancel()
		self.key = key
		self.panel.hidden = !key
		self.song = song
		self.lines = []
		self.loaded = false
		self.position = 0
		self.active = null
		self.message.textContent = ''
		self.words.hidden = true
		self.retry.hidden = true
		if !key
			self.panel.open = false
		elif self.panel.open
			self.load()

	def load()
		if !self.key || !self.panel.open || self.loaded || self.controller
			return
		const controller = new AbortController()
		self.controller = controller
		const timeout = setTimeout((do controller.abort()),12000)
		self.retry.hidden = true
		self.message.textContent = 'Looking up lyrics on LRCLIB…'
		try
			const song = self.song
			const url = new URL('https://lrclib.net/api/get')
			url.searchParams.set('artist_name',song.artist)
			url.searchParams.set('track_name',song.title)
			if song.album
				url.searchParams.set('album_name',song.album)
			if Number(song.duration) > 0
				url.searchParams.set('duration',String(Math.round(song.duration)))
			const reply = await fetchLyrics(url.href,{signal:controller.signal,credentials:'omit',referrerPolicy:'no-referrer',headers:{'Lrclib-Client':'Melodica/' + self.version + ' (https://github.com/Spaceghost/melodica-web)'}})
			if !reply.ok && reply.status !== 404
				throw new Error('Lyrics unavailable')
			const record = reply.ok ? await reply.json() : null
			if self.controller !== controller
				return
			self.lines = parseLrc((record)?.syncedLyrics)
			self.loaded = true
			self.message.textContent = self.lines.some(do(line) !!line.text) ? '' : (record)?.instrumental ? 'Instrumental track.' : 'No timed lyrics for this recording.'
			self.words.hidden = !!self.message.textContent
			self.tick(self.position)
		catch e
			if self.controller === controller
				self.message.textContent = 'Could not reach LRCLIB. Try again.'
				self.retry.hidden = false
		finally
			clearTimeout(timeout)
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
		self.active = index
		for node,i in self.words.children
			node.textContent = (self.lines[index + i - 1])?.text || ''
