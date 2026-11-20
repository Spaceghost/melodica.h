import {songAt,pointAt,walkFile,trimWalk,lengthText,timeText,distanceOf} from './walk-trace.js'
import {savePortable} from './history-tools.js'
import {makePlate,drawCursor,coverBlob} from './walk-art.js'

const layout = '''
<section class="walks" aria-labelledby="walk-heading">
    <header class="walk-head">
      <div><h1 id="walk-heading">Walk records</h1><p>Walk with your Melodica station. When you finish, your route becomes a record cover colored by the songs you heard.</p></div>
      <div class="walk-actions"><button type="button" class="walk-start" data-w="start">Start a walk</button><button type="button" data-w="pauseGps" hidden>Pause GPS</button><button type="button" data-w="finish" hidden>Finish walk</button><button type="button" data-w="cancel" hidden>Cancel</button><label class="walk-file">Import GPX<input type="file" data-w="file" accept=".gpx,application/gpx+xml,application/xml,text/xml"></label></div>
    </header>
    <section class="walk-music" aria-labelledby="walk-music-title">
      <div class="walk-live-track"><img data-w="art" alt="" width="64" height="64" hidden><div class="walk-now"><h2 id="walk-music-title">Your Melodica music</h2><p data-w="now"></p></div></div>
      <div class="walk-actions"><label class="walk-picker" data-w="stationLabel">Your station<select data-w="station"></select></label><button type="button" data-w="music">Play my music</button></div>
    </section>
    <details data-w="browserHelp" class="walk-help"><summary>Walking with an iPhone or Android</summary><p>To record live in Safari or Chrome, allow location and keep Melodica visible. Your route stays in this browser.</p><p>For a walk with the screen locked, enable <strong>Scrobble to spacegho.st</strong> in the Melodica web player before you play a station. Record a timed GPX with <a href="https://apps.apple.com/us/app/open-gpx-tracker/id984503772" target="_blank" rel="noreferrer">Open GPX Tracker for iPhone</a> or <a href="https://gpslogger.app/" target="_blank" rel="noreferrer">GPSLogger for Android</a>. Save the GPX on your phone and select <strong>Import GPX</strong> here to match your songs by time.</p><p><a href="/melodica/apps/#android">Browse Melodica’s Android apps</a></p></details>
    <p class="walk-status" data-w="notice" role="status"></p>
    <p class="fine"><a href="/melodica/track/game/">Play Sidewalk Stereo at public stops</a></p>
    <p class="walk-empty" data-w="empty">Your saved walks will appear here. Start a walk or import a GPX from your phone.</p>
    <div class="walk-grid" data-w="record" hidden>
      <figure class="walk-sleeve">
        <figcaption><span data-w="source"></span><h2 data-w="name"></h2></figcaption>
        <canvas data-w="canvas" width="850" height="850" role="img" aria-label="Your route colored by song"></canvas>
        <div class="walk-stats"><span data-w="stats"></span><span data-w="fix"></span></div>
      </figure>
      <section class="walk-side">
        <label class="walk-picker">Your records<select data-w="library"></select></label>
        <div class="walk-replay"><h2>On this block</h2><p class="walk-song" data-w="song"></p><p class="walk-artist" data-w="artist"></p>
          <label class="walk-time"><span>Walk timeline</span><output data-w="time"></output><input type="range" data-w="scrub" min="0" max="1000" step="1" value="0" aria-label="Scrub the walk timeline"></label>
          <div class="walk-actions"><button type="button" data-w="replay">Replay route</button><button type="button" data-w="playStation" hidden></button></div>
        </div>
        <h2>Tracklist</h2><div data-w="songs" class="walk-list"></div>
        <div class="walk-actions walk-exports"><button type="button" data-w="export">Save cover image</button><button type="button" data-w="match" hidden>Match listening history</button></div>
        <details data-w="sharing" class="walk-help" hidden><summary>Trim a copy for sharing</summary>
          <div class="walk-actions"><label class="walk-picker">Hide around start<select data-w="trimStart"></select></label><label class="walk-picker">Hide around finish<select data-w="trimEnd"></select></label></div>
          <div data-w="preview"></div><p data-w="trimStatus" role="status"></p>
          <div class="walk-actions"><button type="button" data-w="trimCover">Save trimmed cover</button><button type="button" data-w="trimGpx">Save trimmed GPX</button></div>
        </details>
        <details data-w="manage" class="walk-help" hidden><summary>Manage this record</summary><p>GPX files contain precise locations, timestamps and song names.</p><button type="button" data-w="backup">Export walk and songs (.gpx)</button> <button type="button" data-w="delete">Delete this walk from this device</button><div data-w="confirm" hidden><p>Delete this route and its saved song times?</p><button type="button" data-w="yes">Delete record</button> <button type="button" data-w="no">Keep record</button></div></details>
      </section>
    </div>
    <details data-w="compare" class="walk-help" hidden><summary>Compare two walks</summary><label class="walk-picker">Compare with<select data-w="otherWalk"></select></label><div data-w="pair" class="walk-pair"></div></details>
  </section>
'''

