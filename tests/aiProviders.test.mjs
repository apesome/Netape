import test from 'node:test';
import assert from 'node:assert/strict';
import directory from '../src/data/aiProviderDirectory.json' with {type:'json'};
import { AI_PROVIDERS, normalizeAiBase, identifyAiProvider, aiSourceIdentity, aiNeedsApiKey } from '../src/aiProviders.ts';

test('missing key prompts apply to hosted providers without blocking local or custom keyless services',()=>{
  const profile={id:'a',name:'test',model:'',hasKey:false,baseUrl:'https://api.openai.com/v1'};
  assert.equal(aiNeedsApiKey(profile),true);
  assert.equal(aiNeedsApiKey({...profile,hasKey:true}),false);
  assert.equal(aiNeedsApiKey({...profile,baseUrl:'http://localhost:11434/v1'}),false);
  assert.equal(aiNeedsApiKey({...profile,baseUrl:'https://custom.test/v1'}),false);
  assert.equal(aiNeedsApiKey({...profile,baseUrl:'https://ollama.com/v1'}),true);
});
test('normalizes compatible roots and complete API endpoints while preserving prefixes',()=>{
  assert.equal(normalizeAiBase(' https://example.com/ '),'https://example.com/v1');
  assert.equal(normalizeAiBase('https://example.com/prefix/v1/chat/completions/'),'https://example.com/prefix/v1');
  assert.equal(normalizeAiBase('http://localhost:11434/v1/models'),'http://localhost:11434/v1');
  for(const invalid of ['file:///tmp','https://key:secret@example.com','https://example.com?key=secret'])assert.equal(normalizeAiBase(invalid),null);
});
test('provider editions round trip without forcing a model',()=>{
  for(const provider of AI_PROVIDERS)for(const edition of provider.editions){
    assert.deepEqual(identifyAiProvider(edition.baseUrl,edition.protocol,provider.id),{provider:provider.id,edition:edition.id});
    assert.ok(!('model' in edition));
  }
  assert.deepEqual(identifyAiProvider('https://custom.test/v1'),{provider:'custom',edition:''});
});
test('source identity isolates credential edits and profile changes',()=>{
  const a=aiSourceIdentity('a','https://example.com/v1',undefined);
  assert.equal(a,aiSourceIdentity('a','https://example.com/v1/models',undefined));
  for(const candidate of [aiSourceIdentity('b','https://example.com/v1',undefined),aiSourceIdentity('a','https://other.test/v1',undefined),aiSourceIdentity('a','https://example.com/v1',''),aiSourceIdentity('a','https://example.com/v1','new-key')])assert.notEqual(candidate,a);
});

test('all provider directory editions are represented without relay presets',()=>{
  const sourceGroups = new Set(directory.providers.map(item=>item.group??item.name));
  assert.equal(AI_PROVIDERS.length,sourceGroups.size+1);
  for(const id of ['88api','grooroute','sidrune','ccvibe'])assert.ok(!AI_PROVIDERS.some(p=>p.id===id));
  assert.ok(AI_PROVIDERS.some(p=>p.id==='anthropic'&&p.editions[0].protocol==='anthropic'));
  assert.ok(AI_PROVIDERS.some(p=>p.id==='meta'&&p.note&&p.editions[0].baseUrl.includes('openrouter')));
  assert.ok(AI_PROVIDERS.some(p=>p.id==='ollama'&&p.editions[0].baseUrl.includes('localhost')));
  for (const entry of directory.providers) {
    if(entry.name==='Meta AI')continue;
    assert.ok(AI_PROVIDERS.some(p=>p.editions.some(e=>e.baseUrl===(entry.baseUrl||entry.anthropicUrl))),entry.name);
  }
});
test('protocols isolate catalog identities and complete Messages URLs normalize',()=>{
  assert.equal(normalizeAiBase('https://api.anthropic.com/v1/messages'),'https://api.anthropic.com/v1');
  assert.notEqual(aiSourceIdentity('a','https://example.com/v1','key','openai'),aiSourceIdentity('a','https://example.com/v1','key','anthropic'));
});
