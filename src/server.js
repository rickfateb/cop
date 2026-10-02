import {startDriveArchive} from './drive-archive.js';
import http from 'node:http';
import {createGoogleAuth} from './google-auth.js';
import { createInfrastructureApi, publicServerSql, publicDvrSql, redactDvr, deviceAssignment, encryptSecret } from './infrastructure.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startIngestWorker } from './ingest.js';
import { createGatewayIngest } from './gateway.js';
import { startFraudAutomation, verifySignedMedia } from './fraud.js';
import { createInvestigation, listInvestigations, investigationDetail } from './investigations.js';
import { startInvestigationWorker } from './investigation-worker.js';
import {listReviews,reviewIncident} from './review.js';
import { createSdkApi, validatePlaybackConfig } from './sdk-connector.js';
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

async function applyDvrPatchFromEnv() {
  const raw = process.env.COP_DVR_PATCH_JSON;
  if (!raw) return;
  let patch;
  try { patch = JSON.parse(raw); }
  catch { throw Error('COP_DVR_PATCH_JSON inválido.'); }
  const serial = nonEmpty(patch.cloud_serial, 'Serial Intelbras Cloud', 80);
  const remoteMode = patch.remote_connection_mode == null ? null : nonEmpty(patch.remote_connection_mode, 'Método remoto', 20);
  if (remoteMode && !['cloud','domain','ip','ip_extra'].includes(remoteMode)) throw Error('Método remoto inválido no patch.');
  const accessMode = patch.access_mode == null ? null : nonEmpty(patch.access_mode, 'Integração principal', 30);
  if (accessMode && !accessModes.includes(accessMode)) throw Error('Integração principal inválida no patch.');
  const servicePort = patch.service_port == null ? null : integer(Number(patch.service_port), 'Porta de serviço', 1, 65535);
  const result = await pool.query(`
    UPDATE cop_dvrs SET
      name=COALESCE($2,name),
      service_port=COALESCE($3,service_port),
      remote_connection_mode=COALESCE($4,remote_connection_mode),
      access_username=COALESCE($5,access_username),
      secret_ref=COALESCE($6,secret_ref),
      access_mode=COALESCE($7,access_mode),
      updated_at=now()
    WHERE cloud_serial=$1
    RETURNING id,name,model,cloud_serial,channel_count,access_mode,remote_connection_mode,access_username,service_port,secret_ref,ingest_key
  `, [serial, optional(patch.name, 120), servicePort, remoteMode, optional(patch.access_username, 120),
      optional(patch.secret_ref, 120), accessMode]);
  if (!result.rowCount) throw Error(`DVR do patch não encontrado: ${serial}`);
  const row = result.rows[0];

  let cameraCount = 0;
  const cameraChannel = patch.camera_channel == null ? null : integer(Number(patch.camera_channel), 'Canal da câmera', 1, 32);
  if (cameraChannel != null) {
    const cameras = await pool.query('SELECT id,channel,name FROM cop_cameras WHERE dvr_id=$1 AND active=TRUE ORDER BY id', [row.id]);
    if (cameras.rowCount !== 1) throw Error(`Atualização automática de canal exige exatamente 1 câmera ativa no DVR ${serial}; encontradas=${cameras.rowCount}`);
    const camera = cameras.rows[0];
    if (camera.channel !== cameraChannel) {
      const conflict = await pool.query('SELECT id FROM cop_cameras WHERE dvr_id=$1 AND channel=$2 AND id<>$3 LIMIT 1', [row.id, cameraChannel, camera.id]);
      if (conflict.rowCount) throw Error(`Canal ${cameraChannel} já está ocupado no DVR ${serial}`);
      await pool.query('UPDATE cop_cameras SET channel=$2, updated_at=now() WHERE id=$1', [camera.id, cameraChannel]);
      console.log(`COP câmera canal atualizado: id=${camera.id} de=${camera.channel} para=${cameraChannel}`);
    }
  }
  if (patch.camera_policy || patch.camera_device_config || cameraChannel != null) {
    const cameraPolicy = patch.camera_policy ? validatePolicy(patch.camera_policy) : null;
    const deviceConfig = patch.camera_device_config && typeof patch.camera_device_config === 'object' && !Array.isArray(patch.camera_device_config)
      ? patch.camera_device_config : null;
    const status = patch.camera_device_config_status || (deviceConfig ? 'pending' : null);
    if (status && !['pending','confirmed','unsupported','error'].includes(status)) throw Error('Status de configuração do dispositivo inválido.');
    const updated = await pool.query(`
      UPDATE cop_cameras SET
        active=TRUE,
        policy=COALESCE($2::jsonb, policy),
        device_config=COALESCE($3::jsonb, device_config),
        device_config_status=COALESCE($4, device_config_status),
        updated_at=now()
      WHERE dvr_id=$1
      RETURNING id,channel,name,policy,device_config,device_config_status
    `, [row.id, cameraPolicy ? JSON.stringify(cameraPolicy) : null, deviceConfig ? JSON.stringify(deviceConfig) : null, status]);
    cameraCount = updated.rowCount;
    if (!cameraCount) throw Error(`Nenhuma câmera cadastrada para o DVR ${serial}`);
  }

  console.log(`COP DVR patch aplicado: id=${row.id} nome=${row.name} serial=${row.cloud_serial} modelo=${row.model} canais=${row.channel_count} ingest=${row.access_mode} remoto=${row.remote_connection_mode} usuario=${row.access_username} porta=${row.service_port} segredo=${row.secret_ref} local=${row.ingest_key} cameras_atualizadas=${cameraCount}`);
}
await applyDvrPatchFromEnv();

