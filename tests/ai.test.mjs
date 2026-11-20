import test from 'node:test';
import assert from 'node:assert/strict';
import { redactAiContext, terminalText, terminalInput } from '../src/ai.ts';
import { updateRightDrawer } from '../src/rightDrawer.ts';
test('shared terminal context removes common credentials and incomplete private keys',()=>{
  const text='API_KEY="private-value"\npassword=abc\nAuthorization: Bearer eyJ.abc\nsk-123456789012345\n-----BEGIN OPENSSH PRIVATE KEY-----\nsecret';
  const redacted=redactAiContext(text);
  for(const secret of ['private-value','abc','eyJ.abc','sk-123456789012345','\nsecret'])assert.ok(!redacted.includes(secret));
  assert.equal(redactAiContext('ls -la /tmp\nerror: no such file'),'ls -la /tmp\nerror: no such file');
});
test('terminal context is bounded to requested recent lines and size',()=>{
  const lines=['old','middle','recent','prompt'];
  const terminal={buffer:{active:{length:lines.length,getLine:i=>({translateToString:()=>lines[i]})}}};
  assert.equal(terminalText(terminal,2),'recent\nprompt');
  assert.equal(terminalText(terminal,0),'prompt');
});
test('AI drawers replace other panels and stay isolated between tabs',()=>{
  const state={a:'monitor',b:'notes'};
  assert.deepEqual(updateRightDrawer(state,'a','ai',true),{a:'ai',b:'notes'});
  assert.deepEqual(updateRightDrawer({a:'ai',b:'notes'},'a','ai',true),{b:'notes'});
});
test('paste never submits Enter and strips terminal control sequences',()=>{
  assert.equal(terminalInput('echo one\necho two\r\x03',false),'echo one echo two ');
  assert.equal(terminalInput('echo one\necho two',true),'\x1b[200~echo one\necho two\x1b[201~');
  assert.equal(terminalInput('pwd',false,true),'pwd\r');
  assert.equal(terminalInput('pwd',true,true),'\x1b[200~pwd\x1b[201~\r');
});
