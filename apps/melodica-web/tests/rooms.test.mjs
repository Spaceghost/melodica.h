import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomHost, isRoomsPath, roomIdFromPath, roomPositionMs, roomBlocksSource } from '../web/rooms.js';
const id='room1234567890123456';
const state={id,seq:1,you:'listener',closed_at:0,members:[{account:'listener'}],play:null};

function fixture(t,{remote=false,loadUi}={}) {
  const previous=globalThis.location;globalThis.location={origin:'https://spacegho.st'};
  t.after(()=>{if(previous===undefined)delete globalThis.location;else globalThis.location=previous;});
  const calls=[];let made=0;
  const connection={getState:()=>state};
  const session=Object.assign(new EventTarget(),{
    connection,getState:()=>state,getAudioState:()=>({state:'listening'}),
    open(){calls.push('open');this.dispatchEvent(new CustomEvent('state',{detail:state}));},
    close(options){calls.push(['close',options]);},setVolume:v=>calls.push(['volume',v]),
    pause:async()=>calls.push('pause'),resume:async()=>calls.push('resume'),
    skip:async()=>calls.push('skip'),command:async(body)=>calls.push(['command',body]),
  });
  const mod={createClient:()=>({}),createRoomConnection:()=>connection,createRoomTransport:()=>({}),createRoomSession:()=>{made++;return session;}};
  const host=createRoomHost({loadUi:loadUi||(async()=>mod),remote:()=>remote,token:async()=>null,player:{},
    send:async(action,fields)=>{calls.push(['remote',action,fields]);return {ok:true,room:{id,state,audio:{state:'listening'}}};}});
  return {host,calls,mod,made:()=>made};
}

test('room routes accept only bounded IDs',()=>{
  assert.equal(roomIdFromPath('/melodica/rooms/'+id+'/'),id);
  assert.equal(isRoomsPath('/melodica/rooms/'),true);
  assert.equal(isRoomsPath('/melodica/rooms/../../oauth/'),false);
});

test('remote room intents create no socket or audio session',async(t)=>{
  const f=fixture(t,{remote:true});
  await f.host.command('room-join',{id});await f.host.command('room-pause');
  assert.equal(f.made(),0);assert.equal(f.calls.filter(x=>x[0]==='remote').length,2);
  assert.equal(f.host.getState().state.seq,1);
});

test('concurrent route joins share one owning session and suspension retains the handoff',async(t)=>{
  let release;const waiting=new Promise(r=>release=r);
  const f=fixture(t,{loadUi:()=>waiting});
  const first=f.host.handle('room-join',{id}),second=f.host.handle('room-join',{id});
  release(f.mod);await Promise.all([first,second]);
  assert.equal(f.made(),1);assert.equal(f.calls.filter(x=>x==='open').length,1);
  f.host.suspend();assert.equal(f.host.getState().id,id);
  assert.deepEqual(f.calls.at(-1),['close',{leave:false}]);
  f.host.leave();assert.equal(f.host.getState(),null);
});

test('room lobby and room metadata in a remote go through the owner without network or playback',async(t)=>{
  const previous=globalThis.location;globalThis.location={origin:'https://spacegho.st'};
  t.after(()=>{if(previous===undefined)delete globalThis.location;else globalThis.location=previous;});
  const calls=[];
  const host=createRoomHost({remote:()=>true,player:{},loadUi:async()=>({
    createClient:()=>({api:()=>{throw new Error('a remote requested the API directly');}}),
    mountRooms:async(_,opts)=>{
      assert.deepEqual(await opts.recentRoomIds(),[id]);
      const found=await opts.searchRooms({query:'Friday',cursor:null});
      assert.deepEqual(found.rooms,[{id,name:'Friday'}]);
      assert.deepEqual(await opts.client.api('rooms',{body:{name:'Friday',kind:'public',mode:'solo',spots:1}}),{id});
      return {unmount(){}};
    },
  }),send:async(action,fields)=>{
    calls.push([action,fields]);
    if(action==='room-recent')return {ok:true,recentRoomIds:[id]};
    if(action==='room-search')return {ok:true,rooms:[{id,name:'Friday'}],recent:[],next_cursor:null};
    if(action==='room-api')return {ok:true,result:{id},status:201};
    throw new Error('unexpected command');
  }});
  await host.mount({});
  assert.deepEqual(calls.map(([action])=>action),['room-recent','room-search','room-api']);
  assert.equal(host.localSession(),null);
});

