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
(async()=>{
  const AH=await hdr(A,T.alice), BH=await hdr(A,T.bob);
  const s=await (await fetch(A+'/api/servers',{method:'POST',headers:AH,body:JSON.stringify({name:'JoinLat '+Date.now()})})).json();
  const sid=s._id||s.id;
  const c=await (await fetch(A+'/api/servers/'+sid+'/channels',{method:'POST',headers:AH,body:JSON.stringify({name:'jl'+Date.now(),type:'text'})})).json();
  const cid=c._id||c.id;
  const iv=await (await fetch(A+'/api/servers/invites',{method:'POST',headers:AH,body:JSON.stringify({serverId:sid})})).json();
  await fetch(A+'/api/servers/invites/'+iv.code+'/use',{method:'POST',headers:BH,body:'{}'});

  for (const [label, recvBase] of [['CROSS (bob@B)', B], ['SAME  (bob@A)', A]]) {
    const sa=await conn(A,T.alice), sb=await conn(recvBase,T.bob);
    sa.emit('channel:join',cid);
    await sleep(1500);
    // Alicinin odaya girmesi icin TEKRARLI join + gonderim (E2E kalibi)
    const content='probe-'+Date.now().toString(36);
    let attempts=0;
    const got=await new Promise(async r=>{
      const deadline=Date.now()+25000; let done=false;
      sb.on('message:new',m=>{if(String(m.content||'')===content&&!done){done=true;r(attempts);}});
      while(!done && Date.now()<deadline){
        attempts++;
        sb.emit('channel:join',cid);
        await sleep(700);
        if(done) break;
        sa.emit('message:send',{channelId:cid,serverId:sid,content,ackId:'p'+Date.now()});
        await sleep(1600);
      }
      if(!done) r(-1);
    });
    console.log(label+': attempts_needed='+(got<0?'NEVER':got));
    sa.close(); sb.close();
    await sleep(1500);
  }
  process.exit(0);
})();
