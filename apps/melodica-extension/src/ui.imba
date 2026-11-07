# Tags shared by the popup and the player page.

import { FALLBACK_COVER, fmtTime } from './shared.imba'

export tag Login
	prop email = ''
	prop password = ''
	prop remember = no
	prop busy = no
	prop message = ''
	prop kind = ''

	def submit
		emit('login', {email: email.trim(), password, remember})

	css
		form
			display: grid
			gap: 10px
		label
			display: grid
			gap: 4px
			color: var(--muted)
			font-size: 12px
		.row
			display: flex
			align-items: center
			gap: 8px
			color: var(--muted)
		.row input
			width: auto
		.primary
			background: var(--gold)
			color: var(--ink)
			border-color: var(--gold)
			font-weight: 600
		small
			color: var(--muted)

	def render
		<self>
			<form#login-form @submit.prevent=submit>
				<label>
					"Email"
					<input#login-email type="email" autocomplete="username" required bind=email>
				<label>
					"Password"
					<input#login-password type="password" autocomplete="current-password" required bind=password>
				<label.row>
					<input#login-remember type="checkbox" bind=remember>
					"Remember password on this device"
				if remember
					<small#remember-warning> "The password is kept in the extension's local storage, unencrypted."
				<button#login-button.primary type="submit" disabled=busy> (busy ? "Signing in…" : "Sign in")
				<div#login-message.message .error=(kind === 'error') .info=(kind === 'info')> message

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

	css
		ul
			list-style: none
			margin: 0
			padding: 0
			display: grid
			gap: 4px
		li
			display: flex
			gap: 4px
		button.station
			flex: 1
			text-align: left
			overflow: hidden
			text-overflow: ellipsis
			white-space: nowrap
			background: var(--panel)
		li.active button.station
			border-color: var(--gold)
			color: var(--gold-2)
		button.delete
			padding: 6px 8px
			color: var(--muted)
		.tools
			display: flex
			gap: 6px
			margin-bottom: 8px
			align-items: center
		.count
			color: var(--muted)
			font-size: 12px
			white-space: nowrap
		.empty
			color: var(--muted)
			padding: 8px 0

	def render
		<self>
			<div.tools>
				<input#station-filter type="search" placeholder="Filter stations" aria-label="Filter stations" bind=filter>
				<span.count#station-count> (stations.length ? "{shown.length} of {stations.length}" : '')
				<button#refresh-stations title="Reload the station list" @click=emit('refresh')> "↻"
			<ul#station-list>
				for s in shown
					<li .active=(active and s.token === active) data-token=s.token>
						<button.station type="button" title=s.name aria-current=(active and s.token === active ? 'true' : null) @click=emit('select', s)> s.name
						if !compact and !s.isQuickMix and s.allowDelete
							<button.delete type="button" title="Delete station {s.name}" aria-label="Delete station {s.name}" @click=emit('delete', s)> "×"
			if stations.length === 0
				<p.empty#station-empty> "No stations yet."

export tag NowPlaying
	prop now = null
	prop compact = no

	css
		.stage
			display: grid
			grid-template-columns: 72px 1fr
			gap: 12px
			align-items: center
		.stage.big
			grid-template-columns: 160px 1fr
		img.cover
			width: 100%
			aspect-ratio: 1
			border-radius: 10px
			object-fit: cover
			background: var(--panel)
		.title
			font-weight: 600
			font-size: 15px
		.big .title
			font-size: 22px
		.artist, .album, .station
			color: var(--muted)
		.station
			font-size: 12px
		.idle
			color: var(--muted)
		.chip
			display: inline-block
			font-size: 11px
			color: var(--gold-2)
			border: 1px solid var(--line)
			border-radius: 999px
			padding: 1px 8px
			margin-top: 4px
		progress
			width: 100%
			height: 6px
			margin-top: 8px
			accent-color: var(--gold)
		.times
			display: flex
			justify-content: space-between
			color: var(--muted)
			font-size: 12px

	def render
		const song = now and now.song
		<self>
			if song
				<div.stage .big=!compact>
					<img.cover#np-cover src=(song.coverArt or FALLBACK_COVER) alt=(song.album ? "Cover of {song.album}" : '')>
					<div>
						<div.title#np-title> song.title
						<div.artist#np-artist> song.artist
						if song.album
							<div.album#np-album> song.album
						<div.station#np-station> (now.station ? "on {now.station.name}" : '')
						if song.audioFormat
							<span.chip#np-quality> "{song.quality} · {song.audioFormat}"
				if !compact
					<progress#np-progress max=(now.duration or song.duration or 1) value=(now.position or 0)>
					<div.times>
						<span#np-time-cur> fmtTime(now.position or 0)
						<span#np-time-len> fmtTime(now.duration or song.duration or 0)
			else
				<p.idle#np-title> "Pick a station"

export tag Transport
	prop now = null

	css
		.bar
			display: flex
			gap: 6px
			flex-wrap: wrap
		button
			min-width: 40px
		.on
			color: var(--gold-2)
			border-color: var(--gold)
		.off
			color: var(--red)
			border-color: var(--red)

	def render
		const song = now and now.song
		const rating = song and song.rating or 0
		<self>
			<div.bar role="group" aria-label="Playback controls">
				<button#play type="button" data-state=(now and !now.paused ? 'playing' : 'paused') aria-label=(now and !now.paused ? 'Pause' : 'Play') @click=emit('control', 'toggle')> (now and !now.paused ? "❚❚" : "▶")
				<button#next type="button" title="Next song" aria-label="Next song" disabled=!song @click=emit('control', 'skip')> "⏭"
				<button#love type="button" .on=(rating === 1) aria-pressed=(rating === 1 ? 'true' : 'false') title="Love this song" aria-label="Love" disabled=!song @click=emit('control', 'love')> "♥"
				<button#ban type="button" .off=(rating === 2) aria-pressed=(rating === 2 ? 'true' : 'false') title="Ban this song (skips)" aria-label="Ban" disabled=!song @click=emit('control', 'ban')> "✕"
				<button#tired type="button" title="Tired of this song (a month off)" aria-label="Tired" disabled=!song @click=emit('control', 'tired')> "zz"
