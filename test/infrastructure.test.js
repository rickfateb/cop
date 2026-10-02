import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {encryptSecret,decryptSecret,validateDirectory,validateServer,createInfrastructureApi,deviceAssignment,publicServerSql,publicDvrSql} from '../src/infrastructure.js';
import {createSdkApi} from '../src/sdk-connector.js';
import {createInvestigation} from '../src/investigations.js';
process.env.COP_CREDENTIALS_KEY='ab'.repeat(32);
test('credentials encrypt with independent IVs and reject tampering; paths stay relative',()=>{
 const a=encryptSecret(' secret<&>\n'),b=encryptSecret(' secret<&>\n');assert.notEqual(a,b);assert.equal(decryptSecret(a),' secret<&>\n');assert.ok(!a.includes('secret'));assert.throws(()=>decryptSecret(a.slice(0,-5)+'AAAAA'));for(const p of ['../etc','/etc','a/../b','a//b','a b'])assert.throws(()=>validateDirectory(p));assert.equal(validateDirectory('unidades/cerejeiras'),'unidades/cerejeiras');assert.throws(()=>validateServer({name:'a',connector_name:'a',host:'1.1.1.1',storage_root:'/',active:true}));
});
test('server registration preserves secrets, restricts directories and isolates SDK tokens',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const {default:pg}=await import('pg'),schema='infra_'+randomBytes(6).toString('hex');
 const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});

 let output;const json=(res,status,value)=>{output={status,value};return output;},readJson=async req=>req.data;
 const api=createInfrastructureApi({pool,json,readJson}),sdk=createSdkApi({pool,json,readJson,token:'legacy'.repeat(8)});
 const call=async(fn,path,data={},headers={},method='POST')=>{output=null;await fn({method,headers,data},{},new URL(path,'https://cop.test'));return output;};
 try{
  const sql=await readFile(new URL('../src/schema.sql',import.meta.url),'utf8');await pool.query(sql);await pool.query(sql);
  const base={name:'Hostinger',connector_name:'hostinger',host:'2.25.64.178',storage_root:'/var/lib/cop-pilot/sdk-jobs',active:true,access_username:'root',access_password:'server pass',private_key:'key\nwith newlines'};
  const one=(await call(api,'/api/servers',base)).value.id;
  const secrets=(await call(api,`/api/servers/${one}/credentials`,{}, {},'GET')).value;assert.ok(secrets.token.length>=32);assert.equal(secrets.access_password,'server pass');
  await call(api,`/api/servers/${one}`,{...base,name:'Edited',token:'',access_password:'',private_key:''},{},'PUT');
  assert.equal((await call(api,`/api/servers/${one}/credentials`,{}, {},'GET')).value.access_password,'server pass');
  const two=(await call(api,'/api/servers',{...base,connector_name:'other'})).value.id;
  const dir=(await call(api,'/api/server-directories',{server_id:one,directory_name:'unidades/cerejeiras',friendly_name:'Cerejeiras'})).value.id;
  await assert.rejects(()=>deviceAssignment(pool,{server_id:two,server_directory_id:dir}));
  const listed=(await pool.query(publicServerSql)).rows;assert.ok(!JSON.stringify(listed).includes('server pass'));assert.equal(listed[0].token_cipher,undefined);
  const unit=(await pool.query("INSERT INTO cop_units(name,code) VALUES('Cerejeiras','CER') RETURNING id")).rows[0].id;
  const dvr=(await pool.query("INSERT INTO cop_dvrs(unit_id,name,model,channel_count,playback_mode,server_id,server_directory_id,autoregister_id,sdk_connector_name,access_username,access_password_cipher) VALUES($1,'DVR','MHDX 1104',4,'netsdk_autoregister',$2,$3,'101','hostinger','admin',$4) RETURNING id",[unit,one,dir,encryptSecret('dvr pass')])).rows[0].id;
  await pool.query("INSERT INTO cop_cameras(dvr_id,channel,name,policy) VALUES($1,1,'Canal 1','{}')",[dvr]);
  const publicDvr=(await pool.query(publicDvrSql)).rows[0].item;assert.equal(publicDvr.access_password_cipher,undefined);assert.equal(publicDvr.password_saved,true);
  const remote=(await call(sdk,'/api/sdk/config',{}, {'x-cop-sdk-token':secrets.token})).value;assert.equal(remote.devices[0].password,'dvr pass');
  const input={unit_id:unit,reference_at:'2026-10-01T13:00:00Z',window_before_seconds:0,window_after_seconds:30,reason:'test',channels:[1]};await createInvestigation(pool,input);
  const identity={connector_name:'hostinger',device_ids:['101']};
  assert.equal((await call(sdk,'/api/sdk/claim',identity,{'x-cop-sdk-token':'legacy'.repeat(8)})).value.job,null);
  const otherSecret=(await call(api,`/api/servers/${two}/credentials`,{},{},'GET')).value.token;
  await assert.rejects(()=>call(sdk,'/api/sdk/claim',identity,{'x-cop-sdk-token':otherSecret}),e=>e.status===403);
  const job=(await call(sdk,'/api/sdk/claim',identity,{'x-cop-sdk-token':secrets.token})).value.job;assert.equal(job.directory_name,'unidades/cerejeiras');
  await assert.rejects(()=>call(sdk,`/api/sdk/jobs/${job.investigation_id}/${job.camera_id}/renew`,{}, {'x-cop-sdk-token':otherSecret,'x-cop-lease-token':job.lease_token}),e=>e.status===403);
  await call(api,`/api/servers/${one}`,{...base,access_password:'',private_key:'',clear_password:true},{},'PUT');assert.equal((await call(api,`/api/servers/${one}/credentials`,{},{},'GET')).value.access_password,'');
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
