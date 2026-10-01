import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startIngestWorker } from './ingest.js';
import { accessModes, defaults, integer, models, nonEmpty, optional, validatePolicy } from './validation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.COP_ADMIN_TOKEN;
if (!token || token.length < 12 || !process.env.DATABASE_URL) {
  console.error('Configure COP_ADMIN_TOKEN (mínimo 12 caracteres) e DATABASE_URL.');
  process.exit(1);
}
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined
});
await pool.query(await readFile(path.join(root, 'src/schema.sql'), 'utf8'));
const ingestWorker = startIngestWorker({ pool });

const json = (res, status, data) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  });
  res.end(JSON.stringify(data));
};
const sameToken = value => {
  const a = Buffer.from(value || ''); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};
async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 65536) throw Object.assign(Error('Requisição muito grande.'), { status: 413 });
  }
  try { const v = JSON.parse(raw); if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error(); return v; }
  catch { throw Error('JSON inválido.'); }
}
const bool = value => { if (typeof value !== 'boolean') throw Error('Ativo deve ser verdadeiro ou falso.'); return value; };
const code = value => {
  const v = nonEmpty(value, 'Sigla', 24).toUpperCase();
  if (!/^[A-Z0-9_-]+$/.test(v)) throw Error('Sigla: use apenas letras, números, _ ou -.');
  return v;
};
const id = value => { if (!/^[1-9]\d*$/.test(String(value))) throw Error('ID inválido.'); return value; };
const exists = async (table, rowId) => {
  const r = await pool.query(`SELECT id FROM ${table} WHERE id=$1`, [id(rowId)]);
  if (!r.rowCount) throw Object.assign(Error('Registro não encontrado.'), { status: 404 });
};
const newIngestKey = () => randomBytes(6).toString('hex');
const publicIngest = () => ({
  protocol: 'SFTP',
  host: process.env.SFTP_PUBLIC_HOST || process.env.RAILWAY_TCP_PROXY_DOMAIN || null,
  port: Number(process.env.SFTP_PUBLIC_PORT || process.env.RAILWAY_TCP_PROXY_PORT || 0) || null,
  username: process.env.SFTP_USERNAME || 'cop_ingest',
  internal_port: Number(process.env.SFTP_PORT || 2222)
});

async function config(res) {
  const [u,d,c,m,e,received] = await Promise.all([
    pool.query('SELECT * FROM cop_units ORDER BY name'),
    pool.query('SELECT * FROM cop_dvrs ORDER BY unit_id, name'),
    pool.query('SELECT * FROM cop_cameras ORDER BY dvr_id, channel'),
    pool.query(`SELECT m.id,m.event_id,m.unit_id,m.dvr_id,m.camera_id,m.detected_channel,m.filename,m.content_type,m.bytes,m.received_at,
      u.name AS unit_name,d.name AS dvr_name,c.name AS camera_name
      FROM cop_media m JOIN cop_units u ON u.id=m.unit_id JOIN cop_dvrs d ON d.id=m.dvr_id
      LEFT JOIN cop_cameras c ON c.id=m.camera_id ORDER BY m.received_at DESC LIMIT 16`),
    pool.query(`SELECT id,dvr_id,source_path,reason,created_at FROM cop_ingest_errors ORDER BY created_at DESC LIMIT 5`),
    pool.query("SELECT count(*)::int AS total FROM cop_media WHERE received_at >= now() - interval '24 hours'")
  ]);
  json(res, 200, {
    units: u.rows, dvrs: d.rows, cameras: c.rows, defaults,
    recent_media: m.rows, ingest_errors: e.rows, received_24h: received.rows[0].total,
    ingest: publicIngest(), ingest_worker: { ok: ingestWorker.state.ok, last_scan_at: ingestWorker.state.last_scan_at }
  });
}

async function events(res, url) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
  const unitId = url.searchParams.get('unit_id');
  const params = [];
  let where = '';
  if (unitId) { params.push(id(unitId)); where = 'WHERE e.unit_id=$1'; }
  params.push(limit);
  const result = await pool.query(`SELECT e.*,u.name AS unit_name,d.name AS dvr_name,c.name AS camera_name,
    (SELECT min(m.id) FROM cop_media m WHERE m.event_id=e.id) AS first_media_id
    FROM cop_events e JOIN cop_units u ON u.id=e.unit_id JOIN cop_dvrs d ON d.id=e.dvr_id
    LEFT JOIN cop_cameras c ON c.id=e.camera_id ${where}
    ORDER BY e.last_frame_at DESC LIMIT $${params.length}`, params);
  json(res, 200, { events: result.rows });
}

