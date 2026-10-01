import net from 'node:net';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';

const root = process.env.FTP_ROOT || '/srv/ftp';
const user = process.env.FTP_USER || 'cop_ftp';
const password = process.env.FTP_PASSWORD || '';
const controlPort = Number(process.env.FTP_CONTROL_PORT || 2121);
const dataListenPort = Number(process.env.FTP_DATA_LISTEN_PORT || 21000);
const publicDataHost = process.env.FTP_PUBLIC_DATA_HOST || '';
const publicDataPort = Number(process.env.FTP_PUBLIC_DATA_PORT || 0);
const copBaseUrl = process.env.COP_BASE_URL || 'https://cop-web-ingest-production.up.railway.app';
const gatewayToken = process.env.COP_GATEWAY_TOKEN || '';
const allowedKeys = new Set(String(process.env.FTP_INGEST_KEYS || '').split(',').map(v => v.trim()).filter(Boolean));
const maxUploadBytes = Number(process.env.FTP_MAX_UPLOAD_BYTES || 268435456);

if (!password || !publicDataHost || !publicDataPort || !gatewayToken) {
  console.error('Configure FTP_PASSWORD, FTP_PUBLIC_DATA_HOST, FTP_PUBLIC_DATA_PORT e COP_GATEWAY_TOKEN.');
  process.exit(1);
}

await fs.mkdir(root, { recursive: true });
for (const key of allowedKeys) await fs.mkdir(path.join(root, key), { recursive: true });

const resolved = await dns.lookup(publicDataHost, { family: 4 });
const pasvIp = resolved.address;

function reply(socket, code, message='') {
  socket.write(String(code) + (message ? ' ' + message : '') + '\r\n');
}
function normalizeRel(cwd, value='') {
  const raw = String(value).trim().replaceAll('\\', '/');
  const joined = raw.startsWith('/') ? raw : path.posix.join('/', cwd, raw);
  const clean = path.posix.normalize(joined);
  if (clean.includes('..')) throw Error('Path inválido');
  return clean.replace(/^\/+/, '');
}
function absolute(rel) {
  const target = path.resolve(root, rel);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) throw Error('Path fora da raiz');
  return target;
}
async function existsDir(target) {
  try { return (await fs.stat(target)).isDirectory(); } catch { return false; }
}
async function ensureParent(target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
}
function formatList(name, st) {
  const type = st.isDirectory() ? 'd' : '-';
  const size = st.isDirectory() ? 0 : st.size;
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][st.mtime.getUTCMonth()];
  const day = String(st.mtime.getUTCDate()).padStart(2,' ');
  const hh = String(st.mtime.getUTCHours()).padStart(2,'0');
  const mm = String(st.mtime.getUTCMinutes()).padStart(2,'0');
  return `${type}rw-r----- 1 ftp ftp ${String(size).padStart(10,' ')} ${month} ${day} ${hh}:${mm} ${name}\r\n`;
}

const waiting = [];
function armData(session) {
  session.dataSocket?.destroy();
  session.dataSocket = null;
  session.dataPromise = new Promise((resolve, reject) => {
    session.dataResolve = resolve;
    session.dataReject = reject;
    session.dataTimer = setTimeout(() => {
      const i = waiting.indexOf(session); if (i >= 0) waiting.splice(i,1);
      reject(Error('timeout data'));
    }, 20000);
  });
  waiting.push(session);
}
function cleanupData(session) {
  clearTimeout(session.dataTimer);
  const i = waiting.indexOf(session); if (i >= 0) waiting.splice(i,1);
  session.dataResolve = null;
  session.dataReject = null;
}
async function getData(session) {
  if (session.dataSocket && !session.dataSocket.destroyed) return session.dataSocket;
  if (!session.dataPromise) throw Error('PASV não iniciado');
  return session.dataPromise;
}

