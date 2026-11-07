// melodica-web UI. No framework, no bundler, no external resources.
// Protocol: ./piano.js (melodica.h in wasm). Audio: the <audio> element.

import { PianoClient, PianoError, resolveApiBase } from './piano.js';
import { BridgeTransport } from './bridge.js';
import { GithubGate } from './gate.js';

const VERSION = '__MELODICA_WEB_VERSION__';
const STORAGE = {
  email: 'melodica.email',
  password: 'melodica.password',
  volume: 'melodica.volume',
  quality: 'melodica.quality',
  station: 'melodica.station',
  shortcuts: 'melodica.shortcuts',
};
// localStorage may throw (blocked cookies, sandboxed frame): degrade to session-only settings.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* unavailable */ } },
  remove(k) { try { localStorage.removeItem(k); } catch (_) { /* unavailable */ } },
};
const HISTORY_MAX = 20;
const UP_NEXT_MAX = 4;
const IDLE_TITLE = 'melodica — Pandora in the browser';
const RATING_WORD = { 1: 'loved', 2: 'banned', 3: 'tired' };
const QUALITIES = ['high', 'medium', 'low'];

// Pandora hands out album-art links with an http:// scheme; the page is https and its
// CSP only allows https images, so upgrade them (the image hosts all serve https).
function artUrl(song) {
  const u = (song && song.coverArt) || '';
  // Only on an https page: a plain-http page (local dev, the CI smoke) can load http art as is.
  return location.protocol === 'https:' ? u.replace(/^http:\/\//i, 'https://') : u;
}

// Fallback cover: a gold record on ink, used whenever Pandora sends no art.
const FALLBACK_COVER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">' +
  '<rect width="120" height="120" fill="#111622"/>' +
  '<g fill="none" stroke="#d8b26a" stroke-width="1.2">' +
  '<circle cx="60" cy="60" r="50"/><circle cx="60" cy="60" r="38" stroke-opacity="0.6"/><circle cx="60" cy="60" r="26" stroke-opacity="0.4"/>' +
  '</g><circle cx="60" cy="60" r="7" fill="#f0d9a4"/></svg>');

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), status: $('status'),
  viewLogin: $('view-login'), viewPlayer: $('view-player'), viewError: $('view-error'),
  viewGithub: $('view-github'), githubButton: $('github-button'), githubMessage: $('github-message'),
  githubDenied: $('github-denied'), githubDeniedText: $('github-denied-text'), githubSignout: $('github-signout'),
  githubLine: $('github-line'), githubLogin: $('github-login'), githubSignout2: $('github-signout-2'),
  loginForm: $('login-form'), email: $('login-email'), password: $('login-password'),
  remember: $('login-remember'), rememberWarning: $('remember-warning'),
  loginButton: $('login-button'), loginMessage: $('login-message'), fatal: $('fatal-message'),
  stationList: $('station-list'), stationFilter: $('station-filter'), stationEmpty: $('station-empty'),
  stationCount: $('station-count'),
  stationsOpen: $('stations-open'), stationsSheet: $('stations-sheet'), stationsClose: $('stations-close'),
  refreshStations: $('refresh-stations'), logout: $('logout'),
  account: $('account'), signedIn: $('signed-in'), signedInFull: $('signed-in-full'),
  searchForm: $('search-form'), searchInput: $('search-input'), searchResults: $('search-results'),
  stage: document.querySelector('.stage'), wash: $('wash'),
  cover: $('cover'), title: $('np-title'), artist: $('np-artist'), album: $('np-album'), station: $('np-station'),
  hint: $('np-hint'), qualityChip: $('np-quality'), miniTitle: $('mini-title'), miniArtist: $('mini-artist'),
  timeCur: $('time-cur'), timeLen: $('time-len'), progress: $('progress'),
  play: $('btn-play'), next: $('btn-next'), love: $('btn-love'), ban: $('btn-ban'),
  tired: $('btn-tired'), explain: $('btn-explain'),
  volume: $('volume'), quality: $('quality'), playerMessage: $('player-message'),
  explainPanel: $('explain-panel'), explainText: $('explain-text'), explainClose: $('explain-close'),
  upNext: $('up-next'), upNextEmpty: $('up-next-empty'), upNextCount: $('up-next-count'),
  history: $('history'), historyEmpty: $('history-empty'),
  shortcuts: $('shortcuts'), shortcutsOpen: $('shortcuts-open'), shortcutsClose: $('shortcuts-close'),
  shortcutsEnabled: $('shortcuts-enabled'),
  confirm: $('confirm'), confirmText: $('confirm-text'),
  audio: $('audio'),
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Stored settings are validated: a stray value must never leave the volume NaN
// or send an unknown quality to the relay.
function readVolume() {
  const raw = store.get(STORAGE.volume);
  if (raw === null || raw.trim() === '') return 80;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(Math.round(n), 0, 100) : 80;
}
function readQuality() {
  const q = store.get(STORAGE.quality);
  return QUALITIES.includes(q) ? q : 'high';
}
const lowerQuality = (q) => QUALITIES[Math.min(QUALITIES.indexOf(q) + 1, QUALITIES.length - 1)];

const state = {
  client: null,
  bridge: null,       // BridgeTransport when the page may use the extension bridge
  gate: null,         // GithubGate (GitHub sign-in gate)
  remote: false,      // true when the melodica extension plays and this page is its view
  remoteState: null,  // last state pushed by the extension
  gateStatus: null,   // last GithubGate.check() result
  apiBase: '',
  apiFromQuery: false,
  stations: [],
  station: null,      // current station object
  queue: [],          // songs not yet played
  song: null,         // now playing
  history: [],        // songs heard this session, newest first
  quality: readQuality(),
  volume: readVolume(),
  shortcutsOn: store.get(STORAGE.shortcuts) !== '0', // single-key shortcuts (WCAG 2.1.4: can be turned off)
  explaining: false,
  playGen: 0,         // bumped when the station/queue context changes; stale playlist fetches are dropped
  fetching: null,     // playGen of the playlist request in flight, or null
  consecutiveAudioErrors: 0,
  keepMessage: false, // a skip reason should outlive the next song change
};

// ---------------------------------------------------------------- helpers

function show(view) {
  for (const v of [el.viewGithub, el.viewLogin, el.viewPlayer, el.viewError]) v.hidden = v !== view;
  el.app.dataset.view = view.id.replace('view-', '');
  el.account.hidden = view !== el.viewPlayer;
  el.account.open = false;
  el.stationsOpen.hidden = view !== el.viewPlayer;
  if (view !== el.viewPlayer) closeStations();
}

