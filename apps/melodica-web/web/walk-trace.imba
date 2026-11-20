# Local, timestamped GPS fixes and the music audible at the same instant.
export const GPS_GAP = 90000
const RAD = Math.PI / 180
export def validPoint(lat, lon)
	return Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180

export def longitudeDelta(a, b)
	return ((b - a + 540) % 360) - 180

export def meters(a, b)
	const h = Math.sin((b.lat - a.lat) * RAD / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(longitudeDelta(a.lon,b.lon) * RAD / 2) ** 2
	return 12742000 * Math.asin(Math.sqrt(Math.min(1,h)))

export def fixPoint(position, previous, cut, now = Date.now())
	const c = position.coords
	const at = Math.round(position.timestamp)
	if !c || !validPoint(c.latitude,c.longitude) || !Number.isFinite(c.accuracy) || c.accuracy < 0 || c.accuracy > 80 || !Number.isFinite(at) || Math.abs(now - at) > 30000 || (previous && at <= previous.at)
		return null
	const p = {at, lat:c.latitude, lon:c.longitude, accuracy:c.accuracy, cut:!!cut}
	if !previous
		p.cut = true
		return p
	const elapsed = at - previous.at
	const distance = meters(previous,p)
	p.cut ||= elapsed > GPS_GAP || (distance > 100 && distance / (elapsed / 1000) > 12)
	if !p.cut && distance < Math.max(4, Math.min(22,(p.accuracy + previous.accuracy) * 0.45))
		if elapsed < 18000
			return null
		p.lat = previous.lat
		p.lon = previous.lon
	return p

export def readWalkFile(text)
	if typeof text !== 'string' || text.length > 16000000 || /<!DOCTYPE|<!ENTITY/i.test(text)
		throw new Error('Choose a GPX route under 16 MB.')
	const doc = new DOMParser().parseFromString(text, 'application/xml')
	if doc.documentElement.localName !== 'gpx' || doc.getElementsByTagName('parsererror').length
		throw new Error('This file could not be read as a GPX route.')
	const points = []
	for part of doc.getElementsByTagNameNS('*','trkseg')
		let first = true
		for node of part.children
			if node.localName !== 'trkpt'
				continue
			const time = Array.from(node.children).find(do(c) c.localName === 'time')
			const stamp = (time)?.textContent.trim() || ''
			const at = /(?:Z|[+-]\d\d:\d\d)$/i.test(stamp) ? Date.parse(stamp) : NaN
			const latText = node.getAttribute('lat') || ''
			const lonText = node.getAttribute('lon') || ''
			const lat = latText.trim() ? Number(latText) : NaN
			const lon = lonText.trim() ? Number(lonText) : NaN
			const prev = points.at(-1)
			if !Number.isFinite(at) || !validPoint(lat,lon) || (prev && at <= prev.at)
				continue
			if points.length >= 80000
				throw new Error('Choose one walk with fewer than 80,000 GPS fixes.')
			points.push({at,lat,lon,cut:first || at - prev.at > GPS_GAP})
			first = false
	if points.length < 2
		throw new Error('Choose a GPX track with at least two locations and their timestamps.')
	const changes = []
	const history = []
	const record = doc.getElementsByTagNameNS(WALK_NS,'record')[0]
	const firstAt = points[0].at
	const lastAt = points.at(-1).at
	const before = record ? Date.parse(record.getAttribute('start')) : NaN
	const after = record ? Date.parse(record.getAttribute('end')) : NaN
	const start = Number.isFinite(before) && before <= firstAt ? before : firstAt
	const end = Number.isFinite(after) && after >= lastAt ? after : lastAt
	if record
		for el of record.children
			const at = Date.parse(el.getAttribute('time'))
			if !Number.isFinite(at)
				continue
			const song = cleanTrack({artist:el.getAttribute('artist'),title:el.getAttribute('title'),stationId:el.getAttribute('station-id'),stationName:el.getAttribute('station')})
			if el.namespaceURI !== WALK_NS
				continue
			if el.localName === 'change' && at <= end
				changes.push({at:Math.max(start,at),...song || {},unknown:el.getAttribute('gap') === 'true'})
			elif el.localName === 'listen' && song
				const endsAt = Date.parse(el.getAttribute('end'))
				if endsAt > start && at <= end && endsAt > at
					history.push({at,endsAt,...song})
	changes.sort(do(a,b) a.at - b.at)
	history.sort(do(a,b) a.at - b.at)
	return {start,end,points,changes,history,restored:!!record}

export def distanceOf(points)
	let total = 0
	for p,i in points
		if i && !p.cut
			total += meters(points[i - 1],p)
	return total

# A kept line can cross a private endpoint even if both its samples are outside.
# Work in metres around the endpoint and handle the international date line.
def lineNear(a,b,center,radius)
	if !radius
		return false
	const scale = RAD * 6371000
	const across = scale * Math.cos(center.lat * RAD)
	const x = longitudeDelta(center.lon,a.lon) * across
	const y = (a.lat - center.lat) * scale
	const dx = longitudeDelta(a.lon,b.lon) * across
	const dy = (b.lat - a.lat) * scale
	const length = dx * dx + dy * dy
	const f = length ? Math.max(0,Math.min(1,-(x * dx + y * dy) / length)) : 0
	return Math.hypot(x + dx * f,y + dy * f) <= radius

export def trimWalk(w,startRadius,endRadius)
	if !(w)?.end || w.points.length < 2 || ![startRadius,endRadius].every(do(n) Number.isFinite(n) && n >= 0)
		return null
	const first = w.points[0]
	const last = w.points.at(-1)
	const points = []
	const spans = []
	let previous = null
	for p of w.points
		if (startRadius && meters(p,first) <= startRadius) || (endRadius && meters(p,last) <= endRadius)
			previous = null
			continue
		const cut = !previous || p.cut || lineNear(previous,p,first,startRadius) || lineNear(previous,p,last,endRadius)
		points.push({...p,cut:!!cut})
		if cut
			spans.push([p.at,p.at])
		else
			spans.at(-1)[1] = p.at
		previous = p
	if !spans.some(do(span) span[1] > span[0])
		return null
	const changes = []
	const timeline = chapters(w,w.end)
	let index = 0
	for span of spans
		const [start,end] = span
		changes.push({at:start,...cleanTrack(songAt(w,start)) || {}})
		while index < timeline.length && timeline[index].at <= end
			const event = timeline[index++]
			if event.at > start
				changes.push({at:event.at,...cleanTrack(event.song) || {}})
		if end < points.at(-1).at
			changes.push({at:end + 1,unknown:true})
	return {name:'Melodica walk',kind:'gpx',start:points[0].at,end:points.at(-1).at,points,changes,history:[]}

export def indexAt(items,t)
	let lo = 0
	let hi = items.length
	while lo < hi
		const m = Math.floor((lo + hi) / 2)
		if items[m].at <= t
			lo = m + 1
		else
			hi = m
	return lo - 1

export def cleanTrack(s)
	if !s || typeof s.title !== 'string' || typeof s.artist !== 'string'
		return null
	const title = s.title.trim().slice(0,250)
	const artist = s.artist.trim().slice(0,250)
	if !title || !artist
		return null
	const station = s.stationName || s.station_name
	const stationName = typeof station === 'string' ? station.trim().slice(0,128) : ''
	const stationId = typeof s.stationId === 'string' ? s.stationId.trim().slice(0,128) : ''
	return {title,artist,...stationName ? {stationName} : {},...stationId ? {stationId} : {}}

export def sameTrack(a,b)
	return (a)?.title === (b)?.title && (a)?.artist === (b)?.artist

export def tracksDuring(start, end, rows)
	const history = []
	for row of rows
		const song = cleanTrack(row)
		const at = Number(row.listened_at) * 1000
		const ms = Number(row.duration_ms)
		const endsAt = at + (Number.isFinite(ms) && ms > 0 ? ms : 1000)
		if song && Number.isFinite(at) && at <= end && endsAt > start
			history.push({...song,at,endsAt})
	return history.sort(do(a,b) a.at - b.at)

export def songAt(walk,t)
	const local = walk.changes[indexAt(walk.changes,t)]
	if local && !local.unknown
		return local.title ? local : null
	const s = walk.history[indexAt(walk.history,t)]
	return s && t < s.endsAt ? s : null

export def chapters(walk,end)
	const times = new Set([walk.start])
	for change of walk.changes
		times.add(change.at)
	for s of walk.history
		times.add(Math.max(walk.start,s.at))
		times.add(s.endsAt)
	const out = []
	for at of Array.from(times).sort(do(a,b) a - b)
		if at > end
			break
		const s = songAt(walk,at)
		if !out.length || !sameTrack(out.at(-1).song,s)
			out.push({at,song:s})
	return out

export def pointAt(points,t)
	const i = indexAt(points,t)
	if i < 0
		return null
	const a = points[i]
	const b = points[i + 1]
	if t === a.at
		return a
	if !b || b.cut
		return null
	const f = (t - a.at) / (b.at - a.at)
	return {lat:a.lat + (b.lat - a.lat) * f,lon:((a.lon + longitudeDelta(a.lon,b.lon) * f + 540) % 360) - 180}

export def lengthText(m)
	return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m'

export def timeText(ms)
	const sec = Math.max(0,Math.floor(ms / 1000))
	return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2,'0')

