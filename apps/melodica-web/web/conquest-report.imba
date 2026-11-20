# Per-visit comparison of the crew map. Only the names and leaders of towns the
# service included on both visits are compared; an omitted town has no known owner.
export def conquestReport(host,g,scope)
	if !scope || !Array.isArray(g.regions)
		return
	const key = 'melodica.conquest.report.' + scope
	let previous = null
	try
		previous = JSON.parse(globalThis.localStorage.getItem(key) || 'null')
	catch _
		# First visit or unavailable storage.
	const towns = {}
	for region of g.regions
		for province of region.provinces || []
			for town of province.towns || []
				const leader = town.leader
				const id = JSON.stringify([province.key,town.key])
				towns[id] = {name:town.name,province:province.name,who:(leader)?.github || (leader)?.name || '',label:(leader)?.name || (leader)?.github || 'Unheld'}
	const current = {season:g.season,at:g.generated_at || Date.now(),towns}
	const pane = document.createElement('details')
	pane.className = 'walk-help'
	const title = document.createElement('summary')
	title.textContent = 'Daily Conquest report'
	const note = document.createElement('p')
	const list = document.createElement('ul')
	pane.append(title,note,list)
	host.prepend(pane)
	if !previous || previous.season !== g.season || !previous.towns
		note.textContent = 'Season '+g.season+' · This visit starts your town record on this device.'
	else
		for [id,town] of Object.entries(towns)
			const old = previous.towns[id]
			if old && old.who !== town.who
				const li = document.createElement('li')
				li.textContent = town.name+' ('+town.province+') · '+old.label+' → '+town.label
				list.append(li)
		const count = list.childElementCount
		note.textContent = 'Season '+g.season+' · '+count+(count === 1 ? ' town has' : ' towns have')+' a different leader since '+new Date(previous.at).toLocaleString()+'.'
	try
		globalThis.localStorage.setItem(key,JSON.stringify(current))
	catch _
		note.append(' Device storage is unavailable.')
