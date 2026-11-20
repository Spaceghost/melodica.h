# A fix or song change is committed separately. A long walk never rewrites its earlier fixes.
def done(tx)
	return new Promise(do(resolve,reject)
		tx.oncomplete = do resolve()
		tx.onerror = tx.onabort = do reject(tx.error || new Error('The walk could not be saved on this device.'))
	)
def read(req)
	return new Promise(do(resolve,reject)
		req.onsuccess = do resolve(req.result)
		req.onerror = do reject(req.error)
	)
def span(id)
	return IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER])
def meta(w)
	return {id:w.id,name:w.name,start:w.start,end:w.end,kind:w.kind,history:w.history,cursor:w.cursor || 0}

export class WalkLibrary
	def open()
		if !self.promise
			self.promise = new Promise(do(resolve,reject)
				const req = globalThis.indexedDB.open('melodica-walk-records',1)
				req.onupgradeneeded = do
					const db = req.result
					db.createObjectStore('walks',{keyPath:'id'})
					for name of ['points','changes']
						db.createObjectStore(name,{keyPath:['id','at']})
				req.onerror = do reject(req.error)
				req.onsuccess = do
					req.result.onversionchange = do
						req.result.close()
						self.promise = null
					resolve(req.result)
			).catch(do(error)
				self.promise = null
				throw error
			)
		return self.promise
	def list()
		const db = await self.open()
		const rows = await read(db.transaction('walks').objectStore('walks').getAll())
		return rows.sort(do(a,b) b.start - a.start)
	def get(id)
		const db = await self.open()
		const tx = db.transaction(['walks','points','changes'])
		const [w,points,changes] = await Promise.all([read(tx.objectStore('walks').get(id)),read(tx.objectStore('points').getAll(span(id))),read(tx.objectStore('changes').getAll(span(id)))])
		return w ? {...w,points,changes} : null
	def save(w, withEvents = false)
		const db = await self.open()
		const tx = db.transaction(withEvents ? ['walks','points','changes'] : ['walks'],'readwrite')
		tx.objectStore('walks').put(meta(w))
		if withEvents
			for name of ['points','changes']
				for entry of w[name]
					tx.objectStore(name).put({...entry,id:w.id})
		return done(tx)
	# Advance the native cursor in the same transaction as its points and track changes.
	def importPage(w,page,end)
		const db = await self.open()
		const tx = db.transaction(['walks','points','changes'],'readwrite')
		for entry of page.events
			tx.objectStore(entry.kind).put({...entry.data,id:w.id})
		tx.objectStore('walks').put({...meta(w),cursor:page.cursor,end})
		return done(tx)
	def append(id,name,entry)
		const db = await self.open()
		const tx = db.transaction(name,'readwrite')
		tx.objectStore(name).put({...entry,id})
		return done(tx)
	def saveHistory(id,history)
		const db = await self.open()
		const tx = db.transaction('walks','readwrite')
		const store = tx.objectStore('walks')
		const req = store.get(id)
		req.onsuccess = do
			if req.result
				store.put({...req.result,history})
		return done(tx)
	def remove(id)
		const db = await self.open()
		const tx = db.transaction(['walks','points','changes'],'readwrite')
		tx.objectStore('walks').delete(id)
		for name of ['points','changes']
			tx.objectStore(name).delete(span(id))
		return done(tx)
