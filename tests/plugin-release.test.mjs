import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createPublicKey, verify, createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

test('publishing tools package immutable target archives and sign exact index bytes',()=>{
  const temp=mkdtempSync(join(tmpdir(),'netape-release-test-'));
  const script=resolve('scripts/plugin-release.mjs');
  const run=(...args)=>{const result=spawnSync(process.execPath,[script,...args],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return result.stdout;};
  try {
    const key=join(temp,'key.pem'), trust=join(temp,'trust.json'), binary=join(temp,'binary'), notices=join(temp,'notices'), out=join(temp,'release');
    writeFileSync(trust,JSON.stringify({indexUrl:'https://example.com/index.json',allowedHosts:['example.com'],keys:{}}));
    writeFileSync(binary,'executable test fixture');mkdirSync(notices);writeFileSync(join(notices,'dependency-MIT.txt'),'Test dependency notice');
    run('keygen','--key',key,'--trust',trust,'--key-id','test');
    assert.equal(readFileSync(trust,'utf8').includes('PRIVATE KEY'),false);
    for(const target of ['x86_64-pc-windows-gnu','aarch64-apple-darwin']) {
      run('pack','--id','ftp','--target',target,'--no-build','--binary',binary,'--notices',notices,'--out',out);
    }
    const indexPath=join(out,'index.json'), bytes=readFileSync(indexPath), index=JSON.parse(bytes);
    assert.equal(index.plugins.length,1); assert.equal(index.plugins[0].version,'1.1.0');
    for(const [target,artifact]of Object.entries(index.plugins[0].platforms)) {
      const name=artifact.url.split('/').at(-1), file=readFileSync(join(out,name));
      assert.equal(artifact.size,file.length);assert.equal(artifact.sha256,createHash('sha256').update(file).digest('hex'));
      assert.ok(artifact.url.includes('/plugin-ftp-v1.1.0/'));
      const unpacked=target.includes('windows')?file:gunzipSync(file);
      for(const expected of ['plugin.json','netape-ftp','licenses/Netape-AGPL-3.0.txt','dependency-MIT.txt']) assert.ok(unpacked.includes(Buffer.from(expected)),expected);
    }
    run('sign','--index',indexPath,'--key',key,'--trust',trust,'--key-id','test');
    const envelope=JSON.parse(readFileSync(indexPath+'.sig','utf8'));
    assert.ok(verify(null,bytes,createPublicKey(readFileSync(key)),Buffer.from(envelope.signature,'base64')));
    assert.ok(!verify(null,Buffer.concat([bytes,Buffer.from(' ')]),createPublicKey(readFileSync(key)),Buffer.from(envelope.signature,'base64')));
    const duplicate=spawnSync(process.execPath,[script,'keygen','--key',key,'--trust',trust],{encoding:'utf8',windowsHide:true}); assert.notEqual(duplicate.status,0);assert.ok(existsSync(key));
  } finally { rmSync(temp,{recursive:true,force:true}); }
});
