# Bits shared by the extension pages, the background and the content script.

globalThis.browser = globalThis.chrome unless globalThis.browser

export const browser = globalThis.browser

export const SETTINGS_DEFAULTS = {
	endpoint: 'https://tuner.pandora.com/services/json/'
	quality: 'high'
	remember: no
	email: ''
	password: ''
	volume: 80
}

export def loadSettings
	const got = await browser.storage.local.get(SETTINGS_DEFAULTS)
	const s = Object.assign({}, SETTINGS_DEFAULTS, got)
	s.endpoint = normalizeEndpoint(s.endpoint)
	s

export def saveSettings patch
	await browser.storage.local.set(patch)

export def normalizeEndpoint value
	let text = String(value or '').trim()
	return SETTINGS_DEFAULTS.endpoint unless text
	try
		const u = new URL(text)
		u.search = ''
		u.hash = ''
		u.pathname += '/' unless u.pathname.endsWith('/')
		u.toString()
	catch e
		SETTINGS_DEFAULTS.endpoint

# Ask the background for something; resolves with its reply or throws.
export def send message
	const reply = await browser.runtime.sendMessage(message)
	throw new Error('The background script did not answer.') unless reply
	unless reply.ok
		const err = new Error(reply.error or 'Unknown error.')
		err.code = reply.code
		err.kind = reply.kind
		throw err
	reply

export def toBase64 bytes
	let s = ''
	let i = 0
	while i < bytes.length
		s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x4000))
		i += 0x4000
	btoa(s)

export def fromBase64 text
	const bin = atob(text or '')
	const out = new Uint8Array(bin.length)
	let i = 0
	while i < bin.length
		out[i] = bin.charCodeAt(i)
		i += 1
	out

export def fmtTime seconds
	return '0:00' unless Number.isFinite(seconds) and seconds >= 0
	const m = Math.floor(seconds / 60)
	const s = Math.floor(seconds % 60)
	const pad = s < 10 ? '0' : ''
	"{m}:{pad}{s}"

# Cover fallback: a gold record on ink.
const COVER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#111622"/><g fill="none" stroke="#d8b26a" stroke-width="1.2"><circle cx="60" cy="60" r="50"/><circle cx="60" cy="60" r="38" stroke-opacity="0.6"/><circle cx="60" cy="60" r="26" stroke-opacity="0.4"/></g><circle cx="60" cy="60" r="7" fill="#f0d9a4"/></svg>'
export const FALLBACK_COVER = 'data:image/svg+xml;utf8,' + encodeURIComponent(COVER_SVG)