test('owner metadata proxy permits discovery and creation but keeps media and room commands private',async(t)=>{
  const f=fixture(t);const requests=[];
  f.mod.createClient=()=>({api:async(path,init)=>{requests.push([path,init]);return {rooms:[]};}});
  await f.host.handle('room-search',{query:'Friday'});
  await f.host.api('rooms',{body:{name:'Friday',kind:'public',mode:'solo',spots:1}});
  assert.equal(requests.length,2);
  assert.equal(new URL(requests[0][0],'https://room.invalid/').searchParams.get('q'),'Friday');
  for(const path of ['rooms/../../oauth','https://evil.invalid/rooms','rooms?token=secret',`rooms/${id}/audio`,`rooms/${id}/ice`]) {
    await assert.rejects(f.host.handle('room-api',{path}));
  }
  await assert.rejects(f.host.handle('room-api',{path:`rooms/${id}`,body:{action:'play'}}));
  await assert.rejects(f.host.handle('room-api',{path:'rooms',body:{name:'Friday',kind:'public',mode:'solo',spots:1,token:'secret'}}));
  assert.equal(requests.length,2,'rejected routes never reach the API');
  await f.host.handle('room-join',{id});
  await f.host.api(`rooms/${id}`,{body:{action:'invite',username:'friend'}});
  assert.deepEqual(f.calls.at(-1),['command',{action:'invite',username:'friend'}]);
});

test('clock updates keep the same play and form state, reject stale plays and do not emit full changes',async(t)=>{
  const f=fixture(t,{remote:true});let changes=0,clocks=0;
  f.host.addEventListener('change',()=>changes++);f.host.addEventListener('clock',()=>clocks++);
  const room={id,state:{...state,server_time:10000,play:{id:'play-one',started_at:10000,duration_ms:60000,position_ms:1000,server_time:11000}},audio:{state:'listening'}};
  f.host.updateRemote(room);
  const formState=f.host.getState().state.members;
  assert.equal(f.host.updateClockRemote({...room,state:{...room.state,play:{...room.state.play,id:'play-two',position_ms:2000,server_time:12000}}}),false);
  assert.equal(f.host.updateClockRemote({...room,state:{...room.state,play:{...room.state.play,position_ms:3000,server_time:13000}}}),true);
  assert.equal(f.host.updateClockRemote(room),false);
  assert.equal(changes,1);assert.equal(clocks,1);
  assert.equal(f.host.getState().state.members,formState);
  f.host.updateRemote(room);
  assert.equal(f.host.getState().state.play.position_ms,3000,'a delayed full snapshot cannot move the clock backwards');
});

test('room progress uses server anchors independently of local clock and stops while paused',()=>{
  const snapshot={clockReceivedAt:900000,state:{server_time:11000,play:{id:'p',duration_ms:60000,started_at:10000,position_ms:1000,server_time:11000}}};
  assert.equal(roomPositionMs(snapshot,902000),3000);
  snapshot.state.play.paused_at=11000;
  assert.equal(roomPositionMs(snapshot,905000),1000);
  snapshot.state.play.paused_at=0;
  assert.equal(roomPositionMs(snapshot,999000),60000);
});

test('only the current DJ without a broadcast can choose an initial source while joined',()=>{
  assert.equal(roomBlocksSource(null),false);
  assert.equal(roomBlocksSource({id,state:null}),true);
  assert.equal(roomBlocksSource({id,state:{you:'me',current_dj:'other',play:null}}),true);
  assert.equal(roomBlocksSource({id,state:{you:'me',current_dj:'me',play:null}}),false);
  assert.equal(roomBlocksSource({id,state:{you:'me',current_dj:'me',play:null,you_broadcasting:true}}),false);
  assert.equal(roomBlocksSource({id,state:{you:'me',current_dj:'me',play:null,you_broadcasting:false}}),true);
  assert.equal(roomBlocksSource({id,state:{you:'me',current_dj:'me',play:{id:'play'},you_broadcasting:true}}),true);
  assert.equal(roomBlocksSource({id,state:{you:'me',current_dj:'me',play:{id:'play'},you_broadcasting:false}}),true);
  assert.equal(roomBlocksSource({id,state:{closed_at:123,play:{id:'play'}}}),false);
});