const dataServer = net.createServer(sock => {
  const session = waiting.shift();
  if (!session) { sock.destroy(); return; }
  clearTimeout(session.dataTimer);
  session.dataSocket = sock;
  session.dataResolve?.(sock);
});
dataServer.listen(dataListenPort, '0.0.0.0', () => {
  console.log(`FTP data interno pronto em :${dataListenPort}; PASV público ${publicDataHost}:${publicDataPort} (${pasvIp})`);
});

async function forwardFile(file, ingestKey, sourcePath, size) {
  const target = new URL('/api/ingest/external/' + encodeURIComponent(ingestKey), copBaseUrl);
  const transport = target.protocol === 'https:' ? https : http;
  await new Promise((resolve, reject) => {
    const req = transport.request(target, {
      method:'POST',
      headers:{
        'x-cop-gateway-token': gatewayToken,
        'x-source-path': sourcePath,
        'content-type':'application/octet-stream',
        'content-length':String(size)
      }
    }, res => {
      let body='';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(Error('COP ' + res.statusCode + ': ' + body.slice(0,200))));
    });
    req.on('error', reject);
    createReadStream(file).on('error', reject).pipe(req);
  });
}
async function scanForward() {
  async function walk(dir, out=[]) {
    let items=[]; try { items=await fs.readdir(dir,{withFileTypes:true}); } catch { return out; }
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const full=path.join(dir,item.name);
      if (item.isDirectory()) await walk(full,out); else if (item.isFile()) out.push(full);
    }
    return out;
  }
  for (const file of await walk(root)) {
    const rel=path.relative(root,file).split(path.sep).join('/');
    const parts=rel.split('/').filter(Boolean);
    const ingestKey=parts.shift();
    if (!ingestKey || (allowedKeys.size && !allowedKeys.has(ingestKey))) continue;
    const sourcePath=parts.join('/') || path.basename(file);
    const st=await fs.stat(file);
    if (Date.now()-st.mtimeMs < 4000 || st.size===0) continue;
    try {
      await forwardFile(file, ingestKey, sourcePath, st.size);
      await fs.unlink(file);
      console.log('FTP->COP OK', ingestKey, sourcePath, st.size);
    } catch (e) {
      console.error('FTP->COP falhou', rel, e.message);
    }
  }
}
setInterval(() => scanForward().catch(e => console.error('scan',e.message)), 5000);

