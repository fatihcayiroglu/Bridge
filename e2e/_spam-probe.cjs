const fs=require('fs');
const io=require('socket.io-client');
const T=JSON.parse(fs.readFileSync('fixtures/tokens.json','utf8'));
const A='http://127.0.0.1:3000';
const UA='Mozilla/5.0 Chrome/120';
(async()=>{
  const H={Authorization:'Bearer '+T.alice,Accept:'application/json','User-Agent':UA};
  const csrf=(await (await fetch(A+'/api/csrf-token',{headers:H})).json()).token||'';
  const MH={...H,'Content-Type':'application/json','X-CSRF-Token':csrf};
  const s=await (await fetch(A+'/api/servers',{method:'POST',headers:MH,body:JSON.stringify({name:'Spam '+Date.now()})})).json();
  const sid=s._id||s.id;
  const c=await (await fetch(A+'/api/servers/'+sid+'/channels',{method:'POST',headers:MH,body:JSON.stringify({name:'sp'+Date.now(),type:'text'})})).json();
  const cid=c._id||c.id;
  const sa=io(A,{auth:{token:T.alice},transports:['websocket'],reconnection:false});
  await new Promise(r=>{sa.on('connect',r);setTimeout(r,8000);});
  for (const ev of ['error:spam','error:message','error:ratelimit']) {
    sa.on(ev, d => console.log('ALICE ' + ev + ' -> ' + JSON.stringify(d).slice(0,110)));
  }
  sa.emit('channel:join', cid);
  await new Promise(r=>setTimeout(r,1500));
  const ack = await new Promise(r => {
    const t=setTimeout(()=>r('NO ACK'),8000);
    sa.once('message:ack',()=>{clearTimeout(t);r('ACK ok');});
    sa.emit('message:send',{channelId:cid,serverId:sid,content:'spam-probe-'+Date.now(),ackId:'sp'+Date.now()});
  });
  console.log('alice send result: ' + ack);
  sa.close();
  process.exit(0);
})();
