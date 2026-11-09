const ROOM_ID = /^[A-Za-z0-9_-]{16,64}$/;

function trackMetadata(track, duration = 0) {
  if (!track?.trackToken || !track.title || !track.artist) return null;
  const metadata = {
    track_name: String(track.title || '').slice(0, 512),
    artist_name: String(track.artist || '').slice(0, 512),
    release_name: String(track.album || '').slice(0, 512),
  };
  const durationMs = Math.round((Number(duration) || Number(track.duration) || 0) * 1000);
  if (!Number.isFinite(durationMs) || durationMs < 1_000 || durationMs > 3_600_000) return null;
  metadata.additional_info = { duration_ms: durationMs };
  const art = track.coverArt || track.art;
  if (typeof art === 'string' && /^https:\/\//i.test(art) && art.length <= 4096) metadata.additional_info = { ...metadata.additional_info, art_url: art };
  return metadata;
}

function validRoomCommand(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid room command.');
  const text = (value, max = 128) => typeof value === 'string' && value.length > 0 && value.length <= max;
  const fields = {
    join: [], heartbeat: [], close: [], leave: [],
    react: ['play_id', 'reaction'], skip: ['play_id'], end: ['play_id'],
    pause: ['play_id'], resume: ['play_id'],
    'request-dj': [], 'vote-dj': ['account', 'approve', 'override'],
    scrobble: ['enabled'], 'scrobble-past': ['play_id', 'heard'],
    settings: ['kind', 'mode', 'spots', 'skip_fraction'], invite: ['username'],
    heard: ['play_id', 'listened_ms'],
    play: ['track_metadata'],
  };
  const action = body.action;
  if (!Object.hasOwn(fields, action)) throw new Error('Unknown room action.');
  for (const key of Object.keys(body)) if (key !== 'action' && !fields[action].includes(key)) throw new Error('Unexpected room command field.');
  const out = { action };
  if (fields[action].includes('play_id')) {
    if (!text(body.play_id)) throw new Error('Invalid room play id.');
    out.play_id = body.play_id;
  }
  if (action === 'react') {
    if (!['like', 'dislike', 'none'].includes(body.reaction)) throw new Error('Invalid room reaction.');
    out.reaction = body.reaction;
  } else if (action === 'vote-dj') {
    if (!text(body.account) || typeof body.approve !== 'boolean' || (body.override !== undefined && typeof body.override !== 'boolean')) throw new Error('Invalid DJ vote.');
    Object.assign(out, { account: body.account, approve: body.approve });
    if (body.override !== undefined) out.override = body.override;
  } else if (action === 'scrobble') {
    if (typeof body.enabled !== 'boolean') throw new Error('Invalid scrobble setting.');
    out.enabled = body.enabled;
  } else if (action === 'scrobble-past') {
    if (typeof body.heard !== 'boolean') throw new Error('Invalid listen state.');
    out.heard = body.heard;
  } else if (action === 'settings') {
    if (!['public', 'private'].includes(body.kind) || !['solo', 'rotation'].includes(body.mode) || !Number.isInteger(body.spots) || body.spots < 1 || body.spots > 5 || !Number.isFinite(body.skip_fraction) || body.skip_fraction < .3 || body.skip_fraction > .8) throw new Error('Invalid room settings.');
    Object.assign(out, { kind: body.kind, mode: body.mode, spots: body.spots, skip_fraction: body.skip_fraction });
  } else if (action === 'invite') {
    if (!/^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/i.test(body.username || '')) throw new Error('Invalid invite username.');
    out.username = body.username.toLowerCase();
  } else if (action === 'heard') {
    if (!Number.isFinite(body.listened_ms) || body.listened_ms < 0 || body.listened_ms > 86_400_000) throw new Error('Invalid listened time.');
    out.listened_ms = Math.floor(body.listened_ms);
  } else if (action === 'play') {
    const t = body.track_metadata;
    if (!t || !text(t.track_name, 512) || !text(t.artist_name, 512) || (t.release_name !== undefined && !text(t.release_name, 512))) throw new Error('Invalid room track metadata.');
    out.track_metadata = { track_name: t.track_name, artist_name: t.artist_name };
    if (t.release_name) out.track_metadata.release_name = t.release_name;
    const duration = t.additional_info?.duration_ms;
    if (duration !== undefined) {
      if (!Number.isFinite(duration) || duration < 1_000 || duration > 3_600_000) throw new Error('Invalid room track duration.');
      out.track_metadata.additional_info = { duration_ms: Math.floor(duration) };
    }
    if (t.additional_info?.art_url && /^https:\/\//i.test(t.additional_info.art_url)) {
      out.track_metadata.additional_info = { ...out.track_metadata.additional_info, art_url: t.additional_info.art_url.slice(0, 4096) };
    }
  }
  return out;
}

export class RoomEngine extends EventTarget {
  constructor({ engine, send, loadMedia } = {}) {
    super();
    if (!engine || typeof send !== 'function' || typeof loadMedia !== 'function') throw new TypeError('Room engine needs the player, background bridge and media bundle.');
    this.engine = engine;
    this.send = send;
    this.loadMedia = loadMedia;
    this.session = null;
    this.id = '';
    this.media = null;
    this.audio = null;
    this.connection = null;
    this.scrobbling = true;
    this.sequence = 0;
    this.stopped = null;
    this.onAudioPlay = () => this.emitPlayerAudio();
    this.onAudioPause = () => this.emitPlayerAudio();
  }

  emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  emitPlayerAudio() {
    const audio = this.engine.audio;
    this.emit('player-audio', { paused: !!audio?.paused, currentTime: Number(audio?.currentTime) || 0 });
  }
  state() { return { id: this.id || null, state: this.session?.getState?.() || null, audio: this.session?.getAudioState?.() || { state: 'idle' } }; }

  async join(id, { base, paused = false, sequence = 0, scrobbling = true, sfuConfigured = true } = {}) {
    if (!ROOM_ID.test(String(id || ''))) throw new Error('Choose a valid room.');
    if (Number.isSafeInteger(sequence) && sequence > this.sequence) this.sequence = sequence;
    if (this.session && this.id === id) {
      if (paused) await this.session.pause();
      return this.waitForInitialState();
    }
    await this.leave({ leave: false });
    const media = await this.loadMedia();
    if (!media?.createRoomConnection || !media?.createRoomTransport || !media?.createRoomSession || !media?.capturePlayerAudio) throw new Error('Room audio is not available in this extension build.');
    this.media = media;
    this.id = id;
    this.scrobbling = scrobbling !== false;
    const client = {
      base,
      token: async () => (await this.send({ type: 'room-token' })).token,
      api: async (path, options = {}) => (await this.send({ type: 'room-api', roomId: id, path, body: options.body })).result,
    };
    const connection = media.createRoomConnection({ client, id });
    const audio = media.createRoomTransport({ connection, sfuConfigured, sfuAvailable: true });
    const player = {
      currentTrack: () => trackMetadata(this.engine.snapshot.track, this.engine.snapshot.duration),
      startTurn: () => this.startTurn(),
      capture: () => media.capturePlayerAudio(this.engine.audio),
      pause: () => this.engine.pause(),
      resume: () => this.engine.resume(),
      setVolume: (value) => this.engine.setVolume(value),
      scrobbling: () => this.scrobbling,
    };
    const session = media.createRoomSession({ connection, audio, player });
    this.connection = connection;
    this.audio = audio;
    this.session = session;
    const sendState = () => this.publish();
    const sendAudio = () => this.publish();
    const sendError = (event) => this.emit('error', event.detail || {});
    session.addEventListener('state', sendState);
    session.addEventListener('audio', sendAudio);
    session.addEventListener('error', sendError);
    this.sessionListeners = [['state', sendState], ['audio', sendAudio], ['error', sendError]];
    this.engine.audio.addEventListener('play', this.onAudioPlay);
    this.engine.audio.addEventListener('pause', this.onAudioPause);
    if (paused) await session.pause();
    session.open();
    return this.waitForInitialState();
  }

  async waitForInitialState(timeout = 12_000) {
    if (this.session?.getState?.()) return this.state();
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true; clearTimeout(timer);
        this.removeEventListener('state', changed);
        this.removeEventListener('error', failed);
        error ? reject(error) : resolve(this.state());
      };
      const changed = () => { if (this.session?.getState?.()) finish(); };
      const failed = (event) => {
        if ([401, 403, 404, 410].includes(Number(event.detail?.status))) finish(new Error(event.detail?.message || 'Could not join the room.'));
      };
      const timer = setTimeout(() => finish(new Error('The room did not send its state in time.')), timeout);
      this.addEventListener('state', changed);
      this.addEventListener('error', failed);
      changed();
    });
  }

  publish() {
    const current = this.state();
    const changed = ++this.sequence;
    this.send({ type: 'room-state', roomId: this.id, changed, room: current.state, audio: current.audio }).catch(() => {});
    this.emit('state', current);
  }

  async startTurn() {
    const before = this.engine.snapshot.track?.trackToken;
    const changedBefore = Number(this.engine.snapshot.changedAt) || 0;
    if (!this.engine.snapshot.station) throw new Error('Start a station in your player before your DJ turn.');
    await this.engine.skip();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const state = this.engine.snapshot, token = state.track?.trackToken;
      if (token && (token !== before || state.changedAt > changedBefore) && state.status === 'playing' && !this.engine.audio.paused) {
        const metadata = trackMetadata(state.track, state.duration);
        if (metadata) return { track_metadata: metadata };
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error('The player did not start a new song for your DJ turn.');
  }

  async command(body) {
    if (!this.session || !this.connection) throw new Error('Join the room first.');
    const command = validRoomCommand(body);
    const state = await this.session.command(command);
    if (command.action === 'leave' || command.action === 'close') await this.leave({ leave: false });
    return state;
  }

  async audioCommand(action, value) {
    if (!this.session || !this.audio) throw new Error('Join the room first.');
    if (action === 'listen') await this.audio.listen();
    else if (action === 'pause') await this.session.pause();
    else if (action === 'resume') await this.session.resume();
    else if (action === 'skip') await this.session.skip();
    else if (action === 'volume' && Number.isFinite(value) && value >= 0 && value <= 100) this.session.setVolume(value);
    else throw new Error('Unknown room audio action.');
    this.publish();
    return this.state();
  }

  setScrobbling(value) { this.scrobbling = value !== false; }

  async leave({ leave = true } = {}) {
    const session = this.session;
    if (!session) { this.id = ''; return this.state(); }
    this.session = null;
    this.id = '';
    for (const [type, fn] of this.sessionListeners || []) session.removeEventListener(type, fn);
    this.sessionListeners = [];
    this.engine.audio.removeEventListener('play', this.onAudioPlay);
    this.engine.audio.removeEventListener('pause', this.onAudioPause);
    try { session.close({ leave }); } finally {
      this.connection = null; this.audio = null; this.media = null;
      this.emit('state', this.state());
    }
    return this.state();
  }
}

export { trackMetadata as roomTrackMetadata, validRoomCommand };
