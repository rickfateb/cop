import { createHash } from 'node:crypto';

const TZ = 'America/Sao_Paulo';
const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const parts = date => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
export function archiveWindow(now=new Date()) { const p=parts(now); return Number(p.hour)>=1 && Number(p.hour)<6; }
export function recordingTime(source) {
 const m=String(source||'').match(/(20\d{2})[-_\/]?(\d{2})[-_\/]?(\d{2})[T _\/.-]+(\d{2})[:_.-]?(\d{2})[:_.-]?(\d{2})/);
 if(!m)return null;
 const value=`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}-03:00`, d=new Date(value);
 if(!Number.isFinite(+d))return null;
 const p=parts(d);
 return p.year===m[1]&&p.month===m[2]&&p.day===m[3]&&p.hour===m[4] ? d : null;
}
export function archivePath(recordedAt,dvrName) {
 if(!recordedAt||!Number.isFinite(+new Date(recordedAt)))throw Error('RECORDING_DATE_UNKNOWN');
 const p=parts(new Date(recordedAt));
 return [p.year,MONTHS[Number(p.month)-1],String(dvrName||'DVR').replace(/[\x00-\x1f/\\]/g,'_').slice(0,120),p.day];
}
export class DriveClient {
 constructor({clientId=process.env.COP_DRIVE_CLIENT_ID,clientSecret=process.env.COP_DRIVE_CLIENT_SECRET,refreshToken=process.env.COP_DRIVE_REFRESH_TOKEN,rootId=process.env.COP_DRIVE_ROOT_ID,fetchImpl=fetch}={}) {
  Object.assign(this,{clientId,clientSecret,refreshToken,rootId,fetchImpl});this.token=null;this.expiry=0;
 }
 get configured(){return Boolean(this.clientId&&this.clientSecret&&this.refreshToken&&this.rootId);}
 async accessToken(){
  if(!this.configured)throw Error('DRIVE_NOT_CONFIGURED');
  if(this.token&&Date.now()<this.expiry)return this.token;
  const r=await this.fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:this.clientId,client_secret:this.clientSecret,refresh_token:this.refreshToken,grant_type:'refresh_token'}),signal:AbortSignal.timeout(30000),redirect:'error'});
  if(!r.ok)throw Error(`DRIVE_AUTH_HTTP_${r.status}`);
  const data=await r.json();if(!data.access_token)throw Error('DRIVE_AUTH_INVALID');
  this.token=data.access_token;this.expiry=Date.now()+Math.max(0,Number(data.expires_in||3600)-60)*1000;return this.token;
 }
 async request(url,opts={}){
  const r=await this.fetchImpl(url,{...opts,headers:{...opts.headers,Authorization:`Bearer ${await this.accessToken()}`},signal:AbortSignal.timeout(120000),redirect:'error'});
  if(!r.ok){if(r.status===401)this.expiry=0;throw Object.assign(Error(`DRIVE_HTTP_${r.status}`),{httpStatus:r.status});}return r;
 }
 async metadata(id){return (await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size,md5Checksum,sha256Checksum,parents,trashed,webViewLink`)).json();}
 async generateId(){const d=await (await this.request('https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files')).json();if(!d.ids?.[0])throw Error('DRIVE_ID_INVALID');return d.ids[0];}
 async folder(name,parent){
  const escaped=v=>v.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  const q=`trashed=false and mimeType='application/vnd.google-apps.folder' and name='${escaped(name)}' and '${escaped(parent)}' in parents`;
  const result=await (await this.request('https://www.googleapis.com/drive/v3/files?'+new URLSearchParams({q,fields:'files(id)',pageSize:'2'}))).json();
  if(result.files?.length>1)throw Error('DRIVE_AMBIGUOUS_FOLDER');
  if(result.files?.length)return result.files[0].id;
  return (await (await this.request('https://www.googleapis.com/drive/v3/files?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,parents:[parent],mimeType:'application/vnd.google-apps.folder'})})).json()).id;
 }
 async destination(recordedAt,name){
  const root=await this.metadata(this.rootId);if(root.trashed||root.mimeType!=='application/vnd.google-apps.folder'||root.name!=='COP')throw Error('DRIVE_ROOT_INVALID');
  let id=this.rootId;for(const namePart of archivePath(recordedAt,name))id=await this.folder(namePart,id);return id;
 }
 async upload(row,parent){
  try{return await this.metadata(row.drive_file_id);}catch(e){if(e.httpStatus!==404)throw e;}
  const meta={id:row.drive_file_id,name:`${row.id}_${row.filename.replace(/[\x00-\x1f/\\]/g,'_').slice(0,180)}`,parents:[parent],appProperties:{cop_media_id:String(row.id),cop_sha256:row.sha256}};
  const init=await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id',{method:'POST',headers:{'Content-Type':'application/json','X-Upload-Content-Type':row.content_type,'X-Upload-Content-Length':String(row.data.length)},body:JSON.stringify(meta)});
  const location=init.headers.get('location');const url=new URL(location);
  if(url.protocol!=='https:'||url.hostname!=='www.googleapis.com'||!url.pathname.startsWith('/upload/drive/'))throw Error('DRIVE_UPLOAD_URL_INVALID');
  await this.request(location,{method:'PUT',headers:{'Content-Type':row.content_type,'Content-Length':String(row.data.length)},body:row.data});
  return this.metadata(row.drive_file_id);
 }
 async download(id){return Buffer.from(await (await this.request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`)).arrayBuffer());}
}
export function verifyArchive(row,metadata,parent){
 const md5=createHash('md5').update(row.data).digest('hex');
 if(metadata.trashed||metadata.id!==row.drive_file_id||Number(metadata.size)!==row.data.length||metadata.md5Checksum!==md5||!metadata.parents?.includes(parent))throw Error('DRIVE_VERIFICATION_FAILED');
 if(createHash('sha256').update(row.data).digest('hex')!==row.sha256)throw Error('LOCAL_CHECKSUM_MISMATCH');
 return md5;
}
export function startDriveArchive({pool,drive=new DriveClient(),now=()=>new Date(),logger=console}={}){
 const state={configured:drive.configured,window:'01:00–06:00',timezone:TZ,retention_days:15,last_run_at:null,last_error:null,archived:0,released:0};
 let stopped=false,running=false;
 async function tick(){
  if(stopped||running||!drive.configured||!archiveWindow(now()))return;
  running=true;let db,locked=false;
  try{
   db=await pool.connect();locked=(await db.query('SELECT pg_try_advisory_lock(724061501) AS locked')).rows[0].locked;if(!locked)return;
   state.last_run_at=now().toISOString();
   // Backlog includes prior days, so missed nights and retroactive recordings are retried.
   const ids=(await db.query(`SELECT id FROM cop_media WHERE data IS NOT NULL AND drive_verified_at IS NULL
    AND (received_at AT TIME ZONE 'America/Sao_Paulo')::date < ($1::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date
    AND (drive_next_attempt_at IS NULL OR drive_next_attempt_at<=$1) ORDER BY received_at,id LIMIT 20`,[now()])).rows;
   for(const {id} of ids){
    if(stopped||!archiveWindow(now()))break;
    try{
     const row=(await db.query(`SELECT m.*,d.name AS dvr_name FROM cop_media m JOIN cop_dvrs d ON d.id=m.dvr_id WHERE m.id=$1`,[id])).rows[0];
     const recorded=row.recorded_at||recordingTime(row.source_path);
     if(!recorded)throw Error('RECORDING_DATE_UNKNOWN');
     const parent=await drive.destination(recorded,row.dvr_name);
     if(!row.drive_file_id){row.drive_file_id=await drive.generateId();await db.query('UPDATE cop_media SET drive_file_id=$2,recorded_at=$3 WHERE id=$1',[id,row.drive_file_id,recorded]);}
     const metadata=await drive.upload(row,parent),md5=verifyArchive(row,metadata,parent);
     await db.query(`UPDATE cop_media SET drive_verified_at=now(),drive_md5=$2,drive_folder_id=$3,drive_error=NULL,drive_next_attempt_at=NULL WHERE id=$1`,[id,md5,parent]);state.archived++;
    }catch(e){state.last_error=e.httpStatus?`DRIVE_HTTP_${e.httpStatus}`:e.message==='RECORDING_DATE_UNKNOWN'?e.message:'ARCHIVE_FAILED';await db.query("UPDATE cop_media SET drive_error=$2,drive_next_attempt_at=now()+interval '15 minutes' WHERE id=$1",[id,state.last_error]);logger.error('COP Drive: '+state.last_error);}
   }
   const expired=(await db.query(`SELECT id,drive_file_id,drive_md5,drive_folder_id,bytes FROM cop_media m
    WHERE data IS NOT NULL AND drive_verified_at IS NOT NULL AND received_at<=$1::timestamptz-interval '15 days'
    AND NOT EXISTS(SELECT 1 FROM cop_analysis_jobs j WHERE j.event_id=m.event_id AND j.status IN ('pending','running')) LIMIT 20`,[now()])).rows;
   for(const row of expired){
    if(stopped||!archiveWindow(now()))break;
    // Revalidate remote copy immediately before releasing the local payload.
    const meta=await drive.metadata(row.drive_file_id);
    if(!meta.trashed&&Number(meta.size)===Number(row.bytes)&&meta.md5Checksum===row.drive_md5&&meta.parents?.includes(row.drive_folder_id)){
     const released=await db.query('UPDATE cop_media SET data=NULL,local_released_at=now() WHERE id=$1 AND drive_verified_at IS NOT NULL AND data IS NOT NULL',[row.id]);state.released+=released.rowCount;
    }
   }
  }catch(e){state.last_error=e.httpStatus?`DRIVE_HTTP_${e.httpStatus}`:'ARCHIVE_UNAVAILABLE';logger.error('COP Drive: '+state.last_error);}
  finally{if(locked)await db.query('SELECT pg_advisory_unlock(724061501)').catch(()=>{});db?.release();running=false;}
 }
 const timer=setInterval(()=>tick().catch(()=>{}),60000);timer.unref();tick().catch(()=>{});
 return {state,drive,tick,stop(){stopped=true;clearInterval(timer);}};
}
