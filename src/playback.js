import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { decryptSecret } from './infrastructure.js';

function intelbrasTime(value) {
  const d=new Date(value);
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(d);
  const v=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  return `${v.year}_${v.month}_${v.day}_${v.hour}_${v.minute}_${v.second}`;
}
function secretFromRef(ref) {
  if(!ref)return null;
  const name=String(ref);
  if(!/^[A-Z][A-Z0-9_]{2,100}$/.test(name))return null;
  return process.env[name]||null;
}
function safeHost(value) {
  const host=String(value||'').trim();
  if(!host||host.length>253||/[\s/@]/.test(host))throw Error('Host de playback inválido.');
  return host;
}
function tcpReachable(host,port,timeoutMs=5000){
 return new Promise(resolve=>{
  const socket=net.createConnection({host,port});
  let done=false;
  const finish=v=>{if(done)return;done=true;socket.destroy();resolve(v);};
  socket.setTimeout(timeoutMs);
  socket.once('connect',()=>finish(true));socket.once('timeout',()=>finish(false));socket.once('error',()=>finish(false));
 });
}

export function buildPlaybackUrl({host,port=554,channel,start,end}) {
 return `rtsp://${safeHost(host)}:${Number(port)}/cam/playback?channel=${Number(channel)}&starttime=${intelbrasTime(start)}&endtime=${intelbrasTime(end)}`;
}

export async function retrieveIntelbrasRtsp({dvr,channel,start,end,logger=console,maxBytes=256*1024*1024}) {
 if(dvr.playback_mode!=='rtsp_direct')return {status:'waiting_connector',reason:'Playback direto não configurado para este DVR.'};
 const host=safeHost(dvr.playback_host||dvr.host),port=Number(dvr.playback_rtsp_port||dvr.rtsp_port||554);
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('Porta RTSP inválida.');
 if(!(await tcpReachable(host,port)))return {status:'waiting_connector',reason:`Endpoint RTSP ${host}:${port} não alcançável pelo COP.`};
 const username=String(dvr.playback_username||dvr.access_username||'');
 const password=dvr.access_password_cipher?decryptSecret(dvr.access_password_cipher):secretFromRef(dvr.playback_password_ref||dvr.secret_ref);
 if(!username||!password)throw Error('Credenciais de playback não configuradas.');
 const url=buildPlaybackUrl({host,port,channel,start,end});
 const dir=await mkdtemp(path.join(tmpdir(),'cop-playback-')),output=path.join(dir,`channel-${channel}.mp4`);
 try{
  const duration=Math.max(1,Math.min(7200,Math.ceil((new Date(end)-new Date(start))/1000)));
  await new Promise((resolve,reject)=>{
   const args=['-hide_banner','-loglevel','error','-rtsp_transport','tcp','-user',username,'-password',password,'-i',url,'-t',String(duration),'-map','0:v:0','-an','-c:v','copy','-movflags','+faststart','-y',output];
   const child=spawn('ffmpeg',args,{stdio:['ignore','ignore','pipe']});const errors=[];let done=false;
   const finish=e=>{if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve();};
   const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('Timeout recuperando playback histórico.'));},Math.min(900000,(duration+60)*1000));
   child.stderr.on('data',b=>{if(errors.reduce((n,x)=>n+x.length,0)<65536)errors.push(b);});
   child.on('error',finish);child.on('close',code=>code===0?finish():finish(Error('FFmpeg playback: '+Buffer.concat(errors).toString('utf8').trim().slice(-800))));
  });
  const data=await readFile(output);
  if(!data.length)throw Error('Playback histórico retornou arquivo vazio.');
  if(data.length>maxBytes)throw Error('Playback histórico excedeu limite de armazenamento temporário.');
  logger.log(`COP playback recuperado: dvr=${dvr.id} canal=${channel} bytes=${data.length}`);
  return {status:'ready',data,contentType:'video/mp4',filename:`investigacao-dvr${dvr.id}-ch${channel}-${intelbrasTime(start)}-${intelbrasTime(end)}.mp4`,url};
 }finally{await rm(dir,{recursive:true,force:true}).catch(()=>{});}
}

