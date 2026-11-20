import {chapters,longitudeDelta,pointAt,songAt,distanceOf,lengthText,timeText} from './walk-trace.js'

const colors = ['#ffb574','#79e3d4','#e4b5fa','#f3d86c','#90bcff','#ff9999','#bae38e']
export def inkFor(song,sequence)
	if !song
		return '#84949a'
	const i = sequence.findIndex(do(x) x.song && x.song.artist === song.artist && x.song.title === song.title)
	return colors[Math.max(0,i) % colors.length]

def disc(ctx,x,y,r,fill)
	ctx.beginPath()
	ctx.arc(x,y,r,0,Math.PI * 2)
	ctx.fillStyle = fill
	ctx.fill()
def line(ctx,a,b,color,width)
	ctx.beginPath()
	ctx.moveTo(a.x,a.y)
	ctx.lineTo(b.x,b.y)
	ctx.strokeStyle = color
	ctx.lineWidth = width
	ctx.stroke()

export def makePlate(walk)
	const size = 850
	const paper = document.createElement('canvas')
	paper.width = paper.height = size
	const ctx = paper.getContext('2d')
	const bg = ctx.createLinearGradient(0,0,size,size)
	bg.addColorStop(0,'#202e35')
	bg.addColorStop(0.55,'#12272a')
	bg.addColorStop(1,'#171c2a')
	ctx.fillStyle = bg
	ctx.fillRect(0,0,size,size)
	const end = walk.end || Math.max(walk.start,walk.points.at(-1)?.at || 0,walk.changes.at(-1)?.at || 0)
	const list = chapters(walk,end).filter(do(c) !!c.song)
	const points = walk.points
	const anchor = points[0] || {lat:0,lon:0}
	const cos = Math.max(0.0001,Math.cos(anchor.lat * Math.PI / 180))
	let left = 0
	let right = 0
	let top = 0
	let bottom = 0
	for p of points
		const x = longitudeDelta(anchor.lon,p.lon) * cos
		const y = anchor.lat - p.lat
		left = Math.min(left,x)
		right = Math.max(right,x)
		top = Math.min(top,y)
		bottom = Math.max(bottom,y)
	const scale = 610 / Math.max(0.00035,right - left,bottom - top)
	const project = do(p)
		return {x:425 + (longitudeDelta(anchor.lon,p.lon) * cos - (left + right) / 2) * scale,y:430 + (anchor.lat - p.lat - (top + bottom) / 2) * scale}
	for i in [0...34]
		ctx.beginPath()
		ctx.arc(425,430,28 + i * 13.5,0,Math.PI * 2)
		ctx.strokeStyle = i % 4 === 0 ? 'rgba(212,237,223,.12)' : 'rgba(212,237,223,.048)'
		ctx.lineWidth = i % 4 === 0 ? 1.4 : 1
		ctx.stroke()
	ctx.fillStyle = '#c0d3c9'
	ctx.font = '600 19px system-ui'
	ctx.fillText('N',777,83)
	line(ctx,{x:784,y:48},{x:784,y:24},'#c0d3c9',2)
	ctx.lineCap = ctx.lineJoin = 'round'
	const stride = Math.max(1,Math.ceil(points.length / 2800))
	let prev = null
	for p,i in points
		if p.cut
			prev = null
		if i % stride && prev && i < points.length - 1 && !points[i + 1]?.cut
			continue
		const curr = project(p)
		if prev
			const song = songAt(walk,(p.at + prev.at) / 2)
			line(ctx,prev,curr,inkFor(song,list),6)
		prev = {...curr,at:p.at}
	for chapter of list
		const p = pointAt(points,chapter.at)
		if p
			const xy = project(p)
			disc(ctx,xy.x,xy.y,10,'#15272b')
			disc(ctx,xy.x,xy.y,6,inkFor(chapter.song,list))
	if points.length
		const first = project(points[0])
		const last = project(points.at(-1))
		ctx.strokeStyle = '#f4f3d9'
		ctx.lineWidth = 3
		ctx.strokeRect(first.x - 7,first.y - 7,14,14)
		disc(ctx,last.x,last.y,6,'#f4f3d9')
	ctx.font = '500 19px system-ui'
	ctx.fillStyle = '#ccdad2'
	ctx.fillText(lengthText(distanceOf(points)),38,802)
	ctx.textAlign = 'right'
	ctx.fillText(timeText(end - walk.start),808,802)
	return {paper,project,list}

export def drawCursor(canvas,plate,walk,at)
	const ctx = canvas.getContext('2d')
	ctx.drawImage(plate.paper,0,0,canvas.width,canvas.height)
	const p = pointAt(walk.points,at)
	if !p
		return
	const xy = plate.project(p)
	ctx.save()
	ctx.scale(canvas.width / 850,canvas.height / 850)
	disc(ctx,xy.x,xy.y,21,'rgba(255,255,235,.24)')
	disc(ctx,xy.x,xy.y,12,'#faf5df')
	disc(ctx,xy.x,xy.y,6,'#133238')
	ctx.restore()

def fit(ctx,text,max)
	if ctx.measureText(text).width <= max
		return text
	let result = text
	while result && ctx.measureText(result+'…').width > max
		result = result.slice(0,-1)
	return result+'…'

export def coverBlob(walk)
	const plate = makePlate(walk)
	const cover = document.createElement('canvas')
	cover.width = cover.height = 1200
	const ctx = cover.getContext('2d')
	ctx.fillStyle = '#122329'
	ctx.fillRect(0,0,1200,1200)
	ctx.drawImage(plate.paper,155,18,890,890)
	ctx.fillStyle = '#f0ebd9'
	ctx.font = '56px Georgia, serif'
	ctx.fillText(fit(ctx,walk.name,1100),48,963)
	ctx.fillStyle = '#a7c4bd'
	ctx.font = '24px system-ui'
	ctx.fillText('Melodica  /  '+new Date(walk.start).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}),50,1007)
	const listing = plate.list
	for c,i in listing.slice(0,4)
		ctx.fillStyle = inkFor(c.song,listing)
		ctx.fillRect(51,1042 + i * 34,12,12)
		ctx.fillStyle = '#eeead9'
		ctx.fillText(fit(ctx,c.song.title+'  ·  '+c.song.artist,1030),80,1057 + i * 34)
	if listing.length > 4
		ctx.textAlign = 'right'
		ctx.fillText('+'+(listing.length - 4),1148,1170)
	return new Promise(do(resolve,reject)
		cover.toBlob((do(blob) blob ? resolve(blob) : reject(new Error('Cover image could not be created.'))),'image/png')
	)
