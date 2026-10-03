import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { transcodeReviewVideo } from './video.js';
import {mapReviewResult} from './review.js';

const TZ = 'America/Sao_Paulo';

function required(name) {
  const value = process.env[name] || '';
  if (!value) throw Error(`Variável ausente: ${name}`);
  return value;
}
function publicBase() {
  return (process.env.COP_PUBLIC_BASE_URL || 'https://cop-web-ingest-production.up.railway.app').replace(/\/$/, '');
}
function mediaSecret() { return required('COP_MEDIA_SIGNING_SECRET'); }
function signature(mediaId, exp) {
  return createHmac('sha256', mediaSecret()).update(`${mediaId}:${exp}`).digest('hex');
}
export function signedMediaUrl(mediaId, ttlSeconds = 172800) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${publicBase()}/api/share/media/${mediaId}?exp=${exp}&sig=${signature(mediaId, exp)}`;
}
export function verifySignedMedia(mediaId, expRaw, sigRaw) {
  const exp = Number(expRaw), sig = String(sigRaw || '');
  if (!Number.isInteger(exp) || exp < Math.floor(Date.now()/1000) || exp > Math.floor(Date.now()/1000) + 7*86400) return false;
  const expected = signature(mediaId, exp);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function evenly(rows, limit = 29) {
  if (rows.length <= limit) return rows;
  const out = [], used = new Set();
  for (let i = 0; i < limit; i++) {
    const index = Math.round(i * (rows.length - 1) / (limit - 1));
    if (!used.has(index)) { used.add(index); out.push(rows[index]); }
  }
  return out;
}
function toIso(value) { return new Date(value).toISOString(); }
function addSeconds(value, seconds) { return new Date(new Date(value).getTime() + Number(seconds || 0) * 1000).toISOString(); }

async function submitOne(pool, job, logger) {
  const media = (await pool.query(`
    SELECT id,filename,received_at,recorded_at,detected_channel,frame_offset_seconds
    FROM cop_media
    WHERE event_id=$1 AND selected_for_ai=TRUE AND content_type='image/jpeg'
    ORDER BY COALESCE(frame_offset_seconds,0),received_at,id`, [job.event_id])).rows;
  const chosen = evenly(media, 29);
  if (!chosen.length) {
    await pool.query("UPDATE cop_analysis_jobs SET status='failed',last_error='Sem quadros selecionados para IA',finished_at=now(),updated_at=now() WHERE id=$1", [job.id]);
    return;
  }
  const base = required('AUDIT_BASE_URL').replace(/\/$/, '');
  const token = required('AUDIT_COP_TOKEN');
  const payload = {
    external_id: `cop-event-${job.event_id}`,
    unit_id: job.unit_code,
    unit_name: job.unit_name,
    captured_at: toIso(job.started_at),
    profile: 'fraude_v1',
    metadata: { cop_event_id: String(job.event_id), dvr_id: String(job.dvr_id), camera_id: job.camera_id == null ? null : String(job.camera_id), sampling_seconds: 3, analysis_protocol: job.analysis_protocol || null },
    media: chosen.map(row => ({
      external_id: `cop-media-${row.id}`,
      kind: 'photo',
      url: signedMediaUrl(row.id, 48*3600),
      captured_at: row.recorded_at ? toIso(row.recorded_at) : addSeconds(job.started_at, row.frame_offset_seconds),
      camera_id: job.camera_id == null ? null : String(job.camera_id),
      metadata: { frame_offset_seconds: row.frame_offset_seconds ?? 0, filename: row.filename,channel:row.detected_channel??null }
    }))
  };
  let response;
  try {
    response = await fetch(base + '/api/v1/ingest/cop', {
      method:'POST',
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify(payload),
      signal:AbortSignal.timeout(30000)
    });
  } catch (error) {
    throw Error('Falha de rede ao enviar para auditoria: ' + error.message);
  }
  let data={}; try { data=await response.json(); } catch {}
  if (!response.ok || !data.id) throw Error(`Auditoria recusou evento (${response.status})`);
  await pool.query(`UPDATE cop_analysis_jobs SET status='running',provider_audit_id=$2,submitted_at=now(),result_checked_at=now(),attempts=attempts+1,last_error=NULL,updated_at=now() WHERE id=$1`, [job.id, data.id]);
  logger.log(`COP fraude enviado: event=${job.event_id} audit=${data.id} quadros=${chosen.length}`);
}

async function ensureReviewVideo(pool, eventId, evidenceRows, logger) {
  let original = null;
  for (const row of evidenceRows) {
    const source = String(row.source_path || '').split('#ai-frame-')[0];
    if (!source) continue;
    const r = await pool.query(`SELECT * FROM cop_media WHERE event_id=$1 AND source_path=$2 AND content_type<>'image/jpeg' ORDER BY id LIMIT 1`, [eventId, source]);
    if (r.rowCount) { original = r.rows[0]; break; }
  }
  if (!original) {
    const r = await pool.query(`SELECT * FROM cop_media WHERE event_id=$1 AND content_type<>'image/jpeg' ORDER BY received_at,id LIMIT 1`, [eventId]);
    if (r.rowCount) original = r.rows[0];
  }
  if (!original) return null;
  const reviewPath = original.source_path + '#review.mp4';
  const existing = await pool.query('SELECT id FROM cop_media WHERE event_id=$1 AND source_path=$2 ORDER BY id LIMIT 1', [eventId, reviewPath]);
  if (existing.rowCount) return existing.rows[0].id;
  try {
    const mp4 = await transcodeReviewVideo(original.data, original.filename);
    const sha = createHash('sha256').update(mp4).digest('hex');
    const name = original.filename.replace(/\.[^.]+$/, '') + '.review.mp4';
    const inserted = await pool.query(`
      INSERT INTO cop_media(event_id,unit_id,dvr_id,camera_id,detected_channel,stream_key,source,source_path,filename,content_type,bytes,sha256,data,expires_at,selected_for_ai,recorded_at)
      VALUES($1,$2,$3,$4,$5,$6,'derived',$7,$8,'video/mp4',$9,$10,$11,$12,FALSE,$13)
      ON CONFLICT(dvr_id,source_path,sha256) DO NOTHING RETURNING id`,
      [eventId,original.unit_id,original.dvr_id,original.camera_id,original.detected_channel,original.stream_key,reviewPath,name,mp4.length,sha,mp4,original.expires_at,original.recorded_at]);
    if (inserted.rowCount) return inserted.rows[0].id;
    const found = await pool.query('SELECT id FROM cop_media WHERE event_id=$1 AND source_path=$2 ORDER BY id DESC LIMIT 1',[eventId,reviewPath]);
    return found.rows[0]?.id || null;
  } catch (error) {
    logger.error('Falha ao preparar MP4 de revisão:', error.message);
    return null;
  }
}

async function completeOne(pool, job, detail, logger) {
  const result = detail.fraud_result;
  if (!result) throw Error('Resultado de fraude ausente.');
  const reviewMedia=(await pool.query('SELECT id,detected_channel,frame_offset_seconds,recorded_at FROM cop_media WHERE event_id=$1',[job.event_id])).rows;
  const review=mapReviewResult(detail,reviewMedia);
  await pool.query('UPDATE cop_analysis_jobs SET analysis_result=$2::jsonb,updated_at=now() WHERE id=$1',[job.id,JSON.stringify(review)]);
  if (result.classification !== 'Grave - Fraude') {
    await pool.query("UPDATE cop_analysis_jobs SET status='done',finished_at=now(),last_error=NULL,updated_at=now() WHERE id=$1",[job.id]);
    return;
  }
  const auditMedia = new Map((detail.media || []).map(m => [String(m.id), String(m.external_id || '')]));
  const orderedIds = (result.evidence_media_ids || []).map(id => auditMedia.get(String(id))).map(v => /^cop-media-(\d+)$/.exec(v || '')?.[1]).filter(Boolean).slice(0,5);
  if (!orderedIds.length) throw Error('IA classificou fraude grave sem evidências mapeáveis.');
  const rows = (await pool.query(`SELECT id,event_id,source_path,filename FROM cop_media WHERE event_id=$1 AND id=ANY($2::bigint[])`, [job.event_id, orderedIds])).rows;
  const byId = new Map(rows.map(r => [String(r.id), r]));
  const evidenceRows = orderedIds.map(id => byId.get(String(id))).filter(Boolean);
  const videoMediaId = await ensureReviewVideo(pool, job.event_id, evidenceRows, logger);
  const incident = await pool.query(`
    INSERT INTO cop_fraud_incidents(event_id,unit_id,dvr_id,camera_id,occurred_at,classification,summary,rationale,confidence,video_media_id)
    VALUES($1,$2,$3,$4,$5,'Grave - Fraude',$6,$7,$8,$9)
    ON CONFLICT(event_id) DO UPDATE SET summary=excluded.summary,rationale=excluded.rationale,confidence=excluded.confidence,video_media_id=COALESCE(excluded.video_media_id,cop_fraud_incidents.video_media_id),updated_at=now()
    RETURNING id`,
    [job.event_id,job.unit_id,job.dvr_id,job.camera_id,job.started_at,review.summary,String(result.rationale).slice(0,4000),Number(result.confidence),videoMediaId]);
  const incidentId = incident.rows[0].id;
  await pool.query('DELETE FROM cop_fraud_evidence WHERE incident_id=$1',[incidentId]);
  for (let i=0;i<evidenceRows.length;i++) await pool.query('INSERT INTO cop_fraud_evidence(incident_id,media_id,evidence_order) VALUES($1,$2,$3)',[incidentId,evidenceRows[i].id,i+1]);
  await pool.query("UPDATE cop_analysis_jobs SET status='done',finished_at=now(),last_error=NULL,updated_at=now() WHERE id=$1",[job.id]);
  logger.log(`COP Grave - Fraude: incident=${incidentId} event=${job.event_id} evidencias=${evidenceRows.length} video=${videoMediaId || 'n/a'}`);
}

async function pollRunning(pool, logger) {
  const jobs = (await pool.query(`
    SELECT j.id,j.event_id,j.provider_audit_id,e.unit_id,e.dvr_id,e.camera_id,e.started_at
    FROM cop_analysis_jobs j JOIN cop_events e ON e.id=j.event_id
    WHERE j.status='running' AND j.provider_audit_id IS NOT NULL
      AND (j.result_checked_at IS NULL OR j.result_checked_at < now()-interval '8 seconds')
    ORDER BY j.result_checked_at NULLS FIRST,j.id LIMIT 4`)).rows;
  if (!jobs.length) return;
  const base = required('AUDIT_BASE_URL').replace(/\/$/, ''), token = required('AUDIT_COP_TOKEN');
  for (const job of jobs) {
    let response;
    try { response = await fetch(base + '/api/v1/service/cop/audits/' + encodeURIComponent(job.provider_audit_id), {headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)}); }
    catch (error) { await pool.query("UPDATE cop_analysis_jobs SET result_checked_at=now(),last_error=$2,updated_at=now() WHERE id=$1",[job.id,'Falha consultando auditoria: '+error.message]); continue; }
    let data={}; try{data=await response.json();}catch{}
    if (!response.ok) { await pool.query("UPDATE cop_analysis_jobs SET result_checked_at=now(),last_error=$2,updated_at=now() WHERE id=$1",[job.id,`Auditoria respondeu ${response.status}`]); continue; }
    await pool.query('UPDATE cop_analysis_jobs SET result_checked_at=now(),updated_at=now() WHERE id=$1',[job.id]);
    if (data.status === 'completed') {
      try { await completeOne(pool,job,data,logger); }
      catch (error) { await pool.query("UPDATE cop_analysis_jobs SET status='failed',last_error=$2,finished_at=now(),updated_at=now() WHERE id=$1",[job.id,error.message.slice(0,1000)]); }
    } else if (data.status === 'failed') {
      await pool.query("UPDATE cop_analysis_jobs SET status='failed',last_error='Auditoria visual falhou',finished_at=now(),updated_at=now() WHERE id=$1",[job.id]);
    }
  }
}

async function submitPending(pool, logger) {
  const jobs=(await pool.query(`
    SELECT j.id,j.event_id,j.attempts,j.analysis_protocol,e.unit_id,e.dvr_id,e.camera_id,e.started_at,u.code unit_code,u.name unit_name
    FROM cop_analysis_jobs j JOIN cop_events e ON e.id=j.event_id JOIN cop_units u ON u.id=e.unit_id
    WHERE j.status='pending' AND j.not_before<=now() AND j.attempts<5
    ORDER BY j.not_before,j.id LIMIT 2`)).rows;
  for (const job of jobs) {
    try { await submitOne(pool,job,logger); }
    catch (error) {
      const attempts=Number(job.attempts||0)+1;
      await pool.query(`UPDATE cop_analysis_jobs SET attempts=$2,status=CASE WHEN $2>=5 THEN 'failed' ELSE 'pending' END,last_error=$3,not_before=now()+interval '30 seconds',updated_at=now() WHERE id=$1`,
        [job.id,attempts,error.message.slice(0,1000)]);
      logger.error('Falha ao enviar evento para IA:', error.message);
    }
  }
}

function localTime(value) {
  return new Intl.DateTimeFormat('pt-BR',{timeZone:TZ,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
}

async function sendNineOClock(pool, logger) {
  if (!process.env.COP_FRAUD_ALERT_URL || !process.env.COP_FRAUD_ALERT_TOKEN) return;
  const clock=(await pool.query(`SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') local_date,
    extract(hour from now() AT TIME ZONE 'America/Sao_Paulo')::int AS local_hour,
    ((date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo')+interval '9 hours') AT TIME ZONE 'America/Sao_Paulo') cutoff`)).rows[0];
  if (clock.local_hour !== 9) return;
  const incidents=(await pool.query(`
    SELECT i.*,u.name unit_name
    FROM cop_fraud_incidents i JOIN cop_units u ON u.id=i.unit_id
    WHERE i.occurred_at < $1 AND i.review_status='confirmed' AND i.alert_status IN ('pending','failed') AND i.alert_attempts<6
      AND (i.last_alert_attempt_at IS NULL OR i.last_alert_attempt_at < now()-interval '10 minutes')
    ORDER BY u.name,i.occurred_at,i.id LIMIT 100`,[clock.cutoff])).rows;
  if (!incidents.length) return;
  const ids=incidents.map(i=>i.id);
  await pool.query(`UPDATE cop_fraud_incidents SET alert_status='sending',alert_attempts=alert_attempts+1,last_alert_attempt_at=now(),updated_at=now() WHERE id=ANY($1::bigint[])`,[ids]);
  const groups=[];
  for (const incident of incidents) {
    let group=groups.find(g=>g.unit===incident.unit_name);
    if(!group){group={unit:incident.unit_name,occurrences:[]};groups.push(group);}
    const evidence=(await pool.query(`SELECT m.id,m.filename FROM cop_fraud_evidence e JOIN cop_media m ON m.id=e.media_id WHERE e.incident_id=$1 ORDER BY e.evidence_order`,[incident.id])).rows;
    let video=null;
    if(incident.video_media_id){
      const v=(await pool.query('SELECT id,filename,content_type FROM cop_media WHERE id=$1',[incident.video_media_id])).rows[0];
      if(v?.content_type==='video/mp4') video={url:signedMediaUrl(v.id,1800),filename:v.filename};
    }
    group.occurrences.push({
      id:String(incident.id),time:localTime(incident.occurred_at),classification:'Grave - Fraude',
      report:`${incident.summary}\n\nMotivo da preocupação: ${incident.rationale}`,
      images:evidence.slice(0,5).map(m=>({url:signedMediaUrl(m.id,1800),filename:m.filename})),
      video
    });
  }
  let response,data={};
  try {
    response=await fetch(process.env.COP_FRAUD_ALERT_URL,{
      method:'POST',
      headers:{Authorization:`Bearer ${process.env.COP_FRAUD_ALERT_TOKEN}`,'Content-Type':'application/json'},
      body:JSON.stringify({dispatchKey:`fraud-${clock.local_date}`,groups}),
      signal:AbortSignal.timeout(120000)
    });
    try{data=await response.json();}catch{}
  } catch (error) {
    await pool.query(`UPDATE cop_fraud_incidents SET alert_status='failed',last_alert_error=$2,updated_at=now() WHERE id=ANY($1::bigint[])`,[ids,('Falha de rede no relay: '+error.message).slice(0,1000)]);
    return;
  }
  if(response.ok && !data.failed){
    await pool.query(`UPDATE cop_fraud_incidents SET alert_status='sent',alert_sent_at=now(),last_alert_error=NULL,updated_at=now() WHERE id=ANY($1::bigint[])`,[ids]);
    logger.log(`COP fraude 09h enviado: unidades=${groups.length} ocorrencias=${ids.length} destinatario=Ricardo`);
  }else{
    await pool.query(`UPDATE cop_fraud_incidents SET alert_status='failed',last_alert_error=$2,updated_at=now() WHERE id=ANY($1::bigint[])`,[ids,(`Relay respondeu ${response.status}: ${data.error||'falha'}`).slice(0,1000)]);
  }
}

export function startFraudAutomation({ pool, logger=console }={}) {
  let stopped=false,busy=false,timer;
  const tick=async()=>{
    if(stopped||busy)return;
    busy=true;
    try{await pollRunning(pool,logger);await submitPending(pool,logger);await sendNineOClock(pool,logger);}
    catch(error){logger.error('COP fraude automação:',error.message);}
    finally{busy=false;if(!stopped)timer=setTimeout(tick,10000);}
  };
  void tick();
  return {stop(){stopped=true;if(timer)clearTimeout(timer);}};
}

