export const roomIdFromPath = (do(path) (/^\/melodica\/rooms\/([A-Za-z0-9_-]{16,64})\/?$/.exec(path))?. [1] || null)
export const isRoomsPath = (do(path) path === '/melodica/rooms/' || path === '/melodica/rooms' || !!roomIdFromPath(path))

const validId = (do(id) typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(id))
const roomError = (do(message) Object.assign(new Error(message), {code: 'room'}))

export def roomBlocksSource(snapshot)
	const room = (snapshot)?.state
	return !!(snapshot)?.id && (!room || !room.closed_at && (!room.you || ((room.play)?.dj || room.current_dj) !== room.you || room.you_broadcasting === false))

# Public room tracks have a play identity, never a private Pandora token.
export def roomTrack(play)
	const t = (play)?.track_metadata
	if !t
		return null
	const info = t.additional_info || {}
	return {
		title: t.track_name || '',
		artist: t.artist_name || '',
		album: t.release_name || '',
		coverArt: info.art_url || '',
		duration: Math.max(0, Number(play.duration_ms || info.duration_ms) || 0) / 1000,
		rating: play.reaction === 'like' ? 1 : play.reaction === 'dislike' ? 2 : 0,
		roomPlayId: play.id,
		kind: 'room'
	}

export def roomHistory(snapshot)
	return [((snapshot)?.state)?.play, ...(((snapshot)?.state)?.past || []).slice().reverse()].map(roomTrack).filter(Boolean).slice(0, 20)

# Advance from the last received server anchor, so a different system clock on
# a remote does not make the play jump. Playback clocks never change membership.
export def roomPositionMs(snapshot, now = Date.now())
	const room = (snapshot)?.state
	const play = (room)?.play
	if !play
		return 0
	const anchored = Number.isSafeInteger(play.position_ms) && Number.isSafeInteger(play.server_time)
	const base = anchored ? play.position_ms : Math.max(0, (play.paused_at || room.server_time || now) - play.started_at - (play.paused_ms || 0))
	const elapsed = play.paused_at ? 0 : Math.max(0, now - (snapshot.clockReceivedAt || now))
	return Math.min(play.duration_ms || Infinity, Math.max(0, base + elapsed))

