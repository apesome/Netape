import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const targets = {
  'x86_64-apple-darwin': { label: 'macos_x64', extensions: ['dmg'] },
  'aarch64-apple-darwin': { label: 'macos_arm64', extensions: ['dmg'] },
  'x86_64-unknown-linux-gnu': { label: 'linux_x64', extensions: ['deb', 'AppImage'] },
  'aarch64-unknown-linux-gnu': { label: 'linux_arm64', extensions: ['deb', 'AppImage'] },
};
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `${command} failed`);
  return result.stdout;
}
const gh = args => run(process.env.GH_PATH || 'gh', args);
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : entry.isFile() ? [join(directory, entry.name)] : []);
function checkedFile(directory, entry) {
  if (!/^[\w.-]+$/.test(entry.name) || entry.name === '.' || entry.name === '..') throw new Error('Invalid artifact name');
  const bytes = readFileSync(join(directory, entry.name));
  if (digest(bytes) !== entry.sha256 || bytes.length !== entry.size) throw new Error(`Artifact checksum mismatch: ${entry.name}`);
  return join(directory, entry.name);
}
export function validateBundle(directory, version, commit) {
  const manifest = read(join(directory, 'build.json'));
  const config = targets[manifest.target];
  if (!config || manifest.version !== version || manifest.commit !== commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Build provenance mismatch');
  if (manifest.assets.length !== config.extensions.length) throw new Error('Missing platform installer');
  const expected = config.extensions.map(ext => `Netape_${version}_${config.label}.${ext}`);
  if (new Set(manifest.assets.map(item => item.name)).size !== expected.length || manifest.assets.some(item => !expected.includes(item.name))) throw new Error('Unexpected platform installer');
  for (const entry of manifest.assets) checkedFile(directory, entry);
  return manifest;
}
export function mergeCatalog(current, addition) {
  const merged = structuredClone(current);
  for (const plugin of addition.plugins) {
    const existing = merged.plugins.find(item => item.id === plugin.id);
    if (plugin.id !== 'ftp' || !existing || existing.version !== plugin.version) throw new Error('Plugin version conflict');
    for (const [target, artifact] of Object.entries(plugin.platforms)) {
      if (!targets[target]) throw new Error('Unexpected plugin platform');
      if (existing.platforms[target] && JSON.stringify(existing.platforms[target]) !== JSON.stringify(artifact)) throw new Error('Immutable plugin platform conflict');
      existing.platforms[target] = artifact;
    }
  }
  return merged;
}
function stage(target) {
  const config = targets[target];
  if (!config) throw new Error('Unsupported target');
  const version = read(join(root, 'package.json')).version;
  const output = join(root, 'plugin-release/unix', target);
  mkdirSync(output, { recursive: true });
  const bundleFiles = files(join(root, 'target', target, 'release/bundle'));
  const assets = config.extensions.map(ext => {
    const matches = bundleFiles.filter(path => path.endsWith(`.${ext}`));
    if (matches.length !== 1) throw new Error(`Expected exactly one ${ext} installer`);
    const name = `Netape_${version}_${config.label}.${ext}`;
    const bytes = readFileSync(matches[0]);
    copyFileSync(matches[0], join(output, name));
    const sha256 = digest(bytes);
    writeFileSync(join(output, `${name}.sha256`), `${sha256}  ${name}\n`);
    return { name, sha256, size: bytes.length };
  });
  save(join(output, 'build.json'), { version, target, commit: run('git', ['rev-parse', 'HEAD']).trim(), assets });
  console.log(`Staged ${target}: ${assets.map(item => item.name).join(', ')}`);
}
function publish() {
  const repository = process.env.GITHUB_REPOSITORY || 'apesome/Netape';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
  const version = read(join(root, 'package.json')).version;
  if (version !== read(join(root, 'src-tauri/tauri.conf.json')).version) throw new Error('App version mismatch');
  const commit = run('git', ['rev-parse', 'HEAD']).trim();
  const output = join(root, 'plugin-release');
  const directories = readdirSync(join(output, 'unix')).map(name => join(output, 'unix', name));
  const builds = directories.map(directory => ({ directory, manifest: validateBundle(directory, version, commit) }));
  if (builds.length !== Object.keys(targets).length || new Set(builds.map(item => item.manifest.target)).size !== builds.length) throw new Error('Expected all four unique platform builds');
  const appTag = `v${version}`;
  const releaseInfo = tag => JSON.parse(gh(['api', `repos/${repository}/releases/tags/${tag}`]));
  const appRelease = releaseInfo(appTag);
  const temporary = mkdtempSync(join(tmpdir(), 'netape-unix-release-'));
  gh(['release', 'download', appTag, '--repo', repository, '--pattern', 'index.json', '--pattern', 'index.json.sig', '--dir', temporary]);
  const trust = read(join(root, 'config/plugin-market.json'));
  const signature = read(join(temporary, 'index.json.sig'));
  const publicHex = trust.keys[signature.keyId];
  if (!/^[a-f0-9]{64}$/.test(publicHex || '')) throw new Error('Unknown catalog key');
  const publicKey = createPublicKey({ key: Buffer.from(`302a300506032b6570032100${publicHex}`, 'hex'), format: 'der', type: 'spki' });
  if (!verify(null, readFileSync(join(temporary, 'index.json')), publicKey, Buffer.from(signature.signature, 'base64'))) throw new Error('Invalid existing catalog signature');
  const privateKey = createPrivateKey(process.env.PLUGIN_CATALOG_PRIVATE_KEY || readFileSync(process.env.NETAPE_CATALOG_KEY_FILE || '', 'utf8'));
  if (createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') !== publicHex) throw new Error('Signing key mismatch');
  let catalog = read(join(temporary, 'index.json'));
  const uploads = [];
  for (const { directory, manifest } of builds) {
    for (const asset of manifest.assets) {
      const path = checkedFile(directory, asset);
      const checksum = `${asset.sha256}  ${asset.name}\n`;
      if (readFileSync(`${path}.sha256`, 'utf8') !== checksum) throw new Error('Checksum sidecar mismatch');
      uploads.push({ tag: appTag, path }, { tag: appTag, path: `${path}.sha256` });
    }
    const provenance = join(output, `Netape_${version}_${targets[manifest.target].label}.build.json`);
    save(provenance, manifest);
    uploads.push({ tag: appTag, path: provenance });
    const pluginsDirectory = join(directory, 'plugins');
    const partial = read(join(pluginsDirectory, 'index.json'));
    catalog = mergeCatalog(catalog, partial);
    const plugin = partial.plugins[0];
    if (partial.plugins.length !== 1 || Object.keys(plugin.platforms).join() !== manifest.target) throw new Error('Plugin build target mismatch');
    const artifact = plugin.platforms[manifest.target];
    const tag = `plugin-${plugin.id}-v${plugin.version}`;
    const prefix = `https://github.com/${repository}/releases/download/${tag}/`;
    if (!artifact.url.startsWith(prefix)) throw new Error('Plugin URL mismatch');
    const name = basename(new URL(artifact.url).pathname);
    const path = checkedFile(pluginsDirectory, { name, ...artifact });
    if (readFileSync(`${path}.sha256`, 'utf8') !== `${artifact.sha256}  ${name}\n`) throw new Error('Plugin checksum sidecar mismatch');
    uploads.push({ tag, path }, { tag, path: `${path}.sha256` });
  }
  // Validate every immutable destination before performing the first upload.
  const releases = new Map();
  for (const upload of uploads) {
    if (!releases.has(upload.tag)) releases.set(upload.tag, releaseInfo(upload.tag));
    const existing = releases.get(upload.tag).assets.find(item => item.name === basename(upload.path));
    if (existing) {
      if (existing.digest !== `sha256:${digest(readFileSync(upload.path))}`) throw new Error(`Published asset differs: ${existing.name}`);
      upload.skip = true;
    }
  }
  for (const upload of uploads) {
    if (!upload.skip) gh(['release', 'upload', upload.tag, upload.path, '--repo', repository]);
    console.log(`${upload.skip ? 'Verified' : 'Uploaded'} ${upload.tag}/${basename(upload.path)}`);
  }
  catalog.generatedAt = Math.floor(Date.now() / 1000);
  catalog.expiresAt = catalog.generatedAt + 60 * 86400;
  const site = join(output, 'site/plugins/v1');
  mkdirSync(site, { recursive: true });
  save(join(site, 'index.json'), catalog);
  save(join(site, 'index.json.sig'), { keyId: signature.keyId, signature: sign(null, readFileSync(join(site, 'index.json')), privateKey).toString('base64') });
  // Only this renewable signed metadata pair may replace published assets.
  gh(['release', 'upload', appTag, join(site, 'index.json'), join(site, 'index.json.sig'), '--repo', repository, '--clobber']);
  const section = '\n## macOS and Linux packages\n\nmacOS: Intel x64 and Apple Silicon ARM64 DMG. Linux: x64 (Ubuntu 22.04+) and ARM64 (Ubuntu 24.04+) DEB and AppImage, requiring WebKitGTK 4.1. SHA-256 files and per-platform source commit manifests accompany every installer. macOS builds are not Developer ID signed or notarized. FTP is available on all published platforms; SMB remains Windows only. Native builds and packaging are verified by CI; interactive desktop sessions have not been tested on these runners.\n\n';
  const marker = '\n## macOS and Linux packages\n';
  const notes = join(output, 'unix-release-notes.md');
  writeFileSync(notes, appRelease.body.split(marker)[0] + section + `Platform package source: https://github.com/${repository}/tree/${commit}\n`);
  gh(['release', 'edit', appTag, '--repo', repository, '--notes-file', notes]);
  writeFileSync(join(output, 'site/.nojekyll'), '');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'stage') stage(process.argv[3]);
  else if (process.argv[2] === 'publish') publish();
  else throw new Error('Usage: node scripts/unix-release.mjs stage TARGET | publish');
}
