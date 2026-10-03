import test from 'node:test';
import assert from 'node:assert/strict';
import {groupCapturePhotos,enqueueCaptureAnalysis} from '../src/capture-analysis.js';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
const sampling={offsets:[0,3,6,9],cooldown_seconds:60};
const photo=(seconds,id=seconds+1)=>({media_id:String(id),sample_at:new Date(Date.UTC(2026,8,10,3,0,seconds)),content_type:'image/jpeg',original_present:true,event_id:null});
test('groups original sample times across a 10-minute batch boundary',()=>{
 const rows=[photo(600),photo(591),photo(594),photo(597),photo(660),photo(663)];
 const groups=groupCapturePhotos(rows,sampling);
 assert.deepEqual(groups.map(g=>g.length),[4,2]);
 assert.equal(groups[0][0].sample_at.toISOString(),'2026-09-10T03:09:51.000Z');
});
test('rejects ambiguous sampling and unavailable originals instead of merging different events',()=>{
 assert.throws(()=>groupCapturePhotos([photo(0)],{...sampling,cooldown_seconds:15}));
 assert.throws(()=>groupCapturePhotos([photo(0),photo(2)],sampling));
 assert.throws(()=>groupCapturePhotos([photo(0),photo(0,2)],sampling));
 assert.throws(()=>groupCapturePhotos([{...photo(0),original_present:false}],sampling));
});
test('PostgreSQL queues once, preserves every original after analysis, and requires recorded consent to release',
 {skip:!process.env.TEST_DATABASE_URL},async()=>{
 const {default:pg}=await import('pg');const schema='capture_analysis_'+randomBytes(6).toString('hex');
 const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 try{await verifyAnalysisDatabase(pool);}finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
export async function verifyAnalysisDatabase(pool){
 await pool.query(await readFile(new URL('../src/schema.sql',import.meta.url),'utf8'));
 const u=(await pool.query("INSERT INTO cop_units(name,code) VALUES('Unit','CAPTURE') RETURNING id")).rows[0].id;
 const d=(await pool.query("INSERT INTO cop_dvrs(unit_id,name,model,channel_count) VALUES($1,'DVR','MHDX 1104',4) RETURNING id",[u])).rows[0].id;
 const c=(await pool.query("INSERT INTO cop_cameras(dvr_id,name,channel,policy) VALUES($1,'Camera',2,$2) RETURNING id",[d,sampling])).rows[0].id;
 const id=(await pool.query("INSERT INTO cop_capture_requests(unit_id,dvr_id,start_at,end_at,capture_mode,media_type,status,requested_by) VALUES($1,$2,'2026-09-10T03:00Z','2026-09-11T03:00Z','motion','photo','ready','test') RETURNING id",[u,d])).rows[0].id;
 await pool.query("INSERT INTO cop_capture_channels(capture_id,camera_id,channel,sampling_config,status,events_found) VALUES($1,$2,2,$3,'ready',2)",[id,c,{policy:sampling}]);
 for(const row of [photo(0),photo(3),photo(6),photo(9),photo(60),photo(63)]){
  const media=(await pool.query("INSERT INTO cop_media(unit_id,dvr_id,camera_id,source_path,filename,content_type,bytes,sha256,data,expires_at,recorded_at) VALUES($1,$2,$3,$4,'photo.jpg','image/jpeg',4,$4,$5,now()+interval '15 days',$6) RETURNING id",[u,d,c,String(row.media_id),Buffer.from([255,216,255,217]),row.sample_at])).rows[0].id;
  await pool.query('INSERT INTO cop_capture_media(capture_id,camera_id,sample_key,media_id,lease_token) VALUES($1,$2,$3,$4,$5)',[id,c,'image/jpeg:'+row.sample_at.toISOString(),media,'test']);
 }
 const queued=await enqueueCaptureAnalysis(pool,id,'Ricardo');assert.equal(queued.sequences,2);assert.equal(queued.preserved_originals,6);assert.equal(queued.new_jobs,2);
 assert.equal((await pool.query('SELECT analysis_protocol FROM cop_analysis_jobs ORDER BY id LIMIT 1')).rows[0].analysis_protocol.id,'fim_da_festa_v1');
 const repeated=await enqueueCaptureAnalysis(pool,id,'Ricardo');assert.equal(repeated.new_jobs,0);
 await pool.query("UPDATE cop_analysis_jobs SET status='done'");
 const media=(await pool.query('SELECT id FROM cop_media ORDER BY id LIMIT 1')).rows[0].id;
 await assert.rejects(pool.query('UPDATE cop_media SET data=NULL WHERE id=$1',[media]),/Original preservado/);
 await assert.rejects(pool.query('DELETE FROM cop_media WHERE id=$1',[media]),/Original preservado/);
 await assert.rejects(pool.query('UPDATE cop_media_preservation_holds SET released_at=now(),released_by=$2 WHERE media_id=$1',[media,'test']),/check constraint/);
 assert.equal((await pool.query('SELECT count(*)::int n FROM cop_media WHERE data IS NOT NULL')).rows[0].n,6);
 // Also preserve media whose analysis is cancelled or fails.
 await pool.query("UPDATE cop_analysis_jobs SET status='failed'");
 await assert.rejects(pool.query('UPDATE cop_media SET data=NULL WHERE id=$1',[media]),/Original preservado/);
 await pool.query('UPDATE cop_media_preservation_holds SET released_at=now(),released_by=$2,release_consent=$3 WHERE media_id=$1',[media,'Ricardo','Consentimento de teste para liberar este original.']);
 await pool.query('UPDATE cop_media SET data=NULL WHERE id=$1',[media]);
 assert.equal((await pool.query('SELECT data FROM cop_media WHERE id=$1',[media])).rows[0].data,null);
 return queued;
}