// The stations sheet (<dialog class="drawer">), opened from the header button,
// the s and / keys, or automatically when the player has nothing to play yet.
function openStations(focus = 'list') {
  if (el.viewPlayer.hidden) return;
  if (!el.stationsSheet.open) {
    if (typeof el.stationsSheet.showModal === 'function') el.stationsSheet.showModal();
    else el.stationsSheet.setAttribute('open', '');
  }
  el.stationsOpen.setAttribute('aria-expanded', 'true');
  if (focus === 'filter') { el.stationFilter.focus(); el.stationFilter.select(); }
  else (visibleStationButton() || el.stationFilter).focus();
}
function closeStations() {
  if (el.stationsSheet.open) {
    if (typeof el.stationsSheet.close === 'function') el.stationsSheet.close();
    else el.stationsSheet.removeAttribute('open');
  }
  el.stationsOpen.setAttribute('aria-expanded', 'false');
}

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle('error', isError);
}

// "direct via melodica extension 0.1.0" or "via spacegho.st relay", then the
// module and page versions once the wasm is up.
function extensionName() {
  const b = state.bridge;
  return `${(b.name || 'melodica extension').replace(/^melodica-extension$/, 'melodica extension')} ${b.version || ''}`.trim();
}
function transportLabel() {
  if (state.remote) return `playing in ${extensionName()}`;
  if (state.bridge && state.bridge.active) return `direct via ${state.bridge.label}`;
  let host = state.apiBase;
  try { host = new URL(state.apiBase).host; } catch (_) { /* keep the raw string */ }
  return `via ${host} relay${state.apiFromQuery ? ' (?api=)' : ''}`;
}
function updateStatus() {
  const mod = state.remote ? `web ${VERSION}`
    : state.client && state.client.version ? `melodica.h ${state.client.version} · web ${VERSION}` : 'loading melodica.h…';
  setStatus(`${transportLabel()} · ${mod}`);
}

// One timer per message target so a login message never clears a toast.
const messageTimers = new Map();
function message(target, text, kind = 'info', ttl = 8000) {
  target.textContent = text || '';
  target.className = `${target === el.playerMessage ? 'toast' : 'message'} ${text ? kind : ''}`.trim();
  clearTimeout(messageTimers.get(target));
  if (text && ttl) {
    messageTimers.set(target, setTimeout(() => { if (target.textContent === text) message(target, ''); }, ttl));
  }
}
const playerMessage = (t, k, ttl) => message(el.playerMessage, t, k, ttl);
const loginMessage = (t, k) => message(el.loginMessage, t, k, 0);

function describeError(err) {
  return err && err.message ? err.message : String(err);
}

function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// Relay precedence: a trusted ?api= in the page URL (it also disables the
// extension bridge), else data-api on the script tag, else ../api/.
function apiBaseFromPage() {
  const params = new URLSearchParams(location.search);
  const tag = document.querySelector('script[type="module"][src$="app.js"]');
  let explicit = params.get('api') || '';
  // A crafted link must not route credentials elsewhere: ?api= is honoured only
  // for the page's own origin (or on a local dev host).
  if (explicit && !trustedApiParam(explicit)) explicit = '';
  const fromQuery = !!explicit;
  if (!explicit) explicit = (tag && tag.dataset.api) || '';
  return { apiBase: resolveApiBase(explicit, location.href), fromQuery };
}
function trustedApiParam(value) {
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return true;
  try { return new URL(value, location.href).origin === location.origin; } catch (_) { return false; }
}

// The play-log rating buttons reuse the transport bar's icons.
const cloneIcon = (button) => button.querySelector('svg').cloneNode(true);

function lastStation() {
  return state.station
    || state.stations.find((s) => s.id === store.get(STORAGE.station))
    || state.stations[0]
    || null;
}

// Dialogs: a click on the ::backdrop (outside the sheet's box) closes them;
// a click in the sheet's own padding does not.
function closeOnBackdrop(dialog, close) {
  dialog.addEventListener('click', (ev) => {
    if (ev.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) close();
  });
}

// In-app confirmation sheet; falls back to window.confirm where <dialog> is unsupported.
function confirmDialog(text) {
  if (typeof el.confirm.showModal !== 'function') return Promise.resolve(window.confirm(text));
  return new Promise((resolve) => {
    el.confirmText.textContent = text;
    el.confirm.returnValue = '';
    const onClose = () => { el.confirm.removeEventListener('close', onClose); resolve(el.confirm.returnValue === 'yes'); };
    el.confirm.addEventListener('close', onClose);
    el.confirm.showModal();
  });
}

// ---------------------------------------------------------------- stations

// Rebuild the list (after load/create/delete). Moving the highlight alone is
// markActiveStation(), so a station click never destroys focus or scroll.
function buildStations() {
  el.stationList.replaceChildren();
  const sorted = [...state.stations].sort((a, b) => {
    if (a.isQuickMix !== b.isQuickMix) return a.isQuickMix ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
  });
  for (const st of sorted) {
    const name = st.name || ''; // the wasm reply emits null for a missing C string
    const li = document.createElement('li');
    li.dataset.id = st.id;
    li.dataset.name = name.toLowerCase();
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'station';
    b.textContent = name;
    b.title = name;
    b.addEventListener('click', () => playStation(st));
    li.append(b);
    if (!st.isQuickMix && !state.remote) {
      const d = document.createElement('button');
      d.type = 'button';
      d.className = 'delete';
      d.title = `Delete station "${st.name}"`;
      d.setAttribute('aria-label', `Delete station ${st.name}`);
      d.textContent = '×';
      d.addEventListener('click', (ev) => { ev.stopPropagation(); deleteStation(st); });
      li.append(d);
    }
    el.stationList.append(li);
  }
  markActiveStation();
  filterStations();
  updateHint();
}

function markActiveStation() {
  const prev = el.stationList.querySelector('li.active');
  const next = state.station ? el.stationList.querySelector(`li[data-id="${CSS.escape(String(state.station.id))}"]`) : null;
  if (prev && prev !== next) {
    prev.classList.remove('active');
    prev.querySelector('button.station').removeAttribute('aria-current');
  }
  if (next) {
    next.classList.add('active');
    next.querySelector('button.station').setAttribute('aria-current', 'true');
  }
}

