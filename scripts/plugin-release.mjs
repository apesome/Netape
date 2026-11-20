import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.argv.slice(2);
function option(name, fallback) { const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index+1]; }
const keyId = option('key-id', 'apesome-2026');
const keyPath = resolve(option('key', join(homedir(), '.netape', 'publisher', 'catalog-key.pem')));
const trustPath = resolve(option('trust', join(root, 'config/plugin-market.json')));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => { mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, JSON.stringify(value,null,2)+'\n'); };
function run(cmd, argv) { const result = spawnSync(cmd, argv, {cwd:root, encoding:'utf8', windowsHide:true, maxBuffer:64*1024*1024, ...(argv[0]==='build'?{stdio:'inherit'}:{})}); if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `${cmd} failed`); return result.stdout; }
function requireKey() {
  const key = createPrivateKey(readFileSync(keyPath));
  const hex = createPublicKey(key).export({type:'spki',format:'der'}).subarray(-32).toString('hex');
  if (read(trustPath).keys[keyId] !== hex) throw new Error('Signing key does not match the committed trusted public key');
  return key;
}
function crc32(data) { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for(let bit=0;bit<8;bit++) crc = (crc>>>1) ^ (0xedb88320 & -(crc&1)); } return (crc ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name=Buffer.from(entry.name), data=entry.data, crc=crc32(data);
    const header=Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt32LE(crc,14); header.writeUInt32LE(data.length,18); header.writeUInt32LE(data.length,22); header.writeUInt16LE(name.length,26);
    local.push(header,name,data);
    const dir=Buffer.alloc(46); dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(0x0314,4); dir.writeUInt16LE(20,6); dir.writeUInt32LE(crc,16); dir.writeUInt32LE(data.length,20); dir.writeUInt32LE(data.length,24); dir.writeUInt16LE(name.length,28); dir.writeUInt32LE(((0o100000|entry.mode)<<16)>>>0,38); dir.writeUInt32LE(offset,42);
    central.push(dir,name); offset += header.length+name.length+data.length;
  }
  const directory=Buffer.concat(central), end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
function tarGz(entries) {
  const parts=[];
  for (const entry of entries) {
    if (Buffer.byteLength(entry.name)>100) throw new Error('Package path exceeds portable tar name length');
    const header=Buffer.alloc(512); header.write(entry.name,0,100);
    for(const [offset,length,value] of [[100,8,entry.mode],[108,8,0],[116,8,0],[124,12,entry.data.length],[136,12,0]]) header.write(value.toString(8).padStart(length-1,'0')+'\0',offset,length);
    header.fill(32,148,156); header[156]=48; header.write('ustar\0',257,6); header.write('00',263,2);
    const sum=header.reduce((total,byte)=>total+byte,0); header.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8);
    parts.push(header,entry.data,Buffer.alloc((512-entry.data.length%512)%512));
  }
  return gzipSync(Buffer.concat([...parts,Buffer.alloc(1024)]));
}
function collectFiles(directory, prefix='licenses') {
  const files=[];
  for(const item of readdirSync(directory,{withFileTypes:true})) {
    if(item.isSymbolicLink()) throw new Error('License directory contains a symbolic link');
    const path=join(directory,item.name), name=`${prefix}/${item.name}`;
    if(item.isDirectory()) files.push(...collectFiles(path,name));
    else if(item.isFile()) files.push({name,data:readFileSync(path),mode:0o644});
  }
  return files;
}

