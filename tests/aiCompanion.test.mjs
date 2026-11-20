import test from 'node:test';
import assert from 'node:assert/strict';
import { companionContext, companionProfile, companionRetry, companionMarkdown, companionModel, companionServiceKey, companionLastModel } from '../src/aiCompanion.ts';

test('model selection follows valid tab choice, active service, then service fallback including services without a default model',()=>{
  const config={activeProfile:'missing',profiles:[{id:'empty',model:' '},{id:'a',model:'one'},{id:'b',model:'two'}]};
  assert.equal(companionProfile(config,'b'),'b');
  assert.equal(companionProfile(config,'gone'),'empty');
  assert.equal(companionProfile({...config,activeProfile:'b'},'gone'),'b');
  assert.equal(companionProfile({...config,profiles:[{id:'empty',model:''}]},'empty'),'empty');
  assert.equal(companionProfile({...config,profiles:[]},'gone'),'');
});
test('retry retains the latest question and its context, removes partial answers',()=>{
  const messages=[{id:'1',role:'user',content:'first'},{id:'2',role:'assistant',content:'answer'},{id:'3',role:'user',content:'second context'},{id:'4',role:'assistant',content:'partial'}];
  assert.deepEqual(companionRetry(messages),messages.slice(0,3));
  assert.deepEqual(companionRetry(messages.slice(0,3)),messages.slice(0,3));
  assert.deepEqual(companionRetry([{role:'assistant',content:'orphan'}]),[]);
  assert.equal(messages.length,4);
});
test('context redacts every source, deduplicates attachments and enforces the total bound',()=>{
  const result=companionContext(['Host: demo\nDirectory: /tmp',' API_KEY=private-value ','API_KEY=private-value','']);
  assert.ok(!result.includes('private-value'));
  assert.equal(result.split('[redacted]').length,2);
  assert.equal(companionContext(['a'.repeat(50000),'b'.repeat(50000)]).length,64000);
  assert.equal(companionContext(['one','one']),'one');
});
test('copying a conversation preserves markdown and role boundaries',()=>{
  const markdown=companionMarkdown([{role:'user',content:'help'},{role:'assistant',content:'```sh\npwd\n```'}],'demo');
  assert.equal(markdown,'# demo\n\n## You\n\nhelp\n\n## AI\n\n```sh\npwd\n```');
});

test('runtime model choices remain isolated by service and endpoint and preserve saved defaults',()=>{
  const a={id:'a',baseUrl:'https://example.com/v1',protocol:'openai',model:''};
  const b={...a,id:'b',model:'default-b'};
  const choices={[companionServiceKey(a)]:'chosen-a',[companionServiceKey(b)]:'chosen-b'};
  assert.equal(companionModel(a,choices),'chosen-a');
  assert.equal(companionModel(b,choices),'chosen-b');
  assert.equal(companionModel({...a,baseUrl:'https://other.test/v1'},choices),'');
  assert.equal(companionModel({...a,protocol:'anthropic'},choices),'');
  assert.equal(companionModel(b,{}),'default-b');
  assert.equal(companionModel(undefined,choices),'');
  assert.equal(a.model,'');assert.equal(b.model,'default-b');
});

test('last selected model restores its service and overrides the saved default',()=>{
  const profile={id:'a',baseUrl:'https://example.com/v1',protocol:'openai',model:'default'};
  const config={profiles:[profile],activeProfile:'other'};
  const raw=JSON.stringify({source:companionServiceKey(profile),model:' selected-model '});
  const restored=companionLastModel(config,raw);
  assert.equal(restored.profileId,'a');
  assert.equal(companionModel(profile,restored.choices),'selected-model');
  assert.equal(profile.model,'default');
  assert.equal(companionLastModel({profiles:[]},raw),null);
  assert.equal(companionLastModel({profiles:[{...profile,baseUrl:'https://changed.test/v1'}]},raw),null);
  assert.equal(companionLastModel({profiles:[{...profile,protocol:'anthropic'}]},raw),null);
});

test('invalid or unavailable last model storage falls back without throwing',()=>{
  const profile={id:'a',baseUrl:'https://example.com/v1',model:''};
  for(const raw of [null,'{','null','{}',JSON.stringify({source:companionServiceKey(profile),model:''}),JSON.stringify({source:companionServiceKey(profile),model:'a\nb'})]){
    assert.equal(companionLastModel({profiles:[profile]},raw),null);
  }
});