async function ensureDvrIngestDirectories() {
  const base = process.env.COP_INGEST_ROOT || '/data/sftp/incoming';
  const rows = await pool.query("SELECT ingest_key FROM cop_dvrs WHERE active=TRUE AND ingest_key IS NOT NULL AND ingest_key <> ''");
  const { mkdir, chown } = await import('node:fs/promises');
  let created = 0;
  for (const row of rows.rows) {
    const target = path.join(base, row.ingest_key);
    await mkdir(target, { recursive: true, mode: 0o750 });
    try {
      const uid = Number(process.env.SFTP_UID || 1000);
      const gid = Number(process.env.SFTP_GID || 1000);
      if (Number.isInteger(uid) && Number.isInteger(gid)) await chown(target, uid, gid);
    } catch {}
    created++;
  }
  console.log(`COP SFTP diretórios preparados: ${created}`);
}
await ensureDvrIngestDirectories();
const driveArchive=startDriveArchive({pool});
const ingestWorker = startIngestWorker({ pool });
const gatewayIngest = createGatewayIngest({ pool });
const fraudAutomation = startFraudAutomation({ pool });
const investigationWorker = startInvestigationWorker({ pool });

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

const googleAuth=createGoogleAuth({pool,json,readJson:body});
const infrastructureApi=createInfrastructureApi({pool,json,readJson:body});
async function config(res) {
  const [u,d,c,m,e,received,servers,directories] = await Promise.all([
    pool.query('SELECT * FROM cop_units ORDER BY name'),
    pool.query(publicDvrSql),
    pool.query('SELECT * FROM cop_cameras ORDER BY dvr_id, channel'),
    pool.query(`SELECT m.id,m.event_id,m.unit_id,m.dvr_id,m.camera_id,m.detected_channel,m.filename,m.content_type,m.bytes,m.received_at,
      u.name AS unit_name,d.name AS dvr_name,c.name AS camera_name
      FROM cop_media m JOIN cop_units u ON u.id=m.unit_id JOIN cop_dvrs d ON d.id=m.dvr_id
      LEFT JOIN cop_cameras c ON c.id=m.camera_id ORDER BY m.received_at DESC LIMIT 16`),
    pool.query(`SELECT id,dvr_id,source_path,reason,created_at FROM cop_ingest_errors ORDER BY created_at DESC LIMIT 5`),
    pool.query("SELECT count(*)::int AS total FROM cop_media WHERE received_at >= now() - interval '24 hours'"),
    pool.query(publicServerSql),pool.query('SELECT * FROM cop_server_directories ORDER BY friendly_name,id')
  ]);
  json(res, 200, {
    units: u.rows, dvrs: d.rows.map(r=>r.item), servers:servers.rows, server_directories:directories.rows, cameras: c.rows, defaults,
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

async function investigationsApi(req,res,url) {
  if(req.method==='GET'){
    const rows=await listInvestigations(pool,{limit:url.searchParams.get('limit'),unitId:url.searchParams.get('unit_id')});
    return json(res,200,{investigations:rows,connector:{status:process.env.COP_SDK_CONNECTOR_TOKEN?'configured':'not_available',note:'A recuperação depende do conector e da conexão de cada DVR.'}});
  }
  if(req.method==='POST'){
    const input=await body(req);
    const created=await createInvestigation(pool,input,'admin');
    return json(res,201,{investigation:created});
  }
  return json(res,405,{error:'Método não permitido.'});
}
async function investigationById(res,idValue) {
  return json(res,200,{investigation:await investigationDetail(pool,idValue)});
}

async function fraudSummaries(res, url) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const unitId = url.searchParams.get('unit_id');
  const params = [];
  const where = [];
  if (unitId) { params.push(id(unitId)); where.push(`i.unit_id=$${params.length}`); }
  params.push(limit);
  const incidents = (await pool.query(`
    SELECT i.*,u.name AS unit_name,u.code AS unit_code,d.name AS dvr_name,c.name AS camera_name
    FROM cop_fraud_incidents i
    JOIN cop_units u ON u.id=i.unit_id
    JOIN cop_dvrs d ON d.id=i.dvr_id
    LEFT JOIN cop_cameras c ON c.id=i.camera_id
    ${where.length ? 'WHERE '+where.join(' AND ') : ''}
    ORDER BY i.occurred_at DESC,i.id DESC LIMIT $${params.length}`, params)).rows;
  if (!incidents.length) return json(res,200,{incidents:[]});
  const ids = incidents.map(row => row.id);
  const evidence = (await pool.query(`
    SELECT e.incident_id,e.evidence_order,m.id media_id,m.filename,m.frame_offset_seconds
    FROM cop_fraud_evidence e JOIN cop_media m ON m.id=e.media_id
    WHERE e.incident_id=ANY($1::bigint[]) ORDER BY e.incident_id,e.evidence_order`, [ids])).rows;
  const byIncident = new Map();
  for (const row of evidence) {
    const key = String(row.incident_id);
    if (!byIncident.has(key)) byIncident.set(key,[]);
    byIncident.get(key).push(row);
  }
  json(res,200,{incidents:incidents.map(row=>({...row,evidence:byIncident.get(String(row.id))||[]}))});
}

async function media(res, mediaId) {
  const result = await pool.query('SELECT filename,content_type,bytes,data,sha256,drive_file_id,drive_verified_at FROM cop_media WHERE id=$1', [id(mediaId)]);
  if (!result.rowCount) return json(res, 404, { error: 'Mídia não encontrada.' });
  const row = result.rows[0];
  if(!row.data){
    if(!row.drive_verified_at||!row.drive_file_id)return json(res,503,{error:'Arquivo aguardando arquivamento.'});
    try{row.data=await driveArchive.drive.download(row.drive_file_id);if(createHash('sha256').update(row.data).digest('hex')!==row.sha256)throw Error('checksum');}
    catch{return json(res,503,{error:'Arquivo no Drive temporariamente indisponível.'});}
  }
  const safeName = String(row.filename || 'media').replace(/["\r\n]/g, '_');
  res.writeHead(200, {
    'Content-Type': row.content_type || 'application/octet-stream', 'Content-Length': row.data.length,
    'Content-Disposition': `inline; filename="${safeName}"`, 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  });
  res.end(row.data);
}

const sdkApi=createSdkApi({pool,json,readJson:body});
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
      'Content-Security-Policy': "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' https://accounts.google.com/gsi/style; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cross-Origin-Opener-Policy':'same-origin-allow-popups'
    });
    return res.end(contents);
  }
  const shareMediaMatch = url.pathname.match(/^\/api\/share\/media\/([1-9]\d*)$/);
  if (shareMediaMatch && req.method === 'GET') {
    if (!verifySignedMedia(shareMediaMatch[1], url.searchParams.get('exp'), url.searchParams.get('sig'))) return json(res,403,{error:'Link de mídia inválido ou expirado.'});
    return media(res, shareMediaMatch[1]);
  }
  const externalMatch = url.pathname.match(/^\/api\/ingest\/external\/([A-Za-z0-9_-]{6,64})$/);
  if (externalMatch && req.method === 'POST') return gatewayIngest(req, res, externalMatch[1], json);
  if(await googleAuth.handle(req,res,url))return;
  if(url.pathname.startsWith('/api/sdk/'))return sdkApi(req,res,url);
  if (!sameToken(req.headers.authorization?.replace(/^Bearer /, ''))) {
    const user=await googleAuth.user(req);
    if(!user)return json(res,401,{error:'Entre com Google para acessar o COP.'});
    if(!['GET','HEAD'].includes(req.method))googleAuth.ensureOrigin(req);
    req.copUser=user;
  }
  if(url.pathname==='/api/archive/status'&&req.method==='GET'){
    const counts=(await pool.query("SELECT count(*) FILTER(WHERE drive_verified_at IS NOT NULL)::int archived,count(*) FILTER(WHERE data IS NOT NULL AND drive_verified_at IS NULL)::int pending,count(*) FILTER(WHERE drive_error IS NOT NULL)::int errors,count(*) FILTER(WHERE data IS NULL)::int local_released FROM cop_media")).rows[0];
    return json(res,200,{...driveArchive.state,...counts,root_url:process.env.COP_DRIVE_ROOT_ID?'https://drive.google.com/drive/folders/'+process.env.COP_DRIVE_ROOT_ID:null});
  }
  if(/^\/api\/(servers|server-directories)(\/|$)/.test(url.pathname)||/^\/api\/dvrs\/[1-9]\d*\/credentials$/.test(url.pathname))return infrastructureApi(req,res,url);
  const playbackMatch=url.pathname.match(/^\/api\/dvrs\/([1-9]\d*)\/playback$/);
  if(playbackMatch&&req.method==='PUT'){
    const settings=validatePlaybackConfig(await body(req));
    const assignment=await deviceAssignment(pool,{...(await pool.query('SELECT server_id,server_directory_id FROM cop_dvrs WHERE id=$1',[playbackMatch[1]])).rows[0],sdk_connector_name:settings.name});
    const saved=await pool.query(`UPDATE cop_dvrs SET playback_mode=$2,autoregister_id=$3,sdk_connector_name=$4,
      sdk_online=FALSE,updated_at=now() WHERE id=$1 RETURNING id,playback_mode,autoregister_id,sdk_connector_name`,
      [playbackMatch[1],settings.mode,settings.register,assignment.connector]);
    if(!saved.rowCount)return json(res,404,{error:'DVR não encontrado.'});
    return json(res,200,saved.rows[0]);
  }
  if (url.pathname === '/api/config' && req.method === 'GET') return config(res);
  if (url.pathname === '/api/events' && req.method === 'GET') return events(res, url);
  if (url.pathname === '/api/fraud/summaries' && req.method === 'GET') return fraudSummaries(res, url);
  if (url.pathname === '/api/fraud/reviews' && req.method === 'GET') return json(res,200,{reviews:await listReviews(pool,{limit:url.searchParams.get('limit'),unitId:url.searchParams.get('unit_id'),clothingOnly:url.searchParams.get('clothing')==='1'})});
  const reviewMatch=url.pathname.match(/^\/api\/fraud\/incidents\/([1-9]\d*)\/review$/);
  if(reviewMatch && req.method==='POST')return json(res,200,await reviewIncident(pool,reviewMatch[1],(await body(req)).status));
  if (url.pathname === '/api/investigations') return investigationsApi(req,res,url);
  const investigationMatch=url.pathname.match(/^\/api\/investigations\/([1-9]\d*)$/);
  if(investigationMatch&&req.method==='GET') return investigationById(res,investigationMatch[1]);
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
    const old=match[2]?(await pool.query('SELECT * FROM cop_dvrs WHERE id=$1',[match[2]])).rows[0]:{};
    if(!old)throw Object.assign(Error('DVR não encontrado.'),{status:404});
    const assignment=await deviceAssignment(pool,{...data,server_id:data.server_id===undefined?old.server_id:data.server_id,server_directory_id:data.server_directory_id===undefined?old.server_directory_id:data.server_directory_id,sdk_connector_name:data.sdk_connector_name??old.sdk_connector_name});
    if(data.clear_password&&data.access_password)throw Error('Para remover a senha, deixe o campo vazio.');
    const password=data.clear_password?null:data.access_password?encryptSecret(data.access_password):old.access_password_cipher||null;
    const playback=validatePlaybackConfig({playback_mode:data.playback_mode??old.playback_mode??'unavailable',autoregister_id:data.autoregister_id??old.autoregister_id,sdk_connector_name:assignment.connector});
    const model = nonEmpty(data.model, 'Modelo', 60);
    if (!models.includes(model)) throw Error('Modelo inválido.');
    const accessMode = data.access_mode;
    if (!accessModes.includes(accessMode)) throw Error('Modo de acesso inválido.');
    const cloudSerial = optional(data.cloud_serial, 80);
    if (cloudSerial && !/^[A-Za-z0-9_-]+$/.test(cloudSerial)) throw Error('Serial Intelbras Cloud inválido.');
    const remoteConnectionMode = optional(data.remote_connection_mode, 20);
    if (remoteConnectionMode && !['cloud','domain','ip','ip_extra'].includes(remoteConnectionMode)) throw Error('Método de conexão remota inválido.');
    const accessUsername = optional(data.access_username, 120);
    const values = [unitId, nonEmpty(data.name, 'DVR'), model, cloudSerial, optional(data.host, 255),
      integer(data.http_port, 'Porta HTTP', 1, 65535), integer(data.rtsp_port, 'Porta RTSP', 1, 65535),
      integer(data.service_port, 'Porta de serviço', 1, 65535), remoteConnectionMode, accessUsername,
      accessMode, optional(data.connector_id, 120), optional(data.secret_ref, 120),
      integer(data.channel_count, 'Canais', 1, 32), bool(data.active),assignment.serverId,assignment.directoryId,password,playback.mode,playback.register,playback.name];
    if (values[12] && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(values[12])) throw Error('Referência de segredo: use nome de variável de ambiente.');
    result = match[2]
      ? await pool.query(`UPDATE cop_dvrs SET unit_id=$1,name=$2,model=$3,cloud_serial=$4,host=$5,http_port=$6,rtsp_port=$7,
          service_port=$8,remote_connection_mode=$9,access_username=$10,access_mode=$11,connector_id=$12,secret_ref=$13,
          channel_count=$14,active=$15,server_id=$16,server_directory_id=$17,access_password_cipher=$18,playback_mode=$19,autoregister_id=$20,sdk_connector_name=$21,sdk_online=FALSE,updated_at=now() WHERE id=$22 RETURNING *`, [...values, id(match[2])])
      : await pool.query(`INSERT INTO cop_dvrs(unit_id,name,model,cloud_serial,host,http_port,rtsp_port,service_port,remote_connection_mode,access_username,access_mode,connector_id,secret_ref,channel_count,active,server_id,server_directory_id,access_password_cipher,playback_mode,autoregister_id,sdk_connector_name,ingest_key)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`, [...values, newIngestKey()]);
    result.rows=result.rows.map(redactDvr);
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
  driveArchive.stop(); ingestWorker.stop(); fraudAutomation.stop(); investigationWorker.stop();
  server.close(() => pool.end().then(() => process.exit(0)));
});
