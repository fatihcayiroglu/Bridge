const fs=require('fs');
const io=require('socket.io-client');
const T=JSON.parse(fs.readFileSync('fixtures/tokens.json','utf8'));
const A='http://127.0.0.1:3000', B='http://127.0.0.1:3010';
const UA='Mozilla/5.0 Chrome/120';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hdr=async(base,tok)=>{const H={Authorization:'Bearer '+tok,Accept:'application/json','User-Agent':UA};
  const c=(await (await fetch(base+'/api/csrf-token',{headers:H})).json()).token||'';
  return {...H,'Content-Type':'application/json','X-CSRF-Token':c};};
const conn=(base,tok)=>new Promise(res=>{const s=io(base,{auth:{token:tok},transports:['websocket'],reconnection:false,timeout:8000});
  const t=setTimeout(()=>res(null),9000);s.on('connect',()=>{clearTimeout(t);res(s);});s.on('connect_error',()=>{clearTimeout(t);res(null);});});
async function sendConfirmed(sock,payload){
  return new Promise(r=>{const t=setTimeout(()=>r(false),9000);
    sock.once('message:ack',()=>{clearTimeout(t);r(true);});
    sock.once('error:spam',()=>{clearTimeout(t);r(false);});
    sock.emit('message:send',payload);});
}
(async()=>{
  const AH=await hdr(A,T.alice), BH=await hdr(A,T.bob);
  const s=await (await fetch(A+'/api/servers',{method:'POST',headers:AH,body:JSON.stringify({name:'SameInst '+Date.now()})})).json();
  const sid=s._id||s.id;
  const c=await (await fetch(A+'/api/servers/'+sid+'/channels',{method:'POST',headers:AH,body:JSON.stringify({name:'si'+Date.now(),type:'text'})})).json();
  const cid=c._id||c.id;
  const iv=await (await fetch(A+'/api/servers/invites',{method:'POST',headers:AH,body:JSON.stringify({serverId:sid})})).json();
  await fetch(A+'/api/servers/invites/'+iv.code+'/use',{method:'POST',headers:BH,body:'{}'});

  // Ayni instance (B) uzerinde IKI farkli kimlik
  const aB=await conn(B,T.alice), bB=await conn(B,T.bob);
  aB.emit('channel:join',cid); bB.emit('channel:join',cid);
  await sleep(2500);
  const n1='onB-'+Date.now().toString(36);
  const g1=new Promise(r=>{const t=setTimeout(()=>r(0),8000);bB.on('message:new',m=>{if(String(m.content||'').includes(n1)){clearTimeout(t);r(1);}});});
  const s1=await sendConfirmed(aB,{channelId:cid,serverId:sid,content:n1,ackId:'i1'+Date.now()});
  console.log('SAME-INSTANCE B: sent='+s1+' delivered='+(await g1));
  aB.close(); bB.close();
  await sleep(2500);

  // Ayni instance (A) uzerinde IKI farkli kimlik
  const aA=await conn(A,T.alice), bA=await conn(A,T.bob);
  aA.emit('channel:join',cid); bA.emit('channel:join',cid);
  await sleep(2500);
  const n2='onA-'+Date.now().toString(36);
  const g2=new Promise(r=>{const t=setTimeout(()=>r(0),8000);bA.on('message:new',m=>{if(String(m.content||'').includes(n2)){clearTimeout(t);r(1);}});});
  const s2=await sendConfirmed(aA,{channelId:cid,serverId:sid,content:n2,ackId:'i2'+Date.now()});
  console.log('SAME-INSTANCE A: sent='+s2+' delivered='+(await g2));
  aA.close(); bA.close();
  process.exit(0);
})();
