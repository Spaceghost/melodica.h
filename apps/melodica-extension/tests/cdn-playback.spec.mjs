import { test, expect, chromium } from '@playwright/test';
import { compile } from 'imba/compiler';
import { build } from 'esbuild';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function wavFile(seconds = 12) {
  const sampleRate = 44_100, samples = sampleRate * seconds;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 10_000), 44 + i * 2);
  return bytes;
}

test('Pandora media without ACAO plays normally and remains origin-clean for room capture', async () => {
  const audioBytes = wavFile();
  let mediaRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/control') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end('<!doctype html><title>unprivileged media control</title>');
      return;
    }
    if (!/^\/track\/[a-c]\.wav$/.test(new URL(req.url, 'http://127.0.0.1').pathname)) {
      res.writeHead(404).end(); return;
    }
    mediaRequests++;
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': audioBytes.length, 'cache-control': 'no-store', 'accept-ranges': 'bytes' });
    res.end(audioBytes);
  });
  await new Promise((resolve, reject) => server.listen(0, '0.0.0.0', resolve).once('error', reject));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const extensionDir = await mkdtemp(join(tmpdir(), 'melodica-cdn-extension-'));
  const profileDir = await mkdtemp(join(tmpdir(), 'melodica-cdn-profile-'));
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const extensionKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const extensionId = createHash('sha256').update(Buffer.from(extensionKey, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (n) => String.fromCharCode(97 + Number.parseInt(n, 16)));
  let context;
  try {
    const source = await readFile(resolve(root, 'src/engine.imba'), 'utf8');
    const compiled = compile(source, { platform: 'browser', format: 'esm', sourcePath: 'src/engine.imba', raiseErrors: true });
    await build({ stdin: { contents: compiled.js, resolveDir: root, sourcefile: 'engine.js', loader: 'js' }, bundle: true,
      format: 'esm', platform: 'browser', outfile: join(extensionDir, 'engine.js') });
    await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify({
      manifest_version: 3, name: 'Melodica no CORS regression fixture', version: '1.0.0',
      permissions: [], host_permissions: ['http://127.0.0.1/*'], key: extensionKey,
    }));
    await writeFile(join(extensionDir, 'page.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="test.js"></script>');
    await writeFile(join(extensionDir, 'test.js'), `
      import { Engine } from './engine.js';
      const origin = new URL(location.href).searchParams.get('origin');
      Object.defineProperty(globalThis, 'caches', { configurable: true, value: undefined });
      const engine = new Engine({ api: {}, report: () => {}, document });
      globalThis.engine = engine;
      globalThis.runNoCorsProof = async () => {
        for (const id of ['a', 'b', 'c']) {
          await engine.importPlayback({ station: { id: 'station', name: 'Fixture' },
            song: { trackToken: 'track-' + id, title: 'Tone ' + id, artist: 'Fixture', duration: 12, audioUrl: origin + '/track/' + id + '.wav' },
            queue: [], position: 0, duration: 12, volume: 80, quality: 'high', status: 'playing', played: true });
          const deadline = Date.now() + 4000;
          while (engine.audio.currentTime < 0.35 && Date.now() < deadline && !engine.audio.error) await new Promise(r => setTimeout(r, 30));
          if (engine.audio.error || engine.audio.currentTime < 0.35 || engine.snapshot.status !== 'playing') {
            throw new Error('Ordinary no-CORS radio failed on ' + id + ': ' + JSON.stringify({ error: engine.audio.error?.code, time: engine.audio.currentTime, status: engine.snapshot.status }));
          }
        }

        const before = engine.audio.currentTime;
        await engine.preparePlayerAudioForCapture();
        if (!engine.audio.src.startsWith('blob:') || engine.audio.paused || engine.audio.currentTime < before - 0.1) {
          throw new Error('DJ capture source did not preserve audible playback position.');
        }
        const context = new AudioContext();
        await context.resume();
        const stream = engine.audio.captureStream();
        engine.audio.muted = true;
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser(); analyser.fftSize = 2048;
        source.connect(analyser); analyser.connect(context.destination);
        const samples = new Float32Array(analyser.fftSize);
        let maxRms = 0;
        for (let i = 0; i < 20; i++) {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0; for (const sample of samples) sum += sample * sample;
          maxRms = Math.max(maxRms, Math.sqrt(sum / samples.length));
          if (maxRms > 0.01) break;
          await new Promise(r => setTimeout(r, 50));
        }
        source.disconnect(); analyser.disconnect(); await context.close();
        engine.audio.muted = false;
        return { noCrossOrigin: engine.audio.crossOrigin == null,
          directRadioAdvancedAcrossThreeTracks: true, preparedBlob: engine.audio.src.startsWith('blob:'), mutedDuringCapture: true, maxRms };
      };
    `);

    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      channel: 'chromium',
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--autoplay-policy=no-user-gesture-required', '--no-first-run'],
    });
    const page = await context.newPage();
    await page.goto(`http://localhost:${server.address().port}/control`);
    const blocked = await page.evaluate((mediaOrigin) => new Promise((resolve) => {
      const anonymous = new Audio(); anonymous.crossOrigin = 'anonymous'; anonymous.src = mediaOrigin + '/track/a.wav';
      anonymous.addEventListener('error', () => resolve(true), { once: true });
      anonymous.play().catch(() => {});
      setTimeout(() => resolve(false), 1500);
    }), origin);
    expect(blocked, 'an ordinary page cannot play the no-ACAO CDN in anonymous CORS mode').toBe(true);
    await page.goto(`chrome-extension://${extensionId}/page.html?origin=${encodeURIComponent(origin)}`);
    await page.waitForFunction(() => typeof globalThis.runNoCorsProof === 'function', null, { timeout: 5000 });
    const proof = await page.evaluate(() => globalThis.runNoCorsProof());
    expect(proof.noCrossOrigin, 'ordinary radio omits the CORS requirement').toBe(true);
    expect(proof.directRadioAdvancedAcrossThreeTracks).toBe(true);
    expect(proof.preparedBlob).toBe(true);
    expect(proof.mutedDuringCapture).toBe(true);
    expect(proof.maxRms, 'the DJ capture stream contains audible decoded samples').toBeGreaterThan(0.01);
    expect(mediaRequests).toBeGreaterThanOrEqual(4, 'radio and privileged clean-copy fetches reach the no-ACAO CDN fixture');
  } finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    await Promise.all([rm(extensionDir, { recursive: true, force: true }), rm(profileDir, { recursive: true, force: true })]);
  }
});
