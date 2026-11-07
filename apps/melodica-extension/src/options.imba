# Options page: API endpoint (the default is Pandora's; CI points it at
# melodica-tuner), audio quality, remembered password.

import { browser, loadSettings, saveSettings, normalizeEndpoint, SETTINGS_DEFAULTS } from './shared.imba'

tag Options
	prop endpoint = ''
	prop quality = 'high'
	prop remember = no
	prop message = ''
	prop kind = ''
	prop version = ''
	prop granted = null
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
		loaded = yes
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

	def render
		<self>
			<main#options>
				<h1>
					"melodica options"
					<small> " {version}"
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
					<div.actions>
						<button#save.primary type="button" @click=save> "Save"
						<button#reset type="button" @click=reset> "Reset to Pandora"
					<p.message#options-message .error=(kind === 'error') .info=(kind === 'info')> message

imba.mount <Options>
