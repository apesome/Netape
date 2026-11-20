import test from 'node:test';
import assert from 'node:assert/strict';
import {syncTransferTimings,transferElapsed} from '../src/transferTiming.ts';
const file=(relPath,extra={})=>({relPath,startedAt:1000,status:'running',speed:10,transferred:20,...extra});
const parent=()=>({id:'t',isDir:true,startedAt:1000,status:'running',speed:20,transferred:40,subFiles:[file('a'),file('dir/b')]});
test('global pause freezes parent and every child, resumes without counting pause',()=>{
 let old=[parent()];let paused=syncTransferTimings([{...old[0],paused:true}],old,4000);
 for(const row of [paused[0],...paused[0].subFiles]){assert.equal(transferElapsed(row,12000),3000);assert.equal(row.speed,0);}
 let resumed=syncTransferTimings([{...paused[0],paused:false}],paused,14000);
 assert.equal(transferElapsed(resumed[0],16000),5000);
 assert.equal(transferElapsed(resumed[0].subFiles[1],16000),5000);
 let done=syncTransferTimings([{...resumed[0],status:'done',elapsedMs:20000}],resumed,18000);
 assert.equal(transferElapsed(done[0],50000),7000);
});
test('pausing every child freezes parent; partial resume keeps other child frozen',()=>{
 let old=[parent()];let one=syncTransferTimings([{...old[0],subFiles:[{...old[0].subFiles[0],paused:true},old[0].subFiles[1]]}],old,4000);
 assert.equal(transferElapsed(one[0],6000),5000);
 let all=syncTransferTimings([{...one[0],subFiles:one[0].subFiles.map(f=>({...f,paused:true}))}],one,6000);
 assert.equal(transferElapsed(all[0],12000),5000);
 let partial=syncTransferTimings([{...all[0],subFiles:all[0].subFiles.map((f,i)=>({...f,paused:i!==0}))}],all,12000);
 assert.equal(transferElapsed(partial[0],14000),7000);
 assert.equal(transferElapsed(partial[0].subFiles[0],14000),5000);
 assert.equal(transferElapsed(partial[0].subFiles[1],14000),5000);
});
test('late progress and repeated pause updates never advance a frozen clock',()=>{
 const old=[parent()],paused=syncTransferTimings([{...old[0],paused:true}],old,4000);
 const late=syncTransferTimings([{...paused[0],speed:999,subFiles:paused[0].subFiles.map(f=>({...f,speed:999}))}],paused,8000);
 assert.equal(transferElapsed(late[0],12000),3000);assert.equal(late[0].speed,0);
 const error=syncTransferTimings([{...late[0],status:'error',elapsedMs:9000}],late,10000);
 assert.equal(transferElapsed(error[0]),3000);
});
