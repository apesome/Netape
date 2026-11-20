import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const repository = option('repository', 'apesome/Netape');
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GitHub repository');
const output = resolve(root, option('out', 'plugin-release'));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function gh(argv, allowMissing = false) {
  const r = spawnSync(process.env.GH_PATH || 'gh', argv, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (r.status === 0) return r.stdout;
  if (allowMissing && /HTTP 404|Not Found|release not found/i.test(r.stderr)) return null;
  throw new Error(r.stderr || r.error?.message || `gh ${argv[0]} failed`);
}
const release = tag => {
  const result = gh(['api', `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`], true);
  return result === null ? null : JSON.parse(result);
};
const manifest = id => read(join(root, `crates/netape-${id}/plugin.json`));
const indexPath = join(output, 'index.json');
const index = read(indexPath);

// Reuse immutable plugin versions when only the application is being released.
// The subsequent client-module verification checks their manifests and contents.
if (args.includes('--prepare')) {
  for (const entry of index.plugins) {
    const published = release(`plugin-${entry.id}-v${entry.version}`);
    if (!published) continue;
    for (const platform of Object.values(entry.platforms)) {
      const name = basename(new URL(platform.url).pathname);
      if (!published.assets.some(asset => asset.name === name)) throw new Error(`Existing plugin release lacks ${name}; publish a new plugin version for a new target.`);
      const temporary = mkdtempSync(join(tmpdir(), 'netape-release-'));
      try {
        gh(['release', 'download', published.tag_name, '--repo', repository, '--pattern', name, '--pattern', `${name}.sha256`, '--dir', temporary]);
        const archive = join(temporary, name);
        const digest = hash(archive);
        const expected = readFileSync(`${archive}.sha256`, 'utf8').trim().split(/\s+/)[0];
        if (digest !== expected) throw new Error(`Published checksum mismatch for ${name}`);
        copyFileSync(archive, join(output, name));
        copyFileSync(`${archive}.sha256`, join(output, `${name}.sha256`));
        platform.sha256 = digest;
        platform.size = readFileSync(archive).length;
        console.log(`Reused published ${published.tag_name}/${name}`);
      } finally { rmSync(temporary, { recursive: true, force: true }); }
    }
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
  console.log('Prepared immutable plugin assets. Sign and verify the catalog before publishing.');
  process.exit(0);
}

const target = option('target', spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim());
if (!/^[a-f0-9]{40}$/.test(target)) throw new Error('Provide a full source commit SHA with --target');
const pkg = read(join(root, 'package.json'));
const tauri = read(join(root, 'src-tauri/tauri.conf.json'));
if (pkg.version !== tauri.version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw new Error('Application versions must match');
const trust = read(join(root, 'config/plugin-market.json'));
const signature = read(`${indexPath}.sig`);
const publicHex = trust.keys[signature.keyId];
if (!publicHex) throw new Error('Unknown catalog signing key');
const key = createPublicKey({ key: Buffer.from(`302a300506032b6570032100${publicHex}`, 'hex'), format: 'der', type: 'spki' });
if (!verify(null, readFileSync(indexPath), key, Buffer.from(signature.signature, 'base64'))) throw new Error('Invalid catalog signature');
if (index.expiresAt * 1000 <= Date.now()) throw new Error('Catalog is expired');

const nsisDir = join(root, 'target/x86_64-pc-windows-gnu/release/bundle/nsis');
const installers = option('installer') ? [resolve(root, option('installer'))] : readdirSync(nsisDir).filter(name => name.endsWith('.exe') && name.includes(pkg.version)).map(name => join(nsisDir, name));
if (installers.length !== 1) throw new Error('Expected exactly one matching NSIS installer; use --installer PATH');
const appName = `Netape_${pkg.version}_windows_x64_setup.exe`;
const appPath = join(output, appName);
copyFileSync(installers[0], appPath);
writeFileSync(`${appPath}.sha256`, `${hash(appPath)}  ${appName}\n`);
const appTag = `v${pkg.version}`;
if (release(appTag)) throw new Error(`${appTag} already exists. Existing app releases are never overwritten.`);
const identity = JSON.parse(gh(['repo', 'view', repository, '--json', 'nameWithOwner,isEmpty']));
if (identity.isEmpty) throw new Error('Push the source commit before publishing');
gh(['api', `repos/${repository}/commits/${target}`, '--jq', '.sha']);

const plans = [];
for (const entry of index.plugins) {
  if (!['ftp', 'smb'].includes(entry.id) || manifest(entry.id).version !== entry.version) throw new Error('Plugin manifest version mismatch');
  const assets = [];
  for (const platform of Object.values(entry.platforms)) {
    const tag = `plugin-${entry.id}-v${entry.version}`;
    const prefix = `https://github.com/${repository}/releases/download/${tag}/`;
    if (!platform.url.startsWith(prefix)) throw new Error('Catalog archive URL does not match the repository and plugin tag');
    const name = basename(new URL(platform.url).pathname);
    const path = join(output, name);
    if (hash(path) !== platform.sha256 || readFileSync(path).length !== platform.size) throw new Error(`Archive differs from signed index: ${name}`);
    assets.push(path, `${path}.sha256`);
  }
  plans.push({ tag: `plugin-${entry.id}-v${entry.version}`, title: `Netape ${entry.name} ${entry.version}`, assets });
}

for (const plan of plans) {
  const existing = release(plan.tag);
  if (existing) {
    const temporary = mkdtempSync(join(tmpdir(), 'netape-readback-'));
    try {
      for (const path of plan.assets) {
        gh(['release', 'download', plan.tag, '--repo', repository, '--pattern', basename(path), '--dir', temporary]);
        if (hash(path) !== hash(join(temporary, basename(path)))) throw new Error(`Existing asset differs: ${basename(path)}`);
      }
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    console.log(`Verified existing immutable release ${plan.tag}`);
    continue;
  }
  const notes = join(output, `${plan.tag}.md`);
  writeFileSync(notes, `Windows x64 GNU plugin for Netape ${pkg.version}. Install from Settings → Plugins, or extract and install locally.\n\nSHA-256 checksums and third-party license notices are included. Complete corresponding source: https://github.com/${repository}/tree/${target}\n\nLicense: AGPL-3.0.\n`);
  gh(['release', 'create', plan.tag, ...plan.assets, '--repo', repository, '--target', target, '--title', plan.title, '--notes-file', notes, '--latest=false']);
}

const notes = join(output, `${appTag}.md`);
writeFileSync(notes, `## Netape ${pkg.version}\n\nWindows x64 installer (GNU target).\n\n- Local terminals, SSH and SFTP file transfers.\n- AI assistant with provider/model selection and usage/balance display.\n- Signed online FTP/SMB plugin downloads with progress and cancellation.\n- Chinese, English, German and Japanese interfaces.\n\nDownload the setup executable below and use the .sha256 file to check its integrity. The installer is not Authenticode-signed. WebView2 Runtime is required; setup downloads it when needed.\n\nFTP/SMB are optional plugins available in separate releases and the in-app plugin market.\n\nSource and build instructions: https://github.com/${repository}/tree/${target}\nLicense: AGPL-3.0.\n`);
gh(['release', 'create', appTag, appPath, `${appPath}.sha256`, indexPath, `${indexPath}.sig`, '--repo', repository, '--target', target, '--title', `Netape ${pkg.version}`, '--notes-file', notes, '--latest']);
const site = join(output, 'site/plugins/v1');
mkdirSync(site, { recursive: true });
copyFileSync(indexPath, join(site, 'index.json'));
copyFileSync(`${indexPath}.sig`, join(site, 'index.json.sig'));
writeFileSync(join(output, 'site/.nojekyll'), '');
console.log(`Published https://github.com/${repository}/releases/tag/${appTag}`);
console.log('Deploy plugin-release/site to GitHub Pages after the release download checks succeed.');
