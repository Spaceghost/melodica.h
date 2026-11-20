import {test,expect} from '@playwright/test';
import {wavBytes} from './tools/test-tone.mjs';
import {readFile} from 'node:fs/promises';

async function open(page) {
  await page.route('https://melodica.example/**',async route => {
    const path = new URL(route.request().url()).pathname.slice(1);
    if (!path) return route.fulfill({contentType:'text/html',body:'<main><div class="deck"></div><audio></audio></main>'});
    if (!/^(devices|history-tools|mobile|mobile-eq|station-tools|imba-runtime)\.js$/.test(path)) return route.fulfill({status:404});
    return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../dist/'+path,import.meta.url))});
  });
  await page.goto('https://melodica.example/');
}

test('linked devices exchange controls and silence the source before starting the handoff',async ({browser}) => {
  const a=await browser.newPage(), b=await browser.newPage();
  for (const [p,playing] of [[a,true],[b,false]]) {
    await open(p);
    await p.evaluate(async playing=>{
      const {LinkedPlayer}=await import('/devices.js');
      window.controls={playing,actions:[],received:0};
      const c=window.controls;
      new LinkedPlayer(document.body,{
        identity:()=> 'same-test-listener',available:()=>true,summary:()=>({title:'Dawn',artist:'Rain',playing:c.playing}),
        command:action=>{c.actions.push(action); if(action==='pause'||action==='play') c.playing=action==='play';},
        record:()=>({playing:c.playing,position:27}),accept:rec=>{c.received=rec.position;c.playing=rec.playing;},rejected:()=>{}
      });
      document.querySelector('details').open=true;
    },playing);
  }
  await a.getByRole('button',{name:'Create pairing invitation'}).click();
  await expect(a.locator('textarea')).toHaveValue(/"offer"/);
  await b.locator('textarea').fill(await a.locator('textarea').inputValue());
  await b.getByRole('button',{name:'Use pasted invitation or reply'}).click();
  await expect(b.locator('textarea')).toHaveValue(/"answer"/);
  await a.locator('textarea').fill(await b.locator('textarea').inputValue());
  await a.getByRole('button',{name:'Use pasted invitation or reply'}).click();
  await expect(b.getByRole('button',{name:'Thumbs up'})).toBeVisible();
  await b.getByRole('button',{name:'Thumbs up'}).click();
  await expect.poll(()=>a.evaluate(()=>controls.actions)).toContain('love');
  await b.getByRole('button',{name:'Move playback here'}).click();
  await expect.poll(()=>b.evaluate(()=>controls.received)).toBe(27);
  expect(await a.evaluate(()=>controls.playing)).toBe(false);
  expect(await b.evaluate(()=>controls.playing)).toBe(true);
  await b.getByRole('button',{name:'Disconnect devices'}).click();
  await expect(a.getByRole('button',{name:'Thumbs up'})).toBeHidden();
  await a.close(); await b.close();
});

test('history reads every cursor, removes repeated listens and exports only portable metadata',async ({page}) => {
  await open(page);
  const result=await page.evaluate(async()=>{
    const {collectHistory}=await import('/history-tools.js');
    const item={id:'one',title:'Night',artist:'Rain',station:'Hill',listened_at:100,secret:'never-export'};
    const hits=[];
    const rows=await collectHistory(async path=>{
      hits.push(path);
      return hits.length===1?{listens:[item],next_cursor:'next.page'}:{listens:[item,{...item,id:'two',listened_at:90}]};
    },()=>true,()=>{});
    return {rows,hits};
  });
  expect(result.hits[1]).toContain('cursor=next.page');
  expect(result.rows.map(r=>r.id)).toEqual(['one','two']);
  expect(result.rows[0]).toMatchObject({title:'Night',artist:'Rain',station:'Hill',listened_at:100});
  expect(JSON.stringify(result.rows)).not.toContain('never-export');
});

test('phone preferences persist by output and change quality when the network changes',async ({page})=>{
  await open(page);
  await page.evaluate(async()=>{
    const {PhonePlayer}=await import('/mobile.js');
    window.changes=[];
    window.melodicaDevice={platform:'android',call:async action=>action==='state'?{network:'wifi',route:'speaker',label:'Speaker'}:true};
    const p=new PhonePlayer({audio:document.querySelector('audio'),eqTrack:()=>null,read:()=>null,stations:()=>[],station:()=>null,
      ready:()=>true,quality:q=>changes.push(q),playback:()=>({playing:false}),volume:()=>{},message:()=>{}});
    window.changeRoute=(route,network)=>p.changed({route,network,label:route});
  });
  await page.getByText('Phone audio',{exact:true}).click();
  await page.getByText('Equalizer · Speaker',{exact:true}).click();
  const bass=page.locator('[data-phone=bands] input').first();
  await bass.fill('5');
  await page.evaluate(()=>changeRoute('headphones','cellular'));
  await expect(bass).toHaveValue('0');
  await page.evaluate(()=>changeRoute('speaker','wifi'));
  await expect(bass).toHaveValue('5');
  expect(await page.evaluate(()=>changes)).toEqual(['high','medium','high']);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('melodica.phone.audio')).outputs.speaker[0])).toBe(5);
});

test('equalization produces audio and restores the original when the track copy fails', async ({page}) => {
  await open(page);
  const tone = wavBytes(12, 500);
  await page.route('**/tone.wav', route => route.fulfill({contentType:'audio/wav',body:tone}));
  await page.evaluate(async () => {
    const {PhoneEqualizer} = await import('/mobile-eq.js');
    const audio = document.querySelector('audio');
    audio.src = '/tone.wav';
    let song = {id:'first'};
    const status = document.createElement('output');
    const equalizer = new PhoneEqualizer(audio, () => song, async current => {
      if (current.id === 'first') return (await fetch('/tone.wav')).blob();
      throw Error('Copy unavailable');
    }, text => { status.textContent = text; });
    const start = document.createElement('button');
    start.textContent = 'Play tone';
    start.onclick = () => {
      equalizer.configure([0,0,0,0,6], true);
      const analyser = equalizer.context.createAnalyser();
      equalizer.gain.connect(analyser);
      const waveform = new Float32Array(analyser.fftSize);
      window.equalizedPeak = () => {
        analyser.getFloatTimeDomainData(waveform);
        return Math.max(...waveform);
      };
      audio.play();
    };
    const change = document.createElement('button');
    change.textContent = 'Change track';
    change.onclick = () => { song = {id:'second'}; equalizer.update(); };
    document.body.append(start, change, status);
  });
  await page.getByRole('button',{name:'Play tone'}).click();
  // The unfiltered tone peaks at 9000 / 32768. A 6 dB boost should nearly double it.
  await expect.poll(() => page.evaluate(() => window.equalizedPeak())).toBeGreaterThan(0.45);
  await expect(page.locator('audio')).toHaveJSProperty('muted', true);
  await page.getByRole('button',{name:'Change track'}).click();
  await expect(page.locator('output')).not.toBeEmpty();
  await expect(page.locator('audio')).toHaveJSProperty('muted', false);
  await expect(page.locator('audio')).toHaveJSProperty('paused', false);
});