const controlServer = net.createServer(socket => {
  const session = { cwd:'', authed:false, userOk:false, dataSocket:null, dataPromise:null, chain:Promise.resolve() };
  socket.setEncoding('utf8');
  socket.setTimeout(120000);
  reply(socket,220,'COP FTP Gateway ready');
  let buffer='';

  async function handle(line) {
    if (!line) return;
    const space=line.indexOf(' ');
    const cmd=(space<0?line:line.slice(0,space)).toUpperCase();
    const arg=space<0?'':line.slice(space+1).trim();
    console.log('FTP', cmd, cmd==='PASS'?'***':arg);

    if (cmd==='USER') { session.userOk = arg===user; return reply(socket,331,'Password required'); }
    if (cmd==='PASS') {
      session.authed = session.userOk && arg===password;
      return reply(socket, session.authed?230:530, session.authed?'Login successful':'Login incorrect');
    }
    if (cmd==='QUIT') { reply(socket,221,'Bye'); return socket.end(); }
    if (!session.authed) return reply(socket,530,'Please login');
    if (cmd==='SYST') return reply(socket,215,'UNIX Type: L8');
    if (cmd==='FEAT') { socket.write('211-Features\r\n UTF8\r\n SIZE\r\n MDTM\r\n PASV\r\n211 End\r\n'); return; }
    if (cmd==='OPTS') return reply(socket,200,'UTF8 enabled');
    if (cmd==='NOOP') return reply(socket,200,'OK');
    if (cmd==='TYPE') return reply(socket,200,'Type set');
    if (cmd==='MODE' || cmd==='STRU') return reply(socket,200,'OK');
    if (cmd==='PWD' || cmd==='XPWD') return reply(socket,257,'"/' + session.cwd + '"');
    if (cmd==='CWD' || cmd==='XCWD') {
      const rel=normalizeRel(session.cwd,arg);
      const target=absolute(rel);
      if (!(await existsDir(target))) await fs.mkdir(target,{recursive:true});
      session.cwd=rel; return reply(socket,250,'Directory changed');
    }
    if (cmd==='CDUP') {
      session.cwd=path.posix.dirname('/'+session.cwd).replace(/^\/+/, '');
      return reply(socket,250,'Directory changed');
    }
    if (cmd==='MKD' || cmd==='XMKD') {
      const rel=normalizeRel(session.cwd,arg); await fs.mkdir(absolute(rel),{recursive:true});
      return reply(socket,257,'"/'+rel+'" created');
    }
    if (cmd==='RMD' || cmd==='XRMD') {
      const rel=normalizeRel(session.cwd,arg); await fs.rm(absolute(rel),{recursive:true,force:true}); return reply(socket,250,'Removed');
    }
    if (cmd==='DELE') {
      const rel=normalizeRel(session.cwd,arg); await fs.unlink(absolute(rel)); return reply(socket,250,'Deleted');
    }
    if (cmd==='SIZE') {
      try { const st=await fs.stat(absolute(normalizeRel(session.cwd,arg))); return reply(socket,213,String(st.size)); }
      catch { return reply(socket,550,'Not found'); }
    }
    if (cmd==='MDTM') {
      try { const st=await fs.stat(absolute(normalizeRel(session.cwd,arg))); const d=st.mtime.toISOString().replace(/[-:T.Z]/g,'').slice(0,14); return reply(socket,213,d); }
      catch { return reply(socket,550,'Not found'); }
    }
    if (cmd==='EPSV') return reply(socket,502,'Use PASV');
    if (cmd==='PORT' || cmd==='EPRT') return reply(socket,502,'Active mode disabled');
    if (cmd==='PASV') {
      armData(session);
      const oct=pasvIp.split('.').map(Number), p1=Math.floor(publicDataPort/256), p2=publicDataPort%256;
      return reply(socket,227,`Entering Passive Mode (${oct.join(',')},${p1},${p2})`);
    }
    if (cmd==='LIST' || cmd==='NLST') {
      reply(socket,150,'Opening data connection');
      try {
        const ds=await getData(session);
        const rel=normalizeRel(session.cwd,arg && !arg.startsWith('-') ? arg : '');
        const target=absolute(rel);
        const names=await fs.readdir(target);
        for (const name of names) {
          if (cmd==='NLST') ds.write(name+'\r\n');
          else ds.write(formatList(name,await fs.stat(path.join(target,name))));
        }
        ds.end(); cleanupData(session); return reply(socket,226,'Transfer complete');
      } catch(e) { cleanupData(session); return reply(socket,425,'Data connection failed'); }
    }
    if (cmd==='STOR' || cmd==='APPE') {
      const rel=normalizeRel(session.cwd,arg);
      const target=absolute(rel); await ensureParent(target);
      reply(socket,150,'Opening binary data connection');
      try {
        const ds=await getData(session);
        let total=0;
        const fh=await fs.open(target, cmd==='APPE'?'a':'w',0o640);
        for await (const chunk of ds) {
          total += chunk.length;
          if (total > maxUploadBytes) throw Error('upload too large');
          await fh.write(chunk);
        }
        await fh.close(); cleanupData(session);
        console.log('FTP armazenou', rel, total, 'bytes');
        return reply(socket,226,'Transfer complete');
      } catch(e) {
        cleanupData(session);
        try { await fs.unlink(target); } catch {}
        console.error('STOR falhou', rel, e.message);
        return reply(socket,426,'Transfer aborted');
      }
    }
    if (cmd==='REST') return reply(socket,350,'Restart position accepted');
    return reply(socket,502,'Command not implemented');
  }

  socket.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const idx=buffer.indexOf('\n'); if (idx<0) break;
      const line=buffer.slice(0,idx).replace(/\r$/,''); buffer=buffer.slice(idx+1);
      session.chain=session.chain.then(()=>handle(line)).catch(e=>{ console.error('FTP command error',e.message); reply(socket,550,'Command failed'); });
    }
  });
  socket.on('timeout',()=>socket.end());
  socket.on('close',()=>cleanupData(session));
  socket.on('error',()=>cleanupData(session));
});

