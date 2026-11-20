import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateBundle, mergeCatalog } from '../scripts/unix-release.mjs';

test('platform publisher rejects changed files, traversal and wrong provenance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'netape-unix-test-'));
  const bytes = Buffer.from('installer fixture');
  const commit = 'a'.repeat(40);
  const name = 'Netape_1.0.0_macos_arm64.dmg';
  const manifest = { version: '1.0.0', target: 'aarch64-apple-darwin', commit, assets: [{ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  const save = () => writeFileSync(join(dir, 'build.json'), JSON.stringify(manifest));
  try {
    writeFileSync(join(dir, name), bytes); save();
    assert.equal(validateBundle(dir, '1.0.0', commit).target, manifest.target);
    assert.throws(() => validateBundle(dir, '1.0.0', 'b'.repeat(40)), /provenance/);
    writeFileSync(join(dir, name), 'altered');
    assert.throws(() => validateBundle(dir, '1.0.0', commit), /checksum/);
    manifest.assets[0].name = '../secret'; save();
    assert.throws(() => validateBundle(dir, '1.0.0', commit), /Unexpected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('catalog expansion preserves Windows and rejects changing an existing target or version', () => {
  const windows = { sha256: 'old' }, mac = { sha256: 'new' };
  const current = { plugins: [{ id: 'ftp', version: '1.1.0', platforms: { 'x86_64-pc-windows-gnu': windows } }] };
  const addition = { plugins: [{ id: 'ftp', version: '1.1.0', platforms: { 'aarch64-apple-darwin': mac } }] };
  const merged = mergeCatalog(current, addition);
  assert.deepEqual(merged.plugins[0].platforms['x86_64-pc-windows-gnu'], windows);
  assert.equal(current.plugins[0].platforms['aarch64-apple-darwin'], undefined);
  assert.deepEqual(mergeCatalog(merged, addition), merged);
  addition.plugins[0].platforms['aarch64-apple-darwin'] = { sha256: 'different' };
  assert.throws(() => mergeCatalog(merged, addition), /Immutable/);
  addition.plugins[0].version = '1.2.0';
  assert.throws(() => mergeCatalog(current, addition), /version conflict/);
});
