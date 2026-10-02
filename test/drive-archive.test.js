import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {archiveWindow,archivePath,recordingTime,verifyArchive,startDriveArchive,DriveClient} from '../src/drive-archive.js';

test('archive window uses Sao Paulo and excludes both daytime and 06:00',()=>{
 for(const [time,result] of [['03:59:59',false],['04:00:00',true],['08:59:59',true],['09:00:00',false],['16:00:00',false]])assert.equal(archiveWindow(new Date('2026-10-03T'+time+'Z')),result);
});
test('retroactive footage is filed by recording date, including midnight boundaries',()=>{
 assert.deepEqual(archivePath('2026-10-02T02:59:59Z','Cerejeiras'),['2026','Outubro','Cerejeiras','01']);
 assert.deepEqual(archivePath('2027-01-01T03:00:00Z','The Wall'),['2027','Janeiro','The Wall','01']);
 assert.equal(recordingTime('Cerejeiras/2026-10-01/12_39_00.jpg').toISOString(),'2026-10-01T15:39:00.000Z');
 assert.equal(recordingTime('2026-02-30_12-00-00.jpg'),null);
 assert.equal(recordingTime('investigacao-1-canal-2.mp4'),null);
 assert.throws(()=>archivePath(null,'DVR'));
});
test('archive verification requires matching identity, parent, size, checksums and non-trashed file',()=>{
 const data=Buffer.from('actual video bytes'),sha256=createHash('sha256').update(data).digest('hex'),md5=createHash('md5').update(data).digest('hex');
 const row={data,sha256,drive_file_id:'persistent-id'},meta={id:'persistent-id',size:String(data.length),md5Checksum:md5,parents:['day']};
 assert.equal(verifyArchive(row,meta,'day'),md5);
 for(const change of [{trashed:true},{size:'0'},{md5Checksum:'bad'},{parents:['other']},{id:'other'}])assert.throws(()=>verifyArchive(row,{...meta,...change},'day'));
 assert.throws(()=>verifyArchive({...row,sha256:'bad'},meta,'day'));
});
test('unconfigured worker does not upload or purge local files',async()=>{
 const worker=startDriveArchive({pool:{connect(){throw Error('must not connect');}},drive:{configured:false},now:()=>new Date('2026-10-03T04:00:00Z')});
 await worker.tick();worker.stop();assert.equal(worker.state.released,0);
});
test('a retry reuses the persisted file ID when the first upload already completed',async()=>{
 let calls=0;const drive=new DriveClient({clientId:'id',clientSecret:'secret',refreshToken:'refresh',rootId:'root'});
 drive.metadata=async id=>{calls++;return {id};};drive.request=()=>{throw Error('must not upload again');};
 assert.deepEqual(await drive.upload({drive_file_id:'stable'},'day'),{id:'stable'});assert.equal(calls,1);
});
test('PostgreSQL archive preserves local bytes until verification, then releases after 15 days without breaking references',
 {skip:!process.env.TEST_DATABASE_URL},async()=>{
 const {default:pg}=await import('pg');const schema='archive_test_'+randomBytes(6).toString('hex');
 const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});let worker;
 try{
  await pool.query(await readFile(new URL('../src/schema.sql',import.meta.url),'utf8'));
  const u=(await pool.query("INSERT INTO cop_units(name,code) VALUES('Unit','ARCHIVE') RETURNING id")).rows[0].id;
  const d=(await pool.query("INSERT INTO cop_dvrs(unit_id,name,model,channel_count) VALUES($1,'Cerejeiras','MHDX 1104',4) RETURNING id",[u])).rows[0].id;
  const data=Buffer.from('persistent footage'),sha=createHash('sha256').update(data).digest('hex'),md5=createHash('md5').update(data).digest('hex');
  const id=(await pool.query(`INSERT INTO cop_media(unit_id,dvr_id,source_path,filename,content_type,bytes,sha256,data,received_at,expires_at,recorded_at)
   VALUES($1,$2,'investigation/1/video','video.mp4','video/mp4',$3,$4,$5,'2026-10-02T12:00Z','2026-10-17T12:00Z','2026-10-01T15:39Z') RETURNING id`,[u,d,data.length,sha,data])).rows[0].id;
  let clock=new Date('2026-10-03T16:00Z'),fail=true,trashed=false;
  const fakeDrive={configured:true,destination:async recorded=>{assert.equal(new Date(recorded).toISOString(),'2026-10-01T15:39:00.000Z');return 'day';},generateId:async()=> 'stable',upload:async()=>({id:'stable',size:String(data.length),md5Checksum:fail?'bad':md5,parents:['day']}),metadata:async()=>({id:'stable',size:String(data.length),md5Checksum:md5,parents:['day'],trashed})};
  // Start outside window so tests explicitly control ticks.
  worker=startDriveArchive({pool,drive:fakeDrive,now:()=>clock,logger:{error(){}}});
  clock=new Date('2026-10-03T04:00Z');await worker.tick();
  assert.ok((await pool.query('SELECT data FROM cop_media WHERE id=$1',[id])).rows[0].data);
  fail=false;clock=new Date('2026-10-03T05:00Z');await worker.tick();
  let row=(await pool.query('SELECT * FROM cop_media WHERE id=$1',[id])).rows[0];assert.ok(row.drive_verified_at);assert.ok(row.data);assert.equal(row.drive_file_id,'stable');
  clock=new Date('2026-10-18T04:00Z');trashed=true;await worker.tick();assert.ok((await pool.query('SELECT data FROM cop_media WHERE id=$1',[id])).rows[0].data);
  trashed=false;await worker.tick();row=(await pool.query('SELECT * FROM cop_media WHERE id=$1',[id])).rows[0];assert.equal(row.data,null);assert.ok(row.local_released_at);assert.equal(row.sha256,sha);
 }finally{worker?.stop();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