export def mountWalk(host,journal,music)
	host.innerHTML = layout
	const el = {}
	for node of host.querySelectorAll('[data-w]')
		el[node.dataset.w] = node
	let stationKey = null
	let pickedStation = null
	let musicBusy = false
	let id = ''
	let version = -1
	let listKey = ''
	let plate = null
	let frame = null
	let position = 0
	let liveFollow = true
	let mounted = true
	let busy = false
	let comparisonRequest = 0
	let trimmed = null
	for select of [el.trimStart,el.trimEnd]
		for radius of [0,100,250,500,1000]
			select.add(new Option(lengthText(radius),String(radius),false,radius === 250))
	const figure = do(w,tracks)
		const plate = makePlate(w)
		const result = document.createElement('figure')
		const caption = document.createElement('figcaption')
		caption.textContent = w.name + ' · ' + lengthText(distanceOf(w.points))
		plate.paper.setAttribute('role','img')
		plate.paper.setAttribute('aria-label',caption.textContent)
		result.append(caption,plate.paper)
		if tracks
			const list = document.createElement('ol')
			for c of plate.list
				const li = document.createElement('li')
				li.textContent = c.song.title + ' · ' + c.song.artist
				list.append(li)
			result.append(list)
		return result
	const trimPreview = do
		trimmed = el.sharing.open ? trimWalk(journal.selected,Number(el.trimStart.value),Number(el.trimEnd.value)) : null
		el.preview.replaceChildren()
		if trimmed
			el.preview.append(figure(trimmed,false))
		el.trimStatus.textContent = trimmed ? 'The shared GPX includes times and locations along the visible route.' : 'Less than one route segment remains. Choose a smaller radius.'
		el.trimCover.disabled = el.trimGpx.disabled = !trimmed
	const compare = do
		const request = ++comparisonRequest
		el.pair.replaceChildren()
		if !el.compare.open || !(journal.selected)?.end || !el.otherWalk.value
			return
		try
			const other = await journal.library.get(el.otherWalk.value)
			if mounted && request === comparisonRequest && (other)?.end && other.id !== (journal.selected)?.id
				el.pair.append(figure(journal.selected,true),figure(other,true))
		catch e
			if mounted && request === comparisonRequest
				journal.message(e.message || 'The other walk could not be opened.')
	el.sharing.ontoggle = el.trimStart.onchange = el.trimEnd.onchange = trimPreview
	el.compare.ontoggle = el.otherWalk.onchange = compare
	const chosen = do journal.selected
	const finishTime = do(w) w.end || ((journal.active)?.id === w.id ? Date.now() : Math.max(w.start,w.points.at(-1)?.at || 0,w.changes.at(-1)?.at || 0))
	const stop = do
		if frame != null
			cancelAnimationFrame(frame)
		frame = null
		el.replay.textContent = 'Replay route'
	const timeAt = do(w) Math.round(w.start + (finishTime(w) - w.start) * position)
	const musicError = do(e) journal.message(e.message || 'Melodica could not start the station.')
	const stationFor = do(song,stations) song && (stations.find(do(st) song.stationId && st.id === song.stationId) || stations.find(do(st) song.stationName && st.name === song.stationName))
	const updateMusic = do
		const m = music.state()
		const key = JSON.stringify(m.stations.map(do(st) [st.id,st.name]))
		const stationsChanged = key !== stationKey
		if stationsChanged
			stationKey = key
			el.station.replaceChildren(...m.stations.map(do(st) new Option(st.name,st.id)))
		if pickedStation && !m.stations.some(do(st) st.id === pickedStation)
			pickedStation = null
		el.station.value = pickedStation || (m.station)?.id || ''
		el.stationLabel.hidden = !m.stations.length
		const current = !el.station.value || el.station.value === (m.station)?.id
		el.now.textContent = m.song ? m.song.title+' · '+m.song.artist : !m.ready ? 'Connecting to Melodica…' : !m.signedIn ? 'Sign in to listen to your Pandora stations.' : m.playing ? 'Playing in Melodica' : (m.station)?.name || (m.room ? 'Listening room' : 'Choose a station in the player.')
		el.music.textContent = !m.ready ? 'Connecting…' : !m.signedIn ? 'Sign in to play' : m.playing && current ? 'Pause music' : !m.station && !m.room ? 'Open player' : 'Play my music'
		el.music.disabled = !m.ready || musicBusy
		if m.art && el.art.getAttribute('src') !== m.art
			el.art.hidden = false
			el.art.src = m.art
		elif !m.art
			el.art.hidden = true
			el.art.removeAttribute('src')
		return stationsChanged
	const draw = do
		const w = chosen()
		if !w
			return
		const t = timeAt(w)
		const s = songAt(w,t)
		const station = stationFor(s,music.state().stations)
		el.playStation.hidden = !station || !w.end
		if station
			el.playStation.textContent = 'Play '+station.name
			el.playStation.dataset.station = station.id
		if !journal.active && w.points.length
			el.fix.textContent = pointAt(w.points,t) ? '' : 'GPS gap at this time'
		el.song.textContent = (s)?.title || (w.end ? 'No song recorded here' : 'Waiting for music')
		el.artist.textContent = (s)?.artist || (w.end ? 'Choose a track below to jump to its place.' : 'Play a station in Melodica to add its songs.')
		el.time.textContent = timeText(t - w.start)+' / '+timeText(finishTime(w) - w.start)
		el.scrub.value = String(Math.round(position * 1000))
		el.scrub.setAttribute('aria-valuetext',timeText(t - w.start) + (s ? ', '+s.title+' by '+s.artist : ', no recorded song'))
		if plate
			drawCursor(el.canvas,plate,w,t)
			let picked = -1
			for c,i in plate.list
				if c.at <= t
					picked = i
			for b,i in Array.from(el.songs.querySelectorAll('button'))
				if s && picked === i && plate.list[i].song.title === s.title && plate.list[i].song.artist === s.artist
					b.setAttribute('aria-current','true')
				else
					b.removeAttribute('aria-current')
	const move = do(n)
		liveFollow = false
		position = Math.max(0,Math.min(1,n))
		draw()
	const render = do
		if !mounted
			return
		const w = chosen()
		const live = !!journal.active
		const finished = !!(w)?.end
		updateMusic()
		el.empty.hidden = !!w
		el.record.hidden = !w
		if id !== (w)?.id
			stop()
			id = (w)?.id
			version = -1
			position = 0
			liveFollow = true
			el.confirm.hidden = true
			el.sharing.open = el.compare.open = false
			trimmed = null
			listKey = null
			comparisonRequest++
			el.pair.replaceChildren()
		if live && liveFollow
			position = 1
		el.notice.textContent = journal.notice
		el.start.hidden = live || journal.waiting
		el.browserHelp.hidden = !!globalThis.melodicaDevice
		el.pauseGps.hidden = !live
		el.pauseGps.textContent = journal.gpsPaused ? 'Resume GPS' : 'Pause GPS'
		el.sharing.hidden = !finished || w.points.length < 2
		el.compare.hidden = !finished || !journal.rows.some(do(row) row.end && row.id !== w.id)
		const open = journal.rows.find(do(row) !row.end)
		el.start.textContent = open ? 'Resume walk' : 'Start a walk'
		el.finish.hidden = !(live || (w && !finished && !journal.waiting))
		el.cancel.hidden = !journal.waiting || !!globalThis.melodicaDevice
		el.file.parentElement.hidden = live || journal.waiting
		el.file.disabled = busy
		el.start.disabled = busy
		el.library.disabled = live || journal.waiting || busy
		if !w
			return
		el.source.textContent = new Date(w.start).toLocaleDateString(undefined,{weekday:'short',month:'long',day:'numeric'})
		el.name.textContent = w.name
		const optionsKey = JSON.stringify(journal.rows.map(do(r) [r.id,r.name,r.end]))
		if optionsKey !== listKey
			listKey = optionsKey
			el.library.replaceChildren(...journal.rows.map(do(row) new Option(row.name + (row.end ? '' : ' · unfinished'),row.id)))
			el.otherWalk.replaceChildren(...journal.rows.filter(do(row) row.end && row.id !== w.id).map(do(row) new Option(row.name,row.id)))
		el.library.value = w.id
		el.fix.textContent = live ? journal.geoMessage : ''
		el.export.disabled = !finished || !w.points.length
		el.backup.disabled = w.points.length < 2
		el.match.hidden = !finished
		el.match.disabled = journal.matching || busy
		el.manage.hidden = !finished || journal.matching || busy
		el.replay.disabled = !finished || w.end <= w.start
		if version !== journal.revision
			version = journal.revision
			plate = makePlate(w)
			if el.sharing.open
				trimPreview()
			if el.compare.open
				compare()
			const count = plate.list.length
			el.stats.textContent = lengthText(distanceOf(w.points))+' · '+count + (count === 1 ? ' song' : ' songs')
			el.canvas.setAttribute('aria-label',w.name+', '+el.stats.textContent+'. The tracklist and timeline describe the route.')
			el.songs.replaceChildren()
			if !count
				const p = document.createElement('p')
				p.textContent = w.kind === 'gpx' ? 'Match listening history to find the songs played during this route.' : 'Tracks appear here as you listen.'
				el.songs.append(p)
			for c of plate.list
				const b = document.createElement('button')
				b.type = 'button'
				const stamp = document.createElement('time')
				stamp.textContent = timeText(c.at - w.start)
				const title = document.createElement('span')
				title.textContent = c.song.title+' · '+c.song.artist
				b.append(stamp,title)
				b.onclick = do
					stop()
					move((c.at - w.start) / Math.max(1,finishTime(w) - w.start))
				el.songs.append(b)
		draw()
	const act = do(fn)
		if busy
			return
		busy = true
		render()
		try
			await fn()
		catch e
			journal.message(e.message || 'That action could not be completed.')
		finally
			busy = false
			render()
	el.art.onerror = do el.art.hidden = true
	el.station.onchange = do
		pickedStation = el.station.value
		updateMusic()
	el.music.onclick = do
		if musicBusy
			return
		musicBusy = true
		updateMusic()
		try
			await music.control(el.station.value,true)
		catch e
			musicError(e)
		finally
			musicBusy = false
			updateMusic()
	el.playStation.onclick = do music.control(el.playStation.dataset.station).catch(musicError)
	el.start.onclick = do
		const m = music.state()
		const start = act(do journal.start())
		if m.ready && m.signedIn && !m.playing && (m.station || m.room) && !musicBusy
			music.control(el.station.value).catch(musicError)
		return start
	el.finish.onclick = do act(do journal.finish())
	el.pauseGps.onclick = do act(do journal.pauseLocation(!journal.gpsPaused))
	el.cancel.onclick = do journal.cancel()
	el.file.onchange = do
		const file = el.file.files[0]
		el.file.value = ''
		if file
			act(do journal.importFile(file))
	el.match.onclick = do act(do journal.match())
	el.library.onchange = do act(do journal.choose(el.library.value))
	el.scrub.oninput = do
		stop()
		move(Number(el.scrub.value) / 1000)
	el.replay.onclick = do
		if frame != null
			stop()
			return
		if position >= 0.999
			position = 0
		const offset = position
		const replayStart = performance.now()
		el.replay.textContent = 'Pause replay'
		const tick = do(now)
			move(offset + (now - replayStart) / 20000)
			if position >= 1
				stop()
			else
				frame = requestAnimationFrame(tick)
		frame = requestAnimationFrame(tick)
	const download = do(blob,ext,trimmedCopy = false)
		const w = chosen()
		const name = (trimmedCopy ? 'melodica-walk-trimmed' : 'melodica-walk-'+new Date(w.start).toISOString().slice(0,10))+'.'+ext
		return await savePortable(blob,name)
	el.export.onclick = do act(do download(await coverBlob(chosen()),'png'))
	el.trimCover.onclick = do act(do trimmed && download(await coverBlob(trimmed),'png',true))
	el.trimGpx.onclick = do act(do trimmed && download(walkFile(trimmed),'gpx',true))
	el.backup.onclick = do act(do download(walkFile(chosen()),'gpx'))
	el.delete.onclick = do
		el.confirm.hidden = false
		el.no.focus()
	el.no.onclick = do
		el.confirm.hidden = true
		el.delete.focus()
	el.yes.onclick = do act(do
		const w = chosen()
		if w.end
			await journal.library.remove(w.id)
			journal.select(null)
			await journal.refresh()
			if journal.rows.length
				await journal.choose(journal.rows[0].id)
			journal.revision++
			journal.message('Walk deleted from this device.')
	)
	journal.onchange = render
	render()
	journal.refresh().then(do
		if mounted && !journal.selected && journal.rows.length
			const last = journal.rows.find(do(row) row.id === journal.preferred)
			return journal.choose((last || journal.rows[0]).id)
	).catch(do(e) journal.message(e.message || 'Local storage is unavailable.'))
	const timer = setInterval((do
		const stationsChanged = updateMusic()
		if (journal.active || stationsChanged) && chosen() && frame == null
			draw()
	),1000)
	return {unmount:do
		mounted = false
		clearInterval(timer)
		stop()
		if journal.onchange === render
			journal.onchange = null
	}
