import test from 'node:test';
import assert from 'node:assert/strict';
import {pluginProgressPercent} from '../src/plugins.ts';

test('download progress is bounded and other phases stay indeterminate',()=>{
  const base={id:'ftp',requestId:'test',phase:'downloading',received:50,total:100};
  assert.equal(pluginProgressPercent(base),50);
  assert.equal(pluginProgressPercent({...base,received:200}),100);
  assert.equal(pluginProgressPercent({...base,received:-10}),0);
  assert.equal(pluginProgressPercent({...base,total:0}),null);
  assert.equal(pluginProgressPercent({...base,phase:'installing'}),null);
});
