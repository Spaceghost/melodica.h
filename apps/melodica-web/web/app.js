// melodica-web UI. No framework, no bundler, no external resources.
// Protocol: ./piano.js (melodica.h in wasm). Audio: the <audio> element.

import { PianoClient, PianoError, resolveApiBase } from './piano.js';
import { BridgeTransport, bridgeAllowed } from './bridge.js';
import { Vault } from './vault.js';
import { Account, USERNAME_RE, USERNAME_FORMAT, normalizeUsername } from './account.js';
import { Scrobbles, ListenTracker, PAGE_SIZE } from './scrobble.js';

const VERSION = '__MELODICA_WEB_VERSION__';
const STORAGE = {
  email: 'melodica.email',
  password: 'melodica.password', // plaintext from versions before 0.8.0: moved into the vault on load, then erased
  revoked: 'melodica.revoked',   // the last 8 sids signed out here (docs/BRIDGE.md 4.4); no secrets
  accountSignout: 'melodica.account.signout', // a spacegho.st sign-out the extension has not heard of yet (4.6)
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
  remoteSignin: $('remote-signin'), remoteSigninOpen: $('remote-signin-open'), remoteSigninHelp: $('remote-signin-help'),
  accountLine: $('account-line'), accountSignin: $('account-signin'), accountSigned: $('account-signed'),
  accountName: $('account-name'), accountSignout: $('account-signout'),
  accountMenuLine: $('account-menu-line'), accountMenuName: $('account-menu-name'), accountMenuSignout: $('account-menu-signout'),
  loginForm: $('login-form'), email: $('login-email'), password: $('login-password'),
  remember: $('login-remember'), rememberMenu: $('remember-menu'),
  loginButton: $('login-button'), loginMessage: $('login-message'), fatal: $('fatal-message'),
  stationList: $('station-list'), stationFilter: $('station-filter'), stationEmpty: $('station-empty'),
  stationCount: $('station-count'),
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
  usernamePick: $('username-pick'), usernamePickForm: $('username-pick-form'), usernamePickInput: $('username-pick-input'),
  usernamePickMessage: $('username-pick-message'), usernamePickCurrent: $('username-pick-current'),
  usernamePickNotice: $('username-pick-notice'), usernamePickLater: $('username-pick-later'), usernamePickSave: $('username-pick-save'),
  usernameChange: $('username-change'), usernameChangeInput: $('username-change-input'),
  usernameChangeMessage: $('username-change-message'), usernameChangeSave: $('username-change-save'),
  listensPanel: $('listens-panel'), listens: $('listens'), listensEmpty: $('listens-empty'), listensMore: $('listens-more'),
  scrobbleSettings: $('scrobble-settings'), scrobbleOn: $('scrobble-on'), scrobbleBoard: $('scrobble-board'),
  scrobbleMessage: $('scrobble-message'), scrobbleCrewWrap: $('scrobble-crew-wrap'), scrobbleNotice: $('scrobble-notice'),
  listensFallback: $('listens-fallback'), liveState: $('live-state'), siteNav: $('site-nav'),
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

// Playback compatibility state is read before loading a playlist.
// Defaults apply until a valid account response is available.
// (refreshPolicy). Nothing is cached between page loads.
function readPolicy() { return { inserts: true }; }

const state = {
  client: null,
  bridge: null,       // BridgeTransport: the link to the melodica extension (remote mode)
  account: null,      // Account (optional spacegho.st sign-in)
  accountReady: Promise.resolve(), // the policy is known once this settles
  policyReady: Promise.resolve(),  // the latest policy request
  remote: false,      // true when the melodica extension plays and this page is its view
  vault: null,        // Vault: the encrypted "Remember me" store (web/vault.js)
  saved: null,        // what the vault holds: {session, credential, relay}, or null
  savedReady: Promise.resolve(),
  remember: false,    // "Remember me on this device"
  sessionMeta: null,  // {sid, email, createdAt} of the Pandora session in the wasm client
  extSid: '',         // sid of the extension's session last seen (docs/BRIDGE.md 4.4)
  remoteState: null,  // last state pushed by the extension
  apiBase: '',
  apiFromQuery: false,
  stations: [],
  station: null,      // current station object
  queue: [],          // songs not yet played
  song: null,         // now playing
  history: [],        // songs heard this session, newest first
  quality: readQuality(),
  volume: readVolume(),
  policy: readPolicy(),
  shortcutsOn: store.get(STORAGE.shortcuts) !== '0', // single-key shortcuts (WCAG 2.1.4: can be turned off)
  explaining: false,
  playGen: 0,         // bumped when the station/queue context changes; stale playlist fetches are dropped
  fetching: null,     // playGen of the playlist request in flight, or null
  consecutiveAudioErrors: 0,
  keepMessage: false, // a skip reason should outlive the next song change
  scrobbles: null,    // Scrobbles: spacegho.st/scrobble/ (web/scrobble.js)
  scrobble: null,     // what the page knows of it (newScrobbleState)
};

// ---------------------------------------------------------------- helpers

function show(view) {
  for (const v of [el.viewLogin, el.viewPlayer, el.viewError]) v.hidden = v !== view;
  el.app.dataset.view = view.id.replace('view-', '');
  el.account.hidden = view !== el.viewPlayer;
  el.account.open = false;
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
  el.qualityChip.textContent = song.isAd ? 'ad' : fmt ? `${q} · ${fmt}` : q;
  el.qualityChip.hidden = false;
}

let renderUpNext = function renderUpNext() {
  el.upNext.replaceChildren();
  const peek = state.queue.slice(0, UP_NEXT_MAX);
  for (const s of peek) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = s.isAd ? 'Advertisement' : s.title || '';
    t.title = t.textContent;
    const a = document.createElement('span');
    a.className = 'a';
    a.textContent = s.isAd ? '' : s.artist || '';
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
    return (songs || []).filter((s) => s && (s.isAd ? state.policy.inserts : s.audioUrl)).map((s) => (s.quality = quality, s));
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
    if (song.isAd) {
      const ad = await loadAd(song);
      if (state.playGen !== gen) return;
      if (!ad) { renderUpNext(); nextSong(); return; }
      playSong(ad);
      renderUpNext();
      return;
    }
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

// An ad item of the playlist becomes a playable "song" from ad.getAdMetadata,
// or null when it has no audio (then it is passed over).
async function loadAd(item) {
  try {
    const meta = await state.client.adMetadata(item.adToken, item.quality || state.quality);
    if (!meta || !meta.audioUrl) return null;
    return {
      isAd: true, adToken: item.adToken, stationId: item.stationId || (state.station && state.station.id) || '',
      title: meta.title || 'Advertisement', artist: meta.companyName || '', album: '',
      coverArt: meta.imageUrl || '', audioUrl: meta.audioUrl, audioFormat: meta.audioFormat || '',
      adTrackingTokens: Array.isArray(meta.adTrackingTokens) ? meta.adTrackingTokens : [],
      clickThroughUrl: meta.clickThroughUrl || '', trackToken: '', duration: 0, rating: 0, quality: item.quality,
      registered: false,
    };
  } catch (err) {
    console.debug('[slot]', `ad metadata failed: ${describeError(err)}`);
    return null;
  }
}

// Registered once, when the ad's audio actually started.
function registerAdOnce(song) {
  if (!song || !song.isAd || song.registered) return;
  song.registered = true;
  state.client.registerAd(song.stationId, song.adTrackingTokens)
    .then(() => console.debug('[slot]', 'ad registered'))
    .catch((err) => console.debug('[slot]', `ad.registerAd failed: ${describeError(err)}`));
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
  if (song.isAd) el.app.dataset.ad = 'true';
  else delete el.app.dataset.ad;
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
  if (!song.isAd) rememberSong(song);
  if (!state.remote) scrobbleStart(song);
  else scheduleListensRefresh();
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
  const ad = has && !!state.song.isAd; // an ad plays through: no skip, rating or explain
  for (const b of [el.next, el.love, el.ban, el.tired, el.explain]) b.disabled = !has || ad;
}

function skip(reason) {
  if (state.remote) { remoteCommand('next'); return; }
  if (state.song && state.song.isAd) return; // inserts play through
  if (reason) { playerMessage(reason); state.keepMessage = true; }
  el.audio.pause();
  nextSong();
}

// Rate the current song (ban skips) or any song from the play log via its trackToken.
async function rateSong(song, kind) {
  if (!song || song.isAd) return;
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
  if (!song || song.isAd) return;
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
  if (!song || song.isAd || state.explaining) return; // the e key bypasses the disabled button
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
    remoteVolumeBusy += 1; // the slider wins over pushed volumes until its command is answered
    clearTimeout(remoteVolumeTimer);
    remoteVolumeTimer = setTimeout(async () => {
      try { await remoteCommand('volume', { value: state.volume }); } finally { remoteVolumeBusy = 0; }
    }, 150);
  }
}
let remoteVolumeTimer = 0;
let remoteVolumeBusy = 0; // > 0 while a slider move has not been answered by the extension

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
// When the melodica extension (0.3.0+) answers on this page, its background player is
// the only player: this page is a view of that playback and a remote for it (same UI,
// driven by the state the extension pushes; controls send commands; no local <audio>,
// no Pandora login here). The switch happens whenever the extension appears, also
// after the page started on its own. Without the extension the page plays on its own
// through the relay.

const CONNECTING = 'Connecting to the melodica extension…';
// Released extensions (0.5.x) do not push every change (not their login; a resume has
// been seen to arrive seconds late), so while the page is visible it also asks for the
// current state every second: the view is never more than about a second behind.
const REMOTE_REFRESH_MS = 1000;

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

let sessionSyncedFor = '';
function onBridgeChange(bridge) {
  updateStatus();
  if (bridge.active && bridge.player && !state.remote) enterRemote();
  if (state.remote) el.logout.hidden = !bridge.session;
  // Once per extension (and version): exchange sessions (docs/BRIDGE.md 4.3).
  if (bridge.active && bridge.player && bridge.session && sessionSyncedFor !== bridge.label) {
    sessionSyncedFor = bridge.label;
    syncWithExtension();
  }
}

async function openExtensionLogin() {
  let r = null;
  try { r = await state.bridge.command('open-login', {}, 3000); } catch (_) { r = null; }
  // Older extensions do not know the command; then say where the login is.
  el.remoteSigninHelp.hidden = !!(r && r.ok);
}

function remoteSong(t) {
  return {
    title: t.title || '', artist: t.artist || '', album: t.album || '', coverArt: t.coverArt || '',
    trackToken: t.trackToken || '', rating: t.rating || 0, duration: t.duration || 0,
    quality: t.quality || '', audioFormat: t.audioFormat || '',
  };
}

let remoteStationsKey = '';
let remoteChangedAt = 0;
function renderRemote(rs) {
  // Command replies are not ordered against the extension's pushes: never draw a state
  // older than the one on screen (docs/BRIDGE.md 2, changedAt).
  const at = Number(rs && rs.changedAt);
  if (Number.isFinite(at) && at > 0) {
    if (at < remoteChangedAt) return;
    remoteChangedAt = at;
  }
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
  if (Number.isFinite(Number(rs.volume)) && !remoteVolumeBusy) {
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

  // No Pandora session in the extension: say where to sign in (the page has no login).
  const needsLogin = rs.loggedIn === false;
  if (el.remoteSignin.hidden === needsLogin) {
    el.remoteSignin.hidden = !needsLogin;
    if (!needsLogin) el.remoteSigninHelp.hidden = true;
  }
  if (needsLogin) el.hint.textContent = '';
  else if (!state.song) updateHint();
  if (el.playerMessage.textContent === CONNECTING) playerMessage('');
  if (rs.status === 'error' && rs.error && !needsLogin) playerMessage(rs.error, 'error', 0);
  else if (rs.status === 'loading') playerMessage('Loading…', 'info', 0);
  else if (el.playerMessage.textContent === 'Loading…' || /^Loading .*…$/.test(el.playerMessage.textContent)) playerMessage('');
  // The extension's username (0.5.4+ sends user: {username, …}); never an email.
  const name = !needsLogin && rs.user && typeof rs.user.username === 'string' ? rs.user.username : '';
  el.signedIn.textContent = name || 'melodica extension';
  el.signedInFull.textContent = name ? `Playing in the melodica extension as ${name}` : 'Playing in the melodica extension';
}

function enterRemote() {
  if (state.remote) return;
  // The page may have started on its own: stop that and forget its Pandora session.
  if (state.song || el.audio.getAttribute('src')) stopPlayback();
  try { if (state.client && state.client.fn) state.client.logout(); } catch (_) { /* not loaded yet */ }
  state.remote = true;
  el.app.dataset.mode = 'remote';
  el.audio.pause();
  el.audio.removeAttribute('src');
  el.audio.load();
  el.searchForm.hidden = true;
  el.searchResults.hidden = true;
  el.logout.hidden = !state.bridge.session; // with the session layer, signing out here signs out both
  closeUsernamePick();
  el.usernameChange.hidden = true; // the extension's account is the extension's to name
  el.signedIn.textContent = 'melodica extension';
  el.signedInFull.textContent = 'Playing in the melodica extension';
  renderUpNext = () => {}; // the queue panel shows the extension's count (renderRemote)
  show(el.viewPlayer);
  playerMessage(CONNECTING, 'info', 0);
  updateStatus();
  state.bridge.subscribe((st) => renderRemote(st));
  setInterval(() => {
    if (document.visibilityState === 'visible' && state.bridge.gotState) state.bridge.post({ type: 'subscribe' });
  }, REMOTE_REFRESH_MS);
  addEventListener('pagehide', () => state.bridge && state.bridge.unsubscribe());
  visibleStationButton()?.focus();
}

// ---------------------------------------------------------------- spacegho.st account
// Optional. The policy endpoint is asked with the account's token when signed in,
// else with the relay's access token from the Pandora login; without either the
// policy is the default (web/account.js, docs/ACCOUNT.md). No text explains it.

// Re-read the policy (after a login, a renewed relay token, sign-in or sign-out).
function refreshPolicy() {
  const a = state.account;
  state.policyReady = (a ? a.policy(state.client.accessToken) : Promise.resolve({ inserts: true }))
    .then((p) => { state.policy = p; }, () => { state.policy = { inserts: true }; });
  return state.policyReady;
}

// The account line on the login card and the entries in the account menu.
function updateAccountLine() {
  const a = state.account;
  const available = !!(a && a.config);
  el.accountLine.hidden = !available;
  const signedIn = available && a.signedIn;
  el.accountSignin.hidden = signedIn;
  el.accountSigned.hidden = !signedIn;
  el.accountName.textContent = signedIn ? a.label : '';
  el.accountMenuLine.hidden = !signedIn;
  el.accountMenuName.textContent = signedIn ? a.label : '';
  el.accountMenuSignout.hidden = !signedIn;
}

// Discovery, a finished sign-in round trip, the policy and the profile.
async function setupAccount() {
  const a = state.account;
  if (!(await a.discover())) return;
  const back = await a.finishRedirect(location, history);
  if (back.done && !back.error) store.remove(STORAGE.accountSignout); // signed in again: nothing to deliver
  // login_required answers a silent sign-in (prompt=none) when there is no spacegho.st session.
  if (back.error && back.error !== 'login_required') loginMessage(`spacegho.st sign-in did not complete (${back.error}).`, 'error');
  await refreshPolicy();
  if (a.signedIn) await a.profile();
  updateAccountLine();
}

async function accountSignIn(ev) {
  ev.preventDefault();
  try {
    location.assign(await state.account.startUrl());
  } catch (err) {
    loginMessage(describeError(err), 'error');
  }
}

// Signing out of spacegho.st here signs the extension out of it too (docs/BRIDGE.md 4.6):
// at once when it is there, else at the next handshake.
async function accountSignOut() {
  await state.account.signOut();
  await refreshPolicy();
  updateAccountLine();
  store.set(STORAGE.accountSignout, '1');
  deliverAccountSignout();
  scrobblesAfterAccountChange();
}

// The spacegho.st account went away: the Scrobbles views start again with whatever
// token remains (the relay's), or close when none does.
async function scrobblesAfterAccountChange() {
  if (!state.scrobble) return;
  clearScrobbles();
  if (await scrobbleToken()) loadScrobbles();
}

async function deliverAccountSignout() {
  const b = state.bridge;
  if (store.get(STORAGE.accountSignout) !== '1' || !b || !b.active || !b.session) return;
  let r = null;
  try { r = await b.accountSignout(); } catch (_) { r = null; }
  if (r && r.ok) store.remove(STORAGE.accountSignout);
}

// The extension signed out of spacegho.st: so does this page, and no silent sign-in follows.
async function onExtensionAccountSignout() {
  const a = state.account;
  if (!a) return;
  a.session.set(SILENT_KEY, '1');
  if (!a.signedIn) return;
  await a.signOut();
  await refreshPolicy();
  updateAccountLine();
  scrobblesAfterAccountChange();
}

// ---------------------------------------------------------------- username
// docs/ACCOUNT.md, Usernames: after the Pandora login the page asks
// /oauth/melodica/me (bearer: the spacegho.st account's token when signed in, else
// the relay's access token). The account chip shows the username, a generated
// listener-… until one is chosen, and never the email; names go in as text only.
// While the name is generated, "Pick a username" opens once per login; "Not now"
// keeps it closed for the rest of this browser session.
const USERNAME_LATER_KEY = 'melodica.username.later';

function showUsername(name) {
  el.signedIn.textContent = name || 'Signed in';
  el.signedInFull.textContent = name ? `Signed in as ${name}` : 'Signed in to Pandora';
  el.usernameChange.hidden = !name;
  if (!name) message(el.usernameChangeMessage, '', '', 0);
  if (document.activeElement !== el.usernameChangeInput) el.usernameChangeInput.value = name || '';
}

// A 401 invalid_token or 404 unknown_user (docs/ACCOUNT.md, Revoked tokens): the
// account's tokens are forgotten; a relay token that no longer counts ends the
// Pandora login too, and the login card says so.
async function usernameAuthFailed(r) {
  const revoked = (r.status === 401 && r.error === 'invalid_token') || (r.status === 404 && r.error === 'unknown_user');
  if (!revoked) return false;
  if (r.bearer === 'account') {
    state.account.forget();
    updateAccountLine();
    refreshPolicy();
    return false; // the relay token may still name the user: the caller asks again
  }
  logout();
  loginMessage('Your melodica session has ended; log in again.', 'error');
  return true;
}

async function refreshMe({ prompt = false } = {}) {
  const a = state.account;
  if (!a || state.remote || !state.client) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = state.client.accessToken;
    const me = await a.me(token);
    if (state.remote || state.client.accessToken !== token || el.app.dataset.view !== 'player') return; // logged out or moved on meanwhile
    if (me.ok) {
      showUsername(me.username);
      if (prompt && !me.chosen && a.session.get(USERNAME_LATER_KEY) !== '1') openUsernamePick(me);
      return;
    }
    if (me.status === 0 || (await usernameAuthFailed(me))) return;
    if (me.bearer !== 'account') return;
  }
}

function openUsernamePick(me) {
  el.usernamePickCurrent.textContent = me.username;
  el.usernamePickNotice.hidden = me.notice !== 'renamed_github';
  el.usernamePickInput.value = me.suggested || '';
  message(el.usernamePickMessage, '', '', 0);
  if (typeof el.usernamePick.showModal === 'function') { if (!el.usernamePick.open) el.usernamePick.showModal(); }
  else el.usernamePick.setAttribute('open', '');
  el.usernamePickInput.focus();
}
function closeUsernamePick() {
  if (!el.usernamePick.open) return;
  if (typeof el.usernamePick.close === 'function') el.usernamePick.close();
  else el.usernamePick.removeAttribute('open');
}

// Checks the format here (the rest is the server's: reserved, taken, locked, rate
// limits) and shows the server's error_description next to the field.
async function saveUsername(input, msgEl, button) {
  const name = normalizeUsername(input.value);
  if (!USERNAME_RE.test(name)) { message(msgEl, USERNAME_FORMAT, 'error', 0); input.focus(); return false; }
  button.disabled = true;
  message(msgEl, 'Saving…', 'info', 0);
  try {
    const r = await state.account.setUsername(name, state.client.accessToken);
    if (r.ok) {
      showUsername(r.username);
      message(msgEl, '', '', 0);
      return true;
    }
    if (await usernameAuthFailed(r)) return false;
    message(msgEl, r.message, 'error', 0);
    input.focus();
    return false;
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------- remembered session
// docs/BRIDGE.md 5: "Remember me on this device" keeps the Pandora session (and the
// relay token, and the credential for when the session has expired) encrypted in
// web/vault.js; nothing secret in localStorage. Off, logout or a revoked session wipes it.

function randomSid() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function revokedList() {
  try { const v = JSON.parse(store.get(STORAGE.revoked) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch (_) { return []; }
}
function addRevoked(sid) {
  if (!sid) return;
  store.set(STORAGE.revoked, JSON.stringify([...revokedList().filter((x) => x !== sid), sid].slice(-8)));
}

function syncRemember() {
  el.remember.checked = state.remember;
  el.rememberMenu.checked = state.remember;
}

async function loadSaved() {
  const plain = store.get(STORAGE.password);
  if (plain !== null) {
    // Versions before 0.8.0 kept the password as plain text: move it, then erase it.
    const email = store.get(STORAGE.email) || '';
    store.remove(STORAGE.password);
    if (plain && email) await state.vault.write({ session: null, credential: { email, password: plain }, relay: null });
  }
  state.saved = await state.vault.read();
  state.remember = !!state.saved;
}

async function forgetSaved() {
  state.saved = null;
  await state.vault.wipe();
}

async function writeSaved(rec) {
  state.saved = rec;
  try { await state.vault.write(rec); } catch (err) { console.debug('[vault]', describeError(err)); }
}

// The wasm client has a new Pandora session (a login or a re-login): a new sid, and
// stored when remembered.
function onClientSession() {
  const c = state.client.credentials;
  state.sessionMeta = { sid: randomSid(), email: c ? c.user : '', createdAt: Date.now() };
  persistSession();
}

function currentRecord() {
  const s = state.client.session();
  if (!s || !state.sessionMeta) return null;
  const c = state.client.credentials;
  return {
    session: { ...state.sessionMeta, ...s },
    credential: c ? { email: c.user, password: c.password } : null,
    relay: state.client.accessToken ? { token: state.client.accessToken, at: state.client.accessAt } : null,
  };
}

function persistSession() {
  if (!state.remember || state.remote) return;
  const rec = currentRecord();
  if (rec) writeSaved(rec);
}

// The checkbox on the login card or in the account menu.
function setRemember(on) {
  state.remember = !!on;
  syncRemember();
  if (!state.remember) { forgetSaved(); return; }
  if (state.remote) {
    if (state.extSid) syncWithExtension(true);
  } else persistSession();
}

const RELAY_TOKEN_MS = 11 * 3600_000; // the relay's tokens last 12 h

// Until when a relay token may be sent: its exp claim less 5 min (read, not verified:
// the relay verifies), else 11 h after it was received.
function relayTokenUntil(relay) {
  if (!relay || !relay.token) return 0;
  try {
    const part = relay.token.split('.')[1];
    const exp = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))).exp;
    if (Number.isFinite(exp)) return exp * 1000 - 300_000;
  } catch (_) { /* not a JWT: the age rule below */ }
  return (Number(relay.at) || 0) + RELAY_TOKEN_MS;
}

// Resume the stored Pandora session; its credential is used only when Pandora or the
// relay no longer honour it (PianoClient re-logs in on 1001 / relay 401).
async function resumeSaved() {
  const s = state.saved;
  if (!s || !s.session || !state.client.restore(s.session)) return false;
  state.sessionMeta = { sid: s.session.sid, email: s.session.email, createdAt: s.session.createdAt };
  state.client.setCredentials(s.credential ? { user: s.credential.email, password: s.credential.password } : null);
  const fresh = s.relay && s.relay.token && Date.now() < relayTokenUntil(s.relay);
  state.client.restoreAccess(fresh ? s.relay.token : '', fresh ? s.relay.at : 0);
  if (fresh) refreshPolicy();
  el.loginButton.disabled = true;
  loginMessage('Signing in…', 'info');
  try {
    await state.policyReady;
    if (state.remote) return true;
    if (s.session.email) store.set(STORAGE.email, s.session.email);
    await enterPlayer();
    loginMessage('');
    persistSession(); // a re-login meanwhile, or a new relay token
    return true;
  } catch (err) {
    state.client.logout();
    state.sessionMeta = null;
    if (state.remote) return false;
    // An expired session without a stored password: sign in again (nothing is wiped).
    loginMessage(s.credential ? describeError(err) : 'Your Pandora session ended; sign in again.', s.credential ? 'error' : 'info');
    return false;
  } finally {
    el.loginButton.disabled = false;
  }
}

// ---------------------------------------------------------------- sessions with the extension
// docs/BRIDGE.md 4: signed in on either side is signed in on both; signing out on
// either side signs out both. No prompt.

function accountView() {
  const a = state.account;
  return a && a.signedIn ? { signedIn: true, username: a.name || '', github: null } : { signedIn: false, username: '', github: null };
}

async function syncWithExtension(force = false) {
  await state.savedReady;
  let m;
  try { m = await state.bridge.sessionGet(); } catch (err) { console.debug('[bridge]', describeError(err)); return; }
  await applyExtensionSession(m, true, force);
  deliverAccountSignout();
}

// m: {session, credential, account, revoked} from the extension (answer or push).
async function applyExtensionSession(m, initial, force = false) {
  await state.savedReady;
  const mine = state.saved && state.saved.session;
  if (m.session) {
    if (revokedList().includes(m.session.sid)) {
      // Signed out here while the extension was away: sign it out too.
      try { await state.bridge.sessionLogout(m.session.sid); } catch (_) { /* tried */ }
      return;
    }
    state.extSid = m.session.sid;
    const same = mine && mine.sid === m.session.sid;
    const credential = m.credential || (state.saved && state.saved.credential && state.saved.credential.email === m.session.email ? state.saved.credential : null);
    const newAccess = !!m.access && !(state.saved && state.saved.relay && state.saved.relay.token === m.access);
    if (!same || force || newAccess || JSON.stringify(credential) !== JSON.stringify(state.saved && state.saved.credential)) {
      // A copy in this page's own store, so it stays signed in without the extension.
      state.remember = true;
      syncRemember();
      const relay = m.access ? { token: m.access, at: Date.now() } : (same && state.saved ? state.saved.relay : null);
      await writeSaved({ session: m.session, credential, relay });
      if (m.session.email) store.set(STORAGE.email, m.session.email);
    }
  } else {
    const mirrored = mine && (m.revoked.includes(mine.sid) || mine.sid === state.extSid);
    state.extSid = '';
    if (mirrored) {
      await forgetSaved();
      syncRemember();
      clearScrobbles();
    } else if (mine && initial) {
      let r = null;
      try { r = await state.bridge.sessionOffer({ session: mine, credential: state.saved.credential || undefined, account: accountView() }); } catch (_) { r = null; }
      if (r && (r.outcome === 'revoked' || r.outcome === 'invalid')) await forgetSaved();
      else if (r && r.ok) state.extSid = mine.sid;
    }
  }
  applyExtensionAccount(m.account);
  if (state.remote) loadScrobbles(); // the copy's token (or the account) reads the listens
}

// spacegho.st: the extension signed in and this page not -> a silent sign-in (prompt=none,
// once per browser session); the extension signed out after being signed in -> sign out.
const SILENT_KEY = 'melodica.account.silent';
function applyExtensionAccount(acc) {
  const a = state.account;
  if (!acc || !a || !a.config) return;
  if (acc.signedIn && !a.signedIn && a.session.get(SILENT_KEY) !== '1') {
    a.session.set(SILENT_KEY, '1');
    a.startUrl({ prompt: 'none' }).then((u) => location.assign(u), () => {});
  }
}

// Sign out from the remote: the extension signs out (and so does this page's copy).
async function remoteLogout(sid) {
  el.account.open = false;
  try { await state.bridge.sessionLogout(state.extSid || sid); } catch (err) { playerMessage(describeError(err), 'error'); }
}

// ---------------------------------------------------------------- login

function showLogin() {
  el.audio.pause();
  playerMessage('');
  show(el.viewLogin);
  updateAccountLine();
  el.email.value = store.get(STORAGE.email) || '';
  el.password.value = '';
  syncRemember();
  (el.email.value ? el.password : el.email).focus();
}

async function login(email, password) {
  el.loginButton.disabled = true;
  loginMessage('Signing in…', 'info');
  try {
    await state.accountReady; // the playback policy is known before anything plays
    state.remember = el.remember.checked;
    if (!state.remember) await forgetSaved();
    await state.client.login(email, password); // onSession stores the session when remembered
    await state.policyReady; // asked with the relay's new access token (onAccess)
    if (store.get(STORAGE.email) !== email) {
      // A different account: its predecessor's play log (and rate tokens) must not carry over.
      state.history = [];
      renderHistory();
    }
    store.set(STORAGE.email, email);
    loginMessage('');
    await enterPlayer();
  } catch (err) {
    loginMessage(describeError(err), 'error');
  } finally {
    el.loginButton.disabled = false;
  }
}

// The player after a login or a resumed session.
async function enterPlayer() {
  showUsername(''); // never the Pandora email: "Signed in" until /oauth/melodica/me names the user
  await loadStations();
  show(el.viewPlayer);
  updateHint();
  renderUpNext();
  visibleStationButton()?.focus();
  refreshMe({ prompt: true }); // not awaited: the username never holds up playback
  loadScrobbles();
}

// Signing out here signs out the extension too (docs/BRIDGE.md 4.4).
function logout() {
  const sid = state.sessionMeta ? state.sessionMeta.sid : (state.saved && state.saved.session ? state.saved.session.sid : '');
  if (sid) addRevoked(sid);
  state.sessionMeta = null;
  forgetSaved();
  clearScrobbles();
  if (state.remote) { remoteLogout(sid); return; }
  closeUsernamePick();
  showUsername('');
  if (state.account && !state.account.signedIn) state.account.name = '';
  stopPlayback();
  state.client.logout();
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

// ---------------------------------------------------------------- scrobbling
// Spacegho.st Scrobbles (web/scrobble.js): on by default for a signed-in user, off in
// the account menu. The page submits only while its own audio plays; in remote mode
// the extension submits and the page only shows the listens (docs/BRIDGE.md 3).
const SCROBBLE_NOTICE_KEY = 'melodica.scrobble.noticeSeen';
const SCROBBLE_RETRY_MAX = 20;
const LISTENS_REFRESH_MS = 4000;

function newScrobbleState() {
  return { gen: 0, loaded: false, settings: null, crew: false, cursor: null, loading: false, tracker: null, retry: [], ids: new Set() };
}

// The bearer: the relay's access token (here, or the extension's kept with the shared
// session), else the spacegho.st account's token.
async function scrobbleToken() {
  if (!state.remote && state.client && state.client.accessToken) return state.client.accessToken;
  const relay = state.saved && state.saved.relay;
  if (state.remote && relay && relay.token && relayTokenUntil(relay) > Date.now()) return relay.token;
  const a = state.account;
  if (a && a.signedIn) { try { return await a.accessToken(); } catch (_) { return ''; } }
  return '';
}

function scrobbleOn() {
  const sc = state.scrobble;
  return !!(sc && sc.loaded && sc.settings && sc.settings.scrobbling);
}

function renderScrobbleSettings() {
  const sc = state.scrobble;
  el.scrobbleSettings.hidden = !(sc && sc.loaded);
  el.listensPanel.hidden = !(sc && sc.loaded);
  if (!sc || !sc.loaded) return;
  const links = state.scrobbles.links; // on this page's origin
  $('scrobble-dashboard').href = links.dashboard;
  $('scrobble-leaderboard').href = links.leaderboard;
  $('scrobble-crew').href = links.crew;
  el.scrobbleOn.checked = !!(sc.settings && sc.settings.scrobbling);
  el.scrobbleBoard.checked = !!(sc.settings && sc.settings.leaderboard);
  el.scrobbleBoard.disabled = !el.scrobbleOn.checked;
  el.scrobbleCrewWrap.hidden = !sc.crew;
}

function listenRow(l) {
  const li = document.createElement('li');
  li.className = 'hist listen';
  li.dataset.id = String(l.id || '');
  const img = document.createElement('img');
  img.className = 'hist-cover';
  img.alt = '';
  img.loading = 'lazy';
  img.src = typeof l.art === 'string' && /^https:\/\//.test(l.art) ? l.art : FALLBACK_COVER;
  img.addEventListener('error', () => { img.src = FALLBACK_COVER; }, { once: true });
  const meta = document.createElement('div');
  meta.className = 'hist-meta';
  const t = document.createElement('span');
  t.className = 'hist-title';
  t.textContent = l.title || '';
  t.title = l.title || '';
  const a = document.createElement('span');
  a.className = 'hist-artist';
  a.textContent = l.artist || '';
  meta.append(t, a);
  const when = document.createElement('time');
  when.className = 'hist-when';
  const ms = Number(l.listened_at) * 1000;
  if (Number.isFinite(ms) && ms > 0) {
    const d = new Date(ms);
    when.dateTime = d.toISOString();
    const today = new Date().toDateString() === d.toDateString();
    when.textContent = today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  li.append(img, meta, when);
  return li;
}

// Adds listens (newest first) at the end, or at the top when fresh.
function addListens(list, fresh = false) {
  const sc = state.scrobble;
  const rows = [];
  for (const l of Array.isArray(list) ? list : []) {
    if (!l || sc.ids.has(l.id)) continue;
    sc.ids.add(l.id);
    rows.push(listenRow(l));
  }
  if (fresh) el.listens.prepend(...rows);
  else el.listens.append(...rows);
  el.listensEmpty.hidden = el.listens.children.length > 0;
  el.listensMore.hidden = !sc.cursor;
}

// Settings and the last PAGE_SIZE listens, after a login, a resume or a shared session.
async function loadScrobbles() {
  if (!state.scrobbles) state.scrobbles = new Scrobbles({ origin: location.origin, token: scrobbleToken });
  if (!state.scrobble) state.scrobble = newScrobbleState();
  const sc = state.scrobble;
  if (sc.loaded || sc.loading) return;
  const gen = sc.gen;
  sc.loading = true;
  try {
    const me = await state.scrobbles.me();
    if (state.scrobble !== sc || sc.gen !== gen) return;
    sc.settings = me.settings || {};
    sc.crew = !!me.crew_viewer;
    sc.cursor = me.next_cursor || null;
    sc.loaded = true;
    el.listens.replaceChildren();
    sc.ids.clear();
    addListens((me.recent || []).slice(0, PAGE_SIZE));
    renderScrobbleSettings();
    startUi();
    if (scrobbleOn() && !state.remote) showScrobbleNotice();
    // A song already playing (a resume) still counts from here.
    if (!state.remote && state.song && !sc.tracker) scrobbleStart(state.song);
    flushScrobbleRetry();
  } catch (err) {
    console.debug('[scrobble]', describeError(err));
  } finally {
    sc.loading = false;
  }
}

async function moreListens() {
  const sc = state.scrobble;
  if (!sc || !sc.loaded || !sc.cursor || sc.paging) return;
  sc.paging = true;
  const gen = sc.gen;
  try {
    const r = await state.scrobbles.listens(sc.cursor);
    if (state.scrobble !== sc || sc.gen !== gen) return;
    sc.cursor = r.next_cursor || null;
    addListens(r.listens);
  } catch (err) {
    console.debug('[scrobble]', describeError(err));
  } finally {
    sc.paging = false;
  }
}

// Newest listens on top (after a submit here, or a track change in the extension).
let listensTimer = 0;
function scheduleListensRefresh() {
  clearTimeout(listensTimer);
  listensTimer = setTimeout(async () => {
    const sc = state.scrobble;
    if (!sc || !sc.loaded) return;
    const gen = sc.gen;
    try {
      const r = await state.scrobbles.listens('', PAGE_SIZE);
      if (state.scrobble === sc && sc.gen === gen) addListens(r.listens, true);
    } catch (err) { console.debug('[scrobble]', describeError(err)); }
  }, LISTENS_REFRESH_MS);
}

function showScrobbleNotice() {
  if (store.get(SCROBBLE_NOTICE_KEY) === '1') return;
  store.set(SCROBBLE_NOTICE_KEY, '1');
  if (el.usernamePick.open) return; // next time, not over the username dialog
  if (typeof el.scrobbleNotice.showModal === 'function') { if (!el.scrobbleNotice.open) el.scrobbleNotice.showModal(); }
  else el.scrobbleNotice.setAttribute('open', '');
}

// A 403 scrobbling_off: the server's setting is off (changed elsewhere).
function scrobbleRefused(err) {
  if (!err || err.status !== 403 || err.code !== 'scrobbling_off') return false;
  const sc = state.scrobble;
  if (sc && sc.settings) sc.settings.scrobbling = false;
  if (sc) { sc.tracker = null; sc.retry = []; }
  renderScrobbleSettings();
  return true;
}

// A new song plays here: "playing now", and a tracker for the listen. Never an ad.
function scrobbleStart(song) {
  const sc = state.scrobble;
  if (!sc) return;
  sc.tracker = null;
  if (!song || song.isAd || state.remote || !scrobbleOn()) return;
  sc.tracker = new ListenTracker(song, Date.now() / 1000, Number(song.duration) || 0);
  const len = el.audio.duration;
  sc.tracker.setDuration(Number.isFinite(len) ? len : 0);
  state.scrobbles.submit('playing_now', song, sc.tracker.duration).catch((err) => {
    if (!scrobbleRefused(err)) console.debug('[scrobble]', describeError(err));
  });
}

function scrobbleTick() {
  const sc = state.scrobble;
  const tr = sc && sc.tracker;
  if (!tr || state.remote || tr.song !== state.song) return;
  if (Number.isFinite(el.audio.duration)) tr.setDuration(el.audio.duration);
  tr.tick(el.audio.currentTime, !el.audio.paused && !el.audio.ended);
  if (!tr.due() || !scrobbleOn()) return;
  tr.sent = true;
  sendListen({ song: tr.song, duration: tr.duration, at: tr.startedAt });
}

async function sendListen(item) {
  const sc = state.scrobble;
  try {
    await state.scrobbles.submit('single', item.song, item.duration, item.at);
    scheduleListensRefresh();
  } catch (err) {
    if (scrobbleRefused(err)) return;
    console.debug('[scrobble]', describeError(err));
    // Network trouble or a 5xx: kept for the next load or submit (a 4xx is final).
    if (sc && state.scrobble === sc && (err.status === 0 || err.status >= 500) && sc.retry.length < SCROBBLE_RETRY_MAX) sc.retry.push(item);
    return;
  }
  flushScrobbleRetry();
}

function flushScrobbleRetry() {
  const sc = state.scrobble;
  if (!sc || !sc.retry.length || !scrobbleOn() || state.remote) return;
  const items = sc.retry.splice(0);
  for (const it of items) sendListen(it);
}

async function setScrobbleSetting(patch) {
  const sc = state.scrobble;
  if (!sc || !sc.loaded) return;
  el.scrobbleOn.disabled = el.scrobbleBoard.disabled = true;
  message(el.scrobbleMessage, 'Saving…', 'info', 0);
  try {
    const r = await state.scrobbles.setSettings(patch);
    if (state.scrobble !== sc) return;
    sc.settings = Object.assign(sc.settings || {}, r && typeof r === 'object' ? r : patch);
    message(el.scrobbleMessage, '', '', 0);
    if ('scrobbling' in patch) {
      if (!sc.settings.scrobbling) { sc.tracker = null; sc.retry = []; }
      else if (!state.remote && state.song) scrobbleStart(state.song);
    }
  } catch (err) {
    message(el.scrobbleMessage, err && err.message ? err.message : 'Could not save.', 'error');
  } finally {
    el.scrobbleOn.disabled = false;
    renderScrobbleSettings();
  }
}

// Logout (here or in the extension): nothing of this listener stays on the page.
function clearScrobbles() {
  stopUi();
  clearTimeout(listensTimer);
  if (state.scrobble) state.scrobble.gen += 1;
  state.scrobble = null;
  el.listens.replaceChildren();
  el.listensEmpty.hidden = false;
  el.listensMore.hidden = true;
  message(el.scrobbleMessage, '', '', 0);
  renderScrobbleSettings();
}

// ---------------------------------------------------------------- scrobbles panels
// The shared Scrobbles UI (spaceghost-scrobble ui/, contract v1 in its docs/CLIENTS.md),
// fetched pinned into vendor/scrobble-ui/ at build time: Your listens (live), Leaderboard
// and, for the GitHub crew, the Map. It loads after the first /scrobble/api/me answer;
// without it the listens list above (v0.9.0) is the fallback.
const UI_MODULE = './vendor/scrobble-ui/scrobble-ui.js';
const PANES = { listens: 'mountListens', leaderboard: 'mountLeaderboard', map: 'mountMap' };
let ui = null;          // {mod, client, live, views, crew}
let uiPane = 'listens';

// Here the relay token first (as for submitting); in remote mode the spacegho.st account
// first. null means the spacegho.st session cookie, when there is one.
async function uiToken() {
  if (state.remote) {
    const a = state.account;
    if (a && a.signedIn) { try { const t = await a.accessToken(); if (t) return t; } catch (_) { /* below */ } }
  }
  return (await scrobbleToken()) || null;
}

function uiLiveState(st) {
  el.liveState.textContent = st === 'open' ? 'live' : st === 'polling' ? 'updating' : '';
  el.liveState.dataset.state = st || '';
}

async function startUi() {
  if (ui) return;
  const mine = ui = { views: {}, crew: !!(state.scrobble && state.scrobble.crew) };
  let mod;
  try {
    mod = await import(UI_MODULE);
  } catch (err) {
    console.debug('[scrobble-ui]', describeError(err));
    if (ui === mine) el.listensFallback.hidden = false;
    return;
  }
  if (ui !== mine) return; // signed out meanwhile
  mine.mod = mod;
  mine.client = mod.createClient({ base: location.origin, token: uiToken });
  mine.live = mine.client.live();
  mine.live.addEventListener('state', (e) => uiLiveState((e.detail && e.detail.state) || e.state));
  el.listensFallback.hidden = true;
  $('tab-map').hidden = !mine.crew;
  if (uiPane === 'map' && !mine.crew) uiPane = 'listens';
  showPane(uiPane, false);
}

function showPane(name, focus = true) {
  uiPane = name;
  for (const tab of el.listensPanel.querySelectorAll('[role="tab"]')) {
    const on = tab.dataset.pane === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  }
  for (const k of Object.keys(PANES)) $(`pane-${k}`).hidden = k !== name;
  if (!ui || !ui.mod || ui.views[name]) return;
  const host = $(`sui-${name}`);
  try {
    const opts = { client: ui.client, live: ui.live };
    if (name === 'listens') { opts.pageSize = 25; opts.scrollRoot = host; } // scrolls inside its own box (0.9.1)
    if (name === 'leaderboard') opts.window = '7d';
    ui.views[name] = ui.mod[PANES[name]](host, opts);
  } catch (err) {
    console.debug('[scrobble-ui]', describeError(err));
  }
}

function stopUi() {
  const mine = ui;
  ui = null;
  uiPane = 'listens';
  if (mine) {
    for (const v of Object.values(mine.views)) { try { v.unmount(); } catch (_) { /* gone */ } }
    try { if (mine.live) mine.live.close(); } catch (_) { /* closed */ }
  }
  for (const k of Object.keys(PANES)) $(`sui-${k}`).replaceChildren();
  $('tab-map').hidden = true;
  el.listensFallback.hidden = true;
  uiLiveState('');
  showPane('listens', false);
}

function installUiEvents() {
  const tabs = () => [...el.listensPanel.querySelectorAll('[role="tab"]')].filter((t) => !t.hidden);
  for (const tab of el.listensPanel.querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', () => showPane(tab.dataset.pane));
    tab.addEventListener('keydown', (ev) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
      ev.preventDefault();
      const list = tabs();
      const i = list.indexOf(tab);
      const next = ev.key === 'Home' ? list[0] : ev.key === 'End' ? list[list.length - 1]
        : list[(i + (ev.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
      showPane(next.dataset.pane);
    });
  }
  for (const k of Object.keys(PANES)) {
    $(`sui-${k}`).addEventListener('sui:error', (ev) => console.debug('[scrobble-ui]', k, ev.detail && ev.detail.code));
    $(`sui-${k}`).addEventListener('sui:live', (ev) => uiLiveState(ev.detail && ev.detail.state));
  }
  // The site nav: same pages on this origin (a self-hosted copy keeps its own host).
  for (const a of el.siteNav.querySelectorAll('a')) {
    const u = new URL(a.getAttribute('href'));
    a.href = `${location.origin}${u.pathname}`;
  }
}

function installScrobbleEvents() {
  installUiEvents();
  el.scrobbleOn.addEventListener('change', () => setScrobbleSetting({ scrobbling: el.scrobbleOn.checked }));
  el.scrobbleBoard.addEventListener('change', () => setScrobbleSetting({ leaderboard: el.scrobbleBoard.checked }));
  el.listensMore.addEventListener('click', () => moreListens());
  closeOnBackdrop(el.scrobbleNotice, () => el.scrobbleNotice.close());
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) moreListens();
    }, { root: $('listens-box'), rootMargin: '0px' }).observe(el.listensMore); // inside the box only, once it is scrolled to
  }
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
  el.remember.addEventListener('change', () => setRemember(el.remember.checked));
  el.rememberMenu.addEventListener('change', () => setRemember(el.rememberMenu.checked));
  el.shortcutsEnabled.checked = state.shortcutsOn;
  el.shortcutsEnabled.addEventListener('change', () => {
    state.shortcutsOn = el.shortcutsEnabled.checked;
    store.set(STORAGE.shortcuts, state.shortcutsOn ? '1' : '0');
  });
  el.logout.addEventListener('click', logout);
  el.usernamePickForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (await saveUsername(el.usernamePickInput, el.usernamePickMessage, el.usernamePickSave)) closeUsernamePick();
  });
  el.usernamePickLater.addEventListener('click', () => {
    state.account.session.set(USERNAME_LATER_KEY, '1');
    closeUsernamePick();
  });
  el.usernamePick.addEventListener('cancel', () => state.account.session.set(USERNAME_LATER_KEY, '1'));
  el.usernameChange.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (await saveUsername(el.usernameChangeInput, el.usernameChangeMessage, el.usernameChangeSave)) {
      message(el.usernameChangeMessage, 'Saved.', 'info', 4000);
    }
  });
  el.accountSignin.addEventListener('click', accountSignIn);
  el.remoteSigninOpen.addEventListener('click', openExtensionLogin);
  el.accountSignout.addEventListener('click', accountSignOut);
  el.accountMenuSignout.addEventListener('click', () => { el.account.open = false; accountSignOut(); });
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
  a.addEventListener('playing', () => registerAdOnce(state.song));
  a.addEventListener('play', () => { setPlayIcon(true); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
  a.addEventListener('pause', () => { setPlayIcon(false); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
  a.addEventListener('timeupdate', () => {
    scrobbleTick();
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
      case 's': visibleStationButton()?.focus(); break;
      case '/': ev.preventDefault(); el.stationFilter.focus(); el.stationFilter.select(); break;
      case '?': ev.preventDefault(); if (el.shortcuts.open) closeShortcuts(); else openShortcuts(); break;
      default: return;
    }
  });
}

async function main() {
  el.volume.value = String(state.volume);
  el.quality.value = state.quality;
  installEvents();
  installScrobbleEvents();
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
  state.client = new PianoClient({ apiBase: api.apiBase, log, onAccess: () => { refreshPolicy(); }, onSession: onClientSession });
  // The encrypted "Remember me" store; an old plaintext password is moved into it first.
  state.vault = new Vault();
  state.savedReady = loadSaved().catch((err) => { console.debug('[vault]', describeError(err)); state.saved = null; });
  // The optional spacegho.st account: finishes a sign-in round trip and reads the
  // policy while the wasm loads; logins wait for it so the policy is known first.
  const session = {
    get(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (_) { /* unavailable */ } },
    remove(k) { try { sessionStorage.removeItem(k); } catch (_) { /* unavailable */ } },
  };
  state.account = new Account({ origin: location.origin, store, session, log: (m) => console.debug('[account]', m) });
  state.accountReady = setupAccount().catch((err) => console.debug('[account]', describeError(err)));
  // The melodica extension: say hello now (and again for a few seconds) so its content
  // script can answer while the wasm loads; it may also appear later, and the page
  // then switches to remote mode (onBridgeChange). An explicit ?api= means the relay
  // given there, without the extension (the CI smoke relies on that).
  if (!api.fromQuery && bridgeAllowed(location)) {
    state.bridge = new BridgeTransport(window, { log, onChange: onBridgeChange, onSession: (m) => applyExtensionSession(m, false), onAccountSignout: onExtensionAccountSignout });
    state.bridge.start();
  }
  updateStatus();
  // The wasm loads meanwhile, so the page on its own does not wait for the extension.
  const loading = state.client.load().then(() => null, (err) => err || new Error('load failed'));
  // An installed extension answers within a few hundred ms; give it 1.5 s before any login shows.
  if (state.bridge && await state.bridge.waitReady(1500)) return; // onBridgeChange entered remote mode
  const loadErr = await loading;
  if (state.remote) return;
  if (loadErr) {
    showFatal(`Could not load melodica.wasm: ${describeError(loadErr)}`);
    setStatus('wasm failed to load', true);
    return;
  }
  updateStatus();
  showLogin();
  await state.accountReady;
  // A remembered login waits until the extension had its full window to answer.
  if (state.bridge) await state.bridge.waitReady();
  if (state.remote) return;
  updateAccountLine();
  await state.savedReady;
  if (state.remote) return;
  syncRemember();
  if (state.saved && state.saved.session) resumeSaved();
  else if (state.saved && state.saved.credential) login(state.saved.credential.email, state.saved.credential.password);
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
