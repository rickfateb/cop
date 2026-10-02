import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {verifyGoogleJwt,createGoogleAuth,cookies} from '../src/google-auth.js';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const jwk={...publicKey.export({format:'jwk'}),kid:'test',use:'sig',alg:'RS256'};
const now=Date.now(),base={sub:'123456',aud:'cop-client',iss:'https://accounts.google.com',exp:Math.floor(now/1000)+3600,iat:Math.floor(now/1000),email:'admin@gmail.com',email_verified:true,nonce:'test-nonce',name:'Admin'};
function jwt(claims={},header={}){const a=Buffer.from(JSON.stringify({alg:'RS256',kid:'test',...header})).toString('base64url'),b=Buffer.from(JSON.stringify({...base,...claims})).toString('base64url');return a+'.'+b+'.'+sign('RSA-SHA256',Buffer.from(a+'.'+b),privateKey).toString('base64url');}
test('Google identity verifies signature, audience, issuer, expiry, nonce and verified email',()=>{
 const opts={clientId:'cop-client',nonce:'test-nonce',keys:[jwk],now};assert.equal(verifyGoogleJwt(jwt(),opts).email,'admin@gmail.com');
 for(const claims of [{aud:'other'},{iss:'evil'},{exp:0},{nonce:'other'},{email_verified:false},{sub:''},{iat:Math.floor(now/1000)+3600}])assert.throws(()=>verifyGoogleJwt(jwt(claims),opts));
 assert.throws(()=>verifyGoogleJwt(jwt({}, {alg:'none'}),opts));const parts=jwt().split('.');parts[1]=Buffer.from(JSON.stringify({...base,email:'attacker@gmail.com'})).toString('base64url');assert.throws(()=>verifyGoogleJwt(parts.join('.'),opts));
 assert.deepEqual(cookies({headers:{cookie:'a=1; a=2'}}),{});
});
test('Google sessions: authorized account, one-time login, persistent cookie, CSRF and logout',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const {default:pg}=await import('pg');const schema='auth_'+randomBytes(6).toString('hex');const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 try{const sql=await readFile(new URL('../src/schema.sql',import.meta.url),'utf8');await pool.query(sql);await pool.query(sql);
 let output;const json=(res,status,value)=>output={status,value};const auth=createGoogleAuth({pool,json,readJson:async req=>req.data,clientId:'cop-client',allowedEmails:'admin@gmail.com',publicUrl:'https://cop.test',fetchKeys:async()=>[jwk]});
 const call=async(path,method='GET',data={},cookie='',origin='https://cop.test')=>{output=null;const headers={};const res={getHeader:k=>headers[k],setHeader:(k,v)=>headers[k]=v};await auth.handle({method,data,headers:{cookie,origin}},res,new URL(path,'https://cop.test'));return {...output,headers};};
 const initial=await call('/api/auth/session');assert.equal(initial.value.user,null);const loginCookie=initial.headers['Set-Cookie'][0].split(';')[0];const nonce=initial.value.nonce;const credential=jwt({nonce});
 await assert.rejects(()=>call('/api/auth/google','POST',{credential},loginCookie,'https://evil.test'),e=>e.status===403);
 await assert.rejects(()=>call('/api/auth/google','POST',{credential:jwt({nonce,email:'stranger@gmail.com'})},loginCookie),e=>e.status===403);
 const signed=await call('/api/auth/google','POST',{credential},loginCookie);assert.equal(signed.value.user.email,'admin@gmail.com');const sessionCookie=signed.headers['Set-Cookie'].find(c=>c.startsWith('__Host-cop-session='));assert.match(sessionCookie,/HttpOnly; Secure; SameSite=Strict; Max-Age=2592000/);const cookie=sessionCookie.split(';')[0];
 assert.equal((await auth.user({headers:{cookie}})).email,'admin@gmail.com');assert.ok(!(await pool.query('SELECT token_hash FROM cop_user_sessions')).rows[0].token_hash.includes(cookie.split('=')[1]));
 await assert.rejects(()=>call('/api/auth/google','POST',{credential},loginCookie),e=>e.status===401);
 await assert.rejects(()=>call('/api/auth/logout','POST',{},cookie,'https://evil.test'),e=>e.status===403);
 const restored=await call('/api/auth/session','GET',{},cookie);assert.equal(restored.value.user.email,'admin@gmail.com');
 await call('/api/auth/logout','POST',{},cookie);assert.equal(await auth.user({headers:{cookie}}),null);
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
