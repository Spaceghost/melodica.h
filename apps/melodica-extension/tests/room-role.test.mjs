import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { compile } from 'imba/compiler';
import { roomHistory } from '../src/room-playback-view.js';

test('compiled room role works while playing, idle and on the DJ account secondary device', async () => {
  const source = await readFile(new URL('../src/bg.imba', import.meta.url), 'utf8');
  const body = source.match(/^def roomIsDj\b[\s\S]*?(?=^def roomBroadcastActive\b)/m)?.[0];
  assert.ok(body, 'Exercise the production role function');
  const { js } = compile(body + '\nglobalThis.checkDj = roomIsDj\n', { platform: 'node', format: 'esm', sourcePath: 'src/bg-role.imba', raiseErrors: true });
  const context = vm.createContext({ room: { id: 'room-1', state: { you: 'dj', play: { dj: 'dj' }, you_broadcasting: true } } });
  vm.runInContext(js, context);
  assert.equal(context.checkDj(), true);
  context.room.state.you_broadcasting = false;
  assert.equal(context.checkDj(), false);
  context.room.state.play = null; context.room.state.current_dj = 'dj';
  assert.equal(context.checkDj(), false);
  context.room.state.you_broadcasting = true;
  assert.equal(context.checkDj(), true);
  context.room.state.you = 'listener';
  assert.equal(context.checkDj(), false);
});

test('compiled player routes a DJ station selection through the room owner while keeping transport protection', async () => {
  const source = await readFile(new URL('../src/bg.imba', import.meta.url), 'utf8');
  const body = source.match(/^def playerCommand\b[\s\S]*?(?=^def \w)/m)?.[0];
  assert.ok(body);
  const {js}=compile(body+'\nglobalThis.command = playerCommand\n',{platform:'node',format:'esm',sourcePath:'src/player-command-test.imba',raiseErrors:true});
  const calls=[];
  const context=vm.createContext({room:{id:'room'},roomEngineReady:true,state:{client:{loggedIn:true}},PLAYER_ACTIONS:new Set(['play','stop','pause']),
    roomBroadcastActive:()=>true,roomIsDj:()=>true,roomCaller:()=>true,
    stationByToken:token=>({token,name:'Selected station'}),engineCall:async(...args)=>calls.push(args),
    playerView:()=>({room:{id:'room'}}),roomPlayerCommand:async(msg)=>{calls.push(['protected',msg.action]);return {};}});
  vm.runInContext(js,context);
  await context.command({action:'play',stationToken:'mobile-station'},{});
  assert.equal(calls[0][0],'room-select-station');assert.equal(calls[0][1][0].token,'mobile-station');
  await context.command({action:'stop'},{});assert.deepEqual(calls[1],['protected','stop']);
  await context.command({action:'pause'},{});assert.deepEqual(calls[2],['protected','pause']);
});

test('compiled room player keeps station choices for its DJ and hides private choices from listeners', async()=>{
  const source=await readFile(new URL('../src/bg.imba',import.meta.url),'utf8');
  const body=source.match(/^def playerView\b[\s\S]*?(?=^def \w)/m)[0];
  const {js}=compile(body+'\nglobalThis.view=playerView\n',{platform:'node',format:'esm',sourcePath:'src/player-view-test.imba',raiseErrors:true});
  const context=vm.createContext({dj:true,player:{volume:80,pendingStation:{token:'new',name:'Queued radio'},queueLength:1,queue:[{title:'Next DJ song'}],history:[{title:'Private song'}]},
    state:{client:{loggedIn:true},saved:{stations:[{token:'radio',name:'Radio'}]}},account:{signedIn:true,label:'DJ'},access:{allowed:true},
    room:{id:'room',state:{name:'Room',play:{id:'play',dj:'dj',duration_ms:10000,track_metadata:{track_name:'Current song',artist_name:'Artist'}}},audio:{state:'broadcasting'}},
    roomHistory,lastView:()=>null,userView:()=>({}),scrobbleView:()=>({}),roomView:()=>context.room,roomIsDj:()=>context.dj});
  vm.runInContext(js,context);let view=context.view();
  assert.equal(view.stations[0].token,'radio');assert.equal(view.pendingStation.token,'new');assert.equal(view.track.title,'Current song');
  assert.equal(view.queue.length,0,'an old station queue is hidden when another station is selected');
  assert.equal(view.history[0].title,'Current song');
  assert.equal(view.history.some(track=>track.title==='Private song'),false);
  context.player.pendingStation=null;view=context.view();assert.equal(view.queue[0].title,'Next DJ song');
  context.dj=false;view=context.view();assert.equal(view.stations.length,0);assert.equal(view.pendingStation,null);assert.equal(view.queue.length,0);
  context.dj=true;context.room.state.play=null;context.room.state.current_dj='dj';view=context.view();assert.equal(view.history.length,0,'an idle DJ still sees room history rather than the private log');
  context.room.id=null;view=context.view();assert.equal(view.history[0].title,'Private song','leaving restores the original private play log');
});

test('compiled engine queues the station without changing the current track, then uses it for the next song', async()=>{
  const source=await readFile(new URL('../src/engine.imba',import.meta.url),'utf8');
  const method=name=>source.match(new RegExp('^\\tdef '+name+'\\b[\\s\\S]*?(?=^\\tdef |^\\tget )','m'))[0].replace(/^\t/gm,'');
  const {js}=compile(method('queueStation')+'\n'+method('next')+'\nglobalThis.select=queueStation\nglobalThis.advance=next\n',{platform:'node',format:'esm',sourcePath:'src/queue-station-test.imba',raiseErrors:true});
  const track={trackToken:'current'},oldStation={token:'old'};const requests=[];
  const context=vm.createContext({state:{station:oldStation,track,pendingStation:null,quality:'high'},queue:[{trackToken:'old-queued-song'}],generation:0,fetching:false,
    set:patch=>Object.assign(context.state,patch),saveLast:()=>{},log:()=>{},api:{playlist:async(station)=>{requests.push(station.token);return [{trackToken:'new-song'}];}},start:song=>context.state.track=song});
  vm.runInContext(js,context);context.select({token:'new',name:'Next radio'});
  assert.equal(context.state.track,track);assert.equal(context.state.station,oldStation);assert.equal(requests.length,0);
  await context.advance();assert.deepEqual(requests,['new']);assert.equal(context.state.track.trackToken,'new-song');assert.equal(context.state.pendingStation,null);
});
