import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {validateCapture,capturePlan,createCapture,listCaptures} from '../src/captures.js';
import {saoPauloInput,buildCapturePayload,captureForm,captureList} from '../public/captures-ui.js';
import {claimSdkJob} from '../src/sdk-connector.js';

const input={unit_id:1,dvr_id:1,start_at:'2026-09-10T00:00:00-03:00',end_at:'2026-10-02T20:00:00-03:00',channels:[2],capture_mode:'motion',media_type:'photo'};
test('capture validates dates, timezone, channels and all type/media combinations',()=>{
  for(const capture_mode of ['continuous','motion','ai'])for(const media_type of ['photo','video','all']){
    const request=validateCapture({...input,capture_mode,media_type});
    assert.equal(request.start,'2026-09-10T03:00:00.000Z');assert.deepEqual(request.channels,[2]);
  }
  for(const patch of [{end_at:input.start_at},{start_at:'2026-02-30T00:00:00Z'},{start_at:'2026-09-10T00:00:00'},{channels:[]},{channels:[33]},{capture_mode:'unknown'},{media_type:'unknown'}])assert.throws(()=>validateCapture({...input,...patch}),e=>e.status===400);
  assert.deepEqual(validateCapture({...input,channels:[4,2,2]}).channels,[2,4]);
});
test('SDK captures all combinations in its own queue; direct RTSP keeps its narrower scope',()=>{
  const dvr={playback_mode:'netsdk_autoregister'};
  for(const mode of ['continuous','motion','ai'])for(const mediaType of ['photo','video','all']){
    const request={...validateCapture({...input,capture_mode:mode,media_type:mediaType}),end:'2026-09-10T03:10:00Z'};
    assert.equal(capturePlan(request,dvr).supported,true);
    assert.equal(capturePlan(request,{playback_mode:'rtsp_direct'}).supported,mode==='continuous'&&mediaType==='video');
  }
  assert.equal(capturePlan(validateCapture({...input,capture_mode:'continuous',media_type:'video'}),dvr).supported,true);
  assert.equal(capturePlan({...validateCapture(input),mode:'continuous',mediaType:'video',end:'2099-09-10T03:10:00Z'},dvr).supported,false);
});
test('capture screen keeps Sao Paulo dates even for clients in other timezones',()=>{
  assert.equal(saoPauloInput(new Date('2026-10-03T00:01:00Z')),'2026-10-02T21:01');
  const draft={unitId:'1',dvrId:'1',start:'2026-09-10T00:00',end:'2026-10-02T21:00',channels:[2],mode:'motion',mediaType:'photo'};
  assert.equal(buildCapturePayload(draft).start_at,'2026-09-10T03:00:00.000Z');
  assert.throws(()=>buildCapturePayload({...draft,start:'2026-02-30T12:00'}));
  assert.throws(()=>buildCapturePayload({...draft,channels:[]}));
  const rendered=captureForm({units:[{id:1,name:'Loja <1>',active:true}],dvrs:[{id:1,unit_id:1,name:'DVR',active:true}],cameras:[{id:1,dvr_id:1,channel:2,name:'Lateral',active:true}]},draft);
  assert.match(rendered,/Loja &lt;1&gt;/);assert.match(rendered,/value="2" checked/);assert.match(rendered,/Modo Contínuo/);assert.match(rendered,/Apenas movimento/);assert.match(rendered,/value="ai"/);assert.match(rendered,/Todos/);
  assert.match(captureList([{...input,unit_name:'Cerejeiras',dvr_name:'DVR',start_at:input.start_at,end_at:input.end_at,effective_status:'waiting_connector',effective_error:'<blocked>',channels:[]}]),/&lt;blocked&gt;/);
});

export async function checkCaptureDatabase(pool) {
  const sql=await readFile(new URL('../src/schema.sql',import.meta.url),'utf8');await pool.query(sql);await pool.query(sql);
  const unit=(await pool.query("INSERT INTO cop_units(name,code) VALUES('Capture test','CAPTEST') RETURNING id")).rows[0];
  const dvr=(await pool.query("INSERT INTO cop_dvrs(unit_id,name,model,channel_count,playback_mode,autoregister_id) VALUES($1,'DVR','MHDX 1104',4,'netsdk_autoregister','101') RETURNING id",[unit.id])).rows[0];
  const camera=(await pool.query(`INSERT INTO cop_cameras(dvr_id,channel,name,policy,device_config) VALUES($1,2,'Lateral','{"offsets":[0,5,15,30]}','{"frame_interval_seconds":3}') RETURNING id`,[dvr.id])).rows[0];
  const request={...input,unit_id:unit.id,dvr_id:dvr.id};
  await assert.rejects(()=>createCapture(pool,{...request,channels:[1]}),e=>e.status===400);
  await assert.rejects(()=>createCapture(pool,{...request,unit_id:9999}),e=>e.status===400);
  for(const capture_mode of ['continuous','motion','ai'])for(const media_type of ['photo','video','all']){
    const saved=await createCapture(pool,{...request,capture_mode,media_type});
    assert.equal(saved.status,'queued');assert.equal(saved.investigation_id,null);
  }
  assert.equal(await claimSdkJob(pool,{connector_name:'hostinger',device_ids:['101']}),null);
  assert.equal((await pool.query('SELECT count(*)::int n FROM cop_investigations')).rows[0].n,0);
  const continuous=await createCapture(pool,{...request,capture_mode:'continuous',media_type:'video',end_at:'2026-09-10T00:30:00-03:00'},'operator@example.com');
  assert.equal(continuous.status,'queued');assert.ok(continuous.investigation_id);
  const job=await claimSdkJob(pool,{connector_name:'hostinger',device_ids:['101']});
  assert.equal(job.investigation_id,continuous.investigation_id);assert.equal(job.channel,2);
  const rows=await listCaptures(pool);assert.equal(rows.length,10);
  const photo=rows.find(r=>r.media_type==='photo'&&r.capture_mode==='motion');
  assert.deepEqual(photo.channels[0].sampling_config.policy.offsets,[0,5,15,30]);
  assert.equal(photo.channels[0].sampling_config.device_config.frame_interval_seconds,3);
  assert.equal(photo.channels[0].camera_id,camera.id);
  assert.equal(rows.find(r=>r.id===continuous.id).effective_status,'retrieving');
  assert.equal((await pool.query('SELECT count(*)::int n FROM cop_media')).rows[0].n,0);
}
test('capture database preserves filters and sampling, routes only compatible video jobs', {skip:!process.env.TEST_DATABASE_URL},async()=>{
  const {default:pg}=await import('pg'),schema='capture_test_'+randomBytes(6).toString('hex');
  const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
  try{await checkCaptureDatabase(pool);}finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
