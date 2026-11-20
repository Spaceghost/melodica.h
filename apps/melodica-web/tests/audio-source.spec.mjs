import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wavBytes } from './tools/test-tone.mjs';
import { readAppSource } from './tools/app-source.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '..');
const appFunction = readAppSource(resolve(root, 'dist/app.js'));
const appHtml = await readFile(resolve(root, 'dist/index.html'), 'utf8');
const playerAudioTag = appHtml.match(/<audio id="audio"[^>]*><\/audio>/)?.[0]?.replace('id="audio"', 'id="player"');
if (!playerAudioTag) throw new Error('Cannot find the player audio element in web/index.html');

const actualPlaySong = appFunction('playSong');
const actualPlayFrom = appFunction('playFrom');
const actualCancelPreparation = appFunction('cancelRoomSourcePreparation');
const actualRevokeBlob = appFunction('revokeBlob');
const actualPrepareRoomAudio = appFunction('prepareRoomPlayerAudio');

const builtVersion = (await readFile(resolve(root, 'dist/app.js'), 'utf8')).match(/const VERSION = '([^']+)'/)?.[1];

const wav = wavBytes();
let appServer, mediaServer, appOrigin, mediaOrigin, relayCount;

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolveListen(server.address().port);
    });
  });
}

test.beforeAll(async () => {
  relayCount = 0;
  mediaServer = createServer((req, res) => {
    if (!new URL(req.url, 'http://media.local').pathname.endsWith('.wav')) {
      res.writeHead(404).end(); return;
    }
    // Deliberately no Access-Control-Allow-Origin header.
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(wav.length), 'cache-control': 'no-store' });
    res.end(wav);
  });
  const mediaPort = await listen(mediaServer);
  mediaOrigin = `http://127.0.0.1:${mediaPort}`;

  appServer = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://app.local');
    if (url.pathname === '/fixture') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8">${playerAudioTag}<audio id="cors-control" preload="auto"></audio><button id="cors-start">Test CORS control</button><button id="play-radio">Play radio</button>
        <script>window.state = {};</script>
        <script type="module">
          import { AudioCopies } from '/dist/lastplay.js';
          import { capturePlayerAudio } from '/dist/vendor/scrobble-ui/scrobble-ui.js';
          window.AudioCopiesClass = AudioCopies;
          window.capturePlayerAudio = (audio) => capturePlayerAudio(audio);
          window.audioHelpersReady = true;
        </script>`);
      return;
    }
    if (url.pathname === '/relay') {
      relayCount += 1;
      const target = url.searchParams.get('audio');
      if (!target || new URL(target).origin !== mediaOrigin) { res.writeHead(400).end('bad media origin'); return; }
      const delay = Number(new URL(target).searchParams.get('delay')) || 0;
      const ctl = new AbortController();
      let timer;
      res.on('close', () => { if (!res.writableEnded) { clearTimeout(timer); ctl.abort(); } });
      try {
        if (delay) await new Promise((resolveDelay, rejectDelay) => {
          timer = setTimeout(resolveDelay, delay);
          ctl.signal.addEventListener('abort', () => rejectDelay(new DOMException('Aborted', 'AbortError')), { once: true });
        });
        const upstream = await fetch(target, { signal: ctl.signal });
        const body = Buffer.from(await upstream.arrayBuffer());
        if (!res.destroyed) {
          res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/octet-stream', 'content-length': String(body.length), 'cache-control': 'no-store' });
          res.end(body);
        }
      } catch (err) {
        if (!res.destroyed) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end(err.message); }
      }
      return;
    }
    const relative = decodeURIComponent(url.pathname.slice(1));
    const filename = resolve(root, relative);
    if (!filename.startsWith(`${root}/`)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(filename);
      const mime = extname(filename) === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' }); res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  const appPort = await listen(appServer);
  appOrigin = `http://127.0.0.1:${appPort}`;
});