function makeLineReader(socket) {
  socket.setEncoding('utf8');
  let buffer = '';
  const queue = [];
  const waiters = [];
  socket.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const i = buffer.indexOf('\n');
      if (i < 0) break;
      const line = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      if (waiters.length) waiters.shift().resolve(line);
      else queue.push(line);
    }
  });
  socket.on('error', error => {
    while (waiters.length) waiters.shift().reject(error);
  });
  return () => new Promise((resolve, reject) => {
    if (queue.length) return resolve(queue.shift());
    const timer = setTimeout(() => reject(Error('timeout resposta FTP')), 10000);
    waiters.push({
      resolve: line => { clearTimeout(timer); resolve(line); },
      reject: error => { clearTimeout(timer); reject(error); }
    });
  });
}

async function runFtpSelfTest() {
  const host = process.env.RAILWAY_TCP_PROXY_DOMAIN;
  const port = Number(process.env.RAILWAY_TCP_PROXY_PORT || 0);
  if (!host || !port) throw Error('proxy público de controle indisponível');
  const sock = net.createConnection({ host, port });
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
    setTimeout(() => reject(Error('timeout conexão controle')), 10000);
  });
  const next = makeLineReader(sock);
  const expect = async (prefixes) => {
    const line = await next();
    if (!prefixes.some(p => line.startsWith(p))) throw Error('resposta inesperada: ' + line);
    return line;
  };
  await expect(['220']);
  sock.write('USER ' + user + '\r\n'); await expect(['331','230']);
  sock.write('PASS ' + password + '\r\n'); await expect(['230']);
  sock.write('PWD\r\n'); await expect(['257']);
  sock.write('PASV\r\n');
  const pasv = await expect(['227']);
  const m = pasv.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
  if (!m) throw Error('PASV inválido: ' + pasv);
  const dataHost = [m[1],m[2],m[3],m[4]].join('.');
  const dataPort = Number(m[5]) * 256 + Number(m[6]);
  const ds = net.createConnection({ host:dataHost, port:dataPort });
  await new Promise((resolve, reject) => {
    ds.once('connect', resolve);
    ds.once('error', reject);
    setTimeout(() => reject(Error('timeout conexão PASV')), 10000);
  });
  let listBytes = 0;
  ds.on('data', chunk => { listBytes += chunk.length; });
  const dataClosed = new Promise((resolve, reject) => {
    ds.once('close', resolve);
    ds.once('error', reject);
  });
  sock.write('LIST\r\n'); await expect(['150']);
  await dataClosed;
  await expect(['226']);
  sock.write('QUIT\r\n'); await expect(['221']);
  sock.end();
  console.log(`FTP SELFTEST OK control=${host}:${port} pasv=${dataHost}:${dataPort} list_bytes=${listBytes}`);
}

controlServer.listen(controlPort,'0.0.0.0',()=>{
  console.log(`COP FTP control pronto em :${controlPort}; usuário=${user}`);
  console.log(`Railway TCP control: ${process.env.RAILWAY_TCP_PROXY_DOMAIN || 'sem-host'}:${process.env.RAILWAY_TCP_PROXY_PORT || 'sem-port'}`);
  if (process.env.FTP_SELFTEST === 'true') setTimeout(() => runFtpSelfTest().catch(error => console.error('FTP SELFTEST FALHOU:', error.message)), 3000);
});
