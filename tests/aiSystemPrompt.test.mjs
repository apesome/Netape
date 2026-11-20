import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultAiSystemPrompt, effectiveAiSystemPrompt, isAutomaticAiSystemPrompt } from '../src/aiSystemPrompt.ts';

test('automatic instructions follow all supported interface languages', () => {
  const values = ['zh_CN','en','de','ja'].map(language => effectiveAiSystemPrompt('', language));
  assert.equal(new Set(values).size, 4);
  assert.match(values[0], /请用中文回答/);
  assert.match(values[1], /Reply in English/);
  assert.match(values[2], /Antworte auf Deutsch/);
  assert.match(values[3], /日本語で回答/);
  assert.equal(defaultAiSystemPrompt('unknown'), values[1]);
  assert.equal(defaultAiSystemPrompt('legacy'), values[1]);
});

test('legacy built-in instructions become automatic while custom text stays unchanged', () => {
  const prompts = JSON.parse(readFileSync(new URL('../src/aiSystemPrompts.json', import.meta.url), 'utf8'));
  assert.ok(isAutomaticAiSystemPrompt(prompts.legacy));
  assert.equal(effectiveAiSystemPrompt(prompts.legacy, 'zh_CN'), prompts.zh_CN);
  const custom = 'My custom instructions. 用中文解释。';
  for(const language of ['zh_CN','en','de','ja']) assert.equal(effectiveAiSystemPrompt(custom, language), custom);
  assert.equal(effectiveAiSystemPrompt(prompts.en, 'ja'), prompts.en);
  assert.ok(!isAutomaticAiSystemPrompt(custom));
});
