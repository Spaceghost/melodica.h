# Tags shared by the popup, the player page and the options page. They render
# melodica-web's markup classes (public/theme.css part 1 is its stylesheet):
# .card / .login-card with the ring .mark, .eyebrow, serif h2, button.primary,
# the .now card with .stage / .controls / button.round, .panel, .station-list.
# No scoped css here: the look is the shared stylesheet's.

import { FALLBACK_COVER, fmtTime } from './shared.imba'

# Is the gate open: not applied (`off`) or an allowed account.
export def gateAllowed g
	!!g and (g.mode === 'off' or g.mode === 'allowed')

# One status line about the GitHub gate, shown wherever Pandora is reachable.
export def gateLine g
	return '' unless g
	switch g.mode
		when 'off' then "GitHub gate off: {g.reason}"
		when 'allowed' then "GitHub: {g.login}{g.stale ? ' (last check failed: ' + g.stale + ')' : ''}"
		when 'denied' then "GitHub: {g.login} (melodica is not available for this account)"
		when 'error' then "GitHub gate: {g.reason}"
		else "GitHub: not signed in"

# The concentric-rings mark of the sign-in cards.
export tag Mark
	def render
		<self.mark aria-hidden="true">
			<svg viewBox="0 0 120 120">
				<circle cx="60" cy="60" r="54">
				<circle cx="60" cy="60" r="38">
				<circle cx="60" cy="60" r="22">
				<circle.dot cx="60" cy="60" r="7">

# The page header: "melodica <tag>" and the page's own buttons (slot).
export tag Top
	prop label = 'extension'
	prop version = ''
	def render
		<self.top>
			<h1.brand>
				"melodica "
				<span.brand-tag> label
			<div.top-right>
				<slot>

# The mono footer: status lines and the version.
export tag Foot
	prop version = ''
	def render
		<self.foot>
			<slot>
			<span>
				"melodica-extension {version} · "
				<a href="https://spacegho.st/extensions/#melodica-extension" target="_blank" rel="noopener"> "spacegho.st/extensions"
				" · MIT / libpiano"

# "melodica <v> is available": shown by every page when the store serves a newer
# version than the running one (the update check in bg.imba). On Chromium, once
# the browser has fetched the update, a Reload button installs it.
export tag UpdateBanner
	prop update = null
	prop busy = no

	def render
		const b = update and update.banner
		<self[display:contents]>
			if b
				<div#update-banner.panel.ext-banner data-version=b.version>
					<span#update-text> b.text
					<a#update-link href=b.url target="_blank" rel="noopener"> "Get it"
					if b.reload and update.canReload
						<button#update-reload type="button" disabled=busy @click=emit('reload')> "Reload to update"

# The gate screen: the GitHub sign-in card, or the not-available card. Shown
# instead of the Pandora login whenever the gate is closed.
export tag Gate
	prop gate = null
	prop busy = no
	prop message = ''

	def render
		const g = gate or {mode: 'anon', reason: ''}
		const anon = g.mode !== 'denied' and g.mode !== 'error'
		<self.view.login>
			<section#gate.card.login-card data-mode=g.mode>
				<Mark>
				<p.eyebrow> "melodica"
				<h2> (anon ? "Sign in with GitHub" : (g.mode === 'denied' ? "Not available" : "Could not check"))
				<p#gate-message.intro>
					if g.mode === 'denied'
						"melodica is not available for your GitHub account ({g.login})."
					elif g.mode === 'error'
						"Could not check the GitHub sign-in: {g.reason}. Press Check again."
					else
						"melodica requires a GitHub sign-in, then sign in to Pandora as usual."
				if anon and g.reason and g.reason !== 'not signed in with GitHub'
					<p#gate-reason.fine> g.reason
				if anon
					<button#github-signin.primary type="button" disabled=busy @click=emit('signin')> (busy ? "Opening GitHub…" : "Sign in with GitHub")
				else
					<button#gate-check.primary type="button" disabled=busy @click=emit('check')> (busy ? "Checking…" : "Check again")
					<button#github-signout.quiet type="button" disabled=busy @click=emit('signout')> "Sign out"
				if message
					<p#gate-error.message.error role="alert"> message
				<p#gate-note.fine> "GitHub sign-in is used for identity only; nothing is stored."

export tag Login
	prop email = ''
	prop password = ''
	prop remember = no
	prop busy = no
	prop message = ''
	prop kind = ''

	def submit
		emit('login', {email: email.trim(), password, remember})

	def render
		<self.view.login>
			<form#login-form.card.login-card autocomplete="on" @submit.prevent=submit>
				<Mark>
				<p.eyebrow> "Pandora · US accounts"
				<h2> "Sign in to Pandora"
				<label.field>
					<span> "Email"
					<input#login-email type="email" autocomplete="username" required bind=email>
				<label.field>
					<span> "Password"
					<input#login-password type="password" autocomplete="current-password" required bind=password>
				<label.check>
					<input#login-remember type="checkbox" bind=remember>
					<span> "Remember password on this device"
				if remember
					<p#remember-warning.warn> "The password is kept in the extension's local storage, unencrypted."
				<button#login-button.primary type="submit" disabled=busy> (busy ? "Signing in…" : "Sign in")
				<p#login-message.message .error=(kind === 'error') .info=(kind === 'info') role="status"> message
				<p.fine> "Sign-in and every Pandora call go from the extension straight to Pandora; no relay sees them."

