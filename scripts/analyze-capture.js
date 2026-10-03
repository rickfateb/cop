import pg from 'pg';
import {enqueueCaptureAnalysis} from '../src/capture-analysis.js';
const [captureId,requestedBy]=process.argv.slice(2);
if(!process.env.AUDIT_BASE_URL||!process.env.AUDIT_COP_TOKEN||!process.env.COP_MEDIA_SIGNING_SECRET)throw Error('Processador de auditoria nao configurado.');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:true}:undefined});
try{console.log(JSON.stringify(await enqueueCaptureAnalysis(pool,captureId,requestedBy),null,2));}finally{await pool.end();}