function filterStations() {
  const q = el.stationFilter.value.trim().toLowerCase();
  let shown = 0;
  for (const li of el.stationList.children) {
    const hit = !q || (li.dataset.name || '').includes(q);
    li.hidden = !hit;
    if (hit) shown += 1;
  }
  const total = el.stationList.children.length;
  el.stationEmpty.hidden = shown > 0 || total === 0;
  el.stationCount.textContent = total ? (q ? `${shown} of ${total}` : String(total)) : '';
}

function visibleStationButton() {
  return el.stationList.querySelector('li.active:not([hidden]) button.station')
    || el.stationList.querySelector('li:not([hidden]) button.station');
}

async function loadStations() {
  state.stations = await state.client.stations();
  buildStations();
}

async function deleteStation(st) {
  if (!(await confirmDialog(`Delete the station "${st.name}" from your Pandora account?`))) return;
  try {
    state.stations = await state.client.deleteStation(st.id);
    if (state.station && state.station.id === st.id) stopPlayback('Station deleted.');
    buildStations();
    // The delete button that opened the dialog is gone; keep keyboard focus in the rail.
    (visibleStationButton() || el.stationFilter).focus();
  } catch (err) {
    playerMessage(describeError(err), 'error');
  }
}

// ---------------------------------------------------------------- now playing display

function setCover(url) {
  el.cover.src = url || FALLBACK_COVER;
  el.wash.src = url || 'data:,';
  if (url) el.cover.addEventListener('error', () => { el.cover.src = FALLBACK_COVER; el.wash.src = 'data:,'; }, { once: true });
}

function setPlayIcon(playing) {
  el.play.dataset.state = playing ? 'playing' : 'paused';
  el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

// Progress row: only touch the DOM when the displayed value changes.
let lastLen = -1;
function setProgress(cur, len) {
  const curText = fmtTime(cur);
  const lenChanged = len !== lastLen;
  if (lenChanged) {
    lastLen = len;
    el.progress.max = len || 1;
    el.timeLen.textContent = fmtTime(len);
  }
  el.progress.value = cur;
  if (lenChanged || curText !== el.timeCur.textContent) {
    el.timeCur.textContent = curText;
    el.progress.setAttribute('aria-valuetext', `${curText} of ${fmtTime(len)}`);
  }
}

function showIdle() {
  el.stage.classList.add('idle');
  el.title.textContent = 'Pick a station';
  el.artist.textContent = el.album.textContent = el.station.textContent = '';
  el.miniTitle.textContent = el.miniArtist.textContent = '';
  el.qualityChip.hidden = true;
  el.cover.alt = '';
  setCover('');
  lastLen = -1;
  setProgress(0, 0);
  el.explainPanel.hidden = true;
  updateHint();
  document.title = IDLE_TITLE;
}

// Idle hint under the title: names the next action (and the station space resumes).
function updateHint() {
  if (state.song) { el.hint.textContent = ''; return; }
  const last = lastStation();
  el.hint.textContent = last
    ? `Press play to resume ${last.name}, or choose a station from the list.`
    : 'Choose a station from the list to start listening.';
}

// The chip names the quality the playing song was fetched at, not the current setting.
function updateQualityChip() {
  const song = state.song;
  if (!song) { el.qualityChip.hidden = true; return; }
  const q = song.quality || state.quality;
  const fmt = song.audioFormat ? String(song.audioFormat).replace(/_/g, ' ') : '';
  el.qualityChip.textContent = fmt ? `${q} · ${fmt}` : q;
  el.qualityChip.hidden = false;
}

let renderUpNext = function renderUpNext() {
  el.upNext.replaceChildren();
  const peek = state.queue.slice(0, UP_NEXT_MAX);
  for (const s of peek) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = s.title || '';
    t.title = s.title || '';
    const a = document.createElement('span');
    a.className = 'a';
    a.textContent = s.artist || '';
    li.append(t, a);
    el.upNext.append(li);
  }
  const more = state.queue.length - peek.length;
  el.upNextCount.textContent = more > 0 ? `+${more} more` : '';
  el.upNextEmpty.hidden = peek.length > 0;
  if (peek.length === 0) {
    el.upNextEmpty.textContent = state.song
      ? 'Last song of this playlist; Pandora sends more when it ends.'
      : 'Nothing queued yet.';
  }
};

function ratingClasses(button, kind, rating) {
  button.classList.toggle('on', kind === 'love' && rating === 1);
  button.classList.toggle('off', kind === 'ban' && rating === 2);
  button.setAttribute('aria-pressed', String(kind === 'love' ? rating === 1 : rating === 2));
}

function historyRatingText(song) {
  return song === state.song ? 'now playing' : (RATING_WORD[song.rating] || '');
}

function renderHistory() {
  el.history.replaceChildren();
  for (const song of state.history) {
    const li = document.createElement('li');
    li.className = 'hist';
    li.dataset.rating = String(song.rating || 0);
    li.dataset.token = song.trackToken || '';
    if (song === state.song) li.classList.add('now');
    const img = document.createElement('img');
    img.className = 'hist-cover';
    img.alt = '';
    img.loading = 'lazy';
    img.src = artUrl(song) || FALLBACK_COVER;
    img.addEventListener('error', () => { img.src = FALLBACK_COVER; }, { once: true });
    const meta = document.createElement('div');
    meta.className = 'hist-meta';
    const t = document.createElement('span');
    t.className = 'hist-title';
    t.textContent = song.title || '';
    t.title = song.title || '';
    const a = document.createElement('span');
    a.className = 'hist-artist';
    a.textContent = song.artist || '';
    const r = document.createElement('span');
    r.className = 'hist-rating';
    r.textContent = historyRatingText(song);
    meta.append(t, a, r);
    const rate = document.createElement('div');
    rate.className = 'hist-rate';
    for (const kind of ['love', 'ban']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = kind;
      b.setAttribute('aria-label', `${kind === 'love' ? 'Love' : 'Ban'} ${song.title || 'this song'}`);
      b.append(cloneIcon(kind === 'love' ? el.love : el.ban));
      ratingClasses(b, kind, song.rating);
      b.addEventListener('click', () => rateSong(song, kind));
      rate.append(b);
    }
    li.append(img, meta, rate);
    el.history.append(li);
  }
  el.historyEmpty.hidden = state.history.length > 0;
}

