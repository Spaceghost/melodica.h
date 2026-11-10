// Display clocks belong to a view, not to the audio owner. Advance from local
// receipt time so a phone's clock cannot change the room's displayed position.
export function roomTimeline(previous, room, now = Date.now()) {
  const state = room?.state, play = state?.play;
  if (!play || state.closed_at) return null;
  const anchored = Number.isSafeInteger(play.position_ms) && Number.isSafeInteger(play.server_time);
  const positionMs = anchored ? play.position_ms : Math.max(0,
    Number(play.paused_at || state.server_time || play.started_at || 0) - Number(play.started_at || 0) - Number(play.paused_ms || 0));
  const key = JSON.stringify([room.id, play.id, positionMs, anchored ? play.server_time : state.server_time,
    play.paused_at || 0, play.paused_ms || 0]);
  return previous?.key === key ? previous : { key, positionMs, receivedAt: now, paused: !!play.paused_at };
}

function roomSong(play) {
  const track = play?.track_metadata;
  if (!track) return null;
  const extra = track.additional_info || {};
  return { title: track.track_name || '', artist: track.artist_name || '', album: track.release_name || '',
    coverArt: extra.art_url || '', duration: Math.max(0, Number(play.duration_ms || extra.duration_ms) || 0) / 1000,
    rating: play.reaction === 'like' ? 1 : play.reaction === 'dislike' ? 2 : 0, roomPlayId: play.id };
}

export function roomNowPlaying(room, timeline, now = Date.now()) {
  if (!room?.id || room.state?.closed_at) return null;
  const play = room.state?.play, song = roomSong(play);
  if (!song) return null;
  const clock = timeline || roomTimeline(null, room, now);
  const elapsed = clock.paused ? 0 : Math.max(0, now - clock.receivedAt);
  const position = Math.max(0, (clock.positionMs + elapsed) / 1000);
  return { song, station: { name: room.state.name || 'Room' }, duration: song.duration,
    position: song.duration ? Math.min(song.duration, position) : position,
    paused: !!(play.paused_at || room.audio?.paused) || !['broadcasting', 'listening'].includes(room.audio?.state) };
}

export function roomHistory(room) {
  if (!room?.state) return [];
  return [room.state.play, ...(room.state.past || []).slice().reverse()]
    .map(roomSong).filter(Boolean).slice(0, 20);
}
