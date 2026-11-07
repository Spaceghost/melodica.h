# Options page: API endpoint (the default is Pandora's; CI points it at
# melodica-tuner), audio quality, remembered password.

import { browser, loadSettings, saveSettings, normalizeEndpoint, SETTINGS_DEFAULTS, send } from './shared.imba'
import { AUTH_BASE, normalizeAuthBase } from './github.imba'
import { gateLine, UpdateBanner } from './ui.imba'

const DIAG_LINES = 50

# Tokens never belong in a pasted bug report: query tokens, JSON token fields,
# anything that looks like a base64 blob of 20+ characters, and passwords.
export def redact text
	String(text)
		.replace(/(auth_token|user_id|partner_id)=([^&\s]+)/g, do(m, k, v) "{k}=[{v.length}chars]")
		.replace(/"(partnerAuthToken|userAuthToken|password)":"([^"]*)"/g, do(m, k, v) "\"{k}\":\"[{v.length}chars]\"")
		.replace(/password[=:]\s*\S+/gi, 'password=[redacted]')
		.replace(/[A-Za-z0-9+]{20,}={0,2}|[A-Za-z0-9+\/]{20,}={1,2}/g, do(m) "[{m.length}chars]")

tag Options
	prop endpoint = ''
	prop quality = 'high'
	prop remember = no
	prop message = ''
	prop kind = ''
	prop version = ''
	prop granted = null
	prop diagnostics = ''
	prop gate = null
	prop authBase = AUTH_BASE
	prop gateBusy = no
	prop update = null
	# The form is shown only once the stored settings are in; a value typed
	# before that would be overwritten when they arrived (seen in Brave, where
	# the page is interactive before storage answers).
	prop loaded = no

	def mount
		const s = await loadSettings()
		endpoint = s.endpoint
		quality = s.quality
		remember = s.remember
		version = browser.runtime.getManifest().version
		await checkPermission()
		await loadGate()
		self.notice = do(msg) onNotice(msg)
		browser.runtime.onMessage.addListener(self.notice)
		loaded = yes
		imba.commit()

	def unmount
		browser.runtime.onMessage.removeListener(self.notice) if self.notice

	def onNotice msg
		if msg and msg.type === 'gate'
			gate = msg.gate
			imba.commit()
		if msg and msg.type === 'update'
			update = msg.update
			imba.commit()
		no

	def reloadExtension
		try
			await send({type: 'update-reload'})
		catch e
			message = String(e.message or e)
			kind = 'error'

	def updateCheck
		try
			update = (await send({type: 'update-check'})).update
			message = update.banner ? update.banner.text : (update.latest ? "Up to date: {update.current} is the version the store serves." : "Could not read the store feed: {update.error}")
			kind = update.error and !update.latest ? 'error' : 'info'
		catch e
			message = String(e.message or e)
			kind = 'error'

	# The GitHub gate as the background knows it, and which auth server it asks
	# (the default Worker, or the `authBase` override the Firefox smoke uses).
	def loadGate
		try
			const got = await browser.storage.local.get({authBase: ''})
			authBase = normalizeAuthBase(got.authBase)
			gate = (await send({type: 'gate'})).gate
			update = (await send({type: 'update'})).update
		catch e
			gate = {mode: 'error', reason: String(e.message or e), login: '', exp: null}

	def gateAction type
		gateBusy = yes
		imba.commit()
		try
			gate = (await send({type})).gate
			message = type === 'github-signout' ? 'Signed out of GitHub.' : "GitHub gate: {gate.mode}."
			kind = 'info'
		catch e
			message = String(e.message or e)
			kind = 'error'
		gateBusy = no
		imba.commit()

	get origin
		try
			new URL(normalizeEndpoint(endpoint)).origin
		catch e
			''

	def checkPermission
		try
			granted = await browser.permissions.contains({origins: ["{origin}/*"]})
		catch e
			granted = null

	def save
		const value = normalizeEndpoint(endpoint)
		const patch = {endpoint: value, quality: quality, remember: remember}
		patch.password = '' unless remember
		await saveSettings(patch)
		endpoint = value
		message = "Saved. Requests go to {value}"
		kind = 'info'
		await checkPermission()

	def reset
		endpoint = SETTINGS_DEFAULTS.endpoint
		quality = SETTINGS_DEFAULTS.quality
		await save()

	# The last DIAG_LINES background log lines plus the environment, tokens
	# redacted, shown in the textarea and copied to the clipboard when allowed.
	def copyDiagnostics
		try
			const d = await send({type: 'diagnostics'})
			const lines = (d.lines or []).slice(-DIAG_LINES)
			const head = [
				"melodica-extension {d.version} core {d.core}"
				"browser {d.ua}"
				"endpoint {d.endpoint}; signed in: {d.loggedIn ? 'yes' : 'no'}; clock offset {d.syncOffset}s; request User-Agent: {d.userAgent}"
				"update: running {d.update and d.update.current}, store {d.update and d.update.latest or 'unknown'}, fetched {d.update and d.update.available or 'none'}, feed {d.update and d.update.feed}{d.update and d.update.error ? ' (' + d.update.error + ')' : ''}"
				"github gate: {d.gate ? d.gate.mode : '?'}{d.gate and d.gate.login ? ' ' + d.gate.login : ''}{d.gate and d.gate.reason ? ' (' + d.gate.reason + ')' : ''}; auth server {d.authBase}"
				"storage.session: {d.sessionStorage ? 'available' : 'missing (storage.local used)'}; background: {JSON.stringify(d.background)}"
				"permissions: {JSON.stringify(d.permissions)}"
				"last {lines.length} background log lines:"
			]
			diagnostics = redact(head.concat(lines).join('\n'))
			let copied = no
			try
				await navigator.clipboard.writeText(diagnostics)
				copied = yes
			catch e
				copied = no
			message = copied ? "Diagnostics copied to the clipboard ({lines.length} log lines)." : "Diagnostics shown below (the clipboard was not available); copy them from the box."
			kind = 'info'
		catch e
			message = "Could not collect diagnostics: {e.message or e}"
			kind = 'error'

	# Optional host permission for a non-Pandora endpoint (a relay or a test
	# server). Without it the endpoint must allow CORS, which melodica-tuner does.
	def grant
		try
			granted = await browser.permissions.request({origins: ["{origin}/*"]})
			message = granted ? "Access to {origin} granted." : "Access to {origin} was not granted; it must allow CORS."
			kind = granted ? 'info' : 'error'
		catch e
			message = String(e.message or e)
			kind = 'error'

	css
		main
			max-width: 560px
			margin: 0 auto
			padding: 24px 16px
			display: grid
			gap: 16px
		h1
			margin: 0
			font-size: 20px
			color: var(--gold-2)
		label
			display: grid
			gap: 4px
			color: var(--muted)
			font-size: 12px
		.row
			display: flex
			gap: 8px
			align-items: center
		.row input
			width: auto
		.actions
			display: flex
			gap: 8px
			flex-wrap: wrap
		.primary
			background: var(--gold)
			color: var(--ink)
			border-color: var(--gold)
			font-weight: 600
		p.help
			color: var(--muted)
			margin: 0
			font-size: 13px
		h2
			margin: 8px 0 0
			font-size: 15px
			color: var(--gold-2)
		textarea#diagnostics
			width: 100%
			min-height: 180px
			font: 11px/1.4 ui-monospace, monospace
			white-space: pre
			resize: vertical

	def render
		<self>
			<main#options>
				<h1>
					"melodica options"
					<small> " {version}"
				<UpdateBanner update=update @reload=reloadExtension>
				if !loaded
					<p.help#options-loading> "Loading settings…"
				else
					<label>
						"API endpoint"
						<input#endpoint type="url" bind=endpoint placeholder=SETTINGS_DEFAULTS.endpoint spellcheck=false>
					<p.help> "Default: {SETTINGS_DEFAULTS.endpoint} (Pandora's JSON API v5, reached directly with the extension's host permission). Point it at a melodica-tuner or a relay for testing."
					if origin and origin !== 'https://tuner.pandora.com'
						<div.row>
							<button#grant type="button" @click=grant> "Grant access to {origin}"
							<span.message#granted> (granted === yes ? "granted" : (granted === no ? "not granted (CORS needed)" : ''))
					<label>
						"Audio quality"
						<select#quality bind=quality>
							<option value="high"> "high"
							<option value="medium"> "medium"
							<option value="low"> "low"
					<label.row>
						<input#remember type="checkbox" bind=remember>
						"Remember the password on this device (kept unencrypted in extension storage)"
					<h2> "GitHub gate"
					<p.help#options-gate> "melodica requires a GitHub sign-in. GitHub sign-in is used for identity only; nothing is stored. {authBase} is asked whether the signed-in account may use melodica. Status: {gateLine(gate) or 'unknown'}"
					if authBase !== AUTH_BASE
						<p.help#options-authbase> "Auth server overridden (storage key authBase): {authBase}. Default: {AUTH_BASE}"
					<div.actions>
						if gate and (gate.mode === 'anon' or gate.mode === 'error')
							<button#options-github-signin type="button" disabled=gateBusy @click=gateAction('github-signin')> "Sign in with GitHub"
						<button#options-gate-check type="button" disabled=gateBusy @click=gateAction('gate-check')> "Check again"
						if gate and gate.login
							<button#options-github-signout type="button" disabled=gateBusy @click=gateAction('github-signout')> "Sign out"
					<h2> "Updates"
					<p.help#options-update> "Firefox and .crx or policy installs update themselves from the feeds on spacegho.st/extensions; an unpacked zip only gets the banner. Running {update and update.current or version}; the store serves {update and update.latest or 'unknown'}{update and update.checkedAt ? ', checked ' + new Date(update.checkedAt).toLocaleString() : ''}."
					<div.actions>
						<button#options-update-check type="button" @click=updateCheck> "Check for updates"
					<div.actions>
						<button#save.primary type="button" @click=save> "Save"
						<button#reset type="button" @click=reset> "Reset to Pandora"
						<button#copy-diagnostics type="button" title="The last {DIAG_LINES} background log lines (tokens redacted) for a bug report" @click=copyDiagnostics> "Copy diagnostics"
					<p.message#options-message .error=(kind === 'error') .info=(kind === 'info')> message
					if diagnostics
						<label>
							"Diagnostics (tokens redacted)"
							<textarea#diagnostics readonly spellcheck=false bind=diagnostics>

imba.mount <Options>