// Refresh one play-log row in place so a rating keeps focus on its button.
function updateHistoryItem(song) {
  if (!song || !song.trackToken) { renderHistory(); return; }
  const li = el.history.querySelector(`li[data-token="${CSS.escape(song.trackToken)}"]`);
  if (!li) return;
  li.dataset.rating = String(song.rating || 0);
  li.querySelector('.hist-rating').textContent = historyRatingText(song);
  for (const b of li.querySelectorAll('.hist-rate button')) {
    ratingClasses(b, b.classList.contains('love') ? 'love' : 'ban', song.rating);
  }
}

function rememberSong(song) {
  state.history = [song, ...state.history.filter((s) => s !== song)].slice(0, HISTORY_MAX);
  renderHistory();
}

// ---------------------------------------------------------------- playback

function stopPlayback(reason) {
  el.audio.pause();
  el.audio.removeAttribute('src');
  el.audio.load();
  state.playGen += 1;
  state.song = null;
  state.queue = [];
  state.station = null;
  state.keepMessage = false;
  showIdle();
  updateRatingButtons();
  markActiveStation();
  renderUpNext();
  renderHistory();
  if (reason) playerMessage(reason);
}

async function playStation(st) {
  closeStations();
  if (state.remote) {
    playerMessage(`Loading ${st.name}…`, 'info', 0);
    await remoteCommand('play', { station: { token: st.id, name: st.name } });
    return;
  }
  state.station = st;
  state.queue = [];
  state.playGen += 1;
  state.consecutiveAudioErrors = 0;
  state.keepMessage = false;
  store.set(STORAGE.station, st.id);
  markActiveStation();
  renderUpNext();
  playerMessage(`Loading ${st.name}…`, 'info', 0);
  await nextSong();
}

// Resolves to the playable songs, or null when the request was superseded
// (station switched, stopped, quality changed) or one is already in flight.
async function fetchPlaylist() {
  const station = state.station;
  const gen = state.playGen;
  if (!station) return null;
  if (state.fetching === gen) return null; // let the first request finish
  state.fetching = gen;
  let quality = state.quality;
  try {
    let songs;
    try {
      try {
        songs = await state.client.playlist(station.id, quality);
      } catch (err) {
        if (state.playGen !== gen) return null; // superseded: neither retry nor touch the setting
        if (!(err instanceof PianoError && err.status === 6 && quality !== 'low')) throw err;
        // Quality unavailable for this station: step down and retry once.
        quality = lowerQuality(quality);
        setQuality(quality);
        playerMessage(`Quality not available; using ${quality}.`);
        songs = await state.client.playlist(station.id, quality);
      }
    } catch (err) {
      if (state.playGen !== gen) return null; // nobody is waiting for this answer
      throw err;
    }
    if (state.playGen !== gen) return null;
    return (songs || []).filter((s) => s && s.audioUrl).map((s) => (s.quality = quality, s));
  } finally {
    if (state.fetching === gen) state.fetching = null;
  }
}

async function nextSong() {
  if (!state.station) return;
  const gen = state.playGen;
  try {
    if (state.queue.length === 0) {
      const songs = await fetchPlaylist();
      if (songs === null) return;
      state.queue = songs;
      if (songs.length === 0) {
        playerMessage('Pandora returned no playable songs for this station.', 'error');
        renderUpNext();
        return;
      }
    }
    if (state.playGen !== gen) return;
    const song = state.queue.shift();
    playSong(song);
    renderUpNext();
  } catch (err) {
    if (err instanceof PianoError && err.badCredentials) {
      stopPlayback();
      showLogin();
      loginMessage(describeError(err), 'error');
    } else {
      playerMessage(describeError(err), 'error', 0);
    }
  } finally {
    state.keepMessage = false; // consumed by playSong, or moot after a failure
  }
}

function applyVolume() {
  // User volume scaled by the track's replay gain, like pianobar does.
  const gain = state.song ? Math.pow(10, (state.song.fileGain || 0) / 20) : 1;
  el.audio.volume = clamp((state.volume / 100) * Math.min(1, gain), 0, 1);
}

function playSong(song) {
  displaySong(song);
  applyVolume();
  el.audio.src = song.audioUrl;
  const p = el.audio.play();
  if (p && p.catch) {
    p.catch((err) => {
      if (err && err.name === 'NotAllowedError') {
        playerMessage('Press play to start (the browser blocks autoplay).', 'info', 0);
        setPlayIcon(false);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      }
    });
  }
  updateMediaSession(song);
}

// Everything about a new song except playing it (shared with remote mode).
function displaySong(song) {
  state.song = song;
  el.stage.classList.remove('idle');
  el.title.textContent = song.title || '';
  el.artist.textContent = song.artist || '';
  el.album.textContent = song.album || '';
  el.station.textContent = state.station ? `on ${state.station.name}` : '';
  el.miniTitle.textContent = song.title || '';
  el.miniArtist.textContent = song.artist || '';
  setCover(artUrl(song));
  el.cover.alt = song.coverArt && song.album ? `Cover of ${song.album}` : '';
  lastLen = -1;
  setProgress(0, song.duration || 0);
  el.explainPanel.hidden = true;
  updateHint();
  updateQualityChip();
  updateRatingButtons();
  rememberSong(song);
  if (state.keepMessage) state.keepMessage = false;
  else playerMessage('');
  const label = [song.title, song.artist].filter(Boolean).join(' – ');
  document.title = label ? `${label} · melodica` : IDLE_TITLE;
}

function updateRatingButtons() {
  const r = state.song ? state.song.rating : 0;
  el.love.classList.toggle('on', r === 1);
  el.ban.classList.toggle('off', r === 2);
  el.tired.classList.toggle('off', r === 3);
  el.love.setAttribute('aria-pressed', String(r === 1));
  el.ban.setAttribute('aria-pressed', String(r === 2));
  const has = !!state.song;
  for (const b of [el.next, el.love, el.ban, el.tired, el.explain]) b.disabled = !has;
}

function skip(reason) {
  if (state.remote) { remoteCommand('next'); return; }
  if (reason) { playerMessage(reason); state.keepMessage = true; }
  el.audio.pause();
  nextSong();
}

// Rate the current song (ban skips) or any song from the play log via its trackToken.
async function rateSong(song, kind) {
  if (!song) return;
  if (state.remote) {
    if (song !== state.song) { playerMessage('Only the playing song can be rated while the extension plays.'); return; }
    const r = await remoteCommand(kind);
    if (r && r.ok) playerMessage(kind === 'ban' ? 'Banned. Skipping.' : 'Loved.');
    return;
  }
  try {
    const r = await state.client.rate(song, kind);
    song.rating = r.rating;
    updateHistoryItem(song);
    if (song === state.song) {
      updateRatingButtons();
      if (kind === 'ban') skip('Banned. Skipping.');
      else playerMessage('Loved.');
    } else {
      playerMessage(kind === 'ban' ? `Banned ${song.title}.` : `Loved ${song.title}.`);
    }
  } catch (err) {
    playerMessage(describeError(err), 'error');
  }
}

