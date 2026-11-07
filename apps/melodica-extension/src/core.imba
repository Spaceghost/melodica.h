# JS side of the wasm core (core/melodica_core.nelua). Moves bytes across the
# boundary through the module's arena; everything else (JSON, HTTP) is done by
# the caller. Works in service workers, pages and Node.

const encoder = new TextEncoder
const decoder = new TextDecoder

export class Core
	static def load bytes
		const result = await WebAssembly.instantiate(bytes, {})
		new Core(result.instance, bytes.byteLength or bytes.length or 0)

	def constructor instance, size
		self.x = instance.exports
		self.wasmBytes = size
		self.abi = self.x.mx_abi()
		self.version = decoder.decode(self.bytes(self.x.mx_version(), self.x.mx_version_len()).slice(0))

	get mem
		new Uint8Array(self.x.memory.buffer)

	def bytes ptr, len
		self.mem.subarray(ptr, ptr + len)

	def init
		self.x.mx_init() === 1

	def initKeys encryptKey, decryptKey
		const e = encoder.encode(encryptKey)
		const d = encoder.encode(decryptKey)
		const pe = self.x.mx_alloc(e.length)
		const pd = self.x.mx_alloc(d.length)
		self.mem.set(e, pe)
		self.mem.set(d, pd)
		try
			self.x.mx_init_keys(pe, e.length, pd, d.length) === 1
		finally
			self.x.mx_free(pd)
			self.x.mx_free(pe)

	get ready
		self.x.mx_ready() === 1

	get arenaUsed
		self.x.mx_arena_used()

	get syncOffset
		self.x.mx_sync_offset()

	def setSyncOffset offset
		self.x.mx_set_sync_offset(offset | 0)

	def syncTime nowSeconds
		self.x.mx_sync_time(nowSeconds >>> 0)

	# Copy `data` (string or bytes) into the arena, run fn(ptr, len), release.
	def withInput data, fn
		const input = typeof data === 'string' ? encoder.encode(data) : data
		const p = self.x.mx_alloc(input.length)
		throw new Error('melodica core: arena exhausted') if p === 0
		self.mem.set(input, p)
		try
			fn(p, input.length)
		finally
			self.x.mx_free(p)

	# Run a sized export: op(src, len, dst, cap) returns the size required and
	# writes only when cap suffices. Returns a fresh Uint8Array or null when the
	# export rejected the input.
	def sized data, op
		self.withInput data, do(p, n)
			const need = op(p, n, 0, 0)
			return null if need === 0
			const out = self.x.mx_alloc(need)
			throw new Error('melodica core: arena exhausted') if out === 0
			try
				const written = op(p, n, out, need)
				return null if written !== need
				self.bytes(out, need).slice(0)
			finally
				self.x.mx_free(out)

	# Blowfish-ECB with the partner's encrypt key -> lowercase hex string.
	def encrypt text
		return '' if text === '' or (text and text.length === 0)
		const out = self.sized(text, do(p, n, d, c) self.x.mx_encrypt(p, n, d, c))
		out ? decoder.decode(out) : null

	# Hex -> plaintext bytes (NUL padding kept), or null for malformed input.
	def decryptHex hex
		self.sized(hex, do(p, n, d, c) self.x.mx_decrypt_hex(p, n, d, c))

	def hexEncode bytes
		return '' if bytes.length === 0
		const out = self.sized(bytes, do(p, n, d, c) self.x.mx_hex_encode(p, n, d, c))
		out ? decoder.decode(out) : null

	def hexDecode hex
		return new Uint8Array(0) if hex === ''
		self.sized(hex, do(p, n, d, c) self.x.mx_hex_decode(p, n, d, c))

	# auth.partnerLogin's syncTime -> server seconds (0 on failure); records the
	# offset against nowSeconds for syncTime()/envelope().
	def syncParse hex, nowSeconds
		self.withInput hex, do(p, n) self.x.mx_sync_parse(p, n, nowSeconds >>> 0)

	# JSON object text -> hex of the Blowfish-encrypted object with syncTime added.
	def envelope json, nowSeconds
		const out = self.sized(json, do(p, n, d, c) self.x.mx_envelope(p, n, nowSeconds >>> 0, d, c))
		out ? decoder.decode(out) : null
