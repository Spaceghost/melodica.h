# The stream keeps its normal media clock. Only replace its audible output once
# the authenticated copy of this same track has decoded and the graph is live.
export const bands = [31,62,125,250,500,1000,2000,4000,8000,16000]
export class PhoneEqualizer
	def constructor(audio,track,read,status)
		self.audio = audio
		self.track = track
		self.read = read
		self.status = status
		self.levels = []
		for event of ['play','playing','timeupdate','ratechange','seeked','volumechange']
			audio.addEventListener(event,do self.update())
		for event of ['seeking','waiting','stalled','pause','ended','emptied']
			audio.addEventListener(event,do self.stop())
	def configure(values,gesture = false)
		self.levels = bands.map(do(_,i) Math.max(-12,Math.min(12,Number(values[i]) || 0)))
		if gesture && !self.context && self.levels.some(do(n) n !== 0)
			const Context = window.AudioContext || window.webkitAudioContext
			if Context
				self.context = new Context()
				self.gain = self.context.createGain()
				self.filters = bands.map(do(f)
					const node = self.context.createBiquadFilter()
					node.type = 'peaking'
					node.frequency.value = Math.min(f,self.context.sampleRate * 0.48)
					node.Q.value = 1.4
					return node
				)
				for filter,i in self.filters
					filter.connect(self.filters[i+1] || self.gain)
				self.gain.connect(self.context.destination)
				self.context.onstatechange = do self.update()
		if self.context
			if gesture && self.context.state !== 'running'
				self.context.resume().catch(do null)
			for filter,i in self.filters
				filter.gain.setTargetAtTime(self.levels[i],self.context.currentTime,0.02)
		self.update()
	def stop()
		if self.source
			const source = self.source
			self.source = null
			source.onended = null
			source.stop()
			source.disconnect()
			self.audio.muted = self.savedMuted
	def update()
		const song = self.track()
		const active = self.levels.some(do(v) v !== 0)
		if self.song !== song || !active
			(self.controller)?.abort()
			self.controller = null
			self.buffer = null
			self.failed = false
			self.song = song
			self.stop()
		const a = self.audio
		if !active || !song || !self.context || self.context.state !== 'running' || a.paused || a.seeking || a.ended || a.readyState < 3
			self.stop()
			return
		if !self.buffer
			if !self.controller && !self.failed
				self.load(song)
			return
		self.gain.gain.value = self.source && self.savedMuted || !self.source && a.muted ? 0 : a.volume
		const pos = a.currentTime
		if pos >= self.buffer.duration - 0.1
			self.stop()
			return
		if self.source && self.rate === a.playbackRate && Math.abs(self.offset + (self.context.currentTime-self.began)*self.rate - pos) < 0.3
			return
		self.stop()
		const source = self.context.createBufferSource()
		source.buffer = self.buffer
		source.connect(self.filters[0])
		source.playbackRate.value = a.playbackRate
		self.rate = a.playbackRate
		self.offset = pos
		self.began = self.context.currentTime
		self.savedMuted = a.muted
		source.start(0,pos)
		self.source = source
		a.muted = true
		source.onended = do
			if self.source === source
				self.source = null
				source.disconnect()
				a.muted = self.savedMuted
	def load(song)
		const ctl = new AbortController()
		self.controller = ctl
		try
			const bytes = await self.read(song,{signal:ctl.signal})
			const buffer = await self.context.decodeAudioData(await bytes.arrayBuffer())
			if !ctl.signal.aborted && self.song === song
				self.buffer = buffer
				self.status('')
				self.update()
		catch e
			if !ctl.signal.aborted
				self.failed = true
				self.status('Equalizer unavailable for this track. Playing the original audio.')
		finally
			if self.controller === ctl
				self.controller = null
