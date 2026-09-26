const fs=require('fs');
const io=require('socket.io-client');
const T=JSON.parse(fs.readFileSync('fixtures/tokens.json','utf8'));
const A='http://127.0.0.1:3000', B='http://127.0.0.1:3010';
const UA='Mozilla/5.0 Chrome/120';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hdr=async(base,tok)=>{const H={Authorization:'Bearer '+tok,Accept:'application/json','User-Agent':UA};
  const c=(await (await fetch(base+'/api/csrf-token',{headers:H})).json()).token||'';
  return {...H,'Content-Type':'application/json','X-CSRF-Token':c};};
// KANONIK: sunucu TUM dinleyicileri kaydettikten SONRA `userAuthenticated`
// yayar. `connect`te emit etmeye baslamak olaylarin SESSIZCE dusmesine yol
// acar (olculdu: 0ms -> teslim 0/1, >=500ms -> 1/1).
const conn=(base,tok)=>new Promise(res=>{
  const s=io(base,{auth:{token:tok},transports:['websocket'],reconnection:false,timeout:8000});
  const t=setTimeout(()=>res(null),12000);
  s.once('userAuthenticated',()=>{clearTimeout(t);res(s);});
  s.on('connect_error',()=>{clearTimeout(t);res(null);});});
/** Gonderim + ack dogrulamasi; ack yoksa mesaj HIC olusmamistir. */
async function sendConfirmed(sock,payload){
  return new Promise(r=>{
    const t=setTimeout(()=>r(false),9000);
    sock.once('message:ack',()=>{clearTimeout(t);r(true);});
    sock.once('error:spam',d=>{clearTimeout(t);console.log('  SPAM MUTE:',JSON.stringify(d).slice(0,70));r(false);});
    sock.emit('message:send',payload);
  });
}
(async()=>{
  const AH=await hdr(A,T.alice), BH=await hdr(A,T.bob);
  const s=await (await fetch(A+'/api/servers',{method:'POST',headers:AH,body:JSON.stringify({name:'FanOut '+Date.now()})})).json();
  const sid=s._id||s.id;
  const c=await (await fetch(A+'/api/servers/'+sid+'/channels',{method:'POST',headers:AH,body:JSON.stringify({name:'fo'+Date.now(),type:'text'})})).json();
  const cid=c._id||c.id;
  const iv=await (await fetch(A+'/api/servers/invites',{method:'POST',headers:AH,body:JSON.stringify({serverId:sid})})).json();
  await fetch(A+'/api/servers/invites/'+iv.code+'/use',{method:'POST',headers:BH,body:'{}'});
  const sa=await conn(A,T.alice), sb=await conn(B,T.bob);
  if(!sa||!sb){console.log('RESULT connect-failed');process.exit(1);}
  sa.emit('channel:join',cid); sb.emit('channel:join',cid);
  await sleep(2500);
  let ab=0, ba=0, abSent=0, baSent=0;
  for(let i=1;i<=5;i++){
    const n1='a2b-'+i+'-'+Date.now().toString(36);
    const got1=new Promise(r=>{const t=setTimeout(()=>r(0),8000);
      const h=m=>{if(String(m.content||'').includes(n1)){clearTimeout(t);sb.off('message:new',h);r(1);}};sb.on('message:new',h);});
    if(await sendConfirmed(sa,{channelId:cid,serverId:sid,content:n1,ackId:'x'+Date.now()+i})){abSent++;ab+=await got1;}
    await sleep(2000);
    const n2='b2a-'+i+'-'+Date.now().toString(36);
    const got2=new Promise(r=>{const t=setTimeout(()=>r(0),8000);
      const h=m=>{if(String(m.content||'').includes(n2)){clearTimeout(t);sa.off('message:new',h);r(1);}};sa.on('message:new',h);});
    if(await sendConfirmed(sb,{channelId:cid,serverId:sid,content:n2,ackId:'y'+Date.now()+i})){baSent++;ba+=await got2;}
    await sleep(2000);
  }
  console.log('A->B  sent='+abSent+'/5  delivered='+ab+'/'+abSent);
  console.log('B->A  sent='+baSent+'/5  delivered='+ba+'/'+baSent);
  sa.close();sb.close();process.exit(0);
})();