async function media(res, mediaId) {
  const result = await pool.query('SELECT filename,content_type,bytes,data FROM cop_media WHERE id=$1', [id(mediaId)]);
  if (!result.rowCount) return json(res, 404, { error: 'Mídia não encontrada.' });
  const row = result.rows[0];
  const safeName = String(row.filename || 'media').replace(/["\r\n]/g, '_');
  res.writeHead(200, {
    'Content-Type': row.content_type || 'application/octet-stream', 'Content-Length': row.data.length,
    'Content-Disposition': `inline; filename="${safeName}"`, 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  });
  res.end(row.data);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, {
    ok: true, ingest: { ok: ingestWorker.state.ok, last_scan_at: ingestWorker.state.last_scan_at }
  });
  if (!url.pathname.startsWith('/api/')) {
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    const entry = files[url.pathname];
    if (!entry || req.method !== 'GET') return json(res, 404, { error: 'Não encontrado.' });
    const contents = await readFile(path.join(root, 'public', entry[0]));
    res.writeHead(200, {
      'Content-Type': `${entry[1]}; charset=utf-8`, 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
    });
    return res.end(contents);
  }
  if (!sameToken(req.headers.authorization?.replace(/^Bearer /, ''))) return json(res, 401, { error: 'Acesso não autorizado.' });
  if (url.pathname === '/api/config' && req.method === 'GET') return config(res);
  if (url.pathname === '/api/events' && req.method === 'GET') return events(res, url);
  const mediaMatch = url.pathname.match(/^\/api\/media\/([1-9]\d*)$/);
  if (mediaMatch && req.method === 'GET') return media(res, mediaMatch[1]);

  const match = url.pathname.match(/^\/api\/(units|dvrs|cameras)(?:\/([1-9]\d*))?$/);
  if (!match || !['POST','PUT'].includes(req.method) || (req.method === 'POST') === !!match[2]) return json(res, 404, { error: 'Rota não encontrada.' });
  const data = await body(req);
  let result;
  if (match[1] === 'units') {
    const values = [nonEmpty(data.name, 'Unidade'), code(data.code), optional(data.city, 120), bool(data.active)];
    result = match[2]
      ? await pool.query('UPDATE cop_units SET name=$1,code=$2,city=$3,active=$4,updated_at=now() WHERE id=$5 RETURNING *', [...values, id(match[2])])
      : await pool.query('INSERT INTO cop_units(name,code,city,active) VALUES($1,$2,$3,$4) RETURNING *', values);
  } else if (match[1] === 'dvrs') {
    const unitId = id(data.unit_id); await exists('cop_units', unitId);
    const model = nonEmpty(data.model, 'Modelo', 60);
    if (!models.includes(model)) throw Error('Modelo inválido.');
    const accessMode = data.access_mode;
    if (!accessModes.includes(accessMode)) throw Error('Modo de acesso inválido.');
    const cloudSerial = optional(data.cloud_serial, 80);
    if (cloudSerial && !/^[A-Za-z0-9_-]+$/.test(cloudSerial)) throw Error('Serial Intelbras Cloud inválido.');
    const values = [unitId, nonEmpty(data.name, 'DVR'), model, cloudSerial, optional(data.host, 255),
      integer(data.http_port, 'Porta HTTP', 1, 65535), integer(data.rtsp_port, 'Porta RTSP', 1, 65535),
      integer(data.service_port, 'Porta de serviço', 1, 65535), accessMode, optional(data.connector_id, 120),
      optional(data.secret_ref, 120), integer(data.channel_count, 'Canais', 1, 32), bool(data.active)];
    if (values[10] && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(values[10])) throw Error('Referência de segredo: use nome de variável de ambiente.');
    result = match[2]
      ? await pool.query(`UPDATE cop_dvrs SET unit_id=$1,name=$2,model=$3,cloud_serial=$4,host=$5,http_port=$6,rtsp_port=$7,
          service_port=$8,access_mode=$9,connector_id=$10,secret_ref=$11,channel_count=$12,active=$13,updated_at=now()
          WHERE id=$14 RETURNING *`, [...values, id(match[2])])
      : await pool.query(`INSERT INTO cop_dvrs(unit_id,name,model,cloud_serial,host,http_port,rtsp_port,service_port,access_mode,connector_id,secret_ref,channel_count,active,ingest_key)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [...values, newIngestKey()]);
  } else {
    const dvrId = id(data.dvr_id); const dvr = await pool.query('SELECT channel_count FROM cop_dvrs WHERE id=$1', [dvrId]);
    if (!dvr.rowCount) throw Object.assign(Error('DVR não encontrado.'), { status: 404 });
    const values = [dvrId, integer(data.channel, 'Canal', 1, dvr.rows[0].channel_count),
      nonEmpty(data.name, 'Câmera'), optional(data.area, 120), JSON.stringify(validatePolicy(data.policy)), bool(data.active)];
    result = match[2]
      ? await pool.query('UPDATE cop_cameras SET dvr_id=$1,channel=$2,name=$3,area=$4,policy=$5,active=$6,updated_at=now() WHERE id=$7 RETURNING *', [...values, id(match[2])])
      : await pool.query('INSERT INTO cop_cameras(dvr_id,channel,name,area,policy,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', values);
  }
  if (!result.rowCount) return json(res, 404, { error: 'Registro não encontrado.' });
  return json(res, match[2] ? 200 : 201, result.rows[0]);
}

const server = http.createServer((req,res) => route(req,res).catch(error => {
  console.error(error.code || error.message);
  const status = error.status || (error.code === '23505' ? 409 : error.code === '23503' || error.code === '23514' ? 400 : error instanceof pg.DatabaseError ? 500 : 400);
  json(res, status, { error: error.code === '23505' ? 'Sigla, canal ou identificador já cadastrado.' : status === 500 ? 'Erro ao consultar o banco de dados.' : error.message });
}));
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => { const sftp=publicIngest(); console.log('COP pronto.'); console.log(`COP SFTP: ${sftp.host || 'sem-host'}:${sftp.port || 'sem-port'} -> ${sftp.internal_port}`); });
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => {
  ingestWorker.stop();
  server.close(() => pool.end().then(() => process.exit(0)));
});
