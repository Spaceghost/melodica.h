import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { compile } from 'imba/compiler';

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
