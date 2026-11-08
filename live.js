(() => {
  const $ = id => document.getElementById(id);
  const config = window.AFTER_DARK_SUPABASE_CONFIG;
  const sb = config && window.supabase?.createClient ? window.supabase.createClient(config.url, config.publishableKey) : null;
  const age=$('age-confirm'), start=$('live-start'), next=$('live-next'), stop=$('live-stop');
  const status=$('live-status'), camBtn=$('camera-toggle'), micBtn=$('mic-toggle');
  const localVideo=$('self-camera'), remoteVideo=$('stranger-camera');
  const localPlaceholder=$('self-camera-placeholder'), remotePlaceholder=$('stranger-camera-placeholder');
  const chatForm=$('live-chat-form'), chatInput=$('live-chat-input'), chatSend=$('live-chat-send');
  const chatList=$('live-chat-messages'), chatEmpty=$('live-chat-empty');
  let uid=null, stream=null, pc=null, channel=null, session=null, peerId=null;
  let poll=null, offerRetry=null, waitingCandidates=[], hasRemoteDescription=false, matched=false, busy=false;

  age.addEventListener('change',()=>{start.disabled=!age.checked;status.textContent=age.checked?'Ready when you are. Camera and microphone stay off until you start.':'Confirm you are 18+ to continue.';});
  async function signIn(){
    if(!sb) throw new Error('Supabase did not load. Refresh and try again.');
    let {data:{session}}=await sb.auth.getSession();
    if(!session){const r=await sb.auth.signInAnonymously();if(r.error)throw r.error;session=r.data.session;}
    uid=session.user.id;
  }
  async function getMedia(){
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Camera access needs HTTPS and a supported browser.');
    if(!stream)stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:true});
    else if(!stream.getAudioTracks().length){const audioOnly=await navigator.mediaDevices.getUserMedia({audio:true,video:false});audioOnly.getAudioTracks().forEach(t=>stream.addTrack(t));}
    localVideo.srcObject=stream;await localVideo.play();localPlaceholder.hidden=true;
    camBtn.setAttribute('aria-pressed','true');camBtn.innerHTML='◉ <span>Camera on</span>';
    micBtn.setAttribute('aria-pressed','true');micBtn.innerHTML='♫ <span>Mic on</span>';
  }
  function stopMedia(){
    if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;localVideo.srcObject=null;
    localPlaceholder.hidden=false;camBtn.setAttribute('aria-pressed','false');camBtn.innerHTML='◉ <span>Camera on</span>';
    micBtn.setAttribute('aria-pressed','false');micBtn.innerHTML='♫ <span>Mic on</span>';
  }
  camBtn.addEventListener('click',async()=>{
    if(!stream){try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:false});localVideo.srcObject=stream;await localVideo.play();localPlaceholder.hidden=true;camBtn.setAttribute('aria-pressed','true');camBtn.innerHTML='◉ <span>Camera off</span>';}catch(e){status.textContent=e.message||'Camera could not start.';}return;}
    const t=stream.getVideoTracks()[0];if(t)t.enabled=!t.enabled;
    camBtn.setAttribute('aria-pressed',String(!!t?.enabled));camBtn.innerHTML=t?.enabled?'◉ <span>Camera off</span>':'◉ <span>Camera on</span>';
  });
  micBtn.addEventListener('click',()=>{
    const t=stream?.getAudioTracks()[0];if(!t){status.textContent='Start a video chat to use your microphone.';return;}
    t.enabled=!t.enabled;micBtn.setAttribute('aria-pressed',String(t.enabled));micBtn.innerHTML=t.enabled?'♫ <span>Mic off</span>':'♫ <span>Mic on</span>';
  });
  function chatEnabled(on){chatInput.disabled=!on;chatSend.disabled=!on;chatEmpty.hidden=on;}
  function message(text,mine){const el=document.createElement('div');el.className='live-chat-message'+(mine?' mine':'');el.textContent=text;chatList.append(el);chatList.scrollTop=chatList.scrollHeight;}
  async function signal(payload){if(channel)await channel.send({type:'broadcast',event:'signal',payload});}
  async function flushIce(){for(const c of waitingCandidates.splice(0)){try{await pc.addIceCandidate(c);}catch(e){console.warn(e);}}}
  function createPeer(){
    pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]});
    stream.getTracks().forEach(t=>pc.addTrack(t,stream));
    pc.ontrack=e=>{remoteVideo.srcObject=e.streams[0];remotePlaceholder.hidden=true;remoteVideo.play().catch(()=>{});};
    pc.onicecandidate=e=>{if(e.candidate)signal({type:'ice',candidate:e.candidate});};
    pc.onconnectionstatechange=()=>{if(pc?.connectionState==='connected')status.textContent='Connected! Say hello.';else if(['failed','disconnected'].includes(pc?.connectionState))status.textContent='Connection interrupted. Try Next or Stop.';};
  }
  async function receive(payload){
    if(!pc||!payload)return;
    if(payload.type==='offer'&&uid>peerId){
      if(pc.signalingState!=='stable')return;
      await pc.setRemoteDescription(payload.description);hasRemoteDescription=true;await flushIce();
      const answer=await pc.createAnswer();await pc.setLocalDescription(answer);
      await signal({type:'answer',description:pc.localDescription});
    }else if(payload.type==='answer'&&uid<peerId&&!pc.currentRemoteDescription){
      await pc.setRemoteDescription(payload.description);hasRemoteDescription=true;await flushIce();
      if(offerRetry)clearInterval(offerRetry);offerRetry=null;
    }else if(payload.type==='ice'&&payload.candidate){
      if(!hasRemoteDescription)waitingCandidates.push(payload.candidate);else try{await pc.addIceCandidate(payload.candidate);}catch(e){console.warn(e);}
    }else if(payload.type==='hangup'){status.textContent='The stranger left the chat.';await finish(false);}
  }
  async function openSignalChannel(){
    channel=sb.channel('video:'+session,{config:{private:true}})
      .on('broadcast',{event:'signal'},({payload})=>receive(payload).catch(e=>{console.error(e);status.textContent='Video connection failed. Try Next.';}))
      .on('broadcast',{event:'chat'},({payload})=>{if(typeof payload?.text==='string')message(payload.text.slice(0,500),false);});
    await new Promise((resolve,reject)=>channel.subscribe((state,error)=>{
      if(state==='SUBSCRIBED')resolve();if(state==='CHANNEL_ERROR'||state==='TIMED_OUT')reject(error||new Error('Could not join the private video room.'));
    }));
    createPeer();
    if(uid<peerId){
      const makeOffer=async()=>{if(!pc||pc.signalingState!=='stable'||pc.currentRemoteDescription)return;const offer=await pc.createOffer();await pc.setLocalDescription(offer);await signal({type:'offer',description:pc.localDescription});};
      await makeOffer();
      offerRetry=setInterval(()=>{if(pc?.signalingState==='have-local-offer')signal({type:'offer',description:pc.localDescription});},2500);
    }
  }
  async function checkMatch(){
    if(!busy)return;
    const {data,error}=await sb.rpc('join_after_dark_video_queue',{
      p_gender:$('live-self-gender').value,p_country:$('live-self-country').value,
      p_preferred_gender:$('live-gender').value,p_preferred_country:$('live-country').value
    });
    if(error)throw error;
    if(data?.status==='matched'){
      clearInterval(poll);poll=null;session=data.session_id;peerId=data.peer_id;matched=true;chatEnabled(true);
      status.textContent='Stranger found. Connecting…';next.disabled=false;stop.disabled=false;await openSignalChannel();
    }
  }
  async function startSearch(){
    if(!age.checked||busy)return;
    busy=true;matched=false;start.disabled=true;next.disabled=true;stop.disabled=false;chatEnabled(false);chatList.innerHTML='';
    remoteVideo.srcObject=null;remotePlaceholder.hidden=false;
    try{
      await signIn();status.textContent='Allow camera and microphone access…';await getMedia();
      status.textContent='Looking for a stranger…';await checkMatch();
      if(busy&&!matched)poll=setInterval(()=>checkMatch().catch(e=>{status.textContent=e.message||'Matching stopped.';finish(false);}),1800);
    }catch(e){status.textContent=e.message||'Could not start video chat.';await finish(false);}
  }
  async function finish(requeue){
    if(poll)clearInterval(poll);poll=null;if(offerRetry)clearInterval(offerRetry);offerRetry=null;
    if(channel){if(matched&&!requeue)await signal({type:'hangup'});await sb.removeChannel(channel);channel=null;}
    if(pc){pc.ontrack=null;pc.close();pc=null;}
    if(sb&&uid){const {error}=await sb.rpc('leave_after_dark_video_queue');if(error)console.warn(error);}
    busy=false;matched=false;session=null;peerId=null;waitingCandidates=[];hasRemoteDescription=false;
    remoteVideo.srcObject=null;remotePlaceholder.hidden=false;stopMedia();chatEnabled(false);
    next.disabled=true;stop.disabled=true;start.disabled=!age.checked;
    if(requeue&&age.checked){await startSearch();}else if(status.textContent!=='The stranger left the chat.')status.textContent='Video chat ended. Start again whenever you like.';
  }
  start.addEventListener('click',startSearch);
  next.addEventListener('click',()=>{status.textContent='Finding your next stranger…';finish(true);});
  stop.addEventListener('click',()=>finish(false));
  chatForm.addEventListener('submit',async e=>{
    e.preventDefault();const text=chatInput.value.trim();if(!text||!channel)return;
    chatInput.value='';message(text,true);await channel.send({type:'broadcast',event:'chat',payload:{text:text.slice(0,500)}});
  });
  window.addEventListener('pagehide',()=>{if(pc)pc.close();if(stream)stream.getTracks().forEach(t=>t.stop());if(sb&&uid)sb.rpc('leave_after_dark_video_queue');});
  chatEnabled(false);
  if(!sb)status.textContent='Supabase could not load. Refresh this page and try again.';
})();