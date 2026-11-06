import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// Use the bridge shipped with this build, including a custom Make BUILD path.
const wasmPath = resolve(process.argv[2] ?? 'build/wasm/melodica.wasm');
const wasmBytes = await readFile(wasmPath);
const wasmModule = await WebAssembly.compile(wasmBytes);
const { loadMelodica } = await import(
  pathToFileURL(resolve(dirname(wasmPath), 'melodica.mjs')).href
);
const utf8 = new TextEncoder();
const bytes = (text) => utf8.encode(text);
const text = (data) => new TextDecoder().decode(data);
const allBytes = Uint8Array.from({ length: 256 }, (_, value) => value);
const stationRequest = (escapedToken, syncTime) =>
  `{"returnAllStations":true,"userAuthToken":"${escapedToken}","syncTime":${syncTime}}`;

const publicFunctions = [
  'melodica_abi_version',
  'melodica_url_encode_size',
  'melodica_url_encode',
  'melodica_json_escape_size',
  'melodica_json_escape',
  'melodica_station_list_request_size',
  'melodica_station_list_request',
];

// Fixed RFC 3986 output for bytes 0x00..0xff, including invalid UTF-8.
const allBytesUrl =
  '%00%01%02%03%04%05%06%07%08%09%0A%0B%0C%0D%0E%0F' +
  '%10%11%12%13%14%15%16%17%18%19%1A%1B%1C%1D%1E%1F' +
  '%20%21%22%23%24%25%26%27%28%29%2A%2B%2C-.%2F' +
  '0123456789%3A%3B%3C%3D%3E%3F' +
  '%40ABCDEFGHIJKLMNOPQRSTUVWXYZ%5B%5C%5D%5E_' +
  '%60abcdefghijklmnopqrstuvwxyz%7B%7C%7D~%7F' +
  '%80%81%82%83%84%85%86%87%88%89%8A%8B%8C%8D%8E%8F' +
  '%90%91%92%93%94%95%96%97%98%99%9A%9B%9C%9D%9E%9F' +
  '%A0%A1%A2%A3%A4%A5%A6%A7%A8%A9%AA%AB%AC%AD%AE%AF' +
  '%B0%B1%B2%B3%B4%B5%B6%B7%B8%B9%BA%BB%BC%BD%BE%BF' +
  '%C0%C1%C2%C3%C4%C5%C6%C7%C8%C9%CA%CB%CC%CD%CE%CF' +
  '%D0%D1%D2%D3%D4%D5%D6%D7%D8%D9%DA%DB%DC%DD%DE%DF' +
  '%E0%E1%E2%E3%E4%E5%E6%E7%E8%E9%EA%EB%EC%ED%EE%EF' +
  '%F0%F1%F2%F3%F4%F5%F6%F7%F8%F9%FA%FB%FC%FD%FE%FF';

// JSON.stringify is an independent escaping oracle. Treat these fixture bytes
// as Latin-1 so 0x80..0xff remain raw bytes; the C ABI uses uppercase hex.
const allBytesJson = new Uint8Array(Buffer.from(
  JSON.stringify(String.fromCharCode(...allBytes)).slice(1, -1)
    .replace(/\\u00([0-9a-f]{2})/g, (_, hex) => `\\u00${hex.toUpperCase()}`),
  'latin1',
));

function assertBytes(actual, expected) {
  assert.ok(actual instanceof Uint8Array, 'bridge returns Uint8Array');
  assert.deepEqual(actual, expected);
}

test('linked WASM has the exact public ABI, no imports, and bounded memory', () => {
  assert.deepEqual(WebAssembly.Module.imports(wasmModule), []);
  const expected = [
    { name: 'memory', kind: 'memory' },
    { name: '__heap_base', kind: 'global' },
    ...publicFunctions.map((name) => ({ name, kind: 'function' })),
  ];
  const byName = (a, b) => a.name.localeCompare(b.name);
  assert.deepEqual(WebAssembly.Module.exports(wasmModule).sort(byName), expected.sort(byName));
  const { exports } = new WebAssembly.Instance(wasmModule);
  assert.equal(exports.melodica_abi_version(), 1);
  assert.equal(exports.memory.buffer.byteLength, 2 * 65536);
  assert.ok(exports.__heap_base.value > 0);
  assert.ok(exports.__heap_base.value < exports.memory.buffer.byteLength);
  assert.equal(exports.memory.grow(254), 2);
  assert.equal(exports.memory.buffer.byteLength, 16 * 1024 * 1024);
  assert.throws(() => exports.memory.grow(1), RangeError);
});

const rawCases = [
  {
    name: 'URL encoding',
    size: 'melodica_url_encode_size',
    encode: 'melodica_url_encode',
    input: bytes('A \0/~'),
    expected: bytes('A%20%00%2F~'),
    extra: [],
  },
  {
    name: 'JSON escaping',
    size: 'melodica_json_escape_size',
    encode: 'melodica_json_escape',
    input: bytes('a"\0\n\\'),
    expected: bytes('a\\"\\u0000\\n\\\\'),
    extra: [],
  },
  {
    name: 'station request',
    size: 'melodica_station_list_request_size',
    encode: 'melodica_station_list_request',
    input: bytes('a"\0\n'),
    expected: bytes(stationRequest('a\\"\\u0000\\n', 0xffffffff)),
    extra: [0xffffffff],
  },
];

