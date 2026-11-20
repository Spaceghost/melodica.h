import {bands,PhoneEqualizer} from './mobile-eq.js'

const panel = '''
<summary>Phone audio</summary>
<div class="phone-options">
  <label>Wi-Fi quality <select data-phone="wifi"></select></label>
  <label>Cellular quality <select data-phone="cellular"></select></label>
  <label><input type="checkbox" data-phone="resumeCall"> Resume after calls</label>
  <label><input type="checkbox" data-phone="speak"> Announce track changes</label>
  <button type="button" data-phone="output">Choose audio output</button>
  <button type="button" data-phone="pin">Pin current station to Home Screen</button>
</div>
<details><summary data-phone="eqName">Equalizer</summary><div data-phone="bands" class="phone-bands"></div><button type="button" data-phone="flat">Reset this output to flat</button></details>
<p class="fine" data-phone="status" role="status"></p>
'''

export class PhonePlayer
	def constructor(api)
		self.api = api
		self.duck = 1
		self.stationKey = null
		self.route = ''
		self.network = ''
		window.addEventListener('melodica:device-ready',do self.connect())
		window.addEventListener('melodica:device',do(e)
			const packet = e.detail
			if packet.event === 'device'
				self.changed(packet.value)
			elif packet.event === 'media'
				self.command(packet.value.action)
			elif packet.event === 'station'
				self.pending = packet.value.id
				self.sync()
			elif packet.event === 'listenLink'
				self.openLink(packet.value.url)
			elif packet.event === 'duck'
				self.duck = packet.value.factor || 1
				api.volume()
		)
		if globalThis.melodicaDevice
			self.connect()
	def send(action,value = {})
		return globalThis.melodicaDevice.call(action,value)
	def notice(message)
		if self.ui
			self.ui.status.textContent = message
	def connect()
		if self.ui
			return
		document.documentElement.classList.add('melodica-phone')
		const brand = document.querySelector('.brand-tag')
		if brand
			brand.textContent = 'mobile'
		const host = document.createElement('details')
		host.className = 'phone-audio'
		host.innerHTML = panel
		document.querySelector('.deck').append(host)
		self.ui = Object.fromEntries(Array.from(host.querySelectorAll('[data-phone]')).map(do(el) [el.dataset.phone,el]))
		const ui = self.ui
		try
			self.options = JSON.parse(globalThis.localStorage.getItem('melodica.phone.audio') || '{}') || {}
		catch _
			self.options = {}
		self.options.outputs ||= {}
		for key of ['wifi','cellular']
			for quality of ['high','medium','low']
				ui[key].add(new Option(quality,quality))
			ui[key].value = ['high','medium','low'].includes(self.options[key]) ? self.options[key] : key === 'wifi' ? 'high' : 'medium'
			ui[key].onchange = do
				self.save()
				self.quality()
		ui.resumeCall.checked = self.options.resumeCall !== false
		ui.speak.checked = self.options.speak === true
		ui.resumeCall.onchange = ui.speak.onchange = do self.save()
		ui.output.onclick = do self.send('output').catch(do(e) self.notice(e.message))
		ui.pin.onclick = do
			const station = self.api.station()
			if station
				self.send('pin',{id:station.id,name:station.name}).then(do(ok) self.notice(ok ? 'Choose where to place the station on your home screen.' : 'Add a Melodica station widget from your home screen.')).catch(do(e) self.notice(e.message))
		self.eq = new PhoneEqualizer(self.api.audio,self.api.eqTrack,self.api.read,do(msg) self.notice(msg))
		self.sliders = bands.map(do(f)
			const label = document.createElement('label')
			label.textContent = f < 1000 ? f + ' Hz' : f/1000 + ' kHz'
			const slider = document.createElement('input')
			slider.type = 'range'
			slider.min = '-12'
			slider.max = '12'
			slider.value = '0'
			const out = document.createElement('output')
			slider.oninput = do
				const values = self.sliders.map(do(s) Number(s.value))
				self.options.outputs[self.route] = values
				self.showLevels(values,true)
				self.save()
			label.append(slider,out)
			ui.bands.append(label)
			return slider
		)
		ui.flat.onclick = do
			delete self.options.outputs[self.route]
			self.showLevels([],true)
			self.save()
		host.addEventListener('pointerdown',(do self.eq.configure(self.options.outputs[self.route] || [],true)),{once:true})
		document.addEventListener('pointerdown',(do self.eq.configure(self.options.outputs[self.route] || [],true)),{once:true})
		for event of ['play','playing','pause','ended','loadedmetadata','seeked','waiting']
			self.api.audio.addEventListener(event,do self.sync())
		self.api.audio.addEventListener('timeupdate',do
			if Math.abs(self.api.audio.currentTime - (self.lastPos || 0)) > 4
				self.sync()
		)
		self.save()
		self.send('state').then(do(s)
			self.pending = s.station
			self.changed(s)
			self.sync()
			self.openLink(s.listenLink)
		).catch(do(e) self.notice(e.message))
	def openLink(raw)
		if !raw || self.openingLink === raw
			return
		self.openingLink = raw
		try
			await self.send('linkHandled',{url:raw})
			if self.openingLink === raw
				self.api.openLink(raw)
		catch e
			self.notice(e.message)
		finally
			if self.openingLink === raw
				self.openingLink = ''
	def save()
		for key of ['wifi','cellular']
			self.options[key] = self.ui[key].value
		for key of ['resumeCall','speak']
			self.options[key] = self.ui[key].checked
		try
			globalThis.localStorage.setItem('melodica.phone.audio',JSON.stringify(self.options))
		catch _
			# Session settings still apply when storage is full.
		self.send('options',{resumeCall:self.options.resumeCall,speak:self.options.speak}).catch(do(e) self.notice(e.message))
	def showLevels(values,gesture = false)
		for slider,i in self.sliders
			slider.value = String(Number(values[i]) || 0)
			slider.nextElementSibling.textContent = slider.value + ' dB'
		self.eq.configure(values,gesture)
	def quality()
		if !self.ui || !self.api.ready() || !['wifi','cellular'].includes(self.network)
			return
		self.api.quality(self.ui[self.network].value)
	def changed(s)
		if !self.ui
			return
		if self.route !== s.route
			self.route = s.route
			self.ui.eqName.textContent = 'Equalizer · ' + (s.label || 'Current output')
			self.showLevels(self.options.outputs[s.route] || [],true)
		const old = self.network
		self.network = s.network
		if s.network === 'offline'
			self.hold()
		elif old !== self.network
			self.quality()
			if old === 'offline' && self.api.online
				self.api.online()
			if self.retry
				self.recover()
	def hold()
		if self.retry || !self.api.eqTrack() || !self.wanted
			return
		self.retry = {song:self.api.eqTrack(),position:self.api.audio.currentTime,attempts:0}
		self.api.message('Waiting for a connection…')
	def offline()
		if self.retry && self.api.eqTrack() === self.retry.song
			return true
		if !self.ui || (self.network !== 'offline' && globalThis.navigator.onLine)
			return false
		self.hold()
		return !!self.retry
	def recover()
		const retry = self.retry
		if !retry || self.recovering || self.api.eqTrack() !== retry.song
			return
		self.recovering = true
		try
			retry.attempts++
			const current = do self.retry === retry && self.api.eqTrack() === retry.song
			if await self.api.recover(retry.song,retry.position,current,retry.attempts)
				self.retry = null
				self.api.message('')
			elif self.retry === retry
				self.api.message('Reconnecting to your station…')
				clearTimeout(self.retryTimer)
				self.retryTimer = setTimeout((do
					if self.retry === retry && self.network !== 'offline'
						self.recover()
				),Math.min(30000,2000 * retry.attempts))
		finally
			self.recovering = false
	def manualPause()
		if self.ui
			clearTimeout(self.retryTimer)
			self.retry = null
			self.wanted = false
			self.send('userPause').catch(do null)
	def command(action)
		if action === 'pause'
			self.retry = null
			self.wanted = false
		self.api.command(action)
	def sync()
		if !self.ui
			return
		const v = self.api.playback()
		if v.playing
			self.wanted = true
		if self.retry && self.api.eqTrack() !== self.retry.song
			self.retry = null
		self.lastPos = v.position
		self.send('now',v).catch(do(e) self.notice(e.message))
		const stations = self.api.stations().map(do(s) {id:String(s.id),name:s.name})
		const key = JSON.stringify(stations)
		if key !== self.stationKey && self.api.ready()
			self.stationKey = key
			self.send('stations',{stations}).catch(do(e)
				self.stationKey = null
				self.notice(e.message)
			)
		self.ui.pin.disabled = !self.api.station()
		if self.pending && self.api.ready() && stations.some(do(s) s.id === self.pending)
			const id = self.pending
			self.pending = ''
			self.api.tune(id).then(do self.send('stationHandled',{id})).catch(do(e) self.notice(e.message))