test.afterAll(async () => {
  for (const server of [appServer, mediaServer]) if (server?.listening) await new Promise((done) => server.close(done));
});

test(`web ${builtVersion}: Pandora radio playback and DJ source stay readable, live, and race-safe`, async ({ page }) => {
  const setup = `
    window.state = { playGen: 0, remote: false, blobUrl: '', preparingRoomAudio: false, volume: 80,
      rooms: { getState: () => ({ state: { id: 'room-test', current_dj: 'dj', you: 'dj', you_broadcasting: true } }) } };
    window.el = { audio: document.querySelector('#player') };
    state.copies = new AudioCopiesClass({
      caches: null, origin: location.origin,
      relayRequest: (audioUrl) => ['/relay?audio=' + encodeURIComponent(audioUrl), { credentials: 'omit', headers: { 'x-melodica-access': 'fixture-access' } }],
    });
    window.displaySong = (song) => { state.song = song; state.playGen += 1; };
    window.clearResume = () => {};
    window.applyVolume = () => {};
    window.keepCopies = () => {};
    window.updateMediaSession = () => {};
    window.playerMessage = () => {};
    window.updateResumeUi = () => {};
    window.setPlayIcon = () => {};
    let roomSourceJob = null;
    ${actualPlaySong}
    ${actualPlayFrom}
    ${actualCancelPreparation}
    ${actualRevokeBlob}
    ${actualPrepareRoomAudio}
    window.startRadio = (song) => playSong(song);
    window.cancelRoomSourcePreparation = cancelRoomSourcePreparation;
    window.prepareRoomPlayerAudio = prepareRoomPlayerAudio;
    window.radioErrors = 0;
    window.playingCount = 0;
    el.audio.addEventListener('error', () => { window.radioErrors += 1; });
    el.audio.addEventListener('playing', () => { window.playingCount += 1; });
    window.pauseRoomAudio = () => { cancelRoomSourcePreparation(); el.audio.pause(); };
    document.querySelector('#cors-start').addEventListener('click', () => document.querySelector('#cors-control').play().catch(() => {}));
    document.querySelector('#play-radio').addEventListener('click', () => playSong(window.nextSong));
  `;
  await page.goto(`${appOrigin}/fixture`);
  await page.waitForFunction(() => window.audioHelpersReady);
  await page.addScriptTag({ content: setup });
  const mediaUrl = `${mediaOrigin}/track.wav`;

  await page.evaluate((url) => {
    const audio = document.querySelector('#cors-control');
    audio.crossOrigin = 'anonymous';
    window.corsFailure = new Promise((resolve) => audio.addEventListener('error', () => resolve(true), { once: true }));
    audio.src = url;
  }, mediaUrl);
  await page.locator('#cors-start').click();
  const corsControl = await page.evaluate(async () => {
    const failed = await Promise.race([
      window.corsFailure,
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    return { failed, errorCode: document.querySelector('#cors-control').error?.code || 0 };
  });
  expect(corsControl.failed, 'crossorigin=anonymous must fail against a source with no ACAO').toBe(true);
  expect(corsControl.errorCode).toBeGreaterThan(0);

  await page.evaluate(() => { window.radioErrors = 0; window.playingCount = 0; });
  await page.evaluate((url) => { window.nextSong = { trackToken: 'radio-a', title: 'Radio A', audioUrl: url }; }, mediaUrl);
  await page.locator('#play-radio').click();
  await page.waitForFunction(() => document.querySelector('#player').currentTime > 3.0, null, { timeout: 10_000 });
  expect(await page.evaluate(() => window.radioErrors)).toBe(0);
  const radioPosition = await page.locator('#player').evaluate((audio) => audio.currentTime);
  expect(radioPosition).toBeGreaterThan(3.0);
  expect(builtVersion).toMatch(/^\d+\.\d+\.\d+$/);

  const relayBefore = relayCount;
  await page.evaluate(() => window.prepareRoomPlayerAudio());
  await page.waitForFunction(() => state.blobUrl && document.querySelector('#player').getAttribute('src') === state.blobUrl, null, { timeout: 15_000 });
  expect(relayCount).toBeGreaterThan(relayBefore);
  const prepared = await page.evaluate(() => ({
    src: document.querySelector('#player').getAttribute('src'),
    blob: state.blobUrl,
    position: document.querySelector('#player').currentTime,
    playing: !document.querySelector('#player').paused,
  }));
  expect(prepared.src).toMatch(/^blob:/);
  expect(prepared.playing).toBe(true);
  expect(Math.abs(prepared.position - radioPosition)).toBeLessThan(0.6);

  const rms = await page.evaluate(async () => {
    const audio = document.querySelector('#player');
    const stream = window.capturePlayerAudio(audio);
    audio.muted = true;
    const context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(stream), analyser = context.createAnalyser(), silent = context.createGain();
    analyser.fftSize = 2048; silent.gain.value = 0;
    source.connect(analyser); analyser.connect(silent); silent.connect(context.destination);
    const samples = new Float32Array(analyser.fftSize);
    const readings = [];
    for (let frame = 0; frame < 20; frame += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      analyser.getFloatTimeDomainData(samples);
      readings.push(Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length));
    }
    const value = Math.max(...readings);
    const muted = audio.muted;
    audio.muted = false;
    source.disconnect(); analyser.disconnect(); silent.disconnect(); await context.close();
    return { rms: value, trackState: stream.getAudioTracks()[0]?.readyState, muted };
  });
  expect(rms.muted).toBe(true);
  expect(rms.trackState).toBe('live');
  expect(rms.rms).toBeGreaterThan(0.01);

  const slowUrl = `${mediaOrigin}/slow.wav?delay=1200`;
  await page.evaluate((url) => window.startRadio({ trackToken: 'slow-a', title: 'Slow A', audioUrl: url }), slowUrl);
  await page.waitForFunction(() => document.querySelector('#player').currentTime > 0.2, null, { timeout: 5000 });
  const pauseRelayBefore = relayCount;
  await page.evaluate(() => { window.pendingPreparation = window.prepareRoomPlayerAudio().catch((error) => { window.lastPreparationError = error.name; }); });
  await expect.poll(() => relayCount, { timeout: 5000 }).toBeGreaterThan(pauseRelayBefore);
  const playsBeforePause = await page.evaluate(() => window.playingCount);
  await page.evaluate(() => window.pauseRoomAudio());
  await page.waitForTimeout(1500);
  const pausedResult = await page.evaluate(() => ({ paused: document.querySelector('#player').paused, playEvents: window.playingCount }));
  expect(pausedResult.paused).toBe(true);
  expect(pausedResult.playEvents).toBe(playsBeforePause);

  const staleUrl = `${mediaOrigin}/stale.wav?delay=1200`;
  await page.evaluate((url) => window.startRadio({ trackToken: 'stale-a', title: 'Stale A', audioUrl: url }), staleUrl);
  await page.waitForFunction(() => document.querySelector('#player').currentTime > 0.2, null, { timeout: 5000 });
  const staleRelayBefore = relayCount;
  await page.evaluate(() => { window.pendingPreparation = window.prepareRoomPlayerAudio().catch((error) => { window.stalePreparationError = error.message; }); });
  await expect.poll(() => relayCount, { timeout: 5000 }).toBeGreaterThan(staleRelayBefore);
  const newUrl = `${mediaOrigin}/new.wav`;
  await page.evaluate((url) => window.startRadio({ trackToken: 'new-b', title: 'New B', audioUrl: url }), newUrl);
  await page.waitForTimeout(1400);
  const staleResult = await page.evaluate(() => ({
    token: state.song.trackToken,
    src: document.querySelector('#player').getAttribute('src'),
    blob: state.blobUrl,
  }));
  expect(staleResult.token).toBe('new-b');
  expect(staleResult.src).toBe(newUrl);
  expect(staleResult.blob).toBe('');
});
