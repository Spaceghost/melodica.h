# Tags shared by the popup, the player page and the options page. They render
# melodica-web's markup classes (public/theme.css part 1 is its stylesheet):
# .card / .login-card with the ring .mark, .eyebrow, serif h2, button.primary,
# the .now card with .stage / .controls / button.round, .panel, .station-list.
# No scoped css here: the look is the shared stylesheet's.

import { FALLBACK_COVER, fmtTime, send } from './shared.imba'
import { listenUri } from './listen-uri.js'

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
				<a href="https://spacegho.st/melodica/extension/" target="_blank" rel="noopener"> "spacegho.st/melodica/extension"
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

# The optional spacegho.st account: who is signed in (display name or email), or a
# button to sign in. Nothing else about the account is shown.
export tag AccountLine
	prop account = null
	prop busy = no
	prop message = ''

	def render
		const a = account or {}
		<self.ext-account-line>
			if a.signedIn
				<span#account-label title="spacegho.st account"> a.label
				<button#account-signout.link type="button" disabled=busy @click=emit('signout')> "Sign out of spacegho.st"
			else
				<button#account-signin.link type="button" disabled=busy @click=emit('signin')> (busy ? "Opening spacegho.st…" : "Sign in with spacegho.st")
			if message
				<span#account-error.message.error role="alert"> message

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
					<span> "Remember me on this device"
				<button#login-button.primary type="submit" disabled=busy> (busy ? "Signing in…" : "Sign in")
				<p#login-message.message .error=(kind === 'error') .info=(kind === 'info') role="status"> message
				<button#login-github.quiet type="button" disabled=busy @click=emit('github')> "Sign in with GitHub"
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
	prop idleTitle = 'Pick a station'

	def render
		const song = now and now.song
		<self.stage .idle=!song aria-label="Now playing">
			<img.wash src=(song and song.coverArt or 'data:,') alt="" aria-hidden="true">
			<figure.art>
				<img.cover#np-cover src=(song and song.coverArt or FALLBACK_COVER) alt=(song and song.album ? "Cover of {song.album}" : '')>
			<div.meta>
				<p.eyebrow.station-name#np-station> (song and !song.ad and now.station ? "on {now.station.name}" : '')
				<h2.title#np-title> (song ? song.title : idleTitle)
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
		# While `track.ad` is set only play/pause works.
		const fixed = !song or !!song.ad
		<self.controls-bar>
			<div.controls role="group" aria-label="Playback controls">
				<button#love.round type="button" .on=(rating === 1) aria-pressed=(rating === 1 ? 'true' : 'false') title="Love this song" aria-label="Love" disabled=fixed @click=emit('control', 'love')>
					<svg aria-hidden="true" viewBox="0 0 24 24">
						<path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3">
				<button#ban.round type="button" .off=(rating === 2) aria-pressed=(rating === 2 ? 'true' : 'false') title="Ban this song (skips)" aria-label="Ban" disabled=fixed @click=emit('control', 'ban')>
					<svg aria-hidden="true" viewBox="0 0 24 24">
						<path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17">
				<button#play.round.big type="button" data-state=(playing ? 'playing' : 'paused') aria-label=(playing ? 'Pause' : 'Play') title="Play / pause" @click=emit('control', 'toggle')>
					<svg.ico-play aria-hidden="true" viewBox="0 0 24 24">
						<path.fill d="M8 5v14l11-7z">
					<svg.ico-pause aria-hidden="true" viewBox="0 0 24 24">
						<path.fill d="M6 5h4v14H6zM14 5h4v14h-4z">
				<button#next.round type="button" title="Next song" aria-label="Next song" disabled=fixed @click=emit('control', 'next')>
					<svg aria-hidden="true" viewBox="0 0 24 24">
						<path.fill d="M5 5v14l10-7zM17 5h2v14h-2z">
				<button#tired.round type="button" title="Tired of this song (a month off)" aria-label="Tired" disabled=fixed @click=emit('control', 'tired')>
					<svg aria-hidden="true" viewBox="0 0 24 24">
						<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z">

def ago at
	const s = Math.max(0, Math.floor(Date.now() / 1000) - (Number(at) or 0))
	return 'now' if s < 60
	return "{Math.floor(s / 60)} min ago" if s < 3600
	return "{Math.floor(s / 3600)} h ago" if s < 86400
	"{Math.floor(s / 86400)} d ago"

# Recent listens (Spaceghost Scrobbles), compact: titles and artists render as text.
export tag RecentListens
	prop recent = null
	prop max = 5
	def render
		const r = recent or {}
		const list = (r.listens or []).slice(0, max)
		const pages = r.pages or {}
		<self.card.ext-recent>
			<h3.ext-recent-head> "Recent listens"
			if list.length
				<ol#recent-listens.ext-recent-list>
					for l in list
						<li.ext-recent-item>
							<span.ext-recent-title> l.title
							<span.ext-recent-artist> l.artist
							<span.ext-recent-when.fine> ago(l.listened_at)
			else
				<p#recent-empty.fine> "No listens yet."
			<p.ext-recent-links.fine>
				<a#link-listens href=pages.listens target="_blank" rel="noopener"> "Listens"
				" · "
				<a#link-leaderboard href=pages.leaderboard target="_blank" rel="noopener"> "Leaderboard"
				if r.crew
					" · "
					<a#link-map href=pages.map target="_blank" rel="noopener"> "Map"
				" · "
				<a#link-account href=pages.account target="_blank" rel="noopener"> "Account"
				" · "
				<a#link-melodica href=pages.home target="_blank" rel="noopener"> "melodica"

