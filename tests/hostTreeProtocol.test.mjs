import test from 'node:test';
import assert from 'node:assert/strict';
import { folderBelongsToProtocol } from '../src/hostTreeProtocol.ts';

test('protocol-specific folders match the home tree even when they contain other protocols', () => {
  assert.equal(folderBelongsToProtocol({protocol: 'Folder', ownerType: 'SSH'}, 'FTP'), false);
  assert.equal(folderBelongsToProtocol({protocol: 'Folder', ownerType: ''}, 'FTP'), false);
  assert.equal(folderBelongsToProtocol({protocol: 'Folder', ownerType: ''}, 'SSH'), true);
  assert.equal(folderBelongsToProtocol({protocol: 'Folder', ownerType: 'FTP'}, 'FTP'), true);
  assert.equal(folderBelongsToProtocol({protocol: 'FTP', ownerType: 'FTP'}, 'FTP'), false);
});
