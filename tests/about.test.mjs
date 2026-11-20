import test from 'node:test';
import assert from 'node:assert/strict';
import { ABOUT_PROJECT, fetchGithubAbout } from '../src/about.ts';

const response = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json'}});

test('GitHub author and release are independent of the installed app version', async()=>{
  const installedVersion=ABOUT_PROJECT.version;
  const calls=[];
  const result=await fetchGithubAbout(async(url,options)=>{
    calls.push(url);
    assert.ok(options.signal);
    if(url.includes('/users/'))return response({login:ABOUT_PROJECT.owner,name:'Display Name'});
    if(url.endsWith('/releases/latest'))return response({tag_name:'v2.0.0'});
    return response({description:'Terminal client',stargazers_count:42,license:{spdx_id:'AGPL-3.0'}});
  });
  assert.equal(result.author,'Display Name');
  assert.equal(result.latestVersion,'v2.0.0');
  assert.equal(result.stars,42);
  assert.equal(result.license,'AGPL-3.0');
  assert.equal(result.releaseAvailable,true);
  assert.equal(ABOUT_PROJECT.version,installedVersion);
  assert.equal(calls.length,3);
  assert.ok(calls.every(url=>url.startsWith('https://api.github.com/')));
});

test('offline or rate limited GitHub keeps local author and unknown release',async()=>{
  for(const fetcher of [async()=>{throw Error('offline');},async()=>response({},403)]){
    const result=await fetchGithubAbout(fetcher);
    assert.equal(result.author,ABOUT_PROJECT.author);
    assert.equal(result.repositoryAvailable,false);
    assert.equal(result.authorAvailable,false);
    assert.equal(result.releaseAvailable,false);
    assert.equal(result.latestVersion,null);
    assert.equal(result.stars,null);
  }
});

test('no published release is distinguished from an unavailable repository',async()=>{
  const result=await fetchGithubAbout(async url=>url.endsWith('/releases/latest')?response({},404):url.includes('/users/')?response({login:ABOUT_PROJECT.owner}):response({license:{spdx_id:'NOASSERTION'}}));
  assert.equal(result.author,ABOUT_PROJECT.owner);
  assert.equal(result.releaseAvailable,true);
  assert.equal(result.latestVersion,null);
  assert.equal(result.license,null);
  const unavailable=await fetchGithubAbout(async()=>response({},404));
  assert.equal(unavailable.releaseAvailable,false);
});

test('malformed GitHub responses retain local information',async()=>{
  const result=await fetchGithubAbout(async()=>response({name:42,stargazers_count:-1,license:{spdx_id:[]},tag_name:{}}));
  assert.equal(result.author,ABOUT_PROJECT.author);
  assert.equal(result.stars,null);
  assert.equal(result.latestVersion,null);
});