export tag StationList
	prop stations = []
	prop active = null
	prop filter = ''
	prop compact = no

	get shown
		const q = filter.trim().toLowerCase()
		const list = stations.filter(do(s) !q or (s.name or '').toLowerCase().includes(q))
		list.sort do(a, b)
			return (a.isQuickMix ? -1 : 1) if a.isQuickMix !== b.isQuickMix
			(a.name or '').localeCompare(b.name or '', undefined, {sensitivity: 'base'})
		list

	def render
		<self.panel.ext-stations>
			<div.rail-head>
				<h2>
					"Stations"
					<span.count#station-count> (stations.length ? "{shown.length} of {stations.length}" : '')
				<button#refresh-stations.icon type="button" aria-label="Reload the station list" title="Reload the station list" @click=emit('refresh')>
					<svg aria-hidden="true" viewBox="0 0 24 24">
						<path d="M23 4v6h-6">
						<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10">
			<input#station-filter.filter type="search" placeholder="Filter stations" aria-label="Filter stations" autocomplete="off" bind=filter>
			<ul#station-list.station-list>
				for s in shown
					<li .active=(active and s.token === active) data-token=s.token>
						<button.station type="button" title=s.name aria-current=(active and s.token === active ? 'true' : null) @click=emit('select', s)> s.name
						if !compact and !s.isQuickMix and s.allowDelete
							<button.delete type="button" title="Delete station {s.name}" aria-label="Delete station {s.name}" @click=emit('delete', s)> "×"
			if stations.length === 0
				<p.fine#station-empty> "No stations yet."

# The now-playing stage: cover, station, title, artist, album, quality, progress.
export tag NowPlaying
	prop now = null
	prop compact = no

	def render
		const song = now and now.song
		<self.stage .idle=!song aria-label="Now playing">
			<figure.art>
				<img.cover#np-cover src=(song and song.coverArt or FALLBACK_COVER) alt=(song and song.album ? "Cover of {song.album}" : '')>
			<div.meta>
				<p.eyebrow.station-name#np-station> (song and now.station ? "on {now.station.name}" : '')
				<h2.title#np-title> (song ? song.title : "Pick a station")
				<p.artist#np-artist> (song ? song.artist : '')
				if !compact
					<p.album#np-album> (song and song.album or '')
				if song and song.audioFormat
					<p.line>
						<span.chip#np-quality> "{song.quality} · {song.audioFormat}"
			if song and !compact
				<div.progress>
					<span#np-time-cur> fmtTime(now.position or 0)
					<progress#np-progress max=(now.duration or song.duration or 1) value=(now.position or 0) aria-label="Playback position">
					<span#np-time-len> fmtTime(now.duration or song.duration or 0)

export tag Transport
	prop now = null

	def render
		const song = now and now.song
		const rating = song and song.rating or 0
		const playing = now and !now.paused
		<self.controls-bar>
			<div.controls role="group" aria-label="Playback controls">
				<button#love.round type="button" .on=(rating === 1) aria-pressed=(rating === 1 ? 'true' : 'false') title="Love this song" aria-label="Love" disabled=!song @click=emit('control', 'love')>
					<svg aria-hidden="true" viewBox="0 0 24 24">
						<path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3">
				<button#ban.round type="button" .off=(rating === 2) aria-pressed=(rating === 2 ? 'true' : 'false') title="Ban this song (skips)" aria-label="Ban" disabled=!song @click=emit('control', 'ban')>
					<svg aria-hidden="true" viewBox="0 0 24 24">
						<path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17">
				<button#play.round.big type="button" data-state=(playing ? 'playing' : 'paused') aria-label=(playing ? 'Pause' : 'Play') title="Play / pause" @click=emit('control', 'toggle')>
					<svg.ico-play aria-hidden="true" viewBox="0 0 24 24">
						<path.fill d="M8 5v14l11-7z">
					<svg.ico-pause aria-hidden="true" viewBox="0 0 24 24">
						<path.fill d="M6 5h4v14H6zM14 5h4v14h-4z">
				<button#next.round type="button" title="Next song" aria-label="Next song" disabled=!song @click=emit('control', 'next')>
					<svg aria-hidden="true" viewBox="0 0 24 24">
						<path.fill d="M5 5v14l10-7zM17 5h2v14h-2z">
				<button#tired.round type="button" title="Tired of this song (a month off)" aria-label="Tired" disabled=!song @click=emit('control', 'tired')>
					<svg aria-hidden="true" viewBox="0 0 24 24">
						<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z">