# The route is a view. Only the elected player engine creates the room socket,
# capture or receiving audio; other tabs and extension remotes forward intents.
export def createRoomHost({
	loadUi,
	token,
	remote,
	send,
	player,
	onChange = (do
		return
	),
	onClock = (do
		return
	)
} = {})
	const events = new EventTarget()
	let session = null
	let snapshot = null
	let joining = null
	let generation = 0
	let recentIds = []
	let recentSubject = ''
	const emit = (do(type, detail) events.dispatchEvent(new CustomEvent(type, {detail})))
	const report = (do(e) emit('error', {message: e.message, code: e.code, status: e.status}))
	def update(next)
		if (next)?.id === (snapshot)?.id && (next)?.state && (snapshot)?.state && next.state.seq < snapshot.state.seq
			return
		if (next)?.id === (snapshot)?.id && ((next)?.state)?.seq === ((snapshot)?.state)?.seq && (((next)?.state)?.play)?.id === (((snapshot)?.state)?.play)?.id && Number((((next)?.state)?.play)?.server_time || 0) < Number((((snapshot)?.state)?.play)?.server_time || 0)
			next = {
				...next,
				state: {
					...next.state,
					play: {
						...next.state.play,
						position_ms: snapshot.state.play.position_ms,
						server_time: snapshot.state.play.server_time
					}
				}
			}
		const roomState = (next)?.state
		const subject = (roomState)?.you
		const isMember = (roomState)?.members && roomState.members.some((do(member) member.account === subject))
		if subject && isMember && !roomState.closed_at
			if recentSubject !== next.state.you
				recentIds = []
				recentSubject = next.state.you
			const otherRooms = recentIds.filter((do(id) id !== next.id))
			otherRooms.unshift(next.id)
			recentIds = otherRooms.slice(0, 12)
		const play = (roomState)?.play
		const previousRoom = (snapshot)?.state
		const previousPlay = (previousRoom)?.play
		const sameTrack = (next)?.id === (snapshot)?.id && (play)?.id === (previousPlay)?.id
		const samePosition = (play)?.server_time === (previousPlay)?.server_time && (play)?.position_ms === (previousPlay)?.position_ms
		const samePause = (play)?.paused_at === (previousPlay)?.paused_at && (play)?.paused_ms === (previousPlay)?.paused_ms
		const sameServerTime = ((play)?.server_time || (roomState)?.server_time) === ((previousPlay)?.server_time || (previousRoom)?.server_time)
		const sameClock = sameTrack && samePosition && samePause && sameServerTime
		snapshot = next ? ({...next, clockReceivedAt: sameClock ? snapshot.clockReceivedAt : Date.now()}) : null
		emit('change', snapshot)
		onChange(snapshot)
	def updateClock(next)
		const play = ((next)?.state)?.play
		const current = ((snapshot)?.state)?.play
		if !play || !current || next.id !== snapshot.id || play.id !== current.id || !Number.isSafeInteger(play.position_ms) || play.position_ms < 0 || !Number.isSafeInteger(play.server_time) || play.server_time <= (current.server_time || 0)
			return false
		snapshot = {
			...snapshot,
			clockReceivedAt: Date.now(),
			state: {
				...snapshot.state,
				play: {...current, position_ms: play.position_ms, server_time: play.server_time}
			}
		}
		const clock = {play_id: play.id, position_ms: play.position_ms, server_time: play.server_time}
		emit('clock', clock)
		onClock(snapshot)
		return true
	def publish()
		if !session
			return
		update({
			id: (session.connection.getState())?.id || (snapshot)?.id,
			state: session.getState(),
			audio: session.getAudioState()
		})
	def join(id, {paused = false} = {})
		if !/^[A-Za-z0-9_-]{16,64}$/.test(id || '')
			throw new Error('Choose a valid room.')
		if session && (snapshot)?.id === id
			return snapshot
		if (joining)?.id === id
			return joining.promise
		const current = (snapshot)?.state
		if (current)?.play && current.play.dj === current.you && current.you_broadcasting !== false
			throw roomError('Leave your DJ room before joining another room.')
		const gen = ++generation
		(session)?.close()
		session = null
		update({id, state: null, audio: {state: 'connecting'}})
		const promise = ((do
			const mod = await loadUi()
			if gen !== generation || remote()
				return snapshot
			if !mod.createRoomSession || !mod.createRoomTransport
				throw new Error('Room playback is waiting for the updated shared player.')
			const client = mod.createClient({base: location.origin, token})
			const connection = mod.createRoomConnection({client, id})
			const audio = mod.createRoomTransport({connection})
			session = mod.createRoomSession({connection, audio, player})
			session.addEventListener('state', publish)
			session.addEventListener('audio', publish)
			session.addEventListener('clock', (do updateClock({id, state: (session)?.getState()})))
			session.addEventListener('error', reportEvent)
			session.setVolume((player)?.volume() ?? 80)
			if paused
				await session.pause()
			session.open()
			return snapshot
		))().finally((do
			if (joining)?.promise === promise
				joining = null
		))
		joining = {id, promise}
		return await promise
	const reportEvent = (do(e)
		report((e.detail instanceof Error) ? e.detail : Object.assign(new Error(e.detail.message), e.detail))
	)
	def leave({leave = true} = {})
		generation++
		const closing = (session)?.close({leave})
		session = null
		update(null)
		return Promise.resolve(closing)
	def suspend()
		generation++
		(session)?.close({leave: false})
		session = null
		# Keep the last public snapshot in the engine handoff. Clearing it here
		# would overwrite the room just as a closing tab releases ownership.
	def handle(action, fields = {})
		if action === 'room-api'
			return {ok: true, result: await localApi(fields.path, fields), status: 200}
		if action === 'room-recent'
			return {ok: true, recentRoomIds: recentIds.slice()}
		if action === 'room-search'
			const query = String(fields.query || '').trim()
			const cursor = String(fields.cursor || '')
			if query.length > 80 || cursor.length > 512 || /[\u0000-\u001f\u007f]/.test(cursor)
				throw roomError('Invalid room search.')
			const params = new URLSearchParams()
			if query
				params.set('q', query)
			if cursor
				params.set('cursor', cursor)
			if recentIds.length
				params.set('recent', recentIds.join(','))
			return {ok: true, ...await localApi('rooms?' + params)}
		if action === 'room-get'
			return {ok: true, room: snapshot}
		if action === 'room-join'
			await join(fields.roomId || fields.id, {paused: fields.paused === true})
		elif action === 'room-leave'
			await leave()
		else
			if !session
				throw new Error('Join the room first.')
			if (fields.roomId || fields.id) && (fields.roomId || fields.id) !== (snapshot)?.id
				throw new Error('The active room changed.')
			if action === 'room-command'
				if (fields.body)?.action === 'leave'
					await leave()
				else
					await session.command(fields.body)
			elif action === 'room-pause'
				await session.pause()
			elif action === 'room-resume'
				await session.resume()
			elif action === 'room-skip'
				await session.skip()
			elif action === 'room-volume'
				session.setVolume(fields.value)
			else
				throw new Error('That room action is unavailable.')
			publish()
		return {ok: true, room: snapshot}
	def request(action, fields = {})
		# The bridge uses id for request correlation; carry room identity separately.
		const roomId = fields.roomId || fields.id || (!['room-join', 'room-search', 'room-recent'].includes(action) ? (snapshot)?.id : null)
		const intent = roomId ? ({...fields, roomId}) : fields
		const result = remote() ? (await send(action, intent)) : (await handle(action, intent))
		if !(result)?.ok
			throw new Error((result)?.error || 'The player did not confirm that room action.')
		if Reflect.has(result, 'room')
			update(result.room)
		return result
	def command(action, fields = {})
		const result = await request(action, fields)
		return (result.room)?.state || null
	def localApi(path, {body, roomId} = {})
		if typeof path !== 'string' || path.length > 512 || !/^rooms(?:\?|\/|$)/.test(path)
			throw roomError('That room request is unavailable.')
		const u = new URL(path, 'https://room.invalid/')
		if u.origin !== 'https://room.invalid' || u.hash
			throw roomError('That room request is unavailable.')
		const match = /^\/rooms\/([A-Za-z0-9_-]{16,64})(\/invite-link)?$/.exec(u.pathname)
		if u.pathname !== '/rooms' && (!match || match[1] !== (snapshot)?.id || roomId && roomId !== match[1] || u.search)
			throw roomError('Join this room before using its controls.')
		const keys = [...u.searchParams.keys()]
		if keys.some((do(key) !['q', 'cursor', 'recent'].includes(key))) || new Set(keys).size !== keys.length || (u.searchParams.get('q') || '').length > 80 || (u.searchParams.get('cursor') || '').length > 512 || /[\u0000-\u001f\u007f]/.test(u.searchParams.get('cursor') || '') || u.searchParams.has('recent') && (u.searchParams.get('recent').split(',').length > 12 || !u.searchParams.get('recent').split(',').every(validId))
			throw roomError('Invalid room search.')
		if body !== undefined
			if !body || typeof body !== 'object' || Array.isArray(body)
				throw roomError('Invalid room request.')
			if u.pathname === '/rooms'
				if u.search || Object.keys(body).some((do(k) !['name', 'kind', 'mode', 'spots'].includes(k))) || typeof body.name !== 'string' || body.name.length > 80 || !['public', 'private'].includes(body.kind) || !['solo', 'rotation'].includes(body.mode) || !Number.isInteger(body.spots) || body.spots < 1 || body.spots > 5
					throw roomError('Invalid room settings.')
			elif !(match)?. [2] || Object.keys(body).length
				throw roomError('Use the player for room actions.')
		elif (match)?. [2]
			throw roomError('Invalid room request.')
		const mod = await loadUi()
		return mod.createClient({base: location.origin, token}).api(path, body === undefined ? ({}) : ({body}))
	def api(path, {body} = {})
		const match = /^rooms\/([A-Za-z0-9_-]{16,64})$/.exec(path)
		if match && body !== undefined
			if match[1] !== (snapshot)?.id
				throw roomError('The active room changed.')
			return command('room-command', {id: match[1], body})
		return (await request('room-api', {path, roomId: (match)?. [1] || (snapshot)?.id, ...body === undefined ? ({}) : ({body})})).result
	def mount(host, id = null)
		const mod = await loadUi()
		const original = mod.createClient({base: location.origin, token})
		const client = {...original, api: (do(path, init) /^rooms(?:\?|\/|$)/.test(path) ? api(path, init) : original.api(path, init))}
		if !id
			return mod.mountRooms(host, {
				client,
				recentRoomIds: (do
					return (await request('room-recent')).recentRoomIds || []
				),
				searchRooms: (do({query, cursor}) request('room-search', {query, cursor}))
			})
		const connection = new EventTarget()
		const audio = new EventTarget()
		const updateView = (do
			if (snapshot)?.id !== id
				return
			if snapshot.state
				connection.dispatchEvent(new CustomEvent('state', {detail: snapshot.state}))
			audio.dispatchEvent(new CustomEvent('state', {detail: snapshot.audio || {state: 'connecting'}}))
		)
		const onError = (do(e) connection.dispatchEvent(new CustomEvent('error', {detail: e.detail})))
		const onClock = (do(e)
			if (snapshot)?.id === id
				connection.dispatchEvent(new CustomEvent('clock', {detail: e.detail}))
		)
		Object.assign(connection, {
			open: (do
				command('room-join', {id}).catch(report)
			),
			getState: (do (snapshot)?.id === id ? snapshot.state : null),
			command: (do(body) command('room-command', {id, body}))
		})
		Object.assign(audio, {
			listen: (do command('room-resume', {id})),
			resume: (do command('room-resume', {id})),
			getState: (do (snapshot)?.id === id ? snapshot.audio : ({state: 'idle'}))
		})
		events.addEventListener('change', updateView)
		events.addEventListener('error', onError)
		events.addEventListener('clock', onClock)
		const view = mod.mountRoom(host, {id, client, connection, audio, ownsAudio: false, recordListens: false})
		updateView()
		return {
			unmount: (do
				view.unmount()
				events.removeEventListener('change', updateView)
				events.removeEventListener('error', onError)
				events.removeEventListener('clock', onClock)
			)
		}
	return Object.assign(events, {
		mount,
		handle,
		command,
		api,
		leave,
		suspend,
		getState: (do snapshot),
		active: (do !!(snapshot)?.state && !snapshot.state.closed_at),
		localSession: (do session),
		updateRemote: (do(next)
			if remote()
				update(next || null)
		),
		updateClockRemote: (do(next) remote() && updateClock(next))
	})
