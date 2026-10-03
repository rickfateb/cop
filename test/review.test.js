import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mapReviewResult,listReviews,reviewIncident} from '../src/review.js';
test('review evidence is restricted to the event; clothing matches preserve the independent decision',()=>{
 const detail={summary:'Compra regular visível.',media:[{id:'a',external_id:'cop-media-7'},{id:'foreign',external_id:'cop-media-99'}],
  fraud_result:{classification:'Sem alerta',confidence:.8,rationale:'Sem comportamento preocupante.',flags:[{type:'sem_camisa',media_id:'a',description:'Torso descoberto visível.'},{type:'fumando',media_id:'foreign',description:'Fora do evento.'},{type:'identidade',media_id:'a',description:'Invalido.'}],observations:[{media_id:'a',description:'Retira uma lata.'}],clothing_matches:[{media_id:'a',description:'Bermuda escura e sacola amarela.'},{media_id:'foreign',description:'Fora do evento.'}]}};
 const result=mapReviewResult(detail,[{id:7,detected_channel:4,frame_offset_seconds:9,recorded_at:'2026-10-02T22:13:13Z'}]);
 assert.equal(result.flags.length,1);assert.equal(result.flags[0].type,'sem_camisa');assert.equal(result.flags[0].media_id,'7');assert.equal(result.classification,'Sem alerta');assert.equal(result.clothing_matches.length,1);
 assert.equal(result.clothing_matches[0].channel,4);assert.equal(result.observations[0].recorded_at,'2026-10-02T22:13:13Z');
 assert.equal(result.requires_human_review,true);assert.equal(result.payment_status,'not_verified');
});
test('review filters use database evidence and parameterized unit IDs',async()=>{
 let captured;await listReviews({query:async(sql,args)=>{captured={sql,args};return {rows:[]};}},{clothingOnly:true,unitId:'12',limit:200});
 assert.match(captured.sql,/jsonb_array_length/);assert.match(captured.sql,/e.unit_id=\$1/);assert.deepEqual(captured.args,['12',100]);
 await assert.rejects(()=>listReviews({}, {unitId:'12 OR 1=1'}),e=>e.status===400);
});
test('only explicit human decisions can confirm or dismiss an incident',async()=>{
 const pool={query:async(sql,args)=>({rows:[{id:args[0],review_status:args[1]}]})};
 assert.equal((await reviewIncident(pool,'1','confirmed')).review_status,'confirmed');
 await assert.rejects(()=>reviewIncident(pool,'1','pending'),e=>e.status===400);
});
