import test from 'node:test';
import assert from 'node:assert/strict';
import { publicRoomMember, publicRoomSummary } from '../src/room-state.js';

test('public room members preserve canonical numeric joined_at and strip private fields', () => {
  assert.deepEqual(publicRoomMember({ account: 'user', name: 'Listener', role: 'dj', joined_at: 1730000000, access_token: 'private' }), {
    account: 'user', name: 'Listener', role: 'dj', joined_at: 1730000000,
  });
});

test('room summaries expose bounded search, DJ spots and nested metadata without private media fields', () => {
  const summary = publicRoomSummary({ id: 'room_id_123456789', name: '  Jazz  ', kind: 'public', mode: 'rotation',
    listeners: 4, spots: 3, created_at: 1730000000, secret: 'nope', current_play: { id: 'play-1', dj: 'dj-1',
      track_metadata: { track_name: 'Song', artist_name: 'Artist', additional_info: { duration_ms: 210000, art_url: 'https://art.example/cover.jpg' }, audioUrl: 'private' } } });
  assert.deepEqual(summary, { id: 'room_id_123456789', name: '  Jazz  ', kind: 'public', mode: 'rotation', listeners: 4, spots: 3,
    created_at: 1730000000, current_play: { id: 'play-1', dj: 'dj-1', track_metadata: { track_name: 'Song', artist_name: 'Artist',
      additional_info: { duration_ms: 210000, art_url: 'https://art.example/cover.jpg' } } } });
  assert.equal(publicRoomSummary({ id: 'invalid' }), null);
});

test('public room members retain bounded string timestamps and reject invalid timestamps', () => {
  assert.deepEqual(publicRoomMember({ joined_at: '2026-11-09T00:00:00Z', extra: 'private' }), { joined_at: '2026-11-09T00:00:00Z' });
  assert.deepEqual(publicRoomMember({ joined_at: null }), {});
});

import {roomTimeline,roomNowPlaying,roomHistory} from '../src/room-playback-view.js';
const displayRoom=()=>({id:'room',state:{name:'Friday',server_time:101000,play:{id:'play',dj:'dj',started_at:100000,
 duration_ms:90000,position_ms:12000,server_time:112000,track_metadata:{track_name:'Song',artist_name:'Artist',release_name:'Album',additional_info:{art_url:'https://art.example/cover.jpg'}}}},audio:{state:'listening'}});

test('room display advances from receipt time, retains its clock across unrelated pushes and uses authoritative duration',()=>{
 const room=displayRoom(),clock=roomTimeline(null,room,500000);
 assert.equal(roomTimeline(clock,{...room,audio:{state:'listening',volume:43}},501000),clock);
 const now=roomNowPlaying(room,clock,501500);assert.equal(now.position,13.5);assert.equal(now.duration,90);
 assert.equal(now.song.album,'Album');assert.equal(now.song.coverArt,'https://art.example/cover.jpg');
 assert.equal(roomNowPlaying(room,clock,900000).position,90,'progress cannot exceed the song duration');
 room.state.play={...room.state.play,id:'next',position_ms:0,server_time:9999999};
 const next=roomTimeline(clock,room,510000);assert.equal(roomNowPlaying(room,next,511000).position,1,'a new play resets and a skewed wall clock does not jump the display');
});

test('server pause and local listener pause show correct controls without discarding the room timeline',()=>{
 const room=displayRoom();room.state.play.paused_at=112000;
 const clock=roomTimeline(null,room,500000);assert.equal(roomNowPlaying(room,clock,502000).position,12);
 assert.equal(roomNowPlaying(room,clock,502000).paused,true,'server pause takes priority over a stale listening audio label');
 room.state.play.paused_at=0;room.audio.paused=true;
 assert.equal(roomNowPlaying(room,roomTimeline(clock,room,502000),503000).paused,true);
 room.audio.paused=false;assert.equal(roomNowPlaying(room,roomTimeline(clock,room,502000),503000).paused,false);
 room.state.closed_at=123;assert.equal(roomNowPlaying(room,clock),null);
});

test('room history uses shared room tracks without leaking private source fields or confusing them with Pandora tokens',()=>{
 const room=displayRoom();room.state.past=[{id:'older',track_metadata:{track_name:'Earlier',artist_name:'Other',audioUrl:'private',trackToken:'secret'}}];
 const history=roomHistory(room);assert.deepEqual(history.map(s=>s.title),['Song','Earlier']);
 assert.equal(history[0].roomPlayId,'play');assert.equal(JSON.stringify(history).includes('private'),false);assert.equal(JSON.stringify(history).includes('secret'),false);
});
