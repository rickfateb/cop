import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {createCapture,listCaptures} from '../src/captures.js';
import {claimCaptureJob,captureAction,validateCaptureMedia} from '../src/capture-connector.js';
const jpeg=Buffer.from([255,216,0,255,217]);
const row={media_type:'photo',capture_mode:'motion',batch_start_at:'2026-09-10T03:00:00Z',batch_end_at:'2026-09-10T03:10:00Z',request_start:'2026-09-10T03:00:00Z',request_end:'2026-09-10T04:00:00Z',sampling_config:{policy:{offsets:[0,5,15,30]},device_config:{frame_interval_seconds:3}}};
const metadata={content_type:'image/jpeg',sample_at:'2026-09-10T03:00:05Z',recorded_at:'2026-09-10T03:00:05Z',event_type:'motion',event_start:'2026-09-10T03:00:00Z',event_end:'2026-09-10T03:00:20Z',acquisition:'playback_snapshot'};
test('capture accepts only requested media, timestamps, sampling offsets and DVR filter',()=>{
 validateCaptureMedia(row,jpeg,metadata);
 for(const patch of [{event_type:'ai'},{event_end:'2026-09-10T03:00:04Z'},{sample_at:'2026-09-10T03:00:06Z',recorded_at:'2026-09-10T03:00:06Z'},{acquisition:'video_download'},{recorded_at:'2026-09-10T03:00:09Z'},{content_type:'video/mp4'}])assert.throws(()=>validateCaptureMedia(row,jpeg,{...metadata,...patch}));
 assert.throws(()=>validateCaptureMedia(row,Buffer.from('jpeg'),metadata));
 const continuous={...row,capture_mode:'continuous'};
 assert.throws(()=>validateCaptureMedia(continuous,jpeg,metadata));
 validateCaptureMedia(continuous,jpeg,{...metadata,sample_at:'2026-09-10T03:00:06Z',recorded_at:'2026-09-10T03:00:06Z'});
});
export async function checkCaptureConnectorDatabase(pool){
 const sql=await readFile(new URL('../src/schema.sql',import.meta.url),'utf8');await pool.query(sql);await pool.query(sql);
 const unit=(await pool.query("INSERT INTO cop_units(name,code) VALUES('Historical','HIST') RETURNING id")).rows[0];
 const dvr=(await pool.query("INSERT INTO cop_dvrs(unit_id,name,model,channel_count,playback_mode,autoregister_id) VALUES($1,'DVR','MHDX 1104',4,'netsdk_autoregister','101') RETURNING id",[unit.id])).rows[0];
 const camera=(await pool.query("INSERT INTO cop_cameras(dvr_id,channel,name,policy,device_config) VALUES($1,2,'Lateral','{\"offsets\":[0,5,15,30]}','{\"frame_interval_seconds\":3}') RETURNING id",[dvr.id])).rows[0];
 const input={unit_id:unit.id,dvr_id:dvr.id,channels:[2],start_at:row.request_start,end_at:'2026-09-10T03:11:00Z',capture_mode:'motion',media_type:'photo'};
 const request=await createCapture(pool,input);
 const old={connector_name:'hostinger',device_ids:['101']},identity={...old,capabilities:['historical_capture_v1']};
 assert.equal(await claimCaptureJob(pool,old),null);
 assert.equal(await claimCaptureJob(pool,{...identity,device_ids:['other']}),null);
 assert.equal(await claimCaptureJob(pool,identity,9999),null);
 const first=await claimCaptureJob(pool,identity);assert.equal(first.kind,'capture');assert.equal(first.channel,2);assert.equal(+new Date(first.end)-+new Date(first.start),600000);
 assert.equal(await claimCaptureJob(pool,identity),null);
 await assert.rejects(()=>captureAction(pool,request.id,camera.id,first.lease_token,9999,'renew'),e=>e.status===409);
 await assert.rejects(()=>captureAction(pool,request.id,camera.id,'0'.repeat(48),null,'renew'),e=>e.status===409);
 const uploaded=await captureAction(pool,request.id,camera.id,first.lease_token,null,'media',{data:jpeg,metadata});
 assert.equal((await captureAction(pool,request.id,camera.id,first.lease_token,null,'media',{data:jpeg,metadata})).media_id,uploaded.media_id);
 await pool.query("UPDATE cop_capture_channels SET lease_until=now()-interval '1 second' WHERE capture_id=$1",[request.id]);
 const replacement=await claimCaptureJob(pool,identity);assert.notEqual(replacement.lease_token,first.lease_token);
 await assert.rejects(()=>captureAction(pool,request.id,camera.id,first.lease_token,null,'complete',{body:{events_found:1,media_count:1}}),e=>e.status===409);
 assert.equal((await captureAction(pool,request.id,camera.id,replacement.lease_token,null,'media',{data:jpeg,metadata})).media_id,uploaded.media_id);
 await captureAction(pool,request.id,camera.id,replacement.lease_token,null,'complete',{body:{events_found:1,media_count:1}});
 await captureAction(pool,request.id,camera.id,replacement.lease_token,null,'complete',{body:{events_found:1,media_count:1}});
 const last=await claimCaptureJob(pool,identity);assert.equal(+new Date(last.start),+new Date('2026-09-10T03:10:00Z'));
 await captureAction(pool,request.id,camera.id,last.lease_token,null,'complete',{body:{events_found:0,media_count:0}});
 assert.equal(await claimCaptureJob(pool,identity),null);
 const listed=(await listCaptures(pool))[0];assert.equal(listed.effective_status,'ready');assert.equal(listed.channels[0].media_count,1);assert.equal(listed.channels[0].events_found,1);assert.equal(listed.channels[0].media[0].content_type,'image/jpeg');
 const failures=await createCapture(pool,input);
 for(let n=0;n<3;n++){
  const job=await claimCaptureJob(pool,identity);
  await captureAction(pool,failures.id,camera.id,job.lease_token,null,'failure',{body:{code:'DVR_OFFLINE'}});
  await pool.query('UPDATE cop_capture_channels SET next_attempt_at=now() WHERE capture_id=$1',[failures.id]);
 }
 assert.equal((await pool.query('SELECT status FROM cop_capture_requests WHERE id=$1',[failures.id])).rows[0].status,'failed');
 assert.equal(await claimCaptureJob(pool,identity),null);
 const cancelled=await createCapture(pool,input);const pending=await claimCaptureJob(pool,identity);
 await pool.query("UPDATE cop_capture_requests SET status='cancelled' WHERE id=$1",[cancelled.id]);
 await assert.rejects(()=>captureAction(pool,cancelled.id,camera.id,pending.lease_token,null,'media',{data:jpeg,metadata}),e=>e.status===409);
 const future=await createCapture(pool,{...input,start_at:'2099-09-10T03:00:00Z',end_at:'2099-09-10T04:00:00Z'});assert.equal(future.status,'waiting_connector');
 assert.equal(await claimCaptureJob(pool,identity),null);
}
test('capture queue leases, retry, server scope, completion, batches and cancellation',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const {default:pg}=await import('pg');const schema='capture_sdk_'+randomBytes(6).toString('hex');
 const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 try{await checkCaptureConnectorDatabase(pool);}finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
