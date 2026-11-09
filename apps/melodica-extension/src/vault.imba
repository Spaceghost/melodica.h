# "Remember me on this device": the remembered Pandora login and session, sealed.
#
# One AES-GCM 256 key, generated with extractable: false and kept as a CryptoKey in
# the extension's own IndexedDB (database melodica-vault, store keys, key "vault");
# only {v, iv, ct} of the sealed record goes to storage.local ("vault"). Nothing is
# ever written to storage.sync. Forgetting deletes the record and the key.
#
# This keeps the password out of the profile's files as text (storage.local is a
# plain database on disk); it does not hide it from code running in the extension
# itself, which can use the key.

import { browser } from './shared.imba'

const DB = 'melodica-vault'
const STORE = 'keys'
const KEY_ID = 'vault'

export def vaultAvailable
	!!(globalThis.indexedDB and globalThis.crypto and crypto.subtle)

def request r
	new Promise do(ok, fail)
		r.onsuccess = do ok(r.result)
		r.onerror = do fail(r.error)

def openDb
	const r = indexedDB.open(DB, 1)
	r.onupgradeneeded = do r.result.createObjectStore(STORE) unless r.result.objectStoreNames.contains(STORE)
	await request(r)

def withStore mode, fn
	const db = await openDb()
	try
		const tx = db.transaction(STORE, mode)
		const out = await fn(tx.objectStore(STORE))
		await new Promise do(ok, fail)
			tx.oncomplete = do ok()
			tx.onerror = do fail(tx.error)
			tx.onabort = do fail(tx.error)
		out
	finally
		db.close()

def loadKey create
	let key = await withStore('readonly', do(s) request(s.get(KEY_ID)))
	return key if key or !create
	key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, no, ['encrypt', 'decrypt'])
	await withStore('readwrite', do(s) request(s.put(key, KEY_ID)))
	key

def b64 bytes
	let s = ''
	for b in new Uint8Array(bytes)
		s += String.fromCharCode(b)
	btoa(s)

def unb64 text
	const s = atob(text)
	const out = new Uint8Array(s.length)
	for i in [0 ... s.length]
		out[i] = s.charCodeAt(i)
	out

# Seal `record` (any JSON value) and store it; replaces the previous one.
export def seal record
	return no unless vaultAvailable()
	const key = await loadKey(yes)
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const ct = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, new TextEncoder().encode(JSON.stringify(record)))
	await browser.storage.local.set({vault: {v: 1, iv: b64(iv), ct: b64(ct)}})
	yes

# The stored record, or null (none, no key, or it does not decrypt).
export def unseal
	return null unless vaultAvailable()
	const got = (await browser.storage.local.get({vault: null})).vault
	return null unless got and got.v === 1 and typeof got.iv === 'string' and typeof got.ct === 'string'
	try
		const key = await loadKey(no)
		return null unless key
		const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(got.iv)}, key, unb64(got.ct))
		JSON.parse(new TextDecoder().decode(plain))
	catch e
		null

# Forget: the sealed record and the key.
export def wipe
	await browser.storage.local.remove('vault')
	return unless vaultAvailable()
	try
		await withStore('readwrite', do(s) request(s.delete(KEY_ID)))
	catch e
		null