if (command === 'keygen') {
  if (existsSync(keyPath)) throw new Error(`Signing key already exists: ${keyPath}`);
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  mkdirSync(dirname(keyPath),{recursive:true}); writeFileSync(keyPath,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
  const trust=read(trustPath); trust.keys[keyId]=publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex'); save(trustPath,trust);
  console.log(`Private signing key saved locally: ${keyPath}\nPublic key updated: ${trustPath}\nBack up the private key securely; never commit or publish it.`);
} else if (command === 'pack') {
  const id=option('id'), target=option('target');
  if(!['ftp','smb'].includes(id)||!['x86_64-pc-windows-msvc','x86_64-pc-windows-gnu','aarch64-pc-windows-msvc','x86_64-unknown-linux-gnu','aarch64-unknown-linux-gnu','x86_64-apple-darwin','aarch64-apple-darwin'].includes(target)) throw new Error('Provide --id ftp|smb and a supported --target Rust triple');
  if(id==='smb'&&!target.includes('windows')) throw new Error('SMB is currently Windows only');
  const manifest=read(join(root,`crates/netape-${id}/plugin.json`));
  const cargo=readFileSync(join(root,`crates/netape-${id}/Cargo.toml`),'utf8');
  if(!cargo.includes(`version = "${manifest.version}"`)) throw new Error('Plugin Cargo and manifest versions do not match');
  if(!args.includes('--no-build')) run('cargo',['build','--release','-p',`netape-${id}`,'--target',target]);
  const exe=manifest.bin+(target.includes('windows')?'.exe':'');
  const binary=resolve(option('binary',join(root,'target',target,'release',exe)));
  const entries=[{name:'plugin.json',data:Buffer.from(JSON.stringify(manifest,null,2)+'\n'),mode:0o644},{name:exe,data:readFileSync(binary),mode:0o755},{name:'licenses/Netape-AGPL-3.0.txt',data:readFileSync(join(root,'LICENSE')),mode:0o644}];
  const notices=option('notices');
  if(notices) entries.push(...collectFiles(resolve(notices)));
  else {
    const metadata=JSON.parse(run('cargo',['metadata','--format-version','1','--filter-platform',target]));
    const pkg=metadata.packages.find(value=>value.name===`netape-${id}`), nodes=new Map(metadata.resolve.nodes.map(value=>[value.id,value]));
    const pending=[pkg.id], visited=new Set();
    while(pending.length) {
      const id=pending.pop(); if(visited.has(id))continue; visited.add(id);
      const dep=metadata.packages.find(value=>value.id===id); pending.push(...(nodes.get(id)?.dependencies??[]));
      if(dep.id===pkg.id)continue;
      const folder=dirname(dep.manifest_path);
      const files=readdirSync(folder).filter(name=>/^(LICENSE|COPYING|NOTICE)([.-]|$)/i.test(name));
      for(const name of files) { const path=join(folder,name); try { entries.push({name:`licenses/${dep.name}-${dep.version}/${basename(name)}`,data:readFileSync(path),mode:0o644}); } catch { /* directories are not license files */ } }
    }
  }
  const out=resolve(option('out',join(root,'plugin-release'))); mkdirSync(out,{recursive:true});
  const format=target.includes('windows')?'zip':'tar.gz', filename=`netape-${id}-${manifest.version}-${target}.${format}`;
  const bytes=format==='zip'?zip(entries):tarGz(entries); writeFileSync(join(out,filename),bytes);
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const repository=option('repository','apesome/Netape'); if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository');
  const indexPath=join(out,'index.json'); const timestamp=Math.floor(Date.now()/1000);
  const index=existsSync(indexPath)?read(indexPath):{schemaVersion:1,generatedAt:timestamp,expiresAt:timestamp+60*86400,plugins:[]};
  let item=index.plugins.find(value=>value.id===id);
  if(item&&item.version!==manifest.version) { index.plugins=index.plugins.filter(value=>value.id!==id); item=null; }
  if(!item) { item={...manifest,minAppVersion:'1.0.0',platforms:{}}; index.plugins.push(item); }
  item.platforms[target]={url:`https://github.com/${repository}/releases/download/plugin-${id}-v${manifest.version}/${filename}`,archive:format,size:bytes.length,sha256};
  index.generatedAt=timestamp; index.expiresAt=timestamp+60*86400; save(indexPath,index);
  writeFileSync(join(out,`${filename}.sha256`),`${sha256}  ${filename}\n`);
  console.log(`Packaged ${filename}; updated ${indexPath}. Upload the archive before signing and publishing the index.`);
} else if(command==='sign') {
  const indexPath=resolve(option('index',join(root,'plugin-release/index.json'))), bytes=readFileSync(indexPath), index=read(indexPath);
  if(index.schemaVersion!==1||!Array.isArray(index.plugins)||index.expiresAt<=Date.now()/1000) throw new Error('Invalid or expired catalog');
  const key=requireKey(); save(indexPath+'.sig',{keyId,signature:sign(null,bytes,key).toString('base64')}); console.log(`Signed ${indexPath}; publish index.json and index.json.sig together after the archives are available.`);
} else {
  console.log('Usage:\n  node scripts/plugin-release.mjs keygen [--key path] [--key-id name]\n  node scripts/plugin-release.mjs pack --id ftp|smb --target TRIPLE [--out dir] [--no-build] [--binary path] [--notices dir]\n  node scripts/plugin-release.mjs sign [--index path] [--key path] [--key-id name]');
  if(command)process.exitCode=1;
}
