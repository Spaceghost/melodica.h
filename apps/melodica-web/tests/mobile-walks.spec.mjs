import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  await page.route('https://melodica.example/**', async route => {
    const path = new URL(route.request().url()).pathname.slice(1);
    if (!path) return route.fulfill({ contentType: 'text/html', body: '<main id="walk"></main>' });
    if (!/^(walk-[a-z]+|history-tools|imba-runtime)\.js$/.test(path)) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../dist/' + path, import.meta.url)) });
  });
  await page.goto('https://melodica.example/');
});

test('trimmed GPX removes endpoint revisits, crossing lines and their song metadata', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const {trimWalk, walkFile, readWalkFile} = await import('/walk-trace.js');
    const points = [0,.003,.005,0,-.005,.005,.008,.01].map((lon,i) =>
      ({lat: 0, lon, at: 1000000 + i*10000, cut: !i}));
    const walk = {name:'Original', start:points[0].at, end:points.at(-1).at, points,
      changes: points.map((p,i) => ({at:p.at, artist:'Artist', title:'Song '+i})), history:[]};
    const original = JSON.stringify(walk);
    const cropped = trimWalk(walk,100,100);
    const xml = await walkFile(cropped).text();
    const roundTrip = readWalkFile(xml);
    return { xml, originalPreserved: JSON.stringify(walk) === original,
      cuts: roundTrip.points.map(p => p.cut), times: roundTrip.points.map(p => p.at),
      titles: roundTrip.changes.filter(s => s.title).map(s => s.title),
      entirelyHidden: trimWalk(walk,10000,10000), invalid:trimWalk(walk,-1,0) };
  });
  expect(result.originalPreserved).toBe(true);
  expect(result.titles).toEqual(['Song 1','Song 2','Song 4','Song 5','Song 6']);
  expect(result.cuts).toEqual([true,false,true,true,false]);
  expect(result.times).toEqual([1010000,1020000,1040000,1050000,1060000]);
  expect(result.xml).not.toContain('Original');
  expect(result.entirelyHidden).toBeNull();
  expect(result.invalid).toBeNull();
});

test('pausing GPS discards late fixes and resumes in a new segment while the music continues', async ({page}) => {
  const result = await page.evaluate(async () => {
    const {WalkJournal} = await import('/walk-journal.js');
    const watches = [], cleared = [];
    Object.defineProperty(navigator,'geolocation',{configurable:true,value:{
      watchPosition(fn) { watches.push(fn); return watches.length; },
      clearWatch(id) { cleared.push(id); }
    }});
    let song = 'A';
    const journal = new WalkJournal(() => ({artist:'Artist',title:song}), () => {});
    const now = Date.now();
    journal.active = {id:'walk',start:now-1000,changes:[],points:[]};
    journal.library.append = async () => {};
    journal.watchLocation();
    const fix = offset => ({timestamp:now+offset,coords:{latitude:10+offset/10000,longitude:5,accuracy:2}});
    watches[0](fix(0));
    journal.pauseLocation(true);
    watches[0](fix(100));
    song = 'B';
    journal.sample();
    journal.pauseLocation(false);
    watches[0](fix(200));
    watches[1](fix(300));
    await journal.pending;
    const data = {cleared:[...cleared],points:journal.active.points.map(p => p.cut),songs:journal.active.changes.map(s => s.title)};
    journal.detach();
    return data;
  });
  expect(result).toEqual({cleared:[1],points:[true,true],songs:['A','B']});
});

test('two saved walks display their own covers and soundtracks; a crop cannot overwrite either record', async ({ page }) => {
  await page.evaluate(async () => {
    const {WalkJournal} = await import('/walk-journal.js');
    const {mountWalk} = await import('/walk-view.js');
    const journal = new WalkJournal(() => null, () => {});
    for (const [id,name,artist] of [['a','Morning','Dawn'],['b','Evening','Dusk']]) {
      const start = id === 'a' ? 1000000 : 2000000;
      const points = [0,.006,.014,.02].map((lon,i) => ({lat:1,lon,at:start+i*10000,cut:!i}));
      await journal.library.save({id,name,start,end:start+30000,kind:'gpx',points,
        changes:[{at:start,artist,title:'Song'}],history:[]},true);
    }
    mountWalk(document.querySelector('main'),journal,{state:()=>({stations:[],ready:true}),control:async()=>{}});
  });
  await page.getByText('Compare two walks',{exact:true}).click();
  await expect(page.locator('.walk-pair figure')).toHaveCount(2);
  await expect(page.locator('.walk-pair')).toContainText('Song · Dawn');
  await expect(page.locator('.walk-pair')).toContainText('Song · Dusk');
  await page.getByText('Trim a copy for sharing',{exact:true}).click();
  await expect(page.getByRole('button',{name:'Save trimmed GPX'})).toBeEnabled();
  const download = page.waitForEvent('download');
  await page.getByRole('button',{name:'Save trimmed GPX'}).click();
  expect((await download).suggestedFilename()).toBe('melodica-walk-trimmed.gpx');
  const counts = await page.evaluate(async () => {
    const {WalkLibrary} = await import('/walk-library.js');
    const lib = new WalkLibrary();
    return Promise.all(['a','b'].map(async id => (await lib.get(id)).points.length));
  });
  expect(counts).toEqual([4,4]);
});
