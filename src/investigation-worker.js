import { createHash } from 'node:crypto';
import { retrieveIntelbrasRtsp } from './playback.js';

async function storePlayback(pool,investigation,channel,result){
 const sha=createHash('sha256').update(result.data).digest('hex');
 const expiresAt=new Date(Date.now()+15*86400000);
 const sourcePath=`investigation/${investigation.id}/channel-${channel.channel}/${result.filename}`;
 const inserted=await pool.query(`
  INSERT INTO cop_media(event_id,unit_id,dvr_id,camera_id,detected_channel,source,source_path,filename,content_type,bytes,sha256,data,expires_at,selected_for_ai)
  VALUES(NULL,$1,$2,$3,$4,'investigation',$5,$6,$7,$8,$9,$10,$11,FALSE)
  ON CONFLICT(dvr_id,source_path,sha256) DO NOTHING RETURNING id`,
  [investigation.unit_id,investigation.dvr_id,channel.camera_id,channel.channel,sourcePath,result.filename,result.contentType,result.data.length,sha,result.data,expiresAt]);
 if(inserted.rowCount)return inserted.rows[0].id;
 return (await pool.query('SELECT id FROM cop_media WHERE dvr_id=$1 AND source_path=$2 AND sha256=$3 ORDER BY id DESC LIMIT 1',[investigation.dvr_id,sourcePath,sha])).rows[0]?.id||null;
}

async function processInvestigation(pool,investigation,logger){
 const dvr=(await pool.query('SELECT * FROM cop_dvrs WHERE id=$1',[investigation.dvr_id])).rows[0];
 if(!dvr)return;
 if(dvr.playback_mode==='unavailable'||dvr.playback_mode==='cloud'){
  await pool.query(`UPDATE cop_investigations SET status='waiting_connector',connector_status='not_available',last_error=$2,updated_at=now() WHERE id=$1`,
   [investigation.id,dvr.playback_mode==='cloud'?'DVR usa Cloud/P2P; conector histórico Cloud ainda não homologado.':'Playback histórico não configurado para este DVR.']);
  return;
 }
 const channels=(await pool.query(`SELECT * FROM cop_investigation_channels WHERE investigation_id=$1 AND status IN ('pending','waiting_connector','failed') ORDER BY channel`,[investigation.id])).rows;
 if(!channels.length)return;
 await pool.query("UPDATE cop_investigations SET status='retrieving',connector_status='running',last_error=NULL,updated_at=now() WHERE id=$1",[investigation.id]);
 for(const channel of channels){
  await pool.query("UPDATE cop_investigation_channels SET status='retrieving',last_error=NULL,updated_at=now() WHERE investigation_id=$1 AND camera_id=$2",[investigation.id,channel.camera_id]);
  try{
   const result=await retrieveIntelbrasRtsp({dvr,channel:channel.channel,start:channel.requested_start_at,end:channel.requested_end_at,logger});
   if(result.status!=='ready'){
    await pool.query("UPDATE cop_investigation_channels SET status='waiting_connector',last_error=$3,updated_at=now() WHERE investigation_id=$1 AND camera_id=$2",[investigation.id,channel.camera_id,result.reason]);
    continue;
   }
   const mediaId=await storePlayback(pool,investigation,channel,result);
   await pool.query("UPDATE cop_investigation_channels SET status='ready',retrieved_media_id=$3,last_error=NULL,updated_at=now() WHERE investigation_id=$1 AND camera_id=$2",[investigation.id,channel.camera_id,mediaId]);
  }catch(error){
   await pool.query("UPDATE cop_investigation_channels SET status='failed',last_error=$3,updated_at=now() WHERE investigation_id=$1 AND camera_id=$2",[investigation.id,channel.camera_id,error.message.slice(0,1000)]);
  }
 }
 const counts=(await pool.query(`SELECT count(*)::int total,count(*) FILTER(WHERE status='ready')::int ready,count(*) FILTER(WHERE status='failed')::int failed,count(*) FILTER(WHERE status='waiting_connector')::int waiting FROM cop_investigation_channels WHERE investigation_id=$1`,[investigation.id])).rows[0];
 let status='retrieving',connector='running',error=null;
 if(counts.ready===counts.total){status='ready';connector='done';}
 else if(counts.ready>0&&(counts.failed>0||counts.waiting>0)){status='partial';connector='partial';}
 else if(counts.waiting===counts.total){status='waiting_connector';connector='not_available';error='Aguardando conector de playback para todos os canais.';}
 else if(counts.failed===counts.total){status='failed';connector='failed';error='Falha ao recuperar todos os canais.';}
 await pool.query('UPDATE cop_investigations SET status=$2,connector_status=$3,last_error=$4,updated_at=now() WHERE id=$1',[investigation.id,status,connector,error]);
}

export function startInvestigationWorker({pool,logger=console,intervalMs=15000}={}){
 let stopped=false,busy=false,timer;
 const tick=async()=>{if(stopped||busy)return;busy=true;try{
  const rows=(await pool.query(`SELECT * FROM cop_investigations WHERE status IN ('pending','waiting_connector','retrieving') ORDER BY created_at,id LIMIT 2`)).rows;
  for(const row of rows)await processInvestigation(pool,row,logger);
 }catch(e){logger.error('COP investigation worker:',e.message);}finally{busy=false;if(!stopped)timer=setTimeout(tick,intervalMs);}};
 void tick();return{stop(){stopped=true;if(timer)clearTimeout(timer);}};
}
