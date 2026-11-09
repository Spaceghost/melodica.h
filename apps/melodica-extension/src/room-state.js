export function publicRoomMember(member) {
  if (!member || typeof member !== 'object' || Array.isArray(member)) return {};
  const out = {};
  for (const key of ['account', 'name', 'github', 'role']) {
    if (typeof member[key] === 'string') out[key] = member[key].slice(0, 256);
  }
  if (typeof member.joined_at === 'string') out.joined_at = member.joined_at.slice(0, 256);
  else if (Number.isFinite(member.joined_at)) out.joined_at = member.joined_at;
  return out;
}

export function publicRoomSummary(room) {
  if (!room || typeof room !== 'object' || Array.isArray(room)) return null;
  if (typeof room.id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(room.id)) return null;
  const out = { id: room.id };
  for (const key of ['name', 'kind', 'mode']) {
    if (typeof room[key] === 'string') out[key] = room[key].slice(0, key === 'name' ? 80 : 16);
  }
  for (const key of ['listeners', 'created_at']) {
    if (Number.isFinite(room[key])) out[key] = Math.max(0, room[key]);
  }
  if (Number.isSafeInteger(room.spots)) out.spots = Math.max(1, Math.min(5, room.spots));
  const play = room.current_play;
  const metadata = play?.track_metadata && typeof play.track_metadata === 'object' ? play.track_metadata : play;
  if (metadata && typeof metadata === 'object' && typeof metadata.track_name === 'string' && typeof metadata.artist_name === 'string') {
    const track = { track_name: metadata.track_name.slice(0, 512), artist_name: metadata.artist_name.slice(0, 512) };
    if (typeof metadata.release_name === 'string') track.release_name = metadata.release_name.slice(0, 512);
    if (metadata.additional_info && typeof metadata.additional_info === 'object') {
      const info = {};
      if (Number.isSafeInteger(metadata.additional_info.duration_ms) && metadata.additional_info.duration_ms >= 1000 && metadata.additional_info.duration_ms <= 3_600_000) info.duration_ms = metadata.additional_info.duration_ms;
      if (typeof metadata.additional_info.art_url === 'string' && /^https:\/\//i.test(metadata.additional_info.art_url)) info.art_url = metadata.additional_info.art_url.slice(0, 4096);
      if (Object.keys(info).length) track.additional_info = info;
    }
    const current = {};
    for (const key of ['id', 'dj']) if (typeof play[key] === 'string') current[key] = play[key].slice(0, 128);
    current.track_metadata = track;
    out.current_play = current;
  }
  return out;
}
