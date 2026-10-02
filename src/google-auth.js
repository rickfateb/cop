import {createHash,createPublicKey,randomBytes,timingSafeEqual,verify} from 'node:crypto';
const fail=(message,status=401)=>Object.assign(Error(message),{status});
const hash=v=>createHash('sha256').update(v).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const SESSION='__Host-cop-session',NONCE='__Host-cop-login';
export function cookies(req){const result={};for(const item of String(req.headers.cookie||'').split(';')){const index=item.indexOf('=');if(index>0){const name=item.slice(0,index).trim();if(result[name]!==undefined)return {};result[name]=item.slice(index+1).trim();}}return result;}
function setCookie(res,name,value,seconds){const existing=res.getHeader('Set-Cookie')||[];res.setHeader('Set-Cookie',[...(Array.isArray(existing)?existing:[existing]),`${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`]);}
export function verifyGoogleJwt(token,{clientId,nonce,keys,now=Date.now()}){
 try{
  if(typeof token!=='string'||token.length>16384)throw Error();const pieces=token.split('.');if(pieces.length!==3||pieces.some(p=>!p||!/^[A-Za-z0-9_-]+$/.test(p)))throw Error();
  const header=JSON.parse(Buffer.from(pieces[0],'base64url')),claims=JSON.parse(Buffer.from(pieces[1],'base64url'));
  if(header.alg!=='RS256'||typeof header.kid!=='string')throw Error();const jwk=keys.find(k=>k.kid===header.kid&&k.kty==='RSA'&&(!k.use||k.use==='sig')&&(!k.alg||k.alg==='RS256'));if(!jwk)throw Error();
  if(!verify('RSA-SHA256',Buffer.from(pieces[0]+'.'+pieces[1]),createPublicKey({key:jwk,format:'jwk'}),Buffer.from(pieces[2],'base64url')))throw Error();
  if(!clientId||claims.aud!==clientId||!['accounts.google.com','https://accounts.google.com'].includes(claims.iss)||!Number.isFinite(claims.exp)||claims.exp*1000<=now||!Number.isFinite(claims.iat)||claims.iat*1000>now+300000||claims.nbf!==undefined&&(!Number.isFinite(claims.nbf)||claims.nbf*1000>now+300000)||!equal(claims.nonce,nonce)||!nonce||![true,'true'].includes(claims.email_verified)||typeof claims.email!=='string'||claims.email.length>254||!/^\S+@\S+\.\S+$/.test(claims.email))throw Error();
  if(typeof claims.sub!=='string'||!claims.sub||claims.sub.length>255)throw Error();
  return {sub:claims.sub,email:claims.email.toLowerCase(),name:String(claims.name||claims.email).slice(0,160)};
 }catch{throw fail('Login Google inválido ou expirado. Tente entrar novamente.');}
}
export function createGoogleAuth({pool,json,readJson,clientId=process.env.GOOGLE_CLIENT_ID,allowedEmails=process.env.COP_GOOGLE_ALLOWED_EMAILS||'',publicUrl=process.env.COP_PUBLIC_BASE_URL||'https://cop.cobile.com.br',fetchKeys}={}){
 const allowed=new Set(allowedEmails.split(/[\s,;]+/).filter(Boolean).map(s=>s.toLowerCase()));const origin=new URL(publicUrl).origin;let cache=[],expires=0,fetchedAt=0,pending;
 const loadKeys=fetchKeys||async function(token){
  let kid;try{kid=JSON.parse(Buffer.from(token.split('.')[0],'base64url')).kid;}catch{throw fail('Login Google inválido.');}
  const missing=!cache.some(k=>k.kid===kid);if(Date.now()<expires&&(!missing||Date.now()-fetchedAt<60000))return cache;
  if(!pending)pending=(async()=>{try{const response=await fetch('https://www.googleapis.com/oauth2/v3/certs',{signal:AbortSignal.timeout(10000),redirect:'error'});if(!response.ok)throw Error();const raw=await response.text();if(raw.length>65536)throw Error();const data=JSON.parse(raw);if(!Array.isArray(data.keys)||data.keys.length>20)throw Error();cache=data.keys;fetchedAt=Date.now();expires=fetchedAt+Math.min(3600,Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1]||300))*1000;return cache;}catch{throw fail('Google indisponível. Tente novamente em instantes.',503);}finally{pending=null;}})();return pending;
 };
 const ensureOrigin=req=>{if(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')throw fail('Origem da solicitação inválida.',403);};
 async function user(req){const value=cookies(req)[SESSION];if(!/^[a-f0-9]{64}$/.test(value||''))return null;const row=(await pool.query('SELECT email,name FROM cop_user_sessions WHERE token_hash=$1 AND expires_at>now()',[hash(value)])).rows[0];if(!row||!allowed.has(row.email))return null;return {...row,role:'ADMINISTRADOR'};}
 return {user,ensureOrigin,async handle(req,res,url){
  if(!url.pathname.startsWith('/api/auth/'))return false;
  if(url.pathname==='/api/auth/session'&&req.method==='GET'){
   const current=await user(req);if(current){json(res,200,{user:current});return true;}
   if(!clientId||!allowed.size){json(res,503,{error:'Login Google ainda não configurado.'});return true;}
   if(req.headers['sec-fetch-site']==='cross-site')throw fail('Origem inválida.',403);
   const nonce=randomBytes(32).toString('hex');const old=cookies(req)[NONCE];
   await pool.query('DELETE FROM cop_login_nonces WHERE expires_at<now() OR nonce_hash=$1',[hash(old||'')]);
   await pool.query("INSERT INTO cop_login_nonces(nonce_hash,expires_at) VALUES($1,now()+interval '10 minutes')",[hash(nonce)]);
   setCookie(res,NONCE,nonce,600);json(res,200,{user:null,client_id:clientId,nonce});return true;
  }
  if(url.pathname==='/api/auth/google'&&req.method==='POST'){
   ensureOrigin(req);const nonce=cookies(req)[NONCE];if(!/^[a-f0-9]{64}$/.test(nonce||''))throw fail('Reabra a página para entrar com Google.');
   const input=await readJson(req),keys=await loadKeys(input.credential||'');const identity=verifyGoogleJwt(input.credential,{clientId,nonce,keys});
   if(!allowed.has(identity.email))throw fail('Esta conta Google não está autorizada a acessar o COP.',403);
   const client=await pool.connect();const session=randomBytes(32).toString('hex');try{await client.query('BEGIN');const used=await client.query('DELETE FROM cop_login_nonces WHERE nonce_hash=$1 AND expires_at>now() RETURNING nonce_hash',[hash(nonce)]);if(!used.rowCount)throw fail('Login já utilizado ou expirado. Reabra a página.');await client.query('DELETE FROM cop_user_sessions WHERE expires_at<now()');const old=cookies(req)[SESSION];if(old)await client.query('DELETE FROM cop_user_sessions WHERE token_hash=$1',[hash(old)]);await client.query("INSERT INTO cop_user_sessions(token_hash,email,name,google_sub,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 days')",[hash(session),identity.email,identity.name,identity.sub]);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
   setCookie(res,NONCE,'',0);setCookie(res,SESSION,session,30*86400);json(res,200,{user:{...identity,role:'ADMINISTRADOR'}});return true;
  }
  if(url.pathname==='/api/auth/logout'&&req.method==='POST'){
   ensureOrigin(req);const value=cookies(req)[SESSION];if(value)await pool.query('DELETE FROM cop_user_sessions WHERE token_hash=$1',[hash(value)]);const nonce=cookies(req)[NONCE];if(nonce)await pool.query('DELETE FROM cop_login_nonces WHERE nonce_hash=$1',[hash(nonce)]);setCookie(res,SESSION,'',0);setCookie(res,NONCE,'',0);json(res,200,{ok:true});return true;
  }
  json(res,404,{error:'Rota de autenticação não encontrada.'});return true;
 }};
}
