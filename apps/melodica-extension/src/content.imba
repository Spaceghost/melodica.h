# Bridge content script for https://spacegho.st/melodica/app/*: lets the web
# client skip its relay by routing Pandora calls through the extension.
#
# Protocol (window.postMessage, same window, same origin, data.melodica === 1):
#   page -> {melodica:1, type:'hello'}
#   ext  -> {melodica:1, type:'ready', name:'melodica-extension', version}
#   page -> {melodica:1, type:'request', id, search:'?method=…', body:Uint8Array}
#   ext  -> {melodica:1, type:'response', id, ok, status, body:Uint8Array, error}
# The extension also announces 'ready' once when it loads. Only searches whose
# method matches /^[a-z]+\.[A-Za-z]+$/ are forwarded; the background POSTs the
# body to <endpoint><search> with content-type text/plain and no cookies.

import { browser, toBase64, fromBase64 } from './shared.imba'

const NAME = 'melodica-extension'
const VERSION = browser.runtime.getManifest().version
const METHOD = /^[a-z]+\.[A-Za-z]+$/

def announce
	window.postMessage({melodica: 1, type: 'ready', name: NAME, version: VERSION}, location.origin)

def methodOf search
	return null unless typeof search === 'string' and search.startsWith('?') and search.length < 4096
	return null if search.includes('#')
	const method = new URLSearchParams(search).get('method')
	method and METHOD.test(method) ? method : null

def bodyBytes body
	return body if body isa Uint8Array
	return new Uint8Array(body) if body isa ArrayBuffer
	return new Uint8Array(body.buffer, body.byteOffset, body.byteLength) if body and ArrayBuffer.isView(body)
	return Uint8Array.from(body) if Array.isArray(body)
	return new TextEncoder().encode(body) if typeof body === 'string'
	new Uint8Array(0)

def handleRequest data
	const id = String(data.id)
	const reply = do(fields)
		window.postMessage(Object.assign({melodica: 1, type: 'response', id}, fields), location.origin)
	const failed = do(error, status = 0)
		reply({ok: no, status, body: new Uint8Array(0), error})
	return failed('method not allowed') unless methodOf(data.search)
	try
		const r = await browser.runtime.sendMessage({type: 'bridge', search: data.search, body: toBase64(bodyBytes(data.body))})
		return failed('the extension did not answer') unless r
		return failed(r.error or 'extension error') unless r.ok
		reply({ok: !!r.fetchOk, status: Number(r.status) or 0, body: fromBase64(r.body), error: undefined})
	catch e
		failed(String(e and e.message or e))

window.addEventListener 'message', do(event)
	return unless event.source === window and event.origin === location.origin
	const data = event.data
	return unless data and typeof data === 'object' and data.melodica === 1
	if data.type === 'hello'
		announce()
	elif data.type === 'request'
		handleRequest(data)

announce()
