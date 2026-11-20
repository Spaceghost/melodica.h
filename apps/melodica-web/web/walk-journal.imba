import {WalkLibrary} from './walk-library.js'
import {cleanTrack,fixPoint,readWalkFile,sameTrack,tracksDuring} from './walk-trace.js'

def label(at)
	return new Intl.DateTimeFormat(undefined,{weekday:'long',hour:'numeric',minute:'2-digit'}).format(at) + ' walk'

export class WalkJournal
	def constructor(getTrack, historyClient)
		self.getTrack = getTrack
		self.historyClient = historyClient
		self.library = new WalkLibrary()
		self.rows = []
		try
			self.preferred = globalThis.sessionStorage.getItem('melodica.walks.viewed')
		catch _
			self.preferred = null
		self.active = null
		self.waiting = false
		self.pending = Promise.resolve()
		self.notice = ''
		self.geoMessage = ''
		self.revision = 0
		self.request = 0
		const deviceChanged = do
			if !document.hidden && globalThis.melodicaDevice
				self.syncPhone().catch(do(e) self.message(e.message))
		window.addEventListener('melodica:device-ready',deviceChanged)
		window.addEventListener('melodica:device',do(e)
			if e.detail.event === 'walkUpdate'
				deviceChanged()
			elif e.detail.event === 'walkError'
				self.message(e.detail.value.message)
		)
		deviceChanged()
		document.addEventListener('visibilitychange', do
			if globalThis.melodicaDevice
				deviceChanged()
				return
			if document.hidden
				self.breakTrace()
			elif self.active
				self.wake()
				self.sample()
		)
		window.addEventListener('pagehide', do self.breakTrace())
	def notify()
		if self.onchange
			self.onchange()
	def message(s)
		self.notice = s
		self.notify()
	def refresh()
		self.rows = await self.library.list()
		self.notify()
	def syncPhone()
		if self.syncing
			self.syncAgain = true
			return self.syncing
		self.syncing = self.readPhone().finally(do self.syncing = null)
		return self.syncing
	def readPhone()
		const phone = globalThis.melodicaDevice
		while true
			self.syncAgain = false
			const rows = await phone.call('walkList')
			for row of rows
				let w = (self.active)?.id === row.id ? self.active : await self.library.get(row.id)
				if !w
					w = {id:row.id,name:label(row.start),start:row.start,end:null,kind:'native',history:[],points:[],changes:[],cursor:0}
				let more = true
				while more
					const page = await phone.call('walkRead',{id:w.id,cursor:w.cursor || 0})
					more = page.events.length === 256
					await self.library.importPage(w,page,more ? null : row.end)
					for entry of page.events
						w[entry.kind].push(entry.data)
					w.cursor = page.cursor
				w.end = row.end
				if w.end
					# A failed acknowledgment can safely repeat the same import.
					await phone.call('walkAck',{id:w.id})
					if (self.active)?.id === w.id
						self.active = null
					if (self.selected)?.id === w.id || !self.selected
						self.select(w)
				else
					self.active = w
					self.select(w)
					self.gpsPaused = row.paused
					self.geoMessage = row.paused ? 'GPS paused. Music continues.' : w.points.length ? 'Recording on this phone' : 'Waiting for a precise location.'
				self.revision++
			if rows.length
				await self.refresh()
			if !self.syncAgain
				break
	def serial(f)
		self.pending = self.pending.then(f).catch(do(err)
			self.detach()
			self.message(err.message || 'Saving failed. Open the journal again to recover the last saved point.')
		)
		return self.pending
	def acquire()
		if self.releaseLock
			return true
		if !(globalThis.navigator.locks)?.request
			throw new Error('This browser needs Web Locks to safely record one walk at a time. You can still import a GPS file.')
		return new Promise(do(resolve,reject)
			globalThis.navigator.locks.request('melodica-walk-recorder',{ifAvailable:true},do(lock)
				if !lock
					resolve(false)
					return
				return new Promise(do(release)
					self.releaseLock = release
					resolve(true)
				)
			).catch(reject)
		)
	def unlock()
		if self.releaseLock
			self.releaseLock()
		self.releaseLock = null
	def detach()
		self.stopLocation()
		self.gpsPaused = false
		clearInterval(self.timer)
		(self.wakeLock)?.release().catch(do null)
		self.wakeLock = null
		self.active = null
		self.waiting = false
		self.unlock()
	def stopLocation()
		self.locationRequest = (self.locationRequest || 0) + 1
		if self.watch != null
			globalThis.navigator.geolocation.clearWatch(self.watch)
		self.watch = null
	def watchLocation()
		self.stopLocation()
		const request = self.locationRequest
		self.watch = globalThis.navigator.geolocation.watchPosition((do(pos)
			if self.active && !self.gpsPaused && request === self.locationRequest
				self.position(pos)
		),(do(e)
			if !self.active || request !== self.locationRequest
				return
			# A provider can report a momentary error between consecutive fixes.
			# fixPoint measures the actual recording gap when location returns.
			if e.code === 1
				self.cut = true
			self.geoMessage = e.code === 1 ? 'Location permission is off. Finish this walk or allow location in your browser.' : 'GPS is unavailable. Waiting for another fix.'
			self.notify()
		),{enableHighAccuracy:true,maximumAge:0,timeout:22000})
	def pauseLocation(paused)
		if !self.active || self.gpsPaused === paused
			return
		if self.active.kind === 'native'
			await globalThis.melodicaDevice.call('walkPause',{paused})
			return await self.syncPhone()
		self.gpsPaused = paused
		self.cut = true
		self.geoMessage = paused ? 'GPS paused. Music continues.' : 'Waiting for a precise location.'
		if paused
			self.stopLocation()
		else
			self.watchLocation()
		self.notify()
	def wake()
		if globalThis.navigator.wakeLock && !document.hidden && !self.wakeLock
			try
				const held = await globalThis.navigator.wakeLock.request('screen')
				if !self.active || self.active.kind === 'native' || document.hidden
					await held.release()
					return
				self.wakeLock = held
				held.addEventListener('release', do
					if self.wakeLock === held
						self.wakeLock = null
				)
			catch _
				return
	def start()
		if self.active || self.waiting
			return
		self.waiting = true
		const gen = ++self.request
		self.message('Waiting for location permission…')
		try
			if globalThis.melodicaDevice
				await globalThis.melodicaDevice.call('walkStart')
				await self.syncPhone()
				self.waiting = false
				self.message('')
				return
			if !globalThis.navigator.geolocation
				throw new Error('Location is unavailable here. Import a timed GPX file to make a walk record.')
			if !(await self.acquire())
				throw new Error('A walk is recording in another Melodica tab.')
			if gen !== self.request
				self.unlock()
				return
			const first = await new Promise(do(resolve,reject)
				self.cancelFix = do reject(new Error('Cancelled'))
				globalThis.navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:20000,maximumAge:0})
			)
			self.cancelFix = null
			if gen !== self.request
				return
			const open = (await self.library.list()).find(do(w) !w.end)
			const now = Date.now()
			const start = Math.min(now,Math.max(now - 30000,Math.round(first.timestamp) || now))
			const w = open ? await self.library.get(open.id) : {id:globalThis.crypto.randomUUID(),kind:'live',name:label(start),start,end:null,points:[],changes:[],history:[]}
			if gen !== self.request
				return
			if !open
				await self.library.save(w)
			elif w.changes.length
				const last = Math.max(w.start,w.points.at(-1)?.at || 0,w.changes.at(-1).at)
				if last + 1 < now && !w.changes.at(-1).unknown
					const stop = {at:last + 1,unknown:true}
					w.changes.push(stop)
					await self.library.append(w.id,'changes',stop)
			self.active = w
			self.gpsPaused = false
			self.select(w)
			self.cut = true
			self.waiting = false
			self.geoMessage = 'Waiting for a precise location.'
			self.lastSample = 0
			self.sample()
			self.position(first)
			self.watchLocation()
			self.timer = setInterval((do self.sample()),1500)
			self.wake()
			self.notice = ''
			await self.refresh()
		catch e
			if gen === self.request
				self.detach()
				self.message(e.code === 1 ? 'Location was declined. Allow it in your browser settings or import a timed GPX route.' : e.code === 3 ? 'The phone could not get a fix. Try again outdoors or import a route.' : (e.message || 'Location is unavailable.'))
	def cancel()
		if self.waiting
			self.request++
			if self.cancelFix
				self.cancelFix()
				self.cancelFix = null
			self.waiting = false
			self.unlock()
			self.message('')
	def breakTrace()
		if self.active && self.active.kind !== 'native'
			self.cut = true
			self.mark({unknown:true},Date.now())
	def sample()
		if !self.active || self.active.kind === 'native' || document.hidden
			return
		const now = Date.now()
		if self.lastSample && now - self.lastSample > 20000
			self.mark({unknown:true},self.lastSample + 1)
			self.cut = true
		self.lastSample = now
		self.mark(cleanTrack(self.getTrack()) || {},now)
	def mark(data,at)
		const w = self.active
		if !w
			return
		const prev = w.changes.at(-1)
		if prev && sameTrack(data,prev) && !!data.unknown === !!prev.unknown
			return
		const entry = {...data,at:Math.max(w.start,at,((prev)?.at || 0) + 1)}
		w.changes.push(entry)
		self.serial(do self.library.append(w.id,'changes',entry))
		self.revision++
		self.notify()
	def position(pos)
		const w = self.active
		if !w || self.gpsPaused || document.hidden
			return
		const p = fixPoint(pos,w.points.at(-1),self.cut)
		if !p || p.at < w.start
			if pos.coords.accuracy > 80
				self.geoMessage = 'GPS accuracy is low. Waiting for a clearer fix.'
				self.notify()
			return
		self.cut = false
		self.geoMessage = 'GPS accuracy ±' + Math.round(p.accuracy) + ' m'
		w.points.push(p)
		self.serial(do self.library.append(w.id,'points',p))
		self.revision++
		self.sample()
		self.notify()
	def finish()
		const w = self.active || self.selected
		if !w || w.end || self.waiting
			return
		if w.kind === 'native'
			await globalThis.melodicaDevice.call('walkFinish',{id:w.id})
			await self.syncPhone()
			self.message('Walk saved on this device.')
			return
		if !(await self.acquire())
			throw new Error('Finish this walk in the tab that is recording it.')
		const live = !!self.active
		if !live
			const saved = await self.library.get(w.id)
			if !saved || saved.end
				self.unlock()
				await self.refresh()
				return
			Object.assign(w,saved)
		const end = live ? Date.now() : Math.max(w.start,w.points.at(-1)?.at || 0,w.changes.at(-1)?.at || 0)
		# Stop accepting new fixes before awaiting the final writes. Hold the lock until the end is durable.
		self.active = null
		try
			await self.pending
			w.end = end
			await self.library.save(w,true)
		catch e
			w.end = null
			throw e
		finally
			self.detach()
		self.select(w)
		self.revision++
		await self.refresh()
		self.message('Walk saved on this device.')
	def select(w)
		self.selected = w
		self.preferred = w ? w.id : null
		try
			if w
				globalThis.sessionStorage.setItem('melodica.walks.viewed',w.id)
			else
				globalThis.sessionStorage.removeItem('melodica.walks.viewed')
		catch _
			return
	def choose(id)
		self.select((self.active)?.id === id ? self.active : await self.library.get(id))
		self.revision++
		self.message('')
	def importFile(file)
		if !file || self.active || self.waiting
			return
		if file.size > 16000000
			throw new Error('Choose a GPX route under 16 MB.')
		const imported = readWalkFile(await file.text())
		const {start,end,points,changes,history} = imported
		const w = {id:globalThis.crypto.randomUUID(),kind:'gpx',name:label(start),start,end,points,changes,history}
		await self.library.save(w,true)
		self.select(w)
		self.revision++
		await self.refresh()
		if imported.restored
			self.message('Walk and song times restored on this device.')
		else
			await self.match(w)
	def match(w = self.selected)
		if !w || !w.end || self.matching
			return
		self.matching = true
		self.message('Matching song times from your Melodica listening history…')
		try
			const client = await self.historyClient()
			const rows = []
			const seen = new Set()
			let cursor = ''
			while true
				const path = 'me/listens?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
				const page = await client.api(path)
				const batch = page.listens || []
				rows.push(...tracksDuring(w.start,w.end,batch))
				cursor = page.next_cursor
				if !cursor || !batch.length || seen.has(cursor) || batch.at(-1).listened_at * 1000 < w.start - 86400000
					break
				seen.add(cursor)
			w.history = rows.sort(do(a,b) a.at - b.at)
			await self.library.saveHistory(w.id,w.history)
			self.revision++
			self.notice = rows.length ? 'Listening history matched by time.' : 'No saved listens overlap this walk. You can match again after your listens sync.'
		catch e
			self.notice = (e.status === 401 || e.status === 403 || e.code === 'no_token') ? 'Walk saved. Sign in to Melodica and choose Match listening history.' : 'Walk saved. Listening history is unavailable. Try matching again.'
		finally
			self.matching = false
			self.notify()
