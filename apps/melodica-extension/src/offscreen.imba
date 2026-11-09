# Chromium's home for the playback engine: an offscreen document
# (chrome.offscreen, reason AUDIO_PLAYBACK) the background creates on the first
# play command and Chrome keeps alive while audio plays (it may close it about
# 30 s after playback stops; the background then recreates it and hands back
# the saved state). Only runtime messaging is available here, so Pandora calls
# go to the background as the pages' do, and every state change is sent to it.

import { browser, send } from './shared.imba'
import { Engine } from './engine.imba'

const engine = new Engine({
	api: {
		playlist: do(station, quality) (await send({type: 'playlist', stationToken: station.token, quality})).songs
		rate: do(trackToken, positive) send({type: 'rate', trackToken, positive})
		tired: do(trackToken) send({type: 'tired', trackToken})
		spotMetadata: do(placeholder, quality) (await send({type: 'spot-metadata', placeholder, quality})).spot
		registerSpot: do(s) send({type: 'register-spot', adToken: s.adToken, stationId: s.stationId, trackingTokens: s.trackingTokens})
	}
	report: do(state) browser.runtime.sendMessage({type: 'engine-state', state}).catch(do(e) null)
	remember: do(record, urgent) browser.runtime.sendMessage({type: 'engine-last', record, urgent: !!urgent}).catch(do(e) null)
	log: do(line)
		console.debug("melodica offscreen {line}")
		browser.runtime.sendMessage({type: 'engine-log', line: String(line).slice(0, 300)}).catch(do(e) null)
})

# Commands from the background: {type: 'engine', op, args}.
browser.runtime.onMessage.addListener do(msg, sender, sendResponse)
	return no unless msg and msg.type === 'engine' and typeof msg.op === 'string'
	const done = do sendResponse({ok: yes, state: engine.snapshot})
	const failed = do(e) sendResponse({ok: no, error: String(e and e.message or e), state: engine.snapshot})
	run(msg.op, msg.args or []).then(done, failed)
	yes

def run op, args
	switch op
		when 'play' then await engine.play(args[0])
		when 'resume' then await engine.resume()
		when 'pause' then engine.pause()
		when 'toggle' then await engine.toggle()
		when 'next' then await engine.skip()
		when 'stop' then engine.stop()
		when 'rate' then await engine.rate(!!args[0])
		when 'tired' then await engine.tired()
		when 'volume' then engine.setVolume(args[0])
		when 'quality' then engine.setQuality(args[0])
		when 'hydrate' then engine.hydrate(args[0])
		when 'state' then null
		else throw new Error("unknown engine op {op}")

# Tell the background this document is up and take back what the last one knew
# (station, volume, quality, the log, a paused track).
send({type: 'engine-hello'}).then((do(r) engine.hydrate(r.saved) if r and r.saved), (do(e) null))
