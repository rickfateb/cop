import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { connectorAuthorized,connectorIdentity,validatePlaybackConfig,validateSdkVideo,
 claimSdkJob,renewSdkJob,failSdkJob,completeSdkJob } from '../src/sdk-connector.js';
import { createInvestigation } from '../src/investigations.js';

test('SDK connector uses a separate strong token and validates IDs',()=>{
 assert.equal(connectorAuthorized('x'.repeat(32),'x'.repeat(32)),true);
 assert.equal(connectorAuthorized('short','short'),false);
 assert.equal(connectorAuthorized('x'.repeat(32),'y'.repeat(32)),false);
 assert.throws(()=>connectorIdentity({connector_name:'hostinger',device_ids:['../101']}));
 assert.throws(()=>validatePlaybackConfig({playback_mode:'netsdk_autoregister'}));
 assert.equal(validatePlaybackConfig({playback_mode:'netsdk_autoregister',autoregister_id:'101'}).register,'101');
});
test('SDK uploads reject invalid MP4 and wrong duration',()=>{
 const data=Buffer.from('0000ftypisom0000');
 assert.throws(()=>validateSdkVideo(Buffer.from('MOCK_DAV'),30,30));
 assert.throws(()=>validateSdkVideo(data,10,30));
 validateSdkVideo(data,30,30);
});
test('SDK queue: concurrent claim, lease recovery, stale completion, idempotence, retries and cancellation',
 {skip:!process.env.TEST_DATABASE_URL},async()=>{
 const {default:pg}=await import('pg');
 const schema='sdk_test_'+randomBytes(6).toString('hex');
 const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 try{
  const sql=await readFile(new URL('../src/schema.sql',import.meta.url),'utf8');
  await pool.query(sql);await pool.query(sql); // Migration is repeatable.
  const unit=(await pool.query("INSERT INTO cop_units(name,code) VALUES('Test','TEST') RETURNING id")).rows[0];
  const dvr=(await pool.query(`INSERT INTO cop_dvrs(unit_id,name,model,channel_count,playback_mode,autoregister_id)
    VALUES($1,'DVR','MHDX 1104',4,'netsdk_autoregister','101') RETURNING id`,[unit.id])).rows[0];
  await pool.query("INSERT INTO cop_cameras(dvr_id,channel,name) VALUES($1,1,'Canal 1')",[dvr.id]);
  const input={unit_id:unit.id,reference_at:'2026-09-30T13:41:38Z',window_before_seconds:0,window_after_seconds:30,reason:'SDK test',channels:[1]};
  await assert.rejects(()=>createInvestigation(pool,{...input,window_after_seconds:0}));
  const investigation=await createInvestigation(pool,input);
  const identity={connector_name:'hostinger',device_ids:['101']};
  const claims=await Promise.all([claimSdkJob(pool,identity),claimSdkJob(pool,identity)]);
  assert.equal(claims.filter(Boolean).length,1);
  const first=claims.find(Boolean);
  await assert.rejects(()=>renewSdkJob(pool,first.investigation_id,first.camera_id,'0'.repeat(48)),e=>e.status===409);
  await pool.query("UPDATE cop_investigation_channels SET sdk_lease_until=now()-interval '1 second' WHERE investigation_id=$1",[investigation.id]);
  const replacement=await claimSdkJob(pool,identity);
  assert.notEqual(first.lease_token,replacement.lease_token);
  const data=Buffer.from('0000ftypisom0000');
  await assert.rejects(()=>completeSdkJob(pool,first.investigation_id,first.camera_id,first.lease_token,data,{duration_seconds:30}),e=>e.status===409);
  const done=await completeSdkJob(pool,replacement.investigation_id,replacement.camera_id,replacement.lease_token,data,{duration_seconds:30});
  const repeated=await completeSdkJob(pool,replacement.investigation_id,replacement.camera_id,replacement.lease_token,data,{duration_seconds:30});
  assert.equal(done.media_id,repeated.media_id);
  assert.equal((await pool.query('SELECT count(*)::int count FROM cop_media')).rows[0].count,1);
  assert.equal((await pool.query('SELECT status FROM cop_investigations WHERE id=$1',[investigation.id])).rows[0].status,'ready');
  const failed=await createInvestigation(pool,input);
  for(let attempt=0;attempt<3;attempt++){
    const job=await claimSdkJob(pool,identity);assert.equal(job.investigation_id,failed.id);
    await failSdkJob(pool,job.investigation_id,job.camera_id,job.lease_token,'DVR_OFFLINE');
    await pool.query('UPDATE cop_investigation_channels SET sdk_next_attempt_at=now() WHERE investigation_id=$1',[failed.id]);
  }
  assert.equal(await claimSdkJob(pool,identity),null);
  assert.equal((await pool.query('SELECT status FROM cop_investigations WHERE id=$1',[failed.id])).rows[0].status,'failed');
  const cancelled=await createInvestigation(pool,input);
  await pool.query("UPDATE cop_investigations SET status='cancelled' WHERE id=$1",[cancelled.id]);
  assert.equal(await claimSdkJob(pool,identity),null);
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