const WALK_NS = 'https://spacegho.st/melodica/walk-record/1'
export def walkFile(w)
	const ns = 'http://www.topografix.com/GPX/1/1'
	const doc = document.implementation.createDocument(ns,'gpx')
	const root = doc.documentElement
	root.setAttribute('version','1.1')
	root.setAttribute('creator','Melodica')
	const add = do(parent,name,value)
		const n = doc.createElementNS(ns,name)
		if value != null
			n.textContent = value
		parent.appendChild(n)
		return n
	const trk = add(root,'trk')
	add(trk,'name',w.name)
	let segment = null
	for p of w.points
		if !segment || p.cut
			segment = add(trk,'trkseg')
		const n = add(segment,'trkpt')
		n.setAttribute('lat',p.lat.toFixed(7))
		n.setAttribute('lon',p.lon.toFixed(7))
		add(n,'time',new Date(p.at).toISOString())
	const record = doc.createElementNS(WALK_NS,'m:record')
	record.setAttribute('start',new Date(w.start).toISOString())
	record.setAttribute('end',new Date(w.end).toISOString())
	add(root,'extensions').appendChild(record)
	for kind of ['changes','history']
		for item of w[kind]
			const n = doc.createElementNS(WALK_NS,kind === 'changes' ? 'm:change' : 'm:listen')
			n.setAttribute('time',new Date(item.at).toISOString())
			if item.endsAt
				n.setAttribute('end',new Date(item.endsAt).toISOString())
			if item.unknown
				n.setAttribute('gap','true')
			if item.title
				n.setAttribute('title',item.title)
				n.setAttribute('artist',item.artist)
				if item.stationId
					n.setAttribute('station-id',item.stationId)
				if item.stationName
					n.setAttribute('station',item.stationName)
			record.appendChild(n)
	return new Blob([new XMLSerializer().serializeToString(doc)],{type:'application/gpx+xml'})
