import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import { defaults, integer, models, nonEmpty, optional, validatePolicy } from './validation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.COP_ADMIN_TOKEN;
if (!token || token.length < 24 || !process.env.DATABASE_URL) {
  console.error('Configure COP_ADMIN_TOKEN (mínimo 24 caracteres) e DATABASE_URL.');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
await pool.query(await readFile(path.join(root, 'src/schema.sql'), 'utf8'));

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
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
    if (raw.length > 32768) throw Object.assign(Error('Requisição muito grande.'), { status: 413 });
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
async function config(res) {
  const [u,d,c] = await Promise.all([
    pool.query('SELECT * FROM cop_units ORDER BY name'),
    pool.query('SELECT * FROM cop_dvrs ORDER BY unit_id, name'),
    pool.query('SELECT * FROM cop_cameras ORDER BY dvr_id, channel')
  ]);
  json(res, 200, { units: u.rows, dvrs: d.rows, cameras: c.rows, defaults });
}
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: true });
  if (!url.pathname.startsWith('/api/')) {
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    const entry = files[url.pathname];
    if (!entry || req.method !== 'GET') return json(res, 404, { error: 'Não encontrado.' });
    const contents = await readFile(path.join(root, 'public', entry[0]));
    res.writeHead(200, { 'Content-Type': `${entry[1]}; charset=utf-8`, 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff' });
    return res.end(contents);
  }
  if (!sameToken(req.headers.authorization?.replace(/^Bearer /, ''))) return json(res, 401, { error: 'Acesso não autorizado.' });
  if (url.pathname === '/api/config' && req.method === 'GET') return config(res);
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
    if (!['agent','vpn'].includes(accessMode)) throw Error('Modo de acesso inválido.');
    const cloudSerial = optional(data.cloud_serial, 80);
    if (cloudSerial && !/^[A-Za-z0-9_-]+$/.test(cloudSerial)) throw Error('Serial Intelbras Cloud inválido.');
    const values = [unitId, nonEmpty(data.name, 'DVR'), model, cloudSerial, optional(data.host, 255),
      integer(data.http_port, 'Porta HTTP', 1, 65535), accessMode, optional(data.connector_id, 120),
      optional(data.secret_ref, 120), integer(data.channel_count, 'Canais', 1, 32), bool(data.active)];
    if (values[8] && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(values[8])) throw Error('Referência de segredo: use nome de variável de ambiente.');
    result = match[2]
      ? await pool.query('UPDATE cop_dvrs SET unit_id=$1,name=$2,model=$3,cloud_serial=$4,host=$5,http_port=$6,access_mode=$7,connector_id=$8,secret_ref=$9,channel_count=$10,active=$11,updated_at=now() WHERE id=$12 RETURNING *', [...values, id(match[2])])
      : await pool.query('INSERT INTO cop_dvrs(unit_id,name,model,cloud_serial,host,http_port,access_mode,connector_id,secret_ref,channel_count,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', values);
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
  json(res, status, { error: error.code === '23505' ? 'Sigla ou número de canal já cadastrado.' : status === 500 ? 'Erro ao consultar o banco de dados.' : error.message });
}));
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('COP pronto.'));
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => server.close(() => pool.end().then(() => process.exit(0))));