for (const fixture of rawCases) {
  test(`${fixture.name}: raw sizing, exact capacity, nulls, and no partial writes`, () => {
    const { exports } = new WebAssembly.Instance(wasmModule);
    const memory = new Uint8Array(exports.memory.buffer);
    const inputPointer = exports.__heap_base.value;
    const outputPointer = inputPointer + 1024;
    const guardSize = 16;
    const regionStart = outputPointer - guardSize;
    const regionEnd = outputPointer + fixture.expected.length + guardSize;
    const fillOutput = () => memory.fill(0xa5, regionStart, regionEnd);
    const size = (pointer, length) => exports[fixture.size](pointer, length, ...fixture.extra);
    const encode = (destination, capacity, pointer, length) =>
      exports[fixture.encode](destination, capacity, pointer, length, ...fixture.extra);
    memory.set(fixture.input, inputPointer);
    assert.equal(size(inputPointer, fixture.input.length), fixture.expected.length);

    for (const capacity of [0, fixture.expected.length - 1]) {
      fillOutput();
      const before = memory.slice(regionStart, regionEnd);
      assert.equal(encode(outputPointer, capacity, inputPointer, fixture.input.length), fixture.expected.length);
      assert.deepEqual(memory.slice(regionStart, regionEnd), before, 'short destination is untouched, including guards');
    }

    // Null destination is a sizing query even when its capacity is sufficient.
    const beforeNullDestination = memory.slice(inputPointer, regionEnd);
    assert.equal(encode(0, fixture.expected.length, inputPointer, fixture.input.length), fixture.expected.length);
    assert.deepEqual(memory.slice(inputPointer, regionEnd), beforeNullDestination, 'null destination leaves caller buffers untouched');

    for (const length of [0, fixture.input.length]) {
      fillOutput();
      const before = memory.slice(inputPointer, regionEnd);
      assert.equal(size(0, length), 0);
      assert.equal(encode(outputPointer, fixture.expected.length, 0, length), 0);
      assert.deepEqual(memory.slice(inputPointer, regionEnd), before, 'null source leaves caller buffers untouched');
    }

    fillOutput();
    assert.equal(encode(outputPointer, fixture.expected.length, inputPointer, fixture.input.length), fixture.expected.length);
    const expectedRegion = new Uint8Array(regionEnd - regionStart).fill(0xa5);
    expectedRegion.set(fixture.expected, guardSize);
    assert.deepEqual(memory.slice(regionStart, regionEnd), expectedRegion, 'exact result has no trailing NUL or guard writes');
    assert.deepEqual(memory.slice(inputPointer, inputPointer + fixture.input.length), fixture.input);
  });
}

test('bridge accepts compiled modules, ArrayBuffers, and offset byte views', async () => {
  const padded = new Uint8Array(wasmBytes.byteLength + 19).fill(0xff);
  padded.set(wasmBytes, 7);
  const sources = [
    wasmModule,
    wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength),
    padded.subarray(7, 7 + wasmBytes.byteLength),
  ];
  for (const source of sources) {
    const api = await loadMelodica(source);
    assert.equal(api.abiVersion, 1);
    assertBytes(api.urlEncode('A b/+~'), bytes('A%20b%2F%2B~'));
  }
});

test('bridge preserves every byte, embedded NULs, UTF-8, and empty inputs', async () => {
  const api = await loadMelodica(wasmModule);
  assertBytes(api.urlEncode(allBytes), bytes(allBytesUrl));
  assertBytes(api.jsonEscape(allBytes), allBytesJson);
  const binaryRequest = api.stationListRequest(allBytes, 7);
  const prefix = bytes('{"returnAllStations":true,"userAuthToken":"');
  const suffix = bytes('","syncTime":7}');
  assertBytes(binaryRequest, new Uint8Array(Buffer.concat([prefix, allBytesJson, suffix])));
  assert.deepEqual(allBytes, Uint8Array.from({ length: 256 }, (_, value) => value), 'input bytes are unchanged');

  assertBytes(api.urlEncode(Uint8Array.of(255, 65, 0, 66, 255).subarray(1, 4)), bytes('A%00B'));

  for (const input of ['café 🎵', bytes('café 🎵')]) {
    assertBytes(api.urlEncode(input), bytes('caf%C3%A9%20%F0%9F%8E%B5'));
    assertBytes(api.jsonEscape(input), bytes('café 🎵'));
    assertBytes(api.stationListRequest(input, 42), bytes(stationRequest('café 🎵', 42)));
  }
  for (const input of ['', new Uint8Array()]) {
    assertBytes(api.urlEncode(input), new Uint8Array());
    assertBytes(api.jsonEscape(input), new Uint8Array());
    assertBytes(api.stationListRequest(input, 0), bytes(stationRequest('', 0)));
  }
});

