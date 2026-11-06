/** Allocation-free wasm32 melodica core. Serializer results are owned bytes. */
const ABI_VERSION = 1;
const PAGE_BYTES = 65536;
const MAX_MEMORY_BYTES = 16 * 1024 * 1024;
const FUNCTIONS = [
  'melodica_abi_version',
  'melodica_url_encode_size',
  'melodica_url_encode',
  'melodica_json_escape_size',
  'melodica_json_escape',
  'melodica_station_list_request_size',
  'melodica_station_list_request',
];

async function compile(source) {
  if (source instanceof WebAssembly.Module) return source;
  if (typeof source === 'string' || source instanceof URL) {
    source = await fetch(source);
  }
  if (typeof Response !== 'undefined' && source instanceof Response) {
    if (!source.ok) {
      throw new Error(`Unable to load melodica.wasm: HTTP ${source.status} ${source.statusText}`);
    }
    const mime = (source.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
    if (mime === 'application/wasm' && typeof WebAssembly.compileStreaming === 'function') {
      // Compilation failures remain visible; only MIME selects the byte fallback.
      return WebAssembly.compileStreaming(source);
    }
    source = await source.arrayBuffer();
  }
  if (ArrayBuffer.isView(source)) {
    source = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  } else if (!(source instanceof ArrayBuffer)) {
    throw new TypeError('Expected a WASM URL, Response, ArrayBuffer, typed array, or WebAssembly.Module');
  }
  return WebAssembly.compile(source);
}

/**
 * Load the freestanding core. Strings are UTF-8 encoded; Uint8Array input and
 * returned Uint8Array output preserve arbitrary bytes, including invalid UTF-8.
 */
export async function loadMelodica(source = new URL('./melodica.wasm', import.meta.url)) {
  const module = await compile(source);
  if (WebAssembly.Module.imports(module).length !== 0) {
    throw new TypeError('Expected a freestanding melodica module with no imports');
  }
  const instance = await WebAssembly.instantiate(module);
  const api = instance.exports;
  for (const name of FUNCTIONS) {
    if (typeof api[name] !== 'function') {
      throw new TypeError(`Invalid melodica module: missing function ${name}`);
    }
  }
  if (!(api.memory instanceof WebAssembly.Memory) ||
      !(api.__heap_base instanceof WebAssembly.Global)) {
    throw new TypeError('Invalid melodica module: memory and __heap_base must be exported');
  }
  const abiVersion = api.melodica_abi_version();
  if (abiVersion !== ABI_VERSION) {
    throw new Error(`Unsupported melodica ABI ${abiVersion}; expected ${ABI_VERSION}`);
  }
  const memory = api.memory;
  const heapBase = api.__heap_base.value;
  if (!Number.isInteger(heapBase) || heapBase <= 0 ||
      heapBase > memory.buffer.byteLength || memory.buffer.byteLength > MAX_MEMORY_BYTES) {
    throw new TypeError('Invalid melodica module: unusable wasm32 scratch memory');
  }
  const encoder = new TextEncoder();

  function reserve(end) {
    if (!Number.isSafeInteger(end) || end > MAX_MEMORY_BYTES) {
      throw new RangeError('Melodica input and output exceed the 16 MiB WebAssembly memory limit');
    }
    if (end > memory.buffer.byteLength) {
      memory.grow(Math.ceil((end - memory.buffer.byteLength) / PAGE_BYTES));
    }
  }

  function serialize(input, size, write, syncTime) {
    if (typeof input === 'string') input = encoder.encode(input);
    if (!(input instanceof Uint8Array)) {
      throw new TypeError('Melodica input must be a string or Uint8Array');
    }
    // A non-null source pointer is required even for empty input.
    const output = heapBase + input.byteLength;
    reserve(output);
    new Uint8Array(memory.buffer).set(input, heapBase);
    const length = size(heapBase, input.byteLength, syncTime) >>> 0;
    reserve(output + length);
    const written = write(output, length, heapBase, input.byteLength, syncTime) >>> 0;
    if (written !== length) {
      throw new Error(`Invalid melodica result: expected ${length} bytes, received ${written}`);
    }
    // Growth detaches old views; use the current buffer and copy before reuse.
    return new Uint8Array(memory.buffer, output, length).slice();
  }

  return Object.freeze({
    abiVersion,
    urlEncode(input) {
      return serialize(input, api.melodica_url_encode_size, api.melodica_url_encode);
    },
    jsonEscape(input) {
      return serialize(input, api.melodica_json_escape_size, api.melodica_json_escape);
    },
    stationListRequest(input, syncTime) {
      if (!Number.isInteger(syncTime) || syncTime < 0 || syncTime > 0xffffffff) {
        throw new RangeError('syncTime must be an unsigned 32-bit integer (0..4294967295)');
      }
      return serialize(input, api.melodica_station_list_request_size,
        api.melodica_station_list_request, syncTime);
    },
  });
}
