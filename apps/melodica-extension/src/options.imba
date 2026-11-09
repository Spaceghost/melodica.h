# Options page: API endpoint (the default is Pandora's; CI points it at
# melodica-tuner), audio quality, remembered password.

import { browser, loadSettings, saveSettings, normalizeEndpoint, SETTINGS_DEFAULTS, send } from './shared.imba'
import { ACCOUNT_BASE, normalizeAccountBase } from './account.imba'
import { AccountLine, UpdateBanner, Top, Foot, Mark, UsernameChange } from './ui.imba'

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
	prop rememberLoaded = no
	prop message = ''
	prop kind = ''
	prop version = ''
	prop granted = null
	prop diagnostics = ''
	prop account = null
	prop accountBase = ACCOUNT_BASE
	prop accountBusy = no
	prop update = null
	prop user = null
	# The form is shown only once the stored settings are in; a value typed
	# before that would be overwritten when they arrived (seen in Brave, where
	# the page is interactive before storage answers).
	prop loaded = no

	def mount
		const s = await loadSettings()
		endpoint = s.endpoint
		quality = s.quality
		remember = s.remember
		rememberLoaded = s.remember
		version = browser.runtime.getManifest().version
		await checkPermission()
		await loadAccount()
		self.notice = do(msg) onNotice(msg)
		browser.runtime.onMessage.addListener(self.notice)
		loaded = yes
		imba.commit()

	def unmount
		browser.runtime.onMessage.removeListener(self.notice) if self.notice

	def onNotice msg
		if msg and msg.type === 'account'
			account = msg.account
			imba.commit()
		if msg and msg.type === 'update'
			update = msg.update
			imba.commit()
		if msg and msg.type === 'player-state' and msg.state and msg.state.user
			const was = user and user.username
			user = msg.state.user
			imba.commit() if user.username !== was
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

	# The optional spacegho.st account as the background knows it, and which account
	# server it asks (spacegho.st, or the `accountBase` override the Firefox smoke uses).
	def loadAccount
		try
			const got = await browser.storage.local.get({accountBase: ''})
			accountBase = normalizeAccountBase(got.accountBase)
			account = (await send({type: 'account'})).account
			update = (await send({type: 'update'})).update
			user = (await send({type: 'username-me'})).user
		catch e
			account = null

	def accountAction type
		accountBusy = yes
		imba.commit()
		try
			account = (await send({type})).account
			message = account and account.signedIn ? "Signed in to spacegho.st as {account.label}." : 'Not signed in to spacegho.st.'
			kind = 'info'
		catch e
			message = String(e.message or e)
			kind = 'error'
		accountBusy = no
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
		await saveSettings({endpoint: value, quality: quality})
		# Unticking "Remember me" forgets the sealed login and its key (bg.imba); sent
		# only when the box changed, so saving the endpoint never touches it.
		if !!remember !== !!rememberLoaded
			remember = (await send({type: 'remember', on: !!remember})).remember
			rememberLoaded = remember
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
				"spacegho.st account: {d.account and d.account.signedIn ? 'signed in' : 'not signed in'}{d.account and d.account.error ? ' (' + d.account.error + ')' : ''}; account server {d.accountBase}"
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

	def render
		<self.ext-root>
			<Top label="options">
			<main#app.app>
				<div#options.view>
					<UpdateBanner update=update @reload=reloadExtension>
					<div.ext-opts>
						<section.card>
							<Mark>
							<p.eyebrow[ta:center]> "melodica extension {version}"
							<h2[ta:center mb:1rem]> "Options"
							if !loaded
								<p.fine#options-loading> "Loading settings…"
							else
								<div.ext-form>
									<label.field>
										<span> "API endpoint"
										<input#endpoint type="url" bind=endpoint placeholder=SETTINGS_DEFAULTS.endpoint spellcheck=false>
									<p.fine> "Default: {SETTINGS_DEFAULTS.endpoint} (Pandora's JSON API v5, reached directly with the extension's host permission). Point it at a melodica-tuner or a relay for testing."
									if origin and origin !== 'https://tuner.pandora.com'
										<div.ext-actions>
											<button#grant type="button" @click=grant> "Grant access to {origin}"
											<span.message#granted> (granted === yes ? "granted" : (granted === no ? "not granted (CORS needed)" : ''))
									<label.field>
										<span> "Audio quality"
										<select#quality bind=quality>
											<option value="high"> "high"
											<option value="medium"> "medium"
											<option value="low"> "low"
									<label.check>
										<input#remember type="checkbox" bind=remember>
										<span> "Remember me on this device"
									<div.ext-actions>
										<button#save.primary type="button" @click=save> "Save"
										<button#reset type="button" @click=reset> "Reset to Pandora"
									<p.message#options-message .error=(kind === 'error') .info=(kind === 'info')> message
						if loaded
							<div.ext-opts-side>
								<section.panel.ext-form#options-account>
									<h3> "spacegho.st account"
									<p.fine> "Optional. melodica works without it; signing in only links this browser to your spacegho.st account."
									if accountBase !== ACCOUNT_BASE
										<p.fine#options-accountbase> "Account server overridden (storage key accountBase): {accountBase}. Default: {ACCOUNT_BASE}"
									<AccountLine account=account busy=accountBusy @signin=accountAction('account-signin') @signout=accountAction('account-signout')>
									if user and user.username
										<p.fine#options-username> "Your melodica username: {user.username}"
										<UsernameChange user=user>
								<section.panel.ext-form>
									<h3> "Updates"
									<p.fine#options-update> "Firefox and .crx or policy installs update themselves from the feeds on spacegho.st/extensions; an unpacked zip only gets the banner. Running {update and update.current or version}; the store serves {update and update.latest or 'unknown'}{update and update.checkedAt ? ', checked ' + new Date(update.checkedAt).toLocaleString() : ''}."
									<div.ext-actions>
										<button#options-update-check type="button" @click=updateCheck> "Check for updates"
								<section.panel.ext-form>
									<h3> "Diagnostics"
									<p.fine> "The last {DIAG_LINES} background log lines, tokens redacted, for a bug report."
									<div.ext-actions>
										<button#copy-diagnostics type="button" @click=copyDiagnostics> "Copy diagnostics"
									if diagnostics
										<textarea#diagnostics readonly spellcheck=false aria-label="Diagnostics (tokens redacted)" bind=diagnostics>
			<Foot version=version>

imba.mount <Options>