test('station syncTime covers the unsigned wasm32 range and rejects truncation', async () => {
  const api = await loadMelodica(wasmModule);
  for (const syncTime of [0, 1, 0x7fffffff, 0x80000000, 0xffffffff]) {
    assertBytes(api.stationListRequest('token', syncTime), bytes(stationRequest('token', syncTime)));
  }
  for (const invalid of [-1, 1.5, 0x100000000, NaN, Infinity, -Infinity, '7', 7n, null, undefined]) {
    assert.throws(() => api.stationListRequest('token', invalid), `reject syncTime ${String(invalid)}`);
  }
  for (const invalid of [null, undefined, 42, [65], new Uint16Array([65])]) {
    assert.throws(() => api.urlEncode(invalid));
    assert.throws(() => api.jsonEscape(invalid));
    assert.throws(() => api.stationListRequest(invalid, 0));
  }
});

test('growing memory preserves copied results and the bridge recovers after its limit', async () => {
  const api = await loadMelodica(wasmModule);
  const retained = api.stationListRequest('keep\nthis', 123);
  const original = retained.slice();
  assertBytes(api.urlEncode('overwrite scratch'), bytes('overwrite%20scratch'));

  // Both input and expanded output exceed the initial two-page memory.
  const zeros = new Uint8Array(200000);
  const expanded = api.jsonEscape(zeros);
  assertBytes(expanded, bytes('\\u0000'.repeat(zeros.length)));
  assertBytes(retained, original);
  const expandedSnapshot = expanded.slice();
  assertBytes(api.jsonEscape('next'), bytes('next'));
  assertBytes(expanded, expandedSnapshot);

  // This would need over 16 MiB of scratch memory after JSON expansion.
  assert.throws(() => api.jsonEscape(new Uint8Array(3 * 1024 * 1024)), RangeError);
  assertBytes(api.stationListRequest('', 0xffffffff), bytes(stationRequest('', 0xffffffff)));
  assertBytes(retained, original);
});

test('loader handles WASM MIME, fallback MIME, Responses, and HTTP failures', async (t) => {
  const server = createServer((request, response) => {
    if (request.url === '/missing') {
      // Valid WASM in an error response must still be rejected by HTTP status.
      response.writeHead(404, { 'Content-Type': 'application/wasm' });
      response.end(wasmBytes);
    } else if (request.url === '/broken') {
      response.writeHead(200, { 'Content-Type': 'application/wasm' });
      response.end('not a WASM module');
    } else {
      response.writeHead(200, {
        'Content-Type': request.url === '/fallback' ? 'application/octet-stream' : 'application/wasm',
      });
      response.end(wasmBytes);
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(() => new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const source of [
    `${origin}/streaming`,
    new URL(`${origin}/fallback`),
    await fetch(`${origin}/streaming`),
    await fetch(`${origin}/fallback`),
  ]) {
    const api = await loadMelodica(source);
    assert.equal(text(api.urlEncode('a b')), 'a%20b');
  }
  await assert.rejects(loadMelodica(`${origin}/missing`), /404/);
  await assert.rejects(loadMelodica(await fetch(`${origin}/missing`)), /404/);
  await assert.rejects(loadMelodica(`${origin}/broken`), WebAssembly.CompileError);
});

test('loader rejects malformed modules and missing public exports', async () => {
  await assert.rejects(loadMelodica(new Uint8Array([0, 1, 2, 3])), WebAssembly.CompileError);
  const emptyModule = new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  await assert.rejects(loadMelodica(emptyModule));
});

test('loader reports an unsupported ABI before exposing serializer methods', async () => {
  const unsigned = (value) => {
    const encoded = [];
    do {
      const byte = value & 0x7f;
      value >>>= 7;
      encoded.push(byte | (value ? 0x80 : 0));
    } while (value);
    return encoded;
  };
  const section = (id, payload) => [id, ...unsigned(payload.length), ...payload];
  const exportName = (name, kind) => [...unsigned(name.length), ...bytes(name), kind, 0];
  // A minimal module with the required export names and an ABI getter returning
  // 2. Serializer names alias the stub: none may be called with an unknown ABI.
  const wrongAbi = new WebAssembly.Module(Uint8Array.from([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [1, 0x60, 0, 1, 0x7f]), // () -> i32
    ...section(3, [1, 0]),
    ...section(5, [1, 0, 1]), // one memory page
    ...section(6, [1, 0x7f, 0, 0x41, 0x80, 0x08, 0x0b]), // heap at 1024
    ...section(7, [
      9,
      ...exportName('memory', 2),
      ...exportName('__heap_base', 3),
      ...publicFunctions.flatMap((name) => exportName(name, 0)),
    ]),
    ...section(10, [1, 4, 0, 0x41, 2, 0x0b]), // return ABI 2
  ]));
  await assert.rejects(loadMelodica(wrongAbi), /Unsupported melodica ABI 2/);
});
