import test from 'node:test';
import assert from 'node:assert/strict';
import { updateRightDrawer } from '../src/rightDrawer.ts';

test('opening another drawer replaces current drawer without changing other tabs', () => {
  let state = {a:'notes', b:'properties'};
  for (const drawer of ['monitor','properties','notes','host']) {
    state = updateRightDrawer(state,'a',drawer);
    assert.deepEqual(state,{a:drawer,b:'properties'});
  }
});
test('toggle closes only the same drawer and preserves independent tabs', () => {
  const state = {a:'monitor',b:'notes'};
  assert.deepEqual(updateRightDrawer(state,'a','monitor',true),{b:'notes'});
  assert.deepEqual(updateRightDrawer(state,'a','properties',true),{a:'properties',b:'notes'});
  assert.deepEqual(updateRightDrawer(state,'b',null),{a:'monitor'});
  assert.deepEqual(state,{a:'monitor',b:'notes'});
});
