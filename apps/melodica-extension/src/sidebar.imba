import {browser,send} from './shared.imba'

const byId = do(id) document.getElementById(id)
const status = document.querySelector('[role=status]')
const lyrics = document.querySelector('.side-lyrics')
const progress = byId('track-progress')
const elapsed = byId('elapsed')
const durationLabel = byId('duration')
let coverUrl = ''
let snapshot = null
let updated = 0
let songKey = null
let job = null
let lines = []
let plain = ''
let current = -2

def clock seconds
	const sec = Math.max(0,Math.floor(seconds))
	return Math.floor(sec/60)+':'+String(sec % 60).padStart(2,'0')

def renderLine
	const seconds = Number(snapshot and snapshot.position or 0) + (snapshot and snapshot.status === 'playing' ? (performance.now()-updated)/1000 : 0)
	const duration = Number(snapshot and (snapshot.duration or (snapshot.track and snapshot.track.duration))) or 0
	progress.parentElement.hidden = duration <= 0
	if duration > 0
		const time = Math.min(duration,seconds)
		progress.max = duration
		progress.value = time
		const label = clock(time)
		elapsed.textContent = label if elapsed.textContent !== label
		durationLabel.textContent = clock(duration)
	let lo = 0
	let hi = lines.length
	while lo < hi
		const mid = (lo+hi) >>> 1
		if lines[mid].at <= seconds then lo = mid+1 else hi = mid
	const i = lo - 1
	return if current === i
	current = i
	byId('before').textContent = i > 0 ? lines[i - 1].text : ''
	byId('line').textContent = lines.length ? (i >= 0 ? lines[i].text : '') : plain
	byId('after').textContent = lines[i+1] ? lines[i+1].text : ''

def loadLyrics song
	job.abort() if job
	job = new AbortController
	const signal = job.signal
	lines = []
	plain = ''
	lyrics.dataset.format = ''
	lyrics.scrollTop = 0
	current = -2
	renderLine()
	status.textContent = song ? 'Finding lyrics…' : 'Play a song in Melodica to follow its lyrics.'
	return unless song
	try
		const url = new URL('https://spacegho.st/melodica/lyrics/get')
		url.searchParams.set('artist_name',song.artist)
		url.searchParams.set('track_name',song.title)
		url.searchParams.set('album_name',song.album) if song.album
		url.searchParams.set('duration',String(Math.round(song.duration))) if song.duration > 0
		const res = await fetch(url,{signal,credentials:'omit',referrerPolicy:'no-referrer'})
		throw new Error('Lyrics unavailable for this song.') unless res.ok
		const data = await res.json()
		return if signal.aborted
		const lrc = String(data.syncedLyrics or '')
		const offset = Number((/\[offset:([+-]?\d+)\]/i.exec(lrc) or [])[1] or 0)/1000
		for row of lrc.split(/\r?\n/)
			const text = row.replace(/^(?:\[\d+:[0-5]\d(?:[.:]\d+)?\]\s*)+/,'')
			for match of Array.from(row.matchAll(/\[(\d+):([0-5]\d)(?:[.:](\d+))?\]/g))
				lines.push({at:Number(match[1])*60+Number(match[2])+Number('0.'+(match[3] or '0'))-offset,text})
		lines.sort(do(a,b) a.at - b.at)
		plain = String(data.plainLyrics or '')
		lyrics.dataset.format = lines.length ? 'timed' : 'plain'
		status.textContent = lines.length or plain ? '' : data.instrumental ? 'Instrumental' : 'Lyrics unavailable for this song.'
		current = -2
		renderLine()
	catch err
		status.textContent = 'Lyrics unavailable for this song.' unless signal.aborted

def update state
	return unless state
	snapshot = state
	updated = performance.now()
	const song = state.track
	const key = JSON.stringify(song ? [song.artist,song.title,song.album] : [])
	if key !== songKey
		songKey = key
		byId('song').textContent = song and song.title or 'Melodica'
		byId('artist').textContent = song and song.artist or ''
		loadLyrics(song)
	const cover = song and (song.coverArt or song.art) or ''
	if cover !== coverUrl
		coverUrl = cover
		byId('cover').hidden = !cover
		if cover then byId('cover').src = cover else byId('cover').removeAttribute('src')
	byId('toggle').textContent = state.status === 'playing' ? 'Pause' : 'Play'
	byId('toggle').disabled = !song and !state.last
	byId('next').disabled = !song or !!song.ad
	byId('undo').hidden = !(state.undoUntil > Date.now())
	renderLine()

byId('cover').onerror = do byId('cover').hidden = yes

for [id,action] of [['toggle','toggle'],['next','next'],['undo','undo-skip']]
	byId(id).onclick = do
		try
			update((await send({type:'player',action})).state)
		catch err
			status.textContent = err.message
browser.runtime.onMessage.addListener(do(msg)
	if msg.type === 'player-state' then update(msg.state)
	return no
)
send({type:'player-get'}).then(do(r) update(r.state)).catch(do(e) status.textContent = e.message)
const tick = setInterval((do
	return if document.hidden
	renderLine()
	byId('undo').hidden = yes if snapshot and !(snapshot.undoUntil > Date.now())
),350)
window.addEventListener('pagehide',do
	clearInterval(tick)
	job.abort() if job
)
