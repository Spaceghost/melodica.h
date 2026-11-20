# Explicit pairing exchanges the two WebRTC descriptions on the listener's own
# devices. The data channel carries playback commands, never a sign-in session.
const layout = '''
<summary>Control another device</summary>
<p>Open this panel on two devices on the same Wi-Fi, signed in to the same Pandora account.</p>
<div data-link="pairing"><button type="button" data-link="create">Create pairing invitation</button>
<label>Pairing text <textarea data-link="text" rows="3" spellcheck="false" autocapitalize="none"></textarea></label>
<div><button type="button" data-link="copy">Copy pairing text</button> <button type="button" data-link="apply">Use pasted invitation or reply</button></div></div>
<div data-link="remote" hidden><p data-link="track"></p><div data-link="buttons"></div><button type="button" data-link="take">Move playback here</button></div>
<button type="button" data-link="close" hidden>Disconnect devices</button><p role="status" data-link="status"></p>
'''

def validDescription(value)
	return value && ['offer','answer'].includes(value.type) && typeof value.sdp === 'string' && value.sdp.length <= 64000

export class LinkedPlayer
	def constructor(host,api)
		self.api = api
		self.host = document.createElement('details')
		self.host.className = 'phone-audio'
		self.host.innerHTML = layout
		host.append(self.host)
		const e = self.ui = Object.fromEntries(Array.from(self.host.querySelectorAll('[data-link]')).map(do(el) [el.dataset.link,el]))
		e.create.onclick = do self.perform(do self.invite())
		e.apply.onclick = do self.perform(do self.apply(e.text.value))
		e.copy.onclick = do self.perform(do
			await globalThis.navigator.clipboard.writeText(e.text.value)
			e.status.textContent = 'Copied. Paste this into the other device.'
		)
		e.close.onclick = do self.close('Devices disconnected.')
		for pair of [['play','Play'],['pause','Pause'],['skip','Skip'],['love','Thumbs up'],['ban','Thumbs down']]
			const b = document.createElement('button')
			b.type = 'button'
			b.textContent = pair[1]
			b.onclick = do self.perform(do self.send({kind:'command',action:pair[0]}))
			e.buttons.append(b)
		e.take.onclick = do self.perform(do
			if !self.api.available()
				throw new Error('Leave the room and open the station player to move playback.')
			self.request = globalThis.crypto.randomUUID()
			e.take.disabled = true
			self.send({kind:'take',nonce:self.request})
			e.status.textContent = 'Requesting the current song…'
		)
		window.addEventListener('pagehide',do self.close('Devices disconnected.'))
	def perform(fn)
		try
			await fn()
		catch e
			self.ui.status.textContent = e.message || 'Pairing failed.'
	def close(message)
		const peer = self.peer
		self.peer = null
		self.channel = null
		self.authorized = false
		self.identity = ''
		self.request = null
		self.sending = null
		clearInterval(self.pulse)
		if peer
			peer.close()
		self.ui.text.value = ''
		self.ui.remote.hidden = self.ui.close.hidden = true
		self.ui.pairing.hidden = false
		self.ui.take.disabled = false
		self.ui.status.textContent = message
	def create()
		const user = self.api.identity()
		if !user
			throw new Error('Sign in to the Pandora station player on each device first.')
		if !globalThis.RTCPeerConnection
			throw new Error('This browser does not support device pairing.')
		self.close('')
		self.identity = String(user)
		const pc = self.peer = new RTCPeerConnection({iceServers:[]})
		pc.ondatachannel = do(event) self.attach(pc,event.channel)
		pc.onconnectionstatechange = do
			if pc === self.peer && ['failed','closed'].includes(pc.connectionState)
				self.close('Connection lost. Playback stays on the last device that started it.')
		self.ui.close.hidden = false
		return pc
	def attach(pc,channel)
		if self.peer !== pc || self.channel || channel.label !== 'melodica-player'
			channel.close()
			return
		self.channel = channel
		channel.onopen = do
			if self.peer === pc
				self.send({kind:'hello',owner:self.identity})
		channel.onclose = do
			if self.peer === pc
				self.close('Devices disconnected.')
		channel.onmessage = do(event)
			if self.peer !== pc || typeof event.data !== 'string' || event.data.length > 64000
				return
			self.perform(do self.receive(JSON.parse(event.data)))
	def describe(pc)
		if pc.iceGatheringState !== 'complete'
			await new Promise(do(resolve)
				const finish = do
					clearTimeout(timer)
					pc.removeEventListener('icegatheringstatechange',changed)
					resolve()
				const changed = do
					if pc.iceGatheringState === 'complete'
						finish()
				const timer = setTimeout(finish,4500)
				pc.addEventListener('icegatheringstatechange',changed)
			)
		if self.peer === pc
			self.ui.text.value = JSON.stringify(pc.localDescription.toJSON())
	def invite()
		const pc = self.create()
		self.attach(pc,pc.createDataChannel('melodica-player'))
		await pc.setLocalDescription(await pc.createOffer())
		await self.describe(pc)
		self.ui.status.textContent = 'Send the invitation to your other device. Paste its reply here.'
	def apply(raw)
		if raw.length > 75000
			throw new Error('Invalid pairing text.')
		const description = JSON.parse(raw)
		if !validDescription(description)
			throw new Error('Paste the complete Melodica pairing text.')
		if description.type === 'offer'
			const pc = self.create()
			await pc.setRemoteDescription(description)
			await pc.setLocalDescription(await pc.createAnswer())
			await self.describe(pc)
			self.ui.status.textContent = 'Copy this reply back to the device that created the invitation.'
		else
			if !self.peer || self.peer.signalingState !== 'have-local-offer'
				throw new Error('Create the invitation on this device first.')
			await self.peer.setRemoteDescription(description)
			self.ui.status.textContent = 'Connecting to the other device…'
	def send(value)
		if (self.channel)?.readyState !== 'open'
			throw new Error('The other device disconnected.')
		self.channel.send(JSON.stringify(value))
	def publish()
		if self.authorized
			if String(self.api.identity() || '') !== self.identity
				return self.close('Account changed. Pair again.')
			const track = self.api.summary()
			self.send({kind:'status',title:track.title,artist:track.artist,playing:track.playing})
	def receive(m)
		if String(self.api.identity() || '') !== self.identity
			return self.close('Account changed. Pair again.')
		if m.kind === 'hello'
			if m.owner !== self.identity
				return self.close('The devices are signed in to different Pandora accounts.')
			self.authorized = true
			self.ui.remote.hidden = false
			self.ui.pairing.hidden = true
			self.ui.status.textContent = 'Devices connected.'
			self.publish()
			clearInterval(self.pulse)
			self.pulse = setInterval((do self.perform(do self.publish())),3500)
			return
		if !self.authorized
			return
		if m.kind === 'status'
			self.ui.track.textContent = m.title ? [m.title,m.artist,m.playing ? 'Playing' : 'Paused'].filter(Boolean).join(' · ') : 'The other player is idle.'
		elif m.kind === 'command' && ['play','pause','skip','love','ban'].includes(m.action)
			await self.api.command(m.action)
			self.publish()
		elif m.kind === 'take' && typeof m.nonce === 'string' && m.nonce.length <= 80
			if self.sending || self.request || !self.api.available()
				return self.send({kind:'refused',nonce:m.nonce})
			const record = self.api.record()
			if !record
				return self.send({kind:'refused',nonce:m.nonce})
			self.sending = {nonce:m.nonce,record}
			self.api.command('pause')
			self.send({kind:'transfer',nonce:m.nonce,record})
			self.ui.status.textContent = 'Playback paused here for the transfer.'
		elif m.kind === 'transfer' && self.request && m.nonce === self.request
			const nonce = self.request
			self.request = null
			try
				await self.api.accept(m.record)
				self.send({kind:'received',nonce})
				self.ui.status.textContent = 'Playback moved here.'
			catch err
				self.send({kind:'refused',nonce})
				self.ui.status.textContent = err.message
			finally
				self.ui.take.disabled = false
		elif m.kind === 'received' && m.nonce === (self.sending)?.nonce
			self.sending = null
			self.ui.status.textContent = 'The other device has the song.'
		elif m.kind === 'refused'
			if m.nonce === self.request
				self.request = null
				self.ui.take.disabled = false
				self.ui.status.textContent = 'The other device has no available song to transfer.'
			elif m.nonce === (self.sending)?.nonce
				self.api.rejected(self.sending.record)
				self.sending = null
				self.ui.status.textContent = 'The other device could not play this song.'
