export def savePortable(blob,name)
	if globalThis.melodicaDevice
		const reader = new FileReader()
		const data = await new Promise(do(resolve,reject)
			reader.onload = do resolve(reader.result.split(',')[1])
			reader.onerror = do reject(new Error('The export could not be read.'))
			reader.readAsDataURL(blob)
		)
		return await globalThis.melodicaDevice.call('saveFile',{name,mime:blob.type.split(';')[0],data})
	const url = URL.createObjectURL(blob)
	const link = document.createElement('a')
	link.href = url
	link.download = name
	document.body.append(link)
	link.click()
	link.remove()
	setTimeout((do URL.revokeObjectURL(url)),60000)
	return true

export def collectHistory(api,current,progress)
	const rows = []
	const seen = new Set()
	const cursors = new Set()
	let cursor = ''
	while current()
		const page = await api('me/listens?limit=100' + (cursor ? '&cursor='+encodeURIComponent(cursor) : ''))
		if !current()
			return []
		for item of page.listens || []
			const key = item.id || JSON.stringify([item.listened_at,item.artist,item.title])
			if !seen.has(key)
				seen.add(key)
				rows.push({id:item.id || '',listened_at:item.listened_at,artist:item.artist || '',title:item.title || '',album:item.album || '',station:item.station_name || item.station || ''})
		progress(rows.length)
		cursor = page.next_cursor || ''
		if !cursor
			return rows
		if cursors.has(cursor)
			throw new Error('The history server repeated a page. Reopen history and try again.')
		cursors.add(cursor)
	return []

export def mountHistoryTools(host,api,current)
	const pane = document.createElement('details')
	pane.className = 'walk-help history-tools'
	pane.innerHTML = '<summary>Search or export listening history</summary><form><label>Artist, title or station <input type="search"></label> <label>Listen date <input type="date"></label> <button>Search</button></form><button data-export type="button">Export all listens (.json)</button><p role="status"></p><ol></ol>'
	host.prepend(pane)
	const form = pane.querySelector('form')
	const results = pane.querySelector('ol')
	const status = pane.querySelector('[role=status]')
	let request = 0
	const run = do(download)
		const seq = ++request
		const live = do seq === request && current() && pane.isConnected
		const term = form.querySelector('[type=search]').value.trim().toLowerCase()
		const date = form.querySelector('[type=date]').value
		results.replaceChildren()
		try
			const rows = await collectHistory(api,live,do(n) status.textContent = 'Read '+n+' listens…')
			if !live()
				return
			if download
				const ok = await savePortable(new Blob([JSON.stringify({version:1,listens:rows},null,2)],{type:'application/json'}),'melodica-listening-history.json')
				status.textContent = ok ? rows.length+' listens exported.' : 'Export cancelled.'
				return
			let count = 0
			for row of rows
				const t = new Date(row.listened_at * 1000)
				const day = [t.getFullYear(),String(t.getMonth()+1).padStart(2,'0'),String(t.getDate()).padStart(2,'0')].join('-')
				const text = [row.title,row.artist,row.station].filter(Boolean).join(' · ')
				if (!date || date === day) && (!term || text.toLowerCase().includes(term))
					count++
					const li = document.createElement('li')
					li.textContent = text+' · '+t.toLocaleString()
					results.append(li)
			status.textContent = count+' matching listens.'
		catch e
			if live()
				status.textContent = e.message
	form.onsubmit = do(ev)
		ev.preventDefault()
		run(false)
	pane.querySelector('[data-export]').onclick = do run(true)
