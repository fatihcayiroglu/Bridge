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
async function sendConfirmed(sock,p){return new Promise(r=>{const t=setTimeout(()=>r(false),9000);
  sock.once('message:ack',()=>{clearTimeout(t);r(true);});sock.once('error:spam',()=>{clearTimeout(t);r(false);});sock.emit('message:send',p);});}

async function trial(delayAfterConnect, recvBase, label){
  const AH=await hdr(A,T.alice), BH=await hdr(A,T.bob);
  const s=await (await fetch(A+'/api/servers',{method:'POST',headers:AH,body:JSON.stringify({name:'Race '+Date.now()})})).json();
  const sid=s._id||s.id;
  const c=await (await fetch(A+'/api/servers/'+sid+'/channels',{method:'POST',headers:AH,body:JSON.stringify({name:'rc'+Date.now(),type:'text'})})).json();
  const cid=c._id||c.id;
  const iv=await (await fetch(A+'/api/servers/invites',{method:'POST',headers:AH,body:JSON.stringify({serverId:sid})})).json();
  await fetch(A+'/api/servers/invites/'+iv.code+'/use',{method:'POST',headers:BH,body:'{}'});
  const sa=await conn(A,T.alice), sb=await conn(recvBase,T.bob);
  await sleep(delayAfterConnect);            // <-- DEGISKEN
  sa.emit('channel:join',cid); sb.emit('channel:join',cid);
  await sleep(2000);
  const n='r-'+Date.now().toString(36);
  const got=new Promise(r=>{const t=setTimeout(()=>r(0),8000);sb.on('message:new',m=>{if(String(m.content||'').includes(n)){clearTimeout(t);r(1);}});});
  const sent=await sendConfirmed(sa,{channelId:cid,serverId:sid,content:n,ackId:'r'+Date.now()});
  const d=await got;
  console.log(label+' joinDelay='+delayAfterConnect+'ms sent='+sent+' delivered='+d);
  sa.close(); sb.close();
  await sleep(1200);
}
(async()=>{
  for (const d of [0, 500, 1500, 3000]) await trial(d, B, 'CROSS');
  for (const d of [0, 1500]) await trial(d, A, 'SAME ');
  process.exit(0);
})();