function rate(kind) { return rateSong(state.song, kind); }

async function tired() {
  const song = state.song;
  if (!song) return;
  if (state.remote) {
    const r = await remoteCommand('tired');
    if (r && r.ok) playerMessage('Pandora will rest this song for a month.');
    return;
  }
  try {
    await state.client.tired(song);
    song.rating = 3;
    updateHistoryItem(song);
    skip('Pandora will rest this song for a month.');
  } catch (err) {
    playerMessage(describeError(err), 'error');
  }
}

async function explain() {
  const song = state.song;
  if (!song || state.explaining) return; // the e key bypasses the disabled button
  if (state.remote) { playerMessage('“Why this song?” is not available while the extension plays.'); return; }
  state.explaining = true;
  el.explain.disabled = true;
  el.explain.setAttribute('aria-busy', 'true');
  playerMessage('Asking Pandora…', 'info', 0);
  try {
    const text = await state.client.explain(song);
    if (state.song !== song) return; // stale answer for a song that has moved on
    el.explainText.textContent = text || 'Pandora gave no explanation for this song.';
    el.explainPanel.hidden = false;
    playerMessage('');
    // Move focus to the panel so assistive tech reads the answer.
    el.explainPanel.focus({ preventScroll: true });
    el.explainPanel.scrollIntoView({ block: 'nearest' });
  } catch (err) {
    if (state.song === song) playerMessage(describeError(err), 'error');
  } finally {
    state.explaining = false;
    el.explain.removeAttribute('aria-busy');
    el.explain.disabled = !state.song;
    if (el.playerMessage.textContent === 'Asking Pandora…') playerMessage('');
  }
}

function togglePlay() {
  if (state.remote) {
    const rs = state.remoteState || {};
    if (!state.song && !rs.station) {
      const st = lastStation();
      if (st) playStation(st);
      return;
    }
    remoteCommand('toggle');
    return;
  }
  if (!state.song) {
    const st = lastStation();
    if (st) playStation(st);
    return;
  }
  if (el.audio.paused) el.audio.play().catch(() => {});
  else el.audio.pause();
}

function setQuality(q) {
  state.quality = q;
  el.quality.value = q;
  store.set(STORAGE.quality, q);
}

// Volume applies immediately; the stored value is written once the slider settles.
let volumeSaveTimer = 0;
function saveVolume() {
  clearTimeout(volumeSaveTimer);
  store.set(STORAGE.volume, String(state.volume));
}
function setVolume(v) {
  state.volume = clamp(Math.round(v), 0, 100);
  el.volume.value = String(state.volume);
  applyVolume();
  clearTimeout(volumeSaveTimer);
  volumeSaveTimer = setTimeout(saveVolume, 400);
  if (state.remote) {
    remoteVolumeAt = Date.now();
    clearTimeout(remoteVolumeTimer);
    remoteVolumeTimer = setTimeout(() => remoteCommand('volume', { value: state.volume }), 150);
  }
}
let remoteVolumeTimer = 0;
let remoteVolumeAt = 0;   // the slider wins over pushed volume for a moment after the user moves it

// ---------------------------------------------------------------- media session

function updateMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title || '',
      artist: song.artist || '',
      album: song.album || '',
      artwork: artUrl(song) ? [{ src: artUrl(song) }] : [],
    });
    navigator.mediaSession.playbackState = 'playing';
  } catch (_) { /* ignore */ }
}

function installMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (_) { /* unsupported */ } };
  set('play', () => el.audio.play().catch(() => {}));
  set('pause', () => el.audio.pause());
  set('nexttrack', () => skip());
  set('previoustrack', null);
  set('stop', () => stopPlayback());
}

// ---------------------------------------------------------------- search

function renderSearch(results) {
  el.searchResults.replaceChildren();
  const items = [];
  for (const a of results.artists || []) {
    if (a && a.musicId) items.push({ kind: 'artist', label: a.name || 'Unnamed artist', token: a.musicId });
  }
  for (const s of results.songs || []) {
    if (s && s.musicId) items.push({ kind: 'song', label: [s.title, s.artist].filter(Boolean).join(' — ') || 'Untitled', token: s.musicId });
  }
  if (items.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No matches.';
    el.searchResults.append(li);
  }
  for (const it of items.slice(0, 30)) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.title = `Create a station from ${it.label}`;
    const k = document.createElement('span');
    k.className = 'kind';
    k.textContent = it.kind;
    b.append(k, document.createTextNode(it.label));
    b.addEventListener('click', () => createStation(it.token, it.label));
    li.append(b);
    el.searchResults.append(li);
  }
  el.searchResults.hidden = false;
  if (items.length) playerMessage(`${items.length} result${items.length === 1 ? '' : 's'}; pick one to create a station.`);
  else playerMessage(''); // the list already says "No matches."
}

async function createStation(token, label) {
  try {
    playerMessage(`Creating station from ${label}…`, 'info', 0);
    const before = new Set(state.stations.map((s) => s.id));
    state.stations = await state.client.createStation(token);
    el.searchResults.hidden = true;
    el.searchInput.value = '';
    buildStations();
    playerMessage('Station created.');
    // The clicked result is gone from the DOM: land focus on the new station.
    const created = state.stations.find((s) => !before.has(s.id));
    const btn = created ? el.stationList.querySelector(`li[data-id="${CSS.escape(String(created.id))}"] button.station`) : null;
    (btn || el.searchInput).focus();
  } catch (err) {
    playerMessage(describeError(err), 'error');
  }
}

// ---------------------------------------------------------------- remote mode
// The melodica extension (0.3.0+) plays in the background; this page becomes a view
// of that playback and a remote for it: same UI, driven by the state the extension
// pushes, controls send commands, no local <audio>. Without the extension, or with an
// older one that ignores subscribe, the page plays locally as before.

async function remoteCommand(action, fields = {}) {
  try {
    const r = await state.bridge.command(action, fields);
    if (r.state) renderRemote(r.state);
    if (!r.ok) playerMessage(r.error || `The extension could not ${action}.`, 'error');
    return r;
  } catch (err) {
    playerMessage(describeError(err), 'error');
    return null;
  }
}

