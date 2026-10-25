// Dev-only: seeds the local e2e harness with a 13-player session and issued requests (prints ids for mobile-audit.mjs).
const B='http://localhost:4310/sb'
const tok=(await (await fetch(B+'/auth/v1/token?grant_type=password',{method:'POST',headers:{'Content-Type':'application/json',apikey:'anon'},body:JSON.stringify({email:'owner@caff.test',password:'local-e2e-only'})})).json()).access_token
const rpc=async(fn,a)=>{const r=await fetch(B+'/rest/v1/rpc/'+fn,{method:'POST',headers:{'Content-Type':'application/json',apikey:'anon',Authorization:'Bearer '+tok},body:JSON.stringify(a)}); const t=await r.text(); if(!r.ok) throw new Error(fn+' '+r.status+' '+t.slice(0,200)); return t?JSON.parse(t):null}
const sid=await rpc('create_pitch_session',{p_title:'Thursday Football at Powerleague Shoreditch (5-a-side, long title check)',p_starts_at:new Date(Date.now()+3*864e5).toISOString(),p_duration_minutes:60,p_venue_id:null,p_venue_name:'Powerleague Shoreditch',p_pitch_name:'Pitch 4',p_pitch_type:'5-a-side 3G',p_pitch_cost_pence:6500,p_fee_mode:'ABSORB',p_notes:'Bring bibs. Gate code on arrival.',p_payment_deadline:new Date(Date.now()+2*864e5).toISOString(),p_status:'CONFIRMED',p_match_id:null})
for (const p of ['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003',...Array.from({length:10},(_,i)=>`10000000-0000-4000-8000-${String(i).padStart(12,'0')}`)]) await rpc('add_session_attendee',{p_session:sid,p_profile:p,p_guest_name:null,p_attendance:'CONFIRMED'})
await rpc('add_session_attendee',{p_session:sid,p_profile:null,p_guest_name:'Maximilian Featherstonehaugh-Worthington',p_attendance:'CONFIRMED'})
let d=await rpc('get_pitch_session',{p_session:sid})
await rpc('issue_payment_requests',{p_session:sid,p_expected_version:d.session.calc_version,p_confirm_changes:true})
d=await rpc('get_pitch_session',{p_session:sid})
const pat=d.attendees.find(a=>a.display_name.startsWith('Pat')); const req=d.requests.find(q=>q.attendee_id===pat.id)
const sam=d.attendees.find(a=>a.display_name.startsWith('Sam'))
await rpc('record_manual_payment',{p_session:sid,p_attendee:sam.id,p_method:'CASH',p_amount_pence:500,p_received_at:new Date().toISOString(),p_reference:'Cash at pitch',p_notes:null,p_client_token:crypto.randomUUID()}).catch(e=>console.log('manual:',e.message.slice(0,120)))
console.log(JSON.stringify({sid, req:req.id, attendees:d.attendees.length, requests:d.requests.length}))