# "Copy listen link" (melodica-scrobble docs/LISTEN-URI.md): the https form of the
# current song's artist, the link that opens it everywhere.
export tag CopyListen
	prop song = null
	prop copied = ''
	def copy
		const f = song and song.artist and !song.ad ? listenUri({target: 'artist', name: String(song.artist).trim()}) : null
		return copied = "That artist has no listen link." unless f
		try
			await window.navigator.clipboard.writeText(f.https)
			copied = "Copied {f.https}"
		catch e
			copied = "Copy failed: {f.https}"
		window.setTimeout((do copied = ''; imba.commit()), 4000)
	def render
		<self.ext-copy-listen>
			<button#copy-listen.quiet type="button" disabled=!(song and song.artist and !song.ad) @click=copy> "Copy listen link"
			<p#copy-listen-done.ext-copy-done role="status"> copied

# A listen link opened in the extension (player.html?listen=…): artist, genre and
# station links offer Play; a link never starts playback by itself.
export tag ListenPrompt
	prop link = null
	prop busy = no
	prop error = ''
	def play
		busy = yes
		error = ''
		try
			if link.target === 'station'
				await send({type: 'player', action: 'play', station: {token: link.station, name: ''}})
			else
				await send({type: 'play-seed', kind: link.target, name: link.name})
			emit('done')
		catch e
			error = String(e and e.message or e)
		busy = no
	def render
		<self.card.ext-listen-prompt>
			<p#listen-title> (link.target === 'station' ? "Station {link.station}" : "{link.target === 'artist' ? 'Artist' : 'Genre'}: {link.name}")
			<div.ext-actions>
				<button#listen-play type="button" disabled=busy @click=play> "Play"
				<button#listen-dismiss.quiet type="button" @click=emit('done')> "Not now"
			<p#listen-error.ext-listen-error role="alert"> error

# The first-run scrobbling notice; nothing is sent until it has been seen.
export tag ScrobbleNotice
	prop scrobbling = null
	def seen
		try
			await send({type: 'scrobble-notice-seen'})
		catch e
			null
	def render
		<self.card.ext-scrobble-notice>
			<p#scrobble-notice role="status"> scrobbling and scrobbling.notice
			<div.ext-actions>
				<button#scrobble-notice-ok type="button" @click=seen> "OK"

# "Pick a username" (docs/ACCOUNT.md, Usernames): shown while the name is a generated
# one, until it is saved or "Not now" (asked again at a later login). The server's
# 409/422/423/429 text is shown under the field. Names render as text only.
export tag UsernamePick
	prop user = null
	prop name = null
	prop busy = no
	prop error = ''

	def save
		busy = yes
		error = ''
		try
			await send({type: 'username-set', username: String(name === null ? (user and user.suggested or '') : name)})
			name = null
		catch e
			error = String(e and e.message or e)
		busy = no
		imba.commit()

	def later
		try
			await send({type: 'username-later'})
		catch e
			null

	def render
		const u = user or {}
		name = u.suggested or '' if name === null
		<self.card.ext-username-pick>
			<form#username-pick-form autocomplete="off" @submit.prevent=save>
				<h3#username-pick-head> "Pick a username"
				if u.notice === 'renamed_github'
					<p#username-pick-notice.warn role="status"> "Your earlier username belonged to a GitHub account and went to that account. Pick a new one."
				<p.fine>
					"It is the name melodica shows for you. Until you pick one, you are "
					<b#username-pick-current> u.username
					"."
				<label.field>
					<span> "Username"
					<input#username-pick-input type="text" autocapitalize="none" spellcheck="false" maxlength="24" bind=name>
				<p#username-pick-message.message .error=!!error role="status"> error
				<div.ext-username-actions>
					<button#username-pick-later.quiet type="button" disabled=busy @click=later> "Not now"
					<button#username-pick-save.primary type="submit" disabled=busy> (busy ? "Saving…" : "Save")

# "Change username" on the options page.
export tag UsernameChange
	prop user = null
	prop name = null
	prop busy = no
	prop message = ''
	prop kind = ''

	def save
		busy = yes
		message = ''
		try
			await send({type: 'username-set', username: String(name or '')})
			name = null
			message = 'Saved.'
			kind = 'info'
		catch e
			message = String(e and e.message or e)
			kind = 'error'
		busy = no
		imba.commit()

	def render
		const u = user or {}
		name = u.username or '' if name === null
		<self.ext-username-change>
			<form#username-change autocomplete="off" @submit.prevent=save>
				<label.field>
					<span> "Change username"
					<div.ext-username-row>
						<input#username-change-input type="text" autocapitalize="none" spellcheck="false" maxlength="24" bind=name>
						<button#username-change-save type="submit" disabled=busy> (busy ? "Saving…" : "Save")
				<p#username-change-message.message .error=(kind === 'error') .info=(kind === 'info') role="status"> message
