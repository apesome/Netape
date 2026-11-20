import test from 'node:test';
import assert from 'node:assert/strict';
import { reorderedHostIds, compareHostOrder, planHostDrop } from '../src/hostTreeOrder.ts';

const host = (id, sort = 0, overrides = {}) => ({id, name:id, sort, parentId:'work', protocol:'SSH', ownerType:'SSH', deleted:false, ...overrides});
const hosts = [host('a'), host('b'), host('c'), host('folder',0,{protocol:'Folder'}),
  host('ftp',0,{protocol:'FTP'}), host('other',0,{parentId:'other'}),host('deleted',0,{deleted:true})];

test('moves before and after siblings using existing sort then name order', () => {
  assert.deepEqual(reorderedHostIds(hosts,'c','a',false), ['c','a','b']);
  assert.deepEqual(reorderedHostIds(hosts,'a','c',true), ['b','c','a']);
  assert.equal(reorderedHostIds(hosts,'a','b',false), null);
  assert.equal(reorderedHostIds(hosts,'a','a',false), null);
});
test('does not move across folders, protocols, categories, or deleted entries', () => {
  for (const target of ['folder','ftp','other','deleted','missing']) {
    assert.equal(reorderedHostIds(hosts,'a',target,true), null, target);
  }
});
test('keeps hidden siblings in their relative order when sorting filtered rows', () => {
  assert.deepEqual(reorderedHostIds(hosts,'c','a',false), ['c','a','b']);
  assert.deepEqual(reorderedHostIds([host('a',9),host('b',2),host('c',7)],'a','b',false), ['a','b','c']);
});
test('same-level folders support sorting; legacy empty owner is SSH', () => {
  const items = [host('f1',0,{protocol:'Folder',ownerType:''}),host('f2',0,{protocol:'Folder'}),host('a')];
  assert.deepEqual(reorderedHostIds(items,'f2','f1',false), ['f2','f1']);
  assert.equal([...items].sort(compareHostOrder)[2].id,'a');
});

const hierarchy = [host('work',0,{protocol:'Folder',parentId:'0'}),host('dest',1,{protocol:'Folder',parentId:'0'}),
  host('child',0,{protocol:'Folder',parentId:'work'}),host('a'),host('b'),host('x',0,{parentId:'dest'}),
  host('ftp-folder',0,{protocol:'Folder',ownerType:'FTP',parentId:'0'}),host('gone',0,{deleted:true})];
test('plans folder moves, destination insertion and returning to root', () => {
  assert.deepEqual(planHostDrop(hierarchy,'a','dest','inside'),{parentId:'dest',ids:['x','a']});
  assert.deepEqual(planHostDrop(hierarchy,'a','x','before'),{parentId:'dest',ids:['a','x']});
  assert.deepEqual(planHostDrop(hierarchy,'a','0','inside'),{parentId:'0',ids:['a']});
  assert.deepEqual(planHostDrop(hierarchy,'child','dest','inside'),{parentId:'dest',ids:['child']});
  assert.deepEqual(planHostDrop(hierarchy,'b','a','before'),{parentId:'work',ids:['b','a']});
});
test('rejects cycles, protocols, invalid targets and unchanged folder membership', () => {
  for (const [source,target,position] of [['work','work','inside'],['work','child','inside'],
    ['a','ftp-folder','inside'],['a','work','inside'],['a','gone','before'],['a','missing','inside'],
    ['a','x','inside'],['a','dest','before']]) {
    assert.equal(planHostDrop(hierarchy,source,target,position),null,`${source} ${target} ${position}`);
  }
});
