function int(value,name,min,max){const n=Number(value);if(!Number.isInteger(n)||n<min||n>max)throw Object.assign(Error(name+' inválido.'),{status:400});return n;}
function txt(value,name,max){if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw Object.assign(Error(name+' inválido.'),{status:400});return value.trim();}
function iso(value,name){const d=new Date(value);if(!value||Number.isNaN(d.getTime()))throw Object.assign(Error(name+' inválido.'),{status:400});return d.toISOString();}

export async function createInvestigation(pool,body,actor='admin'){
 const unitId=int(body.unit_id,'Unidade',1,2147483647);
 const referenceAt=iso(body.reference_at,'Data/hora');
 const before=int(body.window_before_seconds??300,'Janela anterior',0,3600);
 const after=int(body.window_after_seconds??600,'Janela posterior',0,3600);
 if(before+after===0)throw Object.assign(Error('Informe uma janela de busca maior que zero.'),{status:400});
 const reason=txt(body.reason,'Motivo',2000);
 const source=['manual','api','financial','stock','other'].includes(body.source)?body.source:'manual';
 const externalRef=body.external_ref==null?null:String(body.external_ref).slice(0,200);
 const dvr=(await pool.query('SELECT id,name,channel_count FROM cop_dvrs WHERE unit_id=$1 AND active=TRUE ORDER BY id LIMIT 1',[unitId])).rows[0];
 if(!dvr)throw Object.assign(Error('Unidade sem DVR ativo.'),{status:409});
 const cameras=(await pool.query('SELECT id,channel,name FROM cop_cameras WHERE dvr_id=$1 AND active=TRUE ORDER BY channel',[dvr.id])).rows;
 if(!cameras.length)throw Object.assign(Error('DVR sem câmeras ativas cadastradas.'),{status:409});
 let selected=cameras;
 if(Array.isArray(body.channels)&&body.channels.length){
   const wanted=new Set(body.channels.map(v=>int(v,'Canal',1,32)));
   selected=cameras.filter(c=>wanted.has(c.channel));
   if(selected.length!==wanted.size)throw Object.assign(Error('Um ou mais canais não estão cadastrados no COP.'),{status:400});
 }
 const start=new Date(new Date(referenceAt).getTime()-before*1000).toISOString();
 const end=new Date(new Date(referenceAt).getTime()+after*1000).toISOString();
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const inv=(await client.query(`INSERT INTO cop_investigations(unit_id,dvr_id,reference_at,window_before_seconds,window_after_seconds,reason,source,external_ref,status,connector_status,requested_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'waiting_connector','not_available',$9) RETURNING *`,
    [unitId,dvr.id,referenceAt,before,after,reason,source,externalRef,actor])).rows[0];
  for(const cam of selected)await client.query(`INSERT INTO cop_investigation_channels(investigation_id,camera_id,channel,status,requested_start_at,requested_end_at)
    VALUES($1,$2,$3,'waiting_connector',$4,$5)`,[inv.id,cam.id,cam.channel,start,end]);
  await client.query('COMMIT');
  return {...inv,dvr_name:dvr.name,channels:selected.map(c=>({camera_id:c.id,channel:c.channel,name:c.name,status:'waiting_connector',requested_start_at:start,requested_end_at:end}))};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}

export async function listInvestigations(pool,{limit=50,unitId=null}={}){
 const params=[];let where='';
 if(unitId){params.push(Number(unitId));where='WHERE i.unit_id=$1';}
 params.push(Math.min(100,Math.max(1,Number(limit)||50)));
 const rows=(await pool.query(`SELECT i.*,u.name unit_name,u.code unit_code,d.name dvr_name
   FROM cop_investigations i JOIN cop_units u ON u.id=i.unit_id JOIN cop_dvrs d ON d.id=i.dvr_id
   ${where} ORDER BY i.created_at DESC,i.id DESC LIMIT $${params.length}`,params)).rows;
 if(!rows.length)return [];
 const ids=rows.map(r=>r.id);
 const channels=(await pool.query(`SELECT ic.*,c.name camera_name FROM cop_investigation_channels ic JOIN cop_cameras c ON c.id=ic.camera_id
   WHERE ic.investigation_id=ANY($1::bigint[]) ORDER BY ic.investigation_id,ic.channel`,[ids])).rows;
 const map=new Map();for(const row of channels){const k=String(row.investigation_id);if(!map.has(k))map.set(k,[]);map.get(k).push(row);}
 return rows.map(row=>({...row,channels:map.get(String(row.id))||[]}));
}

export async function investigationDetail(pool,id){
 const rows=await listInvestigations(pool,{limit:100});
 const found=rows.find(row=>String(row.id)===String(id));
 if(!found)throw Object.assign(Error('Investigação não encontrada.'),{status:404});
 return found;
}
