const layout = '''
<summary>Organize and edit stations</summary>
<label>Station to edit <select data-st="station"></select></label>
<div class="station-tools-row"><button type="button" data-st="pin"></button><button type="button" data-st="up">Move pin up</button><button type="button" data-st="down">Move pin down</button></div>
<label>Folder <input data-st="folder" maxlength="60" list="station-folder-names" placeholder="Folder name"><datalist id="station-folder-names" data-st="folders"></datalist></label>
<button type="button" data-st="saveFolder">Save folder</button>
<div data-st="pandora"><details data-st="seeds"><summary>Station seeds and modes</summary>
  <div data-st="seedList"></div><form data-st="search"><label>Add a seed <input data-st="query" type="search" placeholder="Artist or song" required></label><button>Search</button></form><div data-st="results"></div>
  <label>Station mode <select data-st="modes"></select></label><button type="button" data-st="setMode">Apply mode</button>
</details>
<details data-st="mix"><summary>Shuffle stations</summary><div data-st="checks"></div><button type="button" data-st="saveMix">Save shuffle</button></details>
<details data-st="filter"><summary>Explicit-content filter</summary><label><input type="checkbox" data-st="enabled"> Filter explicit content</label>
  <label>Confirm Pandora password <input data-st="password" type="password" autocomplete="current-password"></label><button type="button" data-st="saveFilter">Save filter</button></details>
<div class="station-tools-row"><button type="button" data-st="fromSong">Station from current song</button><button type="button" data-st="fromArtist">Station from current artist</button></div></div>
<p role="status" class="fine" data-st="status"></p>
'''

def action(label,click)
	const b = document.createElement('button')
	b.type = 'button'
	b.textContent = label
	b.onclick = click
	return b

