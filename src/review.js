export function mapReviewResult(detail, media) {
 const result=detail.fraud_result;
 if(!result||!['Sem alerta','Revisar','Grave - Fraude'].includes(result.classification))throw Error('Resultado de análise inválido.');
 const byId=new Map(media.map(m=>[String(m.id),m]));
 const refs=new Map((detail.media||[]).map(m=>[String(m.id),/^cop-media-(\d+)$/.exec(m.external_id||'')?.[1]]));
 const map=(items,flags=false)=>(items||[]).slice(0,29).flatMap(item=>{
  const m=byId.get(refs.get(String(item.media_id)));
  if(!m)return [];
  return [{...(flags?{type:item.type}:{}),media_id:String(m.id),description:String(item.description||'').slice(0,2000),channel:m.detected_channel??null,
   frame_offset_seconds:m.frame_offset_seconds??null,recorded_at:m.recorded_at??null}];
 });
 return {classification:result.classification,summary:String(detail.summary||result.summary||'').slice(0,4000),
  rationale:String(result.rationale||'').slice(0,4000),confidence:result.confidence,
  observations:map(result.observations),clothing_matches:map(result.clothing_matches).slice(0,5),
  flags:map((result.flags||[]).filter(f=>['fumando','sem_camisa'].includes(f.type)),true),
  reference_id:'cerejeiras-20261002-v1',requires_human_review:true,payment_status:'not_verified'};
}

export async function listReviews(pool,{limit=100,clothingOnly=false,unitId=null}={}) {
 const params=[],where=['j.analysis_result IS NOT NULL'];
 if(unitId){if(!/^[1-9]\d*$/.test(String(unitId)))throw Object.assign(Error('Unidade inválida.'),{status:400});params.push(unitId);where.push(`e.unit_id=$${params.length}`);}
 if(clothingOnly)where.push("jsonb_array_length(COALESCE(j.analysis_result->'clothing_matches','[]'::jsonb))>0");
 params.push(Math.min(100,Math.max(1,Number(limit)||100)));
 return (await pool.query(`SELECT j.id,j.event_id,j.analysis_result,j.analysis_protocol,e.started_at,u.name unit_name,c.name camera_name,
  (SELECT m.id FROM cop_media m WHERE m.event_id=e.id AND m.content_type LIKE 'video/%' ORDER BY m.id LIMIT 1) video_media_id
  FROM cop_analysis_jobs j JOIN cop_events e ON e.id=j.event_id JOIN cop_units u ON u.id=e.unit_id
  LEFT JOIN cop_cameras c ON c.id=e.camera_id WHERE ${where.join(' AND ')} ORDER BY e.started_at DESC,j.id DESC LIMIT $${params.length}`,params)).rows;
}

export async function reviewIncident(pool,id,status) {
 if(!/^[1-9]\d*$/.test(String(id))||!['confirmed','dismissed'].includes(status))throw Object.assign(Error('Revisão inválida.'),{status:400});
 const row=(await pool.query('UPDATE cop_fraud_incidents SET review_status=$2,reviewed_at=now(),updated_at=now() WHERE id=$1 RETURNING id,review_status,reviewed_at',[id,status])).rows[0];
 if(!row)throw Object.assign(Error('Ocorrência não encontrada.'),{status:404});
 return row;
}
