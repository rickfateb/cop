import { createReadStream } from 'node:fs';
import { readdir, stat, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

const root = process.env.FTP_ROOT || '/srv/ftp';
const baseUrl = process.env.COP_BASE_URL || 'https://cop-web-ingest-production.up.railway.app';
const token = process.env.COP_GATEWAY_TOKEN || '';
const intervalMs = Math.max(1000, Number(process.env.FTP_SCAN_MS || 3000));
const allowedKeys = new Set(String(process.env.FTP_INGEST_KEYS || '').split(',').map(v => v.trim()).filter(Boolean));
const stable = new Map();

async function walk(dir, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return out; throw e; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.avi') return 'video/x-msvideo';
  if (ext === '.dav') return 'application/octet-stream';
  return 'application/octet-stream';
}

function send(file, ingestKey, sourcePath, size) {
  return new Promise((resolve, reject) => {
    const target = new URL('/api/ingest/external/' + encodeURIComponent(ingestKey), baseUrl);
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(target, {
      method: 'POST',
      headers: {
        'x-cop-gateway-token': token,
        'x-source-path': sourcePath,
        'content-type': contentType(file),
        'content-length': String(size)
      }
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, body });
        else reject(Error('COP respondeu ' + res.statusCode + ': ' + body.slice(0, 300)));
      });
    });
    req.on('error', reject);
    createReadStream(file).on('error', reject).pipe(req);
  });
}

async function cleanupParents(file) {
  let dir = path.dirname(file);
  while (dir.startsWith(root) && dir !== root) {
    try { await rmdir(dir); } catch { break; }
    dir = path.dirname(dir);
  }
}

async function scan() {
  const files = await walk(root);
  const seen = new Set(files);
  for (const file of files) {
    const info = await stat(file);
    const signature = info.size + ':' + info.mtimeMs;
    const previous = stable.get(file);
    if (!previous || previous.signature !== signature) { stable.set(file, { signature, count: 0 }); continue; }
    previous.count++;
    if (previous.count < 1 || Date.now() - info.mtimeMs < 2000 || info.size === 0) continue;
    const rel = path.relative(root, file).split(path.sep).join('/');
    const parts = rel.split('/').filter(Boolean);
    const ingestKey = parts.shift();
    if (!ingestKey || (allowedKeys.size && !allowedKeys.has(ingestKey))) {
      console.error('Arquivo fora de ingest_key permitido:', rel); stable.delete(file); continue;
    }
    const sourcePath = parts.join('/') || path.basename(file);
    try {
      await send(file, ingestKey, sourcePath, info.size);
      console.log('FTP->COP OK:', ingestKey, sourcePath, info.size, 'bytes');
      await unlink(file);
      await cleanupParents(file);
      stable.delete(file);
    } catch (error) {
      console.error('FTP->COP falhou:', rel, error.message);
    }
  }
  for (const file of stable.keys()) if (!seen.has(file)) stable.delete(file);
}

if (!token || token.length < 24) { console.error('Configure COP_GATEWAY_TOKEN com pelo menos 24 caracteres.'); process.exit(1); }
console.log('COP FTP gateway watcher ativo em', root, '->', baseUrl);
setInterval(() => scan().catch(error => console.error('scan:', error.message)), intervalMs);
scan().catch(error => console.error('scan inicial:', error.message));