export class StationTools
	def constructor(host,api)
		self.api = api
		self.host = document.createElement('details')
		self.host.className = 'station-tools'
		self.host.innerHTML = layout
		host.append(self.host)
		const e = self.ui = Object.fromEntries(Array.from(self.host.querySelectorAll('[data-st]')).map(do(el) [el.dataset.st,el]))
		self.host.ontoggle = do
			if self.host.open
				self.render()
		e.station.onchange = do
			e.seeds.open = false
			e.results.replaceChildren()
			self.details()
		e.pin.onclick = do
			const id = e.station.value
			if self.prefs.pins.includes(id)
				self.prefs.pins = self.prefs.pins.filter(do(p) p !== id)
			else
				self.prefs.pins.push(id)
			self.save()
		e.up.onclick = do self.move(-1)
		e.down.onclick = do self.move(1)
		e.saveFolder.onclick = do
			const name = e.folder.value.trim()
			if name
				self.prefs.folders[e.station.value] = name
			else
				delete self.prefs.folders[e.station.value]
			self.save()
		e.seeds.ontoggle = do
			if e.seeds.open
				self.loadSeeds()
		e.search.onsubmit = do(ev)
			ev.preventDefault()
			const id = e.station.value
			self.run(do
				const result = await api.client().search(e.query.value.trim())
				if id !== e.station.value
					return
				e.results.replaceChildren()
				for item of [...(result.artists || []),...(result.songs || [])]
					const name = item.name || [item.title,item.artist].filter(Boolean).join(' · ')
					e.results.append(action('Add '+name,do self.editSeed(id,'addSeed',{musicId:item.musicId})))
				if !e.results.childElementCount
					e.results.textContent = 'No matching artists or songs.'
			)
		e.setMode.onclick = do self.run(do
			await api.client().call({action:'setMode',stationId:e.station.value,mode:Number(e.modes.value)})
			api.changed(e.station.value)
			e.status.textContent = 'Station mode saved.'
		)
		e.mix.ontoggle = do
			if e.mix.open
				self.shuffle()
		e.saveMix.onclick = do self.run(do
			const ids = Array.from(e.checks.querySelectorAll('input:checked')).map(do(c) c.value)
			await api.client().call({action:'setShuffle',ids})
			await api.reload()
			api.changed((api.stations().find(do(s) s.isQuickMix))?.id)
			e.status.textContent = 'Shuffle saved.'
		)
		e.filter.ontoggle = do
			if e.filter.open
				self.run(do
					const result = await api.client().call({action:'getFilter'})
					e.enabled.checked = result.enabled
				)
			else
				e.password.value = ''
		e.saveFilter.onclick = do self.run(do
			const user = api.email()
			const password = e.password.value
			e.password.value = ''
			if !user || !password
				throw new Error('Confirm your Pandora password to change the filter.')
			await api.client().call({action:'setFilter',enabled:e.enabled.checked,user,password})
			e.status.textContent = 'Content filter saved.'
		)
		e.fromSong.onclick = do self.fromTrack('song')
		e.fromArtist.onclick = do self.fromTrack('artist')
	def fromTrack(type)
		const song = self.api.track()
		if song && !song.isInsert && song.trackToken
			self.run(do self.api.create(song.trackToken,type === 'artist' ? song.artist : song.title,type))
		else
			self.ui.status.textContent = 'Play a station song first.'
	def run(fn)
		if self.busy
			return
		const account = self.account
		self.busy = true
		self.ui.status.textContent = ''
		try
			await fn()
		catch e
			if self.account === account
				self.ui.status.textContent = e.message || 'The change could not be saved.'
		finally
			self.busy = false
	def accountChanged()
		const acct = self.api.account() || ''
		if self.account === acct
			return
		self.account = acct
		self.folder = ''
		self.host.open = false
		self.ui.password.value = ''
		self.ui.status.textContent = ''
		for section of [self.ui.seeds,self.ui.mix,self.ui.filter]
			section.open = false
		try
			self.prefs = JSON.parse(globalThis.localStorage.getItem('melodica.station.collections.'+acct) || 'null')
		catch _
			self.prefs = null
		self.prefs ||= {}
		if !Array.isArray(self.prefs.pins)
			self.prefs.pins = []
		if !self.prefs.folders || typeof self.prefs.folders !== 'object'
			self.prefs.folders = {}
	def save()
		if !self.account
			return
		try
			globalThis.localStorage.setItem('melodica.station.collections.'+self.account,JSON.stringify(self.prefs))
		catch _
			self.ui.status.textContent = 'Device storage is full. This change will last for this session.'
		self.api.rebuild()
	def move(delta)
		const pins = self.prefs.pins
		const i = pins.indexOf(self.ui.station.value)
		const j = i + delta
		if i < 0 || j < 0 || j >= pins.length
			return
		pins.splice(j,0,pins.splice(i,1)[0])
		self.save()
	def rank(id)
		const i = self.prefs.pins.indexOf(id)
		return i < 0 ? Number.MAX_SAFE_INTEGER : i
	def render()
		self.accountChanged()
		const e = self.ui
		const all = self.api.stations()
		self.host.hidden = !self.account || !all.length
		const selected = e.station.value || (self.api.active())?.id
		e.station.replaceChildren()
		for st of all
			e.station.add(new Option(st.name,st.id,false,st.id === selected))
		e.pandora.hidden = !self.api.client() || self.api.remote()
		const folderFilter = self.api.folderFilter
		const names = Array.from(new Set(all.map(do(s) self.prefs.folders[s.id]).filter(Boolean))).sort()
		e.folders.replaceChildren()
		folderFilter.replaceChildren(new Option('All folders',''))
		for name of names
			e.folders.append(new Option(name,name))
			folderFilter.add(new Option(name,name))
		folderFilter.hidden = !names.length
		self.folder = names.includes(self.folder) ? self.folder : ''
		folderFilter.value = self.folder
		self.details()
		if e.mix.open
			self.shuffle()
	def details()
		const e = self.ui
		const id = e.station.value
		const i = self.prefs.pins.indexOf(id)
		e.pin.textContent = i < 0 ? 'Pin station' : 'Unpin station'
		e.up.disabled = i <= 0
		e.down.disabled = i < 0 || i === self.prefs.pins.length - 1
		e.folder.value = self.prefs.folders[id] || ''
		const st = self.api.stations().find(do(s) s.id === id)
		e.seeds.hidden = !st || st.isQuickMix
	def shuffle()
		const e = self.ui
		e.checks.replaceChildren()
		for st of self.api.stations()
			if st.isQuickMix
				continue
			const row = document.createElement('label')
			const c = document.createElement('input')
			c.type = 'checkbox'
			c.value = st.id
			c.checked = !!st.useQuickMix
			row.append(c,st.name)
			e.checks.append(row)
	def editSeed(id,operation,fields)
		self.run(do
			await self.api.client().call({action:operation,stationId:id,...fields})
			self.api.changed(id)
			if self.ui.station.value === id
				self.ui.results.replaceChildren()
				await self.loadSeeds()
		)
	def loadSeeds()
		const e = self.ui
		const id = e.station.value
		const account = self.account
		const current = do e.seeds.open && e.station.value === id && self.account === account
		e.modes.replaceChildren()
		e.setMode.disabled = true
		e.seedList.textContent = 'Loading seeds…'
		try
			const info = await self.api.client().call({action:'stationInfo',stationId:id})
			if !current()
				return
			e.seedList.replaceChildren()
			for item of [...info.artists,...info.songs,...info.stations]
				if item.seedId
					const name = item.name || [item.title,item.artist].filter(Boolean).join(' · ')
					e.seedList.append(action('Remove '+name,do self.editSeed(id,'deleteSeed',{seedId:item.seedId})))
			const result = await self.api.client().call({action:'modes',stationId:id})
			if current()
				for m of result.modes
					e.modes.add(new Option(m.name,String(m.id),false,m.active))
				e.setMode.disabled = !result.modes.length
		catch err
			if current()
				e.status.textContent = err.message
