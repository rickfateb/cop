import {randomBytes,createHash} from 'node:crypto';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const errors={DVR_OFFLINE:'DVR desconectado; aguardando novo registro.',EVENT_QUERY_FAILED:'DVR recusou a consulta histórica de eventos.',EVENT_QUERY_UNSUPPORTED:'Consulta histórica de eventos indisponível neste SDK/DVR.',PHOTO_UNSUPPORTED:'Captura de fotos do playback indisponível neste SDK/DVR. Nenhuma gravação foi baixada em substituição.',PHOTO_FAILED:'Não foi possível capturar uma foto no horário solicitado.',VIDEO_INVALID:'Vídeo incompleto ou com duração incorreta.',TOO_LARGE:'O lote excedeu o limite de mídia.',DOWNLOAD_INCOMPLETE:'Recuperação interrompida.',LEASE_LOST:'Reserva expirada.',NO_RECORDING:'O DVR não disponibilizou a gravação solicitada.'};
async function transaction(pool,run){const c=await pool.connect();try{await c.query('BEGIN');const r=await run(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function refresh(c,id){
 await c.query('SELECT id FROM cop_capture_requests WHERE id=$1 FOR UPDATE',[id]);
 await c.query(`UPDATE cop_capture_requests r SET status=s.status,last_error=s.error FROM (
  SELECT capture_id,CASE WHEN bool_and(status='ready') THEN 'ready' WHEN bool_or(status='retrieving') THEN 'retrieving'
   WHEN bool_or(status IN ('queued','waiting_connector')) THEN 'waiting_connector' WHEN bool_or(status='ready') THEN 'partial' ELSE 'failed' END status,
   string_agg(DISTINCT last_error,' · ') FILTER(WHERE last_error IS NOT NULL) error
  FROM cop_capture_channels WHERE capture_id=$1 GROUP BY capture_id
 ) s WHERE r.id=s.capture_id AND r.status<>'cancelled'`,[id]);
}
export function captureSampling(config={}){
 const policy=config.policy||{},device=config.device_config||{};
 const offsets=policy.offsets||[0,5,15,30];
 if(!Array.isArray(offsets)||!offsets.length||offsets.length>10||offsets.some(x=>!Number.isInteger(x)||x<0||x>600))throw fail('Intervalos de captura inválidos.');
 const interval=Number(device.frame_interval_seconds??3);
 if(!Number.isInteger(interval)||interval<1||interval>30)throw fail('Intervalo contínuo inválido.');
 return {offsets,frame_interval_seconds:interval,min_motion_seconds:Number(policy.min_motion_seconds||0),cooldown_seconds:Number(policy.cooldown_seconds||0)};
}
export async function claimCaptureJob(pool,body,serverId=null){
 if(!Array.isArray(body.capabilities)||!body.capabilities.includes('historical_capture_v1'))return null;
 return transaction(pool,async c=>{
  const expired=await c.query(`UPDATE cop_capture_channels cc SET status='failed',lease_until=NULL,last_error='O receptor não concluiu este lote após três tentativas.'
   FROM cop_capture_requests r JOIN cop_dvrs d ON d.id=r.dvr_id WHERE cc.capture_id=r.id AND r.investigation_id IS NULL
   AND d.sdk_connector_name=$1 AND d.server_id IS NOT DISTINCT FROM $2::bigint AND cc.status='retrieving'
   AND cc.lease_until<now() AND cc.attempts>=3 RETURNING cc.capture_id`,[body.connector_name,serverId]);
  for(const row of expired.rows)await refresh(c,row.capture_id);
  const row=(await c.query(`SELECT cc.*,r.unit_id,r.dvr_id,r.start_at request_start,r.end_at request_end,r.capture_mode,r.media_type,d.autoregister_id,dir.directory_name
   FROM cop_capture_channels cc JOIN cop_capture_requests r ON r.id=cc.capture_id JOIN cop_dvrs d ON d.id=r.dvr_id
   LEFT JOIN cop_server_directories dir ON dir.id=d.server_directory_id
   WHERE r.investigation_id IS NULL AND r.status IN ('queued','waiting_connector','retrieving','partial')
   AND d.active=TRUE AND d.playback_mode='netsdk_autoregister' AND d.sdk_connector_name=$1
   AND d.server_id IS NOT DISTINCT FROM $3::bigint AND d.autoregister_id=ANY($2::text[])
   AND r.end_at<=now() AND cc.attempts<3 AND cc.next_attempt_at<=now()
   AND (cc.status IN ('queued','waiting_connector') OR (cc.status='retrieving' AND cc.lease_until<now()))
   ORDER BY cc.next_attempt_at,r.created_at,cc.channel FOR UPDATE OF cc SKIP LOCKED LIMIT 1`,[body.connector_name,body.device_ids,serverId])).rows[0];
  if(!row)return null;
  const start=row.cursor_at||row.request_start;
  const end=new Date(Math.min(+new Date(row.request_end),+new Date(start)+(row.media_type==='video'?7200000:600000)));
  const lease=randomBytes(24).toString('hex');
  const sampling=captureSampling(row.sampling_config);
  await c.query(`UPDATE cop_capture_channels SET status='retrieving',lease_token=$3,lease_until=now()+interval '10 minutes',
   batch_start_at=$4,batch_end_at=$5,attempts=attempts+1,last_error=NULL WHERE capture_id=$1 AND camera_id=$2`,[row.capture_id,row.camera_id,lease,start,end]);
  await refresh(c,row.capture_id);
  return {kind:'capture',capture_id:row.capture_id,camera_id:row.camera_id,device_id:row.autoregister_id,directory_name:row.directory_name||null,
   channel:row.channel,start,end,request_start:row.request_start,request_end:row.request_end,capture_mode:row.capture_mode,media_type:row.media_type,sampling,lease_token:lease};
 });
}
async function leased(c,id,cam,lease,serverId){
 if(!/^[a-f0-9]{48}$/.test(String(lease||'')))throw fail('Reserva inválida.',409);
 const row=(await c.query(`SELECT cc.*,r.unit_id,r.dvr_id,r.start_at request_start,r.end_at request_end,r.capture_mode,r.media_type
  FROM cop_capture_channels cc JOIN cop_capture_requests r ON r.id=cc.capture_id JOIN cop_dvrs d ON d.id=r.dvr_id
  WHERE cc.capture_id=$1 AND cc.camera_id=$2 AND d.server_id IS NOT DISTINCT FROM $4::bigint AND r.status<>'cancelled'
  AND (cc.last_completed_lease=$3 OR (cc.lease_token=$3 AND cc.status='retrieving' AND cc.lease_until>now()))
  FOR UPDATE OF cc`,[id,cam,lease,serverId])).rows[0];
 if(!row)throw fail('Reserva expirada ou tarefa indisponível.',409);
 return row;
}
function instant(value){const t=Date.parse(value);if(typeof value!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(t))throw fail('Horário da mídia inválido.');return t;}
export function validateCaptureMedia(row,data,meta){
 const type=meta.content_type;
 if(!['image/jpeg','video/mp4'].includes(type)||!Buffer.isBuffer(data))throw fail('Mídia inválida.');
 if((row.media_type==='photo'&&type!=='image/jpeg')||(row.media_type==='video'&&type!=='video/mp4'))throw fail('A mídia não corresponde ao pedido.');
 const sample=instant(meta.sample_at),actual=instant(meta.recorded_at);
 if(sample<+new Date(row.batch_start_at)||sample>=+new Date(row.batch_end_at)||actual<+new Date(row.request_start)||actual>=+new Date(row.request_end))throw fail('Mídia fora do período reservado.');
 if(Math.abs(sample-actual)>1000)throw fail('Horário do playback não corresponde à amostra.');
 const sampling=captureSampling(row.sampling_config);let eventStart,eventEnd;
 if(row.capture_mode!=='continuous'){
  if(meta.event_type!==row.capture_mode)throw fail('Evento não corresponde ao filtro solicitado.');
  eventStart=instant(meta.event_start);eventEnd=instant(meta.event_end);
  if(eventEnd<=eventStart||sample<eventStart||sample>=eventEnd||actual<eventStart||actual>=eventEnd)throw fail('Mídia fora do evento registrado pelo DVR.');
  if((eventEnd-eventStart)/1000<sampling.min_motion_seconds)throw fail('Evento abaixo da duração mínima configurada.');
 }
 if(type==='image/jpeg'){
  if(data.length<4||data.length>8*1024*1024||data[0]!==255||data[1]!==216||data.at(-2)!==255||data.at(-1)!==217)throw fail('JPEG inválido.');
  if(meta.acquisition!=='playback_snapshot')throw fail('Foto deve vir de captura do playback.');
  if(row.capture_mode==='continuous'){
   if((sample-+new Date(row.request_start))%(sampling.frame_interval_seconds*1000)!==0)throw fail('Foto não respeita o intervalo configurado.');
  }else if(!sampling.offsets.includes((sample-eventStart)/1000))throw fail('Foto não respeita os offsets configurados.');
 }else{
  const duration=Number(meta.duration_seconds),finish=sample+duration*1000;
  if(data.length<12||data.length>256*1024*1024||data.toString('ascii',4,8)!=='ftyp'||!Number.isFinite(duration)||duration<=0||duration>116.5||finish>+new Date(row.batch_end_at)+500||finish>+new Date(row.request_end)+500||(eventEnd&&finish>eventEnd+500))throw fail('Vídeo inválido ou fora do intervalo.');
 }
 return {type,sample,actual,key:`${type}:${new Date(sample).toISOString()}`};
}
export async function captureAction(pool,id,cam,lease,serverId,action,{data,metadata,body={}}={}){
 return transaction(pool,async c=>{
  const row=await leased(c,id,cam,lease,serverId);
  if(row.last_completed_lease===lease)return {ok:true,completed:true};
  if(action==='renew'){await c.query("UPDATE cop_capture_channels SET lease_until=now()+interval '10 minutes' WHERE capture_id=$1 AND camera_id=$2",[id,cam]);return {ok:true};}
  if(action==='failure'){
   const unsupported=['PHOTO_UNSUPPORTED','EVENT_QUERY_UNSUPPORTED'].includes(body.code);
   await c.query(`UPDATE cop_capture_channels SET status=CASE WHEN attempts>=3 OR $4 THEN 'failed' ELSE 'waiting_connector' END,
    lease_until=NULL,next_attempt_at=now()+interval '1 minute',last_error=$3 WHERE capture_id=$1 AND camera_id=$2`,[id,cam,errors[body.code]||'Falha no receptor; consultar o serviço no VPS.',unsupported]);
   await refresh(c,id);return {ok:true};
  }
  if(action==='media'){
   const valid=validateCaptureMedia(row,data,metadata);
   const previous=(await c.query('SELECT media_id FROM cop_capture_media WHERE capture_id=$1 AND camera_id=$2 AND sample_key=$3',[id,cam,valid.key])).rows[0];
   if(previous){await c.query('UPDATE cop_capture_media SET lease_token=$4 WHERE capture_id=$1 AND camera_id=$2 AND sample_key=$3',[id,cam,valid.key,lease]);return {ok:true,media_id:previous.media_id};}
   const count=(await c.query('SELECT count(*)::int n,COALESCE(sum(m.bytes),0)::bigint bytes FROM cop_capture_media cm JOIN cop_media m ON m.id=cm.media_id WHERE cm.capture_id=$1 AND cm.camera_id=$2 AND cm.lease_token=$3',[id,cam,lease])).rows[0];
   if(count.n>=1500||Number(count.bytes)+data.length>256*1024*1024)throw fail('Lote acima do limite de armazenamento.',413);
   const ext=valid.type==='image/jpeg'?'jpg':'mp4',filename=`captura-${id}-canal-${row.channel}-${valid.sample}.${ext}`;
   const media=(await c.query(`INSERT INTO cop_media(event_id,unit_id,dvr_id,camera_id,detected_channel,source,source_path,filename,content_type,bytes,sha256,data,expires_at,selected_for_ai,recorded_at)
    VALUES(NULL,$1,$2,$3,$4,'capture',$5,$6,$7,$8,$9,$10,now()+interval '15 days',FALSE,$11) RETURNING id`,[row.unit_id,row.dvr_id,cam,row.channel,`capture/${id}/${cam}/${valid.key}`,filename,valid.type,data.length,createHash('sha256').update(data).digest('hex'),data,new Date(valid.actual)])).rows[0];
   await c.query('INSERT INTO cop_capture_media(capture_id,camera_id,sample_key,media_id,lease_token) VALUES($1,$2,$3,$4,$5)',[id,cam,valid.key,media.id,lease]);
   return {ok:true,media_id:media.id};
  }
  if(action!=='complete')throw fail('Ação inválida.');
  if(!Number.isSafeInteger(body.events_found)||body.events_found<0||body.events_found>10000||!Number.isSafeInteger(body.media_count)||body.media_count<0)throw fail('Contadores inválidos.');
  const count=(await c.query('SELECT count(*)::int n FROM cop_capture_media WHERE capture_id=$1 AND camera_id=$2 AND lease_token=$3',[id,cam,lease])).rows[0].n;
  if(count!==body.media_count||(row.capture_mode==='continuous'&&!count))throw fail('Lote de mídia incompleto.',409);
  await c.query(`UPDATE cop_capture_channels SET cursor_at=batch_end_at,status=CASE WHEN batch_end_at>=$4 THEN 'ready' ELSE 'queued' END,
   lease_until=NULL,last_completed_lease=$3,attempts=0,next_attempt_at=now(),last_error=NULL,events_found=events_found+$5 WHERE capture_id=$1 AND camera_id=$2`,[id,cam,lease,row.request_end,body.events_found]);
  await refresh(c,id);return {ok:true,media_count:count};
 });
}