// Wait up to `ms` for the bridge's ready, then subscribe; resolves with the first
// pushed state, or null (no extension, or one without remote control).
async function probeRemote(bridge, ms = 1000) {
  const until = Date.now() + ms;
  while (!bridge.active && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  if (!bridge.active) return null;
  return bridge.subscribe((st) => { if (state.remote) renderRemote(st); });
}

function remoteSong(t) {
  return {
    title: t.title || '', artist: t.artist || '', album: t.album || '', coverArt: t.coverArt || '',
    trackToken: t.trackToken || '', rating: t.rating || 0, duration: t.duration || 0,
    quality: t.quality || '', audioFormat: t.audioFormat || '',
  };
}

let remoteStationsKey = '';
function renderRemote(rs) {
  state.remoteState = rs;
  // Stations: rebuilt only when the list itself changed (keeps focus and scroll).
  const stations = (Array.isArray(rs.stations) ? rs.stations : []).filter((s) => s && s.token)
    .map((s) => ({ id: s.token, name: s.name || '', isQuickMix: !!s.isQuickMix }));
  const key = JSON.stringify(stations);
  if (key !== remoteStationsKey) {
    remoteStationsKey = key;
    state.stations = stations;
    buildStations();
  }
  const cur = rs.station && rs.station.token ? rs.station : null;
  state.station = cur ? (state.stations.find((s) => s.id === cur.token) || { id: cur.token, name: cur.name || '' }) : null;
  if (cur) store.set(STORAGE.station, cur.token);
  markActiveStation();

  // Now playing.
  const t = rs.track && (rs.track.title || rs.track.trackToken) ? rs.track : null;
  if (t) {
    if (!state.song || state.song.trackToken !== (t.trackToken || '') || state.song.title !== (t.title || '')) {
      const known = state.history.find((s) => s.trackToken && s.trackToken === t.trackToken);
      displaySong(known ? Object.assign(known, remoteSong(t)) : remoteSong(t));
    } else if (state.song.rating !== (t.rating || 0)) {
      state.song.rating = t.rating || 0;
      updateRatingButtons();
      updateHistoryItem(state.song);
    }
    el.station.textContent = state.station ? `on ${state.station.name}` : '';
  } else if (state.song) {
    state.song = null;
    showIdle();
    updateRatingButtons();
    renderHistory();
  }
  setPlayIcon(rs.status === 'playing');
  const len = Number(rs.duration) || (t && Number(t.duration)) || 0;
  setProgress(Number(rs.position) || 0, len);

  // Settings the extension owns.
  if (Number.isFinite(Number(rs.volume)) && Date.now() - remoteVolumeAt > 1500) {
    state.volume = clamp(Math.round(Number(rs.volume)), 0, 100);
    el.volume.value = String(state.volume);
  }
  if (QUALITIES.includes(rs.quality)) { state.quality = rs.quality; el.quality.value = rs.quality; }

  // Up next: the extension only says how many songs are queued.
  el.upNext.replaceChildren();
  const n = Number(rs.queueLength) || 0;
  el.upNextCount.textContent = '';
  el.upNextEmpty.hidden = false;
  el.upNextEmpty.textContent = n ? `${n} song${n === 1 ? '' : 's'} queued in the extension.` : 'Nothing queued yet.';

  // Why nothing can play yet, in the extension's own terms.
  const gateMode = rs.gate && rs.gate.mode;
  if (rs.loggedIn === false || (gateMode && gateMode !== 'allowed' && gateMode !== 'off')) {
    el.hint.textContent = gateMode && gateMode !== 'allowed' && gateMode !== 'off'
      ? 'Sign in with GitHub in the melodica extension, then come back.'
      : 'Sign in to Pandora in the melodica extension, then come back.';
  } else if (!state.song) {
    updateHint();
  }
  if (rs.status === 'error' && rs.error) playerMessage(rs.error, 'error', 0);
  else if (rs.status === 'loading') playerMessage('Loading…', 'info', 0);
  else if (el.playerMessage.textContent === 'Loading…' || /^Loading .*…$/.test(el.playerMessage.textContent)) playerMessage('');
  const who = rs.gate && rs.gate.login ? `the melodica extension (${rs.gate.login})` : 'the melodica extension';
  el.signedIn.textContent = 'melodica extension';
  el.signedInFull.textContent = who;
}

function enterRemote(first) {
  state.remote = true;
  el.app.dataset.mode = 'remote';
  el.audio.pause();
  el.audio.removeAttribute('src');
  el.searchForm.hidden = true;
  el.searchResults.hidden = true;
  el.logout.hidden = true;
  renderRemote(first);
  show(el.viewPlayer);
  renderUpNext = () => {}; // the queue panel shows the extension's count (renderRemote)
  updateStatus();
  addEventListener('pagehide', () => state.bridge && state.bridge.unsubscribe());
  if (!state.song && state.stations.length) openStations();
  else el.play.focus();
}

// ---------------------------------------------------------------- GitHub gate

// Where GitHub sends the browser back: the hosted app's address (the Worker accepts
// exactly https://spacegho.st/melodica/app/, so a self-host needs its own Worker).
const RETURN_TO = location.origin + '/melodica/app/';

// The GitHub sign-in screen. `gate` is a GithubGate.check() result; `note` is an extra
// line (a relay 401's own message, or a GitHub-side error code).
function showGithub(gate, note = '') {
  el.audio.pause();
  playerMessage('');
  show(el.viewGithub);
  const denied = gate && gate.status === 'denied' && gate.login;
  el.githubDenied.hidden = !denied;
  el.githubButton.hidden = !!denied;
  if (denied) {
    el.githubDeniedText.textContent = `melodica is not available for your GitHub account (${gate.login}).`;
  } else {
    el.githubDeniedText.textContent = '';
    el.githubButton.href = state.gate ? state.gate.startUrl(RETURN_TO) : '#';
  }
  message(el.githubMessage, note, note ? 'error' : 'info', 0);
  (denied ? el.githubSignout : el.githubButton).focus();
}

// A relay 401 (token missing or not allowed): back to the GitHub screen with the relay's message.
let routing = null;
function onUnauthorized(err) {
  if (routing) return;
  stopPlayback();
  state.client.credentials = null;
  routing = (state.gate ? state.gate.check() : Promise.resolve({ status: 'anonymous' }))
    .then((gate) => {
      state.gateStatus = gate;
      state.client.authToken = state.gate ? state.gate.token : '';
      showGithub(gate, describeError(err));
    })
    .finally(() => { routing = null; });
}

async function githubSignOut() {
  if (!state.gate) return;
  await state.gate.signOut();
  state.client.authToken = '';
  state.gateStatus = { status: 'anonymous', token: '', login: '', allowed: false };
  stopPlayback();
  state.client.logout();
  showGithub(state.gateStatus);
}

// The small "GitHub: <login> · sign out" line on the Pandora login card.
function updateGithubLine() {
  const g = state.gateStatus;
  const signedIn = !!(g && g.login && (g.status === 'allowed' || g.status === 'denied'));
  el.githubLine.hidden = !signedIn;
  el.githubLogin.textContent = signedIn ? g.login : '';
}

// ---------------------------------------------------------------- login

function showLogin() {
  el.audio.pause();
  playerMessage('');
  show(el.viewLogin);
  updateGithubLine();
  el.email.value = store.get(STORAGE.email) || '';
  const saved = store.get(STORAGE.password);
  el.password.value = saved || '';
  el.remember.checked = !!saved;
  el.rememberWarning.hidden = !el.remember.checked;
  (el.email.value ? el.password : el.email).focus();
}

async function login(email, password) {
  el.loginButton.disabled = true;
  loginMessage('Signing in…', 'info');
  try {
    await state.client.login(email, password);
    if (store.get(STORAGE.email) !== email) {
      // A different account: its predecessor's play log (and rate tokens) must not carry over.
      state.history = [];
      renderHistory();
    }
    store.set(STORAGE.email, email);
    if (el.remember.checked) store.set(STORAGE.password, password);
    else store.remove(STORAGE.password);
    loginMessage('');
    el.signedIn.textContent = email;
    el.signedInFull.textContent = email;
    await loadStations();
    show(el.viewPlayer);
    updateHint();
    renderUpNext();
    if (!state.song && state.stations.length) openStations();
  } catch (err) {
    loginMessage(describeError(err), 'error');
  } finally {
    el.loginButton.disabled = false;
  }
}

function logout() {
  stopPlayback();
  state.client.logout();
  store.remove(STORAGE.password);
  state.history = [];
  renderHistory();
  // Nothing from this account may carry into the next one's session.
  el.searchResults.replaceChildren();
  el.searchResults.hidden = true;
  el.searchInput.value = '';
  el.stationFilter.value = '';
  filterStations();
  showLogin();
}

// ---------------------------------------------------------------- shortcuts sheet

let shortcutsFromMenu = false;
function openShortcuts(fromMenu = false) {
  shortcutsFromMenu = fromMenu && el.account.open;
  el.account.open = false;
  if (typeof el.shortcuts.showModal === 'function') {
    if (!el.shortcuts.open) el.shortcuts.showModal();
  } else {
    el.shortcuts.setAttribute('open', '');
  }
}
function closeShortcuts() {
  if (typeof el.shortcuts.close === 'function') el.shortcuts.close();
  else el.shortcuts.removeAttribute('open');
}

// ---------------------------------------------------------------- wiring

function installEvents() {
  el.loginForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    login(el.email.value.trim(), el.password.value);
  });
  el.remember.addEventListener('change', () => { el.rememberWarning.hidden = !el.remember.checked; });
  el.shortcutsEnabled.checked = state.shortcutsOn;
  el.shortcutsEnabled.addEventListener('change', () => {
    state.shortcutsOn = el.shortcutsEnabled.checked;
    store.set(STORAGE.shortcuts, state.shortcutsOn ? '1' : '0');
  });
  el.logout.addEventListener('click', logout);
  el.stationsOpen.addEventListener('click', () => openStations());
  el.stationsClose.addEventListener('click', () => { closeStations(); el.stationsOpen.focus(); });
  el.stationsSheet.addEventListener('close', () => el.stationsOpen.setAttribute('aria-expanded', 'false'));
  closeOnBackdrop(el.stationsSheet, closeStations);
  el.githubSignout.addEventListener('click', githubSignOut);
  el.githubSignout2.addEventListener('click', githubSignOut);
  el.refreshStations.addEventListener('click', () => {
    if (state.remote) { remoteCommand('stations'); return; }
    loadStations().catch((e) => playerMessage(describeError(e), 'error'));
  });
  el.stationFilter.addEventListener('input', filterStations);
  el.stationFilter.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const first = el.stationList.querySelector('li:not([hidden]) button.station');
      if (first) first.click();
    } else if (ev.key === 'Escape' && el.stationFilter.value) {
      ev.preventDefault();
      el.stationFilter.value = '';
      filterStations();
    }
  });
  el.searchForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const q = el.searchInput.value.trim();
    if (!q) { el.searchResults.hidden = true; return; }
    try {
      renderSearch(await state.client.search(q));
    } catch (err) {
      playerMessage(describeError(err), 'error');
    }
  });

  el.play.addEventListener('click', togglePlay);
  el.next.addEventListener('click', () => skip());
  el.love.addEventListener('click', () => rate('love'));
  el.ban.addEventListener('click', () => rate('ban'));
  el.tired.addEventListener('click', tired);
  el.explain.addEventListener('click', explain);
  el.explainClose.addEventListener('click', () => { el.explainPanel.hidden = true; el.explain.focus(); });
  el.volume.addEventListener('input', () => setVolume(Number(el.volume.value)));
  el.volume.addEventListener('change', saveVolume);
  el.quality.addEventListener('change', () => {
    if (state.remote) { remoteCommand('quality', { value: QUALITIES.includes(el.quality.value) ? el.quality.value : 'high' }); return; }
    setQuality(QUALITIES.includes(el.quality.value) ? el.quality.value : 'high');
    const wasFetching = state.fetching !== null;
    state.queue = [];
    state.playGen += 1; // a playlist in flight at the old quality is dropped
    renderUpNext();
    // Nothing playing (a load was in flight or the playlist ran dry): refetch at the new quality.
    if (state.station && (!state.song || el.audio.ended || wasFetching)) nextSong();
  });
  el.shortcutsOpen.addEventListener('click', () => openShortcuts(true));
  el.shortcutsClose.addEventListener('click', closeShortcuts);
  el.shortcuts.addEventListener('close', () => {
    // The menu item that opened the sheet sits in a collapsed <details>, so the
    // native focus restore lands on <body>; send focus to the menu button instead.
    if (shortcutsFromMenu || document.activeElement === document.body || !document.activeElement) {
      if (!el.account.hidden) el.account.querySelector('summary').focus();
    }
    shortcutsFromMenu = false;
  });
  closeOnBackdrop(el.shortcuts, closeShortcuts);
  closeOnBackdrop(el.confirm, () => el.confirm.close('no'));
  document.addEventListener('click', (ev) => {
    if (el.account.open && !el.account.contains(ev.target)) el.account.open = false;
  });

  const a = el.audio;
  a.addEventListener('play', () => { setPlayIcon(true); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
  a.addEventListener('pause', () => { setPlayIcon(false); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
  a.addEventListener('timeupdate', () => {
    const len = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : (state.song ? state.song.duration : 0);
    if (len) {
      setProgress(a.currentTime, len);
    } else {
      const t = fmtTime(a.currentTime);
      if (t !== el.timeCur.textContent) el.timeCur.textContent = t;
    }
  });
  a.addEventListener('ended', () => { state.consecutiveAudioErrors = 0; nextSong(); });
  a.addEventListener('error', () => {
    if (!state.song) return;
    state.consecutiveAudioErrors += 1;
    const code = a.error ? a.error.code : 0;
    const why = code === 4 ? `this browser cannot play ${state.song.audioFormat} audio` : `audio error ${code}`;
    if (state.consecutiveAudioErrors >= 2 && state.quality !== 'low') {
      setQuality(lowerQuality(state.quality));
      state.queue = [];
      renderUpNext();
      playerMessage(`Skipping: ${why}. Trying ${state.quality} quality.`, 'error');
    } else if (state.consecutiveAudioErrors >= 4) {
      playerMessage(`Giving up: ${why}.`, 'error', 0);
      return;
    } else {
      playerMessage(`Skipping: ${why}.`, 'error');
    }
    state.keepMessage = true;
    nextSong();
  });

  document.addEventListener('keydown', (ev) => {
    if (el.viewPlayer.hidden) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === 'Escape') {
      if (el.account.open) { el.account.open = false; el.account.querySelector('summary').focus(); }
      return;
    }
    if (el.confirm.open) return; // the confirm sheet owns the keyboard
    if (el.shortcuts.open && ev.key !== '?') return;
    if (!state.shortcutsOn && ev.key !== '?') return; // single-key shortcuts turned off in the sheet
    // Space on a dialog, menu, summary or link activates that control; on the
    // transport and station buttons it toggles playback (as in the original).
    if (ev.key === ' ' && t && t.closest && t.closest('dialog, details, summary, a')) return;
    switch (ev.key) {
      case ' ': ev.preventDefault(); togglePlay(); break;
      case 'n': skip(); break;
      case '+': case '=': rate('love'); break;
      case '-': rate('ban'); break;
      case 't': tired(); break;
      case 'e': explain(); break;
      case ')': setVolume(state.volume + 5); break;
      case '(': setVolume(state.volume - 5); break;
      case 's': openStations(); break;
      case '/': ev.preventDefault(); openStations('filter'); break;
      case '?': ev.preventDefault(); if (el.shortcuts.open) closeShortcuts(); else openShortcuts(); break;
      default: return;
    }
  });
}

async function main() {
  el.volume.value = String(state.volume);
  el.quality.value = state.quality;
  installEvents();
  installMediaSession();
  showIdle();
  updateRatingButtons();
  setPlayIcon(false);
  renderUpNext();
  renderHistory();

  let api;
  try {
    api = apiBaseFromPage();
  } catch (err) {
    throw new Error(`Bad relay address: ${describeError(err)}`);
  }
  state.apiBase = api.apiBase;
  state.apiFromQuery = api.fromQuery;
  const log = (m) => console.debug('[piano]', m);
  state.client = new PianoClient({ apiBase: api.apiBase, log, onUnauthorized });
  // The GitHub sign-in gate: the token arrives in the fragment after the GitHub round
  // trip and lives in localStorage. With ?api= (local dev, the tuner smoke) the GitHub
  // screen is skipped; the stored token, if any, is still sent to the relay.
  const authBase = resolveApiBase('../auth/', location.href);
  state.gate = new GithubGate({ authBase, store, log: (m) => console.debug('[gate]', m) });
  const arrived = state.gate.takeTokenFromHash(location, history);
  state.client.authToken = state.gate.token;
  const gateCheck = api.fromQuery
    ? Promise.resolve({ status: 'off', token: state.gate.token, login: '', allowed: false, reason: '?api=' })
    : state.gate.check().catch((err) => ({ status: 'unknown', token: state.gate.token, login: '', allowed: false, reason: describeError(err) }));
  // The extension bridge: say hello now so a content script can answer while
  // the wasm loads. An explicit ?api= wins over it (the CI smoke relies on that).
  if (!api.fromQuery) {
    state.bridge = new BridgeTransport(window, { log, onChange: updateStatus });
    state.client.bridge = state.bridge;
    state.bridge.start();
  }
  updateStatus();
  // Remote mode is decided first (at most ~2 s: 1 s for ready, 1 s for the first
  // state); the wasm loads meanwhile so local playback does not wait for it.
  const remoteProbe = state.bridge ? probeRemote(state.bridge).catch(() => null) : Promise.resolve(null);
  const loading = state.client.load().then(() => null, (err) => err || new Error('load failed'));
  const first = await remoteProbe;
  if (first) {
    enterRemote(first);
    return;
  }
  const loadErr = await loading;
  if (loadErr) {
    showFatal(`Could not load melodica.wasm: ${describeError(loadErr)}`);
    setStatus('wasm failed to load', true);
    return;
  }
  updateStatus();
  const gate = await gateCheck;
  state.gateStatus = gate;
  state.client.authToken = state.gate.token; // /auth/me may have refreshed it
  if (gate.reason) console.debug('[gate]', `${gate.status} (${gate.reason})`);
  if (gate.status === 'anonymous' || gate.status === 'denied') {
    showGithub(gate, arrived.error ? `GitHub sign-in did not complete (${arrived.error}). Try again.` : '');
    return;
  }
  showLogin();
  if (el.email.value && el.password.value) login(el.email.value, el.password.value);
}

// The view is unhidden before the alert text is set so it is announced; focus
// moves to the heading so keyboard and screen-reader users land on the error.
function showFatal(text) {
  show(el.viewError);
  el.fatal.textContent = text;
  const h = el.viewError.querySelector('h2');
  if (h) h.focus();
}

main().catch((err) => {
  showFatal(describeError(err));
  setStatus('startup failed', true);
});
