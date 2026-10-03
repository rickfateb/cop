import {readFile} from 'node:fs/promises';

// Capture v1 retained sample timestamps, not the event metadata supplied by the
// receiver. Reconstruction is allowed only when the configured cooldown keeps
// different events strictly farther apart than the complete offset span.
export function groupCapturePhotos(rows,sampling) {
 const offsets=sampling?.offsets;
 if(!Array.isArray(offsets)||!offsets.length||offsets.some(n=>!Number.isInteger(n)||n<0)||!offsets.includes(0))throw Error('Offsets invalidos para agrupar a captura.');
 const span=Math.max(...offsets);
 if(!Number.isFinite(sampling.cooldown_seconds)||sampling.cooldown_seconds<=2*span)throw Error('Intervalos insuficientes para distinguir as sequencias.');
 const sorted=[...rows].sort((a,b)=>Date.parse(a.sample_at)-Date.parse(b.sample_at)||Number(a.media_id)-Number(b.media_id));
 const groups=[];let previous=null;
 for(const row of sorted) {
  const time=Date.parse(row.sample_at);
  if(!Number.isFinite(time)||row.content_type!=='image/jpeg'||!row.original_present)throw Error('Foto original ausente ou invalida.');
  if(previous!==null&&time===previous)throw Error('Amostra duplicada.');
  if(previous===null||time-previous>span*1000)groups.push([]);
  const group=groups.at(-1),first=Date.parse(group[0]?.sample_at??row.sample_at);
  if(!offsets.includes((time-first)/1000))throw Error('Sequencia nao corresponde aos offsets configurados.');
  group.push(row);previous=time;
 }
 return groups;
}

export async function enqueueCaptureAnalysis(pool,captureId,requestedBy) {
 if(!/^[1-9]\d*$/.test(String(captureId))||typeof requestedBy!=='string'||!requestedBy.trim())throw Error('Pedido de analise invalido.');
 await pool.query(await readFile(new URL('./capture-analysis-schema.sql',import.meta.url),'utf8'));
 const db=await pool.connect();
 try {
  await db.query('BEGIN');
  const capture=(await db.query('SELECT * FROM cop_capture_requests WHERE id=$1 FOR UPDATE',[captureId])).rows[0];
  if(!capture||capture.status!=='ready'||capture.capture_mode!=='motion'||capture.media_type!=='photo')throw Error('Somente captura de fotos por movimento concluida pode ser analisada por este fluxo.');
  const channels=(await db.query('SELECT * FROM cop_capture_channels WHERE capture_id=$1 ORDER BY camera_id',[captureId])).rows;
  let sequences=0,photos=0,newJobs=0;
  for(const channel of channels) {
   const frames=(await db.query(`SELECT cm.media_id,substring(cm.sample_key from 12)::timestamptz sample_at,
    m.content_type,m.event_id,m.data IS NOT NULL original_present
    FROM cop_capture_media cm JOIN cop_media m ON m.id=cm.media_id
    WHERE cm.capture_id=$1 AND cm.camera_id=$2 ORDER BY sample_at,cm.media_id`,[captureId,channel.camera_id])).rows;
   const groups=groupCapturePhotos(frames,channel.sampling_config);
   if(groups.length!==channel.events_found)throw Error('A quantidade de sequencias diverge dos eventos registrados pelo DVR.');
   for(const group of groups) {
    const first=group[0].sample_at,last=group.at(-1).sample_at,ids=group.map(m=>m.media_id);
    const existing=(await db.query('SELECT event_id FROM cop_capture_analysis_sequences WHERE capture_id=$1 AND camera_id=$2 AND first_sample_at=$3',[captureId,channel.camera_id,first])).rows[0];
    let eventId=existing?.event_id;
    if(!eventId) {
     if(group.some(m=>m.event_id!==null))throw Error('Foto ja vinculada a outro evento.');
     eventId=(await db.query(`INSERT INTO cop_events(unit_id,dvr_id,camera_id,detected_channel,stream_key,source,status,started_at,last_frame_at,media_count)
      VALUES($1,$2,$3,$4,$5,'manual','ready',$6,$7,$8) RETURNING id`,[capture.unit_id,capture.dvr_id,channel.camera_id,channel.channel,`capture-${captureId}`,first,last,group.length])).rows[0].id;
     await db.query('INSERT INTO cop_capture_analysis_sequences(capture_id,camera_id,first_sample_at,event_id) VALUES($1,$2,$3,$4)',[captureId,channel.camera_id,first,eventId]);
    }
    await db.query(`INSERT INTO cop_media_preservation_holds(media_id,reason,requested_by)
     SELECT unnest($1::bigint[]),$2,$3 ON CONFLICT(media_id) DO UPDATE SET released_at=NULL,released_by=NULL,release_consent=NULL,reason=excluded.reason,requested_by=excluded.requested_by`,[ids,'Preservar os originais da captura ate consentimento explicito do usuario.',requestedBy]);
    const changed=await db.query(`UPDATE cop_media SET event_id=$2,selected_for_ai=TRUE,
     frame_offset_seconds=extract(epoch from(substring(cm.sample_key from 12)::timestamptz-$3::timestamptz))::int
     FROM cop_capture_media cm WHERE cm.media_id=cop_media.id AND cop_media.id=ANY($1::bigint[])
      AND cm.capture_id=$4 AND (cop_media.event_id IS NULL OR cop_media.event_id=$2)`,[ids,eventId,first,captureId]);
    if(changed.rowCount!==group.length)throw Error('Vinculo da sequencia inconsistente.');
    const job=await db.query(`INSERT INTO cop_analysis_jobs(event_id,status,not_before) VALUES($1,'pending',$2)
     ON CONFLICT(event_id) DO NOTHING RETURNING id`,[eventId,first]);
    newJobs+=job.rowCount;sequences++;photos+=group.length;
   }
  }
  await db.query('COMMIT');
  return {capture_id:String(captureId),sequences,photos,preserved_originals:photos,new_jobs:newJobs};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
