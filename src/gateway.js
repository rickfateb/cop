import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

function sameSecret(expected, value) {
  if (!expected || expected.length < 24) return false;
  const a = Buffer.from(value || ''); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function binaryBody(req, maxBytes) {
  const chunks = []; let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(Error('Arquivo acima do limite do gateway.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!total) throw Error('Arquivo vazio.');
  return Buffer.concat(chunks, total);
}

function safeRelativePath(value) {
  const raw = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '.' || part === '..')) throw Error('Caminho de arquivo inválido.');
  return parts.map(part => {
    const safe = part.replace(/[^A-Za-z0-9._() -]/g, '_').slice(0, 120);
    if (!safe || safe === '.' || safe === '..') throw Error('Nome de arquivo inválido.');
    return safe;
  }).join('/');
}

export function createGatewayIngest({ pool, root = process.env.COP_INGEST_ROOT || '/data/sftp/incoming', logger = console } = {}) {
  if (!pool) throw Error('Pool PostgreSQL obrigatório para o gateway.');
  const secret = process.env.COP_GATEWAY_TOKEN || '';
  return async function gatewayIngest(req, res, ingestKey, json) {
    if (!sameSecret(secret, req.headers['x-cop-gateway-token'])) return json(res, 401, { error: 'Gateway não autorizado.' });
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(ingestKey)) throw Error('Identificador de ingestão inválido.');
    const dvr = await pool.query('SELECT id FROM cop_dvrs WHERE lower(ingest_key)=lower($1) AND active=TRUE', [ingestKey]);
    if (!dvr.rowCount) return json(res, 404, { error: 'DVR de ingestão não encontrado.' });
    const source = safeRelativePath(req.headers['x-source-path'] || req.headers['x-file-name'] || ('upload-' + Date.now() + '.bin'));
    const configured = Number(process.env.COP_GATEWAY_MAX_BYTES || 67108864);
    const maxBytes = Math.max(1024 * 1024, Math.min(512 * 1024 * 1024, Number.isFinite(configured) ? configured : 67108864));
    const payload = await binaryBody(req, maxBytes);
    const dest = path.join(root, ingestKey, source);
    await mkdir(path.dirname(dest), { recursive: true });
    const temp = dest + '.uploading-' + randomBytes(4).toString('hex');
    try {
      await writeFile(temp, payload, { flag: 'wx', mode: 0o640 });
      await rename(temp, dest);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
    logger.log('COP gateway recebeu: dvr=' + ingestKey + ' bytes=' + payload.length + ' arquivo=' + source);
    return json(res, 202, { ok: true, bytes: payload.length, source_path: source });
  };
}
