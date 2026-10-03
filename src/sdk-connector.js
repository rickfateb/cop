import { randomBytes, timingSafeEqual } from 'node:crypto';
import { tokenHash, decryptSecret } from './infrastructure.js';
import { storePlayback } from './investigation-worker.js';
import {claimCaptureJob,captureAction} from './capture-connector.js';

const fail=(message,status=400)=>Object.assign(Error(message),{status});
export function connectorAuthorized(expected,value) {
 if(typeof expected!=='string'||expected.length<32||typeof value!=='string')return false;
 const a=Buffer.from(expected),b=Buffer.from(value);
 return a.length===b.length&&timingSafeEqual(a,b);
}
export function connectorIdentity(body) {
 const name=String(body.connector_name||'');
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(name))throw fail('Nome do conector inválido.');
 const ids=body.device_ids;
 if(!Array.isArray(ids)||ids.length>64||ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id)))throw fail('IDs do conector inválidos.');
 return {name,ids:[...new Set(ids)]};
}
export function validatePlaybackConfig(body) {
 const mode=body.playback_mode;
 if(!['unavailable','rtsp_direct','agent','cloud','netsdk_autoregister'].includes(mode))throw fail('Modo de recuperação inválido.');
 const register=String(body.autoregister_id||'').trim()||null;
 const name=String(body.sdk_connector_name||'hostinger').trim();
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(name)||register&&!/^[A-Za-z0-9_-]{1,128}$/.test(register))throw fail('Identificador de Auto Registro inválido.');
 if(mode==='netsdk_autoregister'&&!register)throw fail('Informe o ID de Auto Registro.');
 return {mode,register,name};
}
async function refreshStatus(client,id) {
 await client.query('SELECT id FROM cop_investigations WHERE id=$1 FOR UPDATE',[id]);
 await client.query(`UPDATE cop_investigations i SET status=s.status,connector_status=s.connector,
 last_error=CASE WHEN s.status='failed' THEN 'Falha ao recuperar todos os canais.' ELSE NULL END,updated_at=now()
 FROM (
 SELECT investigation_id,
 CASE WHEN bool_and(status='ready') THEN 'ready'
 WHEN bool_or(status='retrieving') THEN 'retrieving'
 WHEN bool_or(status='ready') THEN 'partial'
 WHEN bool_or(status IN ('pending','waiting_connector')) THEN 'waiting_connector' ELSE 'failed' END status,
 CASE WHEN bool_and(status='ready') THEN 'done'
 WHEN bool_or(status='retrieving') THEN 'running'
 WHEN bool_or(status='ready') THEN 'partial'
 WHEN bool_or(status IN ('pending','waiting_connector')) THEN 'queued' ELSE 'failed' END connector
 FROM cop_investigation_channels WHERE investigation_id=$1 GROUP BY investigation_id
 ) s WHERE i.id=s.investigation_id AND i.status NOT IN ('cancelled','completed','analyzing')`,[id]);
}
export async function claimSdkJob(pool,body,serverId=null) {
 const {name,ids}=connectorIdentity(body);
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  const expired=await client.query(`UPDATE cop_investigation_channels ic SET status='failed',
    last_error='O receptor não concluiu a tarefa após três tentativas.',updated_at=now()
    FROM cop_investigations i JOIN cop_dvrs d ON d.id=i.dvr_id
    WHERE ic.investigation_id=i.id AND d.sdk_connector_name=$1
    AND d.playback_mode='netsdk_autoregister' AND d.server_id IS NOT DISTINCT FROM $2::bigint AND ic.status='retrieving'
    AND ic.sdk_attempts>=3 AND ic.sdk_lease_until<now()
    RETURNING ic.investigation_id`,[name,serverId]);
  for(const row of expired.rows)await refreshStatus(client,row.investigation_id);
  const selected=await client.query(`SELECT ic.*,i.dvr_id,d.autoregister_id,dir.directory_name
   FROM cop_investigation_channels ic JOIN cop_investigations i ON i.id=ic.investigation_id
   JOIN cop_dvrs d ON d.id=i.dvr_id LEFT JOIN cop_server_directories dir ON dir.id=d.server_directory_id
   WHERE d.active=TRUE AND d.playback_mode='netsdk_autoregister' AND d.sdk_connector_name=$1
   AND d.autoregister_id=ANY($2::text[]) AND d.server_id IS NOT DISTINCT FROM $3::bigint
   AND i.status IN ('pending','waiting_connector','retrieving','partial','failed')
   AND ic.sdk_attempts<3 AND ic.sdk_next_attempt_at<=now()
   AND (ic.status IN ('pending','waiting_connector','failed') OR (ic.status='retrieving' AND ic.sdk_lease_until<now()))
   ORDER BY ic.sdk_next_attempt_at,i.created_at,ic.channel
   FOR UPDATE OF ic SKIP LOCKED LIMIT 1`,[name,ids,serverId]);
  if(!selected.rowCount){await client.query('COMMIT');return null;}
  const job=selected.rows[0],lease=randomBytes(24).toString('hex');
  await client.query(`UPDATE cop_investigation_channels SET status='retrieving',sdk_lease_token=$3,
   sdk_lease_until=now()+interval '10 minutes',sdk_attempts=sdk_attempts+1,last_error=NULL,updated_at=now()
   WHERE investigation_id=$1 AND camera_id=$2`,[job.investigation_id,job.camera_id,lease]);
  await refreshStatus(client,job.investigation_id);
  await client.query('COMMIT');
  return {investigation_id:job.investigation_id,camera_id:job.camera_id,dvr_id:job.dvr_id,
   device_id:job.autoregister_id,directory_name:job.directory_name||null,channel:job.channel,start:job.requested_start_at,end:job.requested_end_at,lease_token:lease};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function leasedRow(client,inv,cam,lease) {
 if(!/^[a-f0-9]{48}$/.test(String(lease||'')))throw fail('Reserva inválida.',409);
 const result=await client.query(`SELECT ic.*,i.unit_id,i.dvr_id,i.status investigation_status
  FROM cop_investigation_channels ic JOIN cop_investigations i ON i.id=ic.investigation_id
  WHERE ic.investigation_id=$1 AND ic.camera_id=$2 AND ic.sdk_lease_token=$3
  AND i.status NOT IN ('cancelled','completed','analyzing')
  AND (ic.status='ready' OR (ic.status='retrieving' AND ic.sdk_lease_until>now()))
  FOR UPDATE OF ic`,[inv,cam,lease]);
 if(!result.rowCount)throw fail('Reserva expirada ou tarefa indisponível.',409);
 return result.rows[0];
}
async function transaction(pool,run) {
 const client=await pool.connect();
 try{await client.query('BEGIN');const value=await run(client);await client.query('COMMIT');return value;}
 catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function renewSdkJob(pool,inv,cam,lease) {
 return transaction(pool,async client=>{
  const row=await leasedRow(client,inv,cam,lease);
  if(row.status!=='ready')await client.query(`UPDATE cop_investigation_channels SET sdk_lease_until=now()+interval '10 minutes',updated_at=now() WHERE investigation_id=$1 AND camera_id=$2`,[inv,cam]);
  return {ok:true,status:row.status};
 });
}
export async function failSdkJob(pool,inv,cam,lease,error) {
 const messages={DVR_OFFLINE:'DVR desconectado; aguardando novo registro.',LOGIN_FAILED:'Autenticação recusada pelo DVR.',
 DOWNLOAD_INCOMPLETE:'Download interrompido.',VIDEO_INVALID:'Vídeo incompleto ou inválido.',TOO_LARGE:'Vídeo excedeu o limite de armazenamento.',
 DOWNLOAD_START_FAILED:'DVR recusou o início do download.',INVALID_CHANNEL:'Canal não disponível no DVR.'};
 return transaction(pool,async client=>{
  const row=await leasedRow(client,inv,cam,lease);
  if(row.status==='ready')return {ok:true,status:'ready'};
  await client.query(`UPDATE cop_investigation_channels SET status=CASE WHEN sdk_attempts>=3 THEN 'failed' ELSE 'waiting_connector' END,
    sdk_lease_until=NULL,sdk_next_attempt_at=now()+interval '1 minute',last_error=$3,updated_at=now()
    WHERE investigation_id=$1 AND camera_id=$2`,[inv,cam,messages[error]||'Falha no receptor SDK; consultar o serviço no VPS.']);
  await refreshStatus(client,inv);return {ok:true};
 });
}
export function validateSdkVideo(data,duration,expected) {
 if(!Buffer.isBuffer(data)||data.length<12||data.toString('ascii',4,8)!=='ftyp')throw fail('Arquivo MP4 inválido.');
 if(!Number.isFinite(duration)||!Number.isFinite(expected)||expected<=0||Math.abs(duration-expected)>2)throw fail('Duração do vídeo não corresponde à janela solicitada.');
}
export async function completeSdkJob(pool,inv,cam,lease,data,metadata) {
 return transaction(pool,async client=>{
  const row=await leasedRow(client,inv,cam,lease);
  if(row.status==='ready')return {ok:true,media_id:row.retrieved_media_id};
  const expected=(new Date(row.requested_end_at)-new Date(row.requested_start_at))/1000;
  validateSdkVideo(data,metadata.duration_seconds,expected);
  const mediaId=await storePlayback(client,{id:inv,unit_id:row.unit_id,dvr_id:row.dvr_id},
   {camera_id:cam,channel:row.channel,requested_start_at:row.requested_start_at},{data,contentType:'video/mp4',filename:`investigacao-${inv}-canal-${row.channel}.mp4`});
  await client.query(`UPDATE cop_investigation_channels SET status='ready',retrieved_media_id=$3,
   retrieval_metadata=$4,sdk_lease_until=NULL,last_error=NULL,updated_at=now() WHERE investigation_id=$1 AND camera_id=$2`,
   [inv,cam,mediaId,JSON.stringify({duration_seconds:metadata.duration_seconds,source:'netsdk_autoregister',trimmed_from_dvr_timestamps:true})]);
  await refreshStatus(client,inv);return {ok:true,media_id:mediaId};
 });
}
export function createSdkApi({pool,json,readJson,token=process.env.COP_SDK_CONNECTOR_TOKEN}) {
 return async (req,res,url)=>{
  const supplied=req.headers['x-cop-sdk-token'];
  const server=typeof supplied==='string'&&supplied.length>=32&&supplied.length<=512?(await pool.query('SELECT id,connector_name,storage_root,registration_port FROM cop_servers WHERE active=TRUE AND token_hash=$1',[tokenHash(supplied)])).rows[0]:null;
  if(!server&&!connectorAuthorized(token,supplied))return json(res,401,{error:'Conector SDK não autorizado.'});
  const scopedIdentity=body=>{const identity=connectorIdentity(body);if(server&&identity.name!==server.connector_name)throw fail('Este token pertence a outro servidor.',403);return body;};
  if(req.method!=='POST')return json(res,405,{error:'Método não permitido.'});
  if(url.pathname==='/api/sdk/config'){
   if(!server)return json(res,404,{error:'Token ainda não vinculado a um servidor cadastrado.'});
   const devices=(await pool.query("SELECT autoregister_id,access_username,access_password_cipher FROM cop_dvrs WHERE server_id=$1 AND active=TRUE AND playback_mode='netsdk_autoregister' AND autoregister_id IS NOT NULL AND access_password_cipher IS NOT NULL ORDER BY id LIMIT 64",[server.id])).rows;
   return json(res,200,{connector_name:server.connector_name,state_dir:server.storage_root,port:server.registration_port,devices:devices.map(d=>({id:d.autoregister_id,username:d.access_username||'admin',password:decryptSecret(d.access_password_cipher)}))});
  }
  if(url.pathname==='/api/sdk/claim'){
   const body=scopedIdentity(await readJson(req));
   return json(res,200,{job:await claimSdkJob(pool,body,server?.id||null)||await claimCaptureJob(pool,body,server?.id||null)});
  }
  if(url.pathname==='/api/sdk/heartbeat'){
   const body=scopedIdentity(await readJson(req)),{name,ids}=connectorIdentity(body);
   const online=body.online_ids;
   if(!Array.isArray(online)||online.some(id=>!ids.includes(id)))throw fail('Estado do conector inválido.');
   await pool.query(`UPDATE cop_dvrs SET sdk_online=autoregister_id=ANY($3::text[]),
    sdk_last_seen_at=CASE WHEN autoregister_id=ANY($3::text[]) THEN now() ELSE sdk_last_seen_at END
    WHERE sdk_connector_name=$1 AND autoregister_id=ANY($2::text[]) AND server_id IS NOT DISTINCT FROM $4::bigint`,[name,ids,online,server?.id||null]);
   return json(res,200,{ok:true});
  }
  const capture=url.pathname.match(/^\/api\/sdk\/captures\/([1-9]\d*)\/([1-9]\d*)\/(renew|failure|media|complete)$/);
  if(capture){
   const [,id,cam,action]=capture,lease=req.headers['x-cop-lease-token'];
   const options={};
   if(action==='media'){
    const raw=req.headers['x-cop-capture-metadata'];
    if(typeof raw!=='string'||raw.length>4096)throw fail('Metadados da captura inválidos.');
    try{options.metadata=JSON.parse(decodeURIComponent(raw));}catch{throw fail('Metadados da captura inválidos.');}
    if(!options.metadata||options.metadata.content_type!==req.headers['content-type'])throw fail('Tipo da mídia inválido.');
    const chunks=[];let total=0;const limit=req.headers['content-type']==='image/jpeg'?8*1024*1024:256*1024*1024;
    for await(const chunk of req){total+=chunk.length;if(total>limit)throw fail('Mídia acima do limite.',413);chunks.push(chunk);}
    options.data=Buffer.concat(chunks,total);
   }else options.body=await readJson(req);
   return json(res,200,await captureAction(pool,id,cam,lease,server?.id||null,action,options));
  }
  const match=url.pathname.match(/^\/api\/sdk\/jobs\/([1-9]\d*)\/([1-9]\d*)\/(renew|failure|complete)$/);
  if(!match)return json(res,404,{error:'Rota SDK não encontrada.'});
  const [,inv,cam,action]=match,lease=req.headers['x-cop-lease-token'];
  const scope=await pool.query('SELECT i.id FROM cop_investigations i JOIN cop_dvrs d ON d.id=i.dvr_id WHERE i.id=$1 AND d.server_id IS NOT DISTINCT FROM $2::bigint',[inv,server?.id||null]);
  if(!scope.rowCount)throw fail('Tarefa de outro servidor ou indisponível.',403);
  if(action==='renew')return json(res,200,await renewSdkJob(pool,inv,cam,lease));
  if(action==='failure')return json(res,200,await failSdkJob(pool,inv,cam,lease,(await readJson(req)).code));
  if(req.headers['content-type']!=='video/mp4')throw fail('Envie video/mp4.');
  const chunks=[];let total=0;
  for await(const chunk of req){total+=chunk.length;if(total>256*1024*1024)throw fail('Vídeo acima do limite.',413);chunks.push(chunk);}
  return json(res,200,await completeSdkJob(pool,inv,cam,lease,Buffer.concat(chunks,total),{duration_seconds:Number(req.headers['x-video-duration-seconds'])}));
 };
}
