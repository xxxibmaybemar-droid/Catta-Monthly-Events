// Public installable Extension. Server-owned prelaunch countdown, scheduled access.
// Before Oct15 only verified Master/Boss and invited testers can open the full preview.
import {createEventLorebookSync,EVENT_CHAT_KEY} from './lorebook-sync.js';
import {createObservedTurnMeter} from './observed-turns.js';
// No demo scores, synthetic ranks, local turn buttons or wallet writes.
const BASE = 'https://st-cattacafe.casa';
const API = BASE + '/v1/monthly-event';
const ID = 'catta-monthly-events-release';
const SLOTS = ['leaderboard','rewards','missions'];
const LABELS = {leaderboard:'ดูคะแนน',rewards:'ของรางวัล',missions:'ภารกิจ'};
// Keep the 2026 Halloween wording separate from future monthly Event settings.
function isHalloween2026(cfg){
  return /Halloween\s*2026/i.test(String(cfg?.title||''));
}
function tabLabel(cfg,slot){
  if(slot==='rewards'&&isHalloween2026(cfg))return 'สุ่มรางวัลใหญ่';
  return cfg[slot+'Label']||LABELS[slot];
}
function rewardTitle(cfg,level){
  const original=cfg['reward'+level+'Title'];
  if(!isHalloween2026(cfg))return original||'รางวัลอันดับ '+level;
  const names=['แจ็คพอต (สุ่มรางวัลที่ 1)','สุ่มรางวัลที่ 2','สุ่มรางวัลที่ 3'];
  const prize=typeof original==='string'
    ?original.replace(/^\s*อันดับ\s*[123]\s*[—–:-]\s*/u,'').trim():'';
  return names[level-1]+(prize?' — '+prize:'');
}
let holder, titleNode, bodyNode, details, eventData=null, offset=0, verifiedScores=null, observedTelemetry=null, eventPhase='live', previewRefreshTriggered=false;
let selection='missions', sequence=0, tick=null, generationBusy=false;
// Reusing the last verified UI briefly avoids full image and member re-fetch on every open.
// Only the display is cached: Event API revalidates bearer credentials for every action.
const UI_CACHE_MS=5*60_000;
const LEADERBOARD_REFRESH_MS=10*60_000;
const LEADERBOARD_PAGE_SIZE=10;
const leaderboardCache=new Map();
let leaderboardPage=1,boardTimer=null,boardBusy=false;
let lastReadyAt=0,lastReadyLogin=null,inFlightLogin=null;
const world=createEventLorebookSync({getContext:()=>globalThis.SillyTavern?.getContext?.(),
  credentials,baseUrl:BASE});
const objectUrls=new Map();
const observedMeter=createObservedTurnMeter({
  getContext:()=>globalThis.SillyTavern?.getContext?.(),
  credentials,
  isEventActive:()=>world.snapshot().enabled,
  report:async (observation,login)=>{
    const result=await fetch(API+'/client-observations',{
      method:'POST',credentials:'omit',cache:'no-store',
      headers:{'x-uid':login.uid,'x-token':login.token,'content-type':'application/json'},
      body:JSON.stringify(observation),signal:AbortSignal.timeout(12000)
    });
    if(!result.ok)throw Error('CLIENT_OBSERVATION_UNAVAILABLE');
    return result.json();
  }
});
function el(tag,cls,text){
  const item=document.createElement(tag);
  if(cls)item.className=cls;
  if(text!==undefined)item.textContent=text;
  return item;
}
function credentials(){
  try{return {uid:localStorage.getItem('catta_uid')||'',token:localStorage.getItem('catta_auth_token')||''};}
  catch{return {uid:'',token:''};}
}
async function requestJSON(url,login){
  const res=await fetch(url,{headers:{'x-uid':login.uid,'x-token':login.token},
    method:'GET',credentials:'omit',cache:'no-store',redirect:'error',
    signal:AbortSignal.timeout(12000)});
  if(!res.ok)throw Error('SERVER_UNAVAILABLE');
  const data=await res.json();
  if(data?.success!==true)throw Error('NOT_AUTHORIZED');
  return data;
}
async function requestClaim(milestoneId, login, manualReview=false) {
  // The browser can only pick the milestone; server verifies UID, turns and amount.
  if(!/^turns-(100|500|1000)$/.test(milestoneId))throw Error('INVALID_MILESTONE');
  const res=await fetch(API+(manualReview?'/manual-claims/':'/missions/')+milestoneId+(manualReview?'':'/claim'),{
    method:'POST',headers:{'x-uid':login.uid,'x-token':login.token},
    credentials:'omit',cache:'no-store',redirect:'error',
    signal:AbortSignal.timeout(12000)
  });
  const data=await res.json().catch(()=>null);
  if(!res.ok||data?.success!==true||
     (manualReview?data?.manual_review!==true:data?.claimed!==true)){
    throw Error('ไม่สามารถยื่นคำขอรับรางวัลได้ กรุณาตรวจสอบสิทธิ์หรือขอลองใหม่');
  }
  return data;
}
function clearImages(){
  for(const value of objectUrls.values())URL.revokeObjectURL(value);
  objectUrls.clear();
}
function clearTimers(){
  if(tick){clearInterval(tick);tick=null;}
}
function clearLeaderboardCache(){
  leaderboardCache.clear();leaderboardPage=1;
}
function cachedLeaderboard(event,login,phase,page){
  const key=event.id+'|'+phase+'|'+page;
  const hit=leaderboardCache.get(key);
  if(hit&&sameLogin(hit.login,login)&&Date.now()-hit.savedAt<LEADERBOARD_REFRESH_MS)return hit;
  return null;
}
async function loadLeaderboardPage(event,login,phase,page){
  if(!Number.isSafeInteger(page)||page<1||page>100000)throw Error('INVALID_BOARD_PAGE');
  const cached=cachedLeaderboard(event,login,phase,page);
  if(cached)return cached.data;
  const result=await requestJSON(API+'/leaderboard?page='+page,login);
  if(result.event_id!==event.id||!Array.isArray(result.ranking)||
     !Number.isSafeInteger(result.page)||!Number.isSafeInteger(result.pages)||
     !Number.isSafeInteger(result.total_players)||
     result.page<1||result.pages<1||result.total_players<0||
     result.ranking.length>LEADERBOARD_PAGE_SIZE||
     (result.phase && result.phase!==phase))throw Error('BOARD_RESPONSE_INVALID');
  if(!sameLogin(login,credentials()))throw Error('MEMBER_SESSION_CHANGED');
  if(leaderboardCache.size>40)leaderboardCache.clear();
  leaderboardCache.set(event.id+'|'+phase+'|'+result.page,
    {data:result,login:{uid:login.uid,token:login.token},savedAt:Date.now()});
  return result;
}
async function changeLeaderboardPage(page){
  if(boardBusy||!eventData||!verifiedScores||!details?.open)return;
  if(page<1||page>(verifiedScores.board?.pages||1))return;
  const event=eventData,login=credentials(),phase=eventPhase;
  boardBusy=true;
  try{
    const result=await loadLeaderboardPage(event,login,phase,page);
    if(eventData!==event||!sameLogin(login,credentials())||eventPhase!==phase)return;
    leaderboardPage=result.page;
    verifiedScores={...verifiedScores,ranking:result.ranking,board:result};
    render();
  }catch{
    globalThis.toastr?.warning?.('ยังไม่สามารถเปิดอันดับหน้านี้ได้ กรุณาลองใหม่');
  }finally{boardBusy=false;}
}
function markReady(login){
  lastReadyAt=Date.now();lastReadyLogin={uid:login.uid,token:login.token};
}
function clearReady(){lastReadyAt=0;lastReadyLogin=null;inFlightLogin=null;}
function sameLogin(a,b){return Boolean(a&&a.uid&&a.token&&a.uid===b.uid&&a.token===b.token);}
function showStatus(text){
  bodyNode.replaceChildren(el('p','cme-message',text));
}
function expireStatus(end){
  const left=Date.parse(end)-Date.now()-offset;
  if(!Number.isFinite(left))return 'ยังไม่ยืนยันเวลา';
  if(left<=0)return 'อีเวนต์สิ้นสุดแล้ว';
  const t=Math.ceil(left/1000);
  const pad=n=>String(n).padStart(2,'0');
  return String(Math.floor(t/86400))+' วัน '+pad(Math.floor(t%86400/3600))+':'+pad(Math.floor(t%3600/60))+':'+pad(t%60);
}
function renderPublicCountdown(){
  bodyNode.replaceChildren();
  const title=eventData?.settings?.title||'ST-Catta Café Halloween 2026';
  titleNode.textContent=title;
  const header=el('section','cme-info');
  // Event title already shown in the collapsible panel's summary.
  if(isHalloween2026(eventData?.settings)){
    header.append(el('p','cme-public-notice',
      'สวัสดีฮะนายท่าน! ฅ^•ﻌ•^ฅ◞♡'));
    header.append(el('p','cme-public-notice',
      'กิจกรรมฮาโลวีนที่ ST-Catta Café กำลังจะเริ่มแล้ว! แคตต้าแอบเตรียมของรางวัลเล็ก ๆ น้อย ๆ ไว้รอนายท่านด้วยล่ะฮะ~ 🎃✨'));
    header.append(el('p','cme-public-notice',
      'มาร่วมสะสมเทิร์นเล่นสนุกกับแคตต้าและพี่พนักงานกัน แคตต้ารอนายท่านอยู่นะฮะ!'));
    header.append(el('p','cme-public-notice',
      'ยินดีต้อนรับสู่ ฮาโลวีน ST-Catta Café ค้าบผม! 🐾👻 (੭˃ᴗ˂)੭'));
  }else{
    header.append(el('p','cme-public-notice',
      '🎃 กิจกรรมจะเปิดให้ร่วมสนุกตามเวลาที่กำหนด'));
    header.append(el('p','cme-public-notice',
      'เมื่อกิจกรรมเริ่ม จะสามารถสะสมเทิร์นตามกติกาและร่วมลุ้นรางวัลได้'));
  }
  bodyNode.append(header);
  const clock=el('div','cme-public-countdown');
  clock.setAttribute('role','timer');
  clock.setAttribute('aria-label','เวลาที่เหลือก่อนกิจกรรมเริ่ม');
  bodyNode.append(clock);
  const startMs=Date.parse(eventData.starts_at);
  const scheduleLabel=Number.isFinite(startMs)
    ? new Intl.DateTimeFormat('th-TH',{
        timeZone:'Asia/Bangkok',day:'numeric',month:'long',year:'numeric',
        hour:'2-digit',minute:'2-digit',hourCycle:'h23'
      }).format(new Date(startMs))+' น. (เวลาไทย)'
    : 'ยังไม่ยืนยันกำหนดเวลาเปิดกิจกรรม';
  bodyNode.append(el('p','cme-message',scheduleLabel));
  const refreshTimer=()=>{
    clock.textContent='⏳ '+expireStatus(eventData.starts_at);
    if(!previewRefreshTriggered && Date.now()+offset >= Date.parse(eventData.starts_at)){
      previewRefreshTriggered=true;
      clock.textContent='กำลังเปิดกิจกรรม…';
      void refresh({force:true});
    }
  };
  refreshTimer();clearTimers();tick=setInterval(refreshTimer,1000);
}
async function getImage(record,login){
  const url=new URL(record.url,BASE);
  if(url.origin!==BASE||!url.pathname.startsWith('/v1/monthly-event/assets/'))return null;
  const res=await fetch(url.href,{headers:{'x-uid':login.uid,'x-token':login.token},
    method:'GET',cache:'no-store',credentials:'omit',redirect:'error',
    signal:AbortSignal.timeout(12000)});
  if(!res.ok||!res.headers.get('content-type')?.startsWith('image/webp'))return null;
  return URL.createObjectURL(await res.blob());
}
function render(){
  if(!eventData)return showStatus('ขณะนี้ยังไม่มีอีเวนต์ที่เปิดใช้งาน');
  bodyNode.replaceChildren();
  const cfg=eventData.settings || {};
  const header=el('header','cme-info');
  header.append(el('h3','',cfg.title||'Catta Monthly Events'));
  if(cfg.description)header.append(el('p','',cfg.description));
  if(eventPhase==='preview'){
    header.append(el('p','cme-preview','🧪 โหมดทดลองสำหรับแอดมิน/บัญชีทดสอบ · ไม่เพิ่มแครอทจริง · ยอดจะเริ่มใหม่วันที่เปิดกิจกรรม'));
  }
  bodyNode.append(header);
  const timer=el('div','cme-timer');
  timer.setAttribute('role','timer');
  const refreshTimer=()=>{
    timer.textContent='⏳ '+(eventPhase==='preview'
      ?'เริ่มกิจกรรมจริงใน '+expireStatus(eventData.starts_at)
      :'ปิดกิจกรรมใน '+expireStatus(eventData.ends_at));
    const now=Date.now()+offset;
    if(!previewRefreshTriggered &&
      ((eventPhase==='preview'&&now>=Date.parse(eventData.starts_at))||
       (eventPhase==='live'&&now>=Date.parse(eventData.ends_at)))){
      previewRefreshTriggered=true;
      void refresh({force:true}); // server decides whether live, ended or next Event
    }
  };
  refreshTimer();clearTimers();tick=setInterval(refreshTimer,1000);
  bodyNode.append(timer);
  if(objectUrls.has('banner')){
    const img=el('img','cme-banner');
    img.src=objectUrls.get('banner');
    img.alt=cfg.title||'Event banner';
    bodyNode.append(img);
  }
  const nav=el('nav','cme-nav');
  nav.setAttribute('aria-label','เมนูอีเวนต์');
  for(const slot of SLOTS){
    const button=el('button','cme-card'+(selection===slot?' active':''));
    button.type='button';
    const src=objectUrls.get(slot);
    if(src){
      const image=el('img');
      image.src=src;image.alt='';
      button.append(image);
    }
    button.append(el('span','',tabLabel(cfg,slot)));
    button.addEventListener('click',()=>{selection=slot;render();});
    nav.append(button);
  }
  bodyNode.append(nav);
  const activation=el('section','cme-lorebook-box');
  const syncState=world.snapshot();
  activation.append(el('strong','',cfg.title||'Catta Monthly Events'));
  const btn=el('button','cme-event-toggle',syncState.enabled?'ปิดกิจกรรมในแชตนี้':'เปิดกิจกรรมในแชตนี้');
  btn.type='button';btn.disabled=syncState.busy;
  btn.addEventListener('click',async()=>{
    btn.disabled=true;
    try{
      if(world.snapshot().enabled){await world.disable();}
      else{
        const selected=eventData.lorebooks||[];
        if(selected.length<1||selected.length>3)throw Error('ยังไม่มี Lorebook อีเวนต์ที่อนุมัติ');
        await world.install(eventData,selected.map(x=>x.id));
      }
      render();
    }catch(error){
      globalThis.toastr?.warning?.(String(error?.message||'ไม่สามารถเปิด Lorebook ได้').slice(0,150));
      render();
    }
  });
  activation.append(btn);
  if(syncState.lastError)activation.append(el('small','','ยังไม่สามารถเปิดกิจกรรมได้ กรุณาลองใหม่อีกครั้ง'));
  bodyNode.append(activation);
  const content=el('section','cme-content');
  content.append(el('h4','',tabLabel(cfg,selection)));
  if(selection==='leaderboard'){
    const cards=el('div','cme-stats');
    for(const [label,value,description] of [
      ['เทิร์นสะสมของฉัน',Number.isSafeInteger(verifiedScores?.usage?.turns)?String(verifiedScores.usage.turns):'—',
       verifiedScores?.usage?.score_source==='owner_accepted_client_observation'?'ยอดที่ผ่านเพดานนับเทิร์นตามกติกา (ผู้เล่นใช้ API ส่วนตัว)':verifiedScores?'ตรวจสอบจากหลักฐานเซิร์ฟเวอร์แล้ว':'ยังไม่มีข้อมูลยืนยัน'],
      ['อันดับของฉัน',Number.isSafeInteger(verifiedScores?.usage?.rank)?String(verifiedScores.usage.rank):'—',
       verifiedScores?.usage?.score_source==='owner_accepted_client_observation'?'อันดับตามกติกายอมรับความเสี่ยง':'รอระบบอันดับจริง']]){
      const card=el('div','cme-stat');
      card.append(el('span','',label),el('strong','',value),el('small','',description));
      cards.append(card);
    }
    content.append(cards);
    const ranking=el('div','cme-ranking');
    ranking.append(el('strong','','ตารางอันดับผู้เล่น'));
    const board=verifiedScores?.board;
    if(verifiedScores?.ranking?.length){
      for(const row of verifiedScores.ranking){
        if(!Number.isSafeInteger(row.turns)||row.turns<1)continue;
        const item=el('div','cme-real-rank'+(Number(row.position)<=3?' cme-podium':''));
        item.append(
          el('span','cme-rank-number',Number(row.position)===1?'🥇':Number(row.position)===2?'🥈':Number(row.position)===3?'🥉':'#'+row.position),
          el('span','cme-rank-name',row.display_name||'ผู้ร่วมกิจกรรม'),
          el('strong','cme-rank-turns',row.turns.toLocaleString('th-TH')+' เทิร์น')
        );
        ranking.append(item);
      }
    }else ranking.append(el('p','cme-ranking-empty',verifiedScores?'ยังไม่มีผู้เล่นที่นับเทิร์นได้':'ยังไม่เปิดแสดงอันดับจริง · ไม่มีชื่อหรือคะแนนสมมุติ'));
    if(board){
      ranking.append(el('p','cme-ranking-hint',
        '🏅 ผู้ร่วมกิจกรรม '+board.total_players.toLocaleString('th-TH')+' คน · อัปเดตอันดับทุก 10 นาที'+
        (board.updated_at?' · ล่าสุด '+new Date(board.updated_at).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Bangkok'})+' น.':'')
      ));
      const navigation=el('div','cme-ranking-pager');
      const prev=el('button','cme-page-button','← ก่อนหน้า');
      prev.type='button';prev.disabled=board.page<=1;
      prev.addEventListener('click',()=>void changeLeaderboardPage(board.page-1));
      const position=el('span','cme-page-position','หน้า '+board.page+' / '+board.pages);
      const next=el('button','cme-page-button','ถัดไป →');
      next.type='button';next.disabled=board.page>=board.pages;
      next.addEventListener('click',()=>void changeLeaderboardPage(board.page+1));
      navigation.append(prev,position,next);
      ranking.append(navigation);
    }
    content.append(ranking);
  }else if(selection==='missions'){
    const intro=el('div','cme-mission-intro');
    intro.append(el('span','','เทิร์นสะสมของฉัน'),el('strong','',
      Number.isSafeInteger(verifiedScores?.missions?.turns)?String(verifiedScores.missions.turns)+' เทิร์น':'— เทิร์น'));
    content.append(intro);
    if(eventPhase==='preview'){
      content.append(el('p','cme-preview',
        '🥕 กระเป๋าทดลอง: '+Number(verifiedScores?.missions?.virtual_carrots||0).toLocaleString('th-TH')+
        ' แครอทเสมือน · ไม่เข้ากระเป๋า Casa และไม่ย้ายไปกิจกรรมจริง'));
    }
    if(verifiedScores?.missions?.risk_held===true){
      content.append(el('p','cme-observed-only','⚠ ยอดถูกพักตรวจสอบความผิดปกติ กรุณาติดต่อแอดมิน'));
    }
    for(const [turns,carrots,icon] of [[100,1,'🎃'],[500,50,'🍬'],[1000,100,'👑']]){
      const card=el('article','cme-mission');
      const heading=el('div','cme-mission-heading');
      heading.append(el('span','cme-mission-icon',icon));
      heading.append(el('strong','','ใช้ Event ครบ '+turns.toLocaleString('th-TH')+' เทิร์น'));
      const status=verifiedScores?.missions?.milestones?.find(x=>x.id==='turns-'+turns);
      const enabled=verifiedScores?.missions?.rewards_enabled===true;
      const claimed=status?.claim_status==='credited';
      const virtual=verifiedScores?.missions?.virtual_only===true&&eventPhase==='preview';
      const manualReview=verifiedScores?.missions?.manual_review_required===true&&eventPhase==='live';
      const pending=status?.claim_status==='pending';
      const rejected=status?.claim_status==='rejected';
      const canClaim=enabled&&status?.claim_enabled===true&&status?.completed===true&&!claimed&&!pending&&!rejected;
      heading.append(el('span','cme-status',claimed?(virtual?'รับแครอทเสมือนแล้ว ✓':'รับแล้ว ✓'):pending?'รอแอดมินอนุมัติ':rejected?'ไม่ผ่านการอนุมัติ':canClaim?(manualReview?'พร้อมยื่นขอรับรางวัล':virtual?'พร้อมรับแครอทเสมือน':'พร้อมรับรางวัล'):!enabled?'รอเปิดระบบ':'กำลังสะสม'));
      card.append(heading,el('small','',virtual?'รางวัลทดลอง: '+carrots+' แครอทเสมือน (ไม่เข้ากระเป๋าจริง)':enabled?'รางวัล: '+carrots+' แครอท':'รอเปิดรับรางวัล: '+carrots+' แครอท'));
      const real=verifiedScores?.missions?.turns;
      const isVerified=Number.isSafeInteger(real)&&real>=0;
      const bar=el('progress');bar.max=turns;bar.value=isVerified?Math.min(real,turns):0;
      bar.setAttribute('aria-valuetext',isVerified?'ตรวจสอบแล้ว '+real+' เทิร์น':'ความคืบหน้ายังไม่ทราบ');card.append(bar);
      card.append(el('p','',(isVerified?real.toLocaleString('th-TH'):'—')+' / '+turns.toLocaleString('th-TH')+
        ' เทิร์น · '+(verifiedScores?.missions?.score_source==='owner_accepted_client_observation'
          ?'ยอดนับตามกติกาจำกัดปั๊มเทิร์น':isVerified?'ยืนยันจากเซิร์ฟเวอร์':'รอข้อมูลจริง')));
      const claim=el('button','cme-claim',claimed?'รับแล้ว ✓':pending?'ส่งคำขอแล้ว · รอแอดมิน':rejected?'ไม่ได้รับอนุมัติ':canClaim?(manualReview?'ยื่นขอรับ '+carrots+' แครอท':'กดรับ '+carrots+(virtual?' แครอทเสมือน':' แครอท')):'ยังไม่สามารถรับรางวัล');
      claim.type='button';claim.disabled=!canClaim;
      if(canClaim)claim.addEventListener('click',async()=>{
        const login=credentials();
        if(!eventData||verifiedScores?.missions?.event_id!==eventData.id)return;
        claim.disabled=true;
        try{
          const result=await requestClaim('turns-'+turns,login,manualReview);
          if(!manualReview&&virtual!==Boolean(result.virtual))throw Error('CARROT_MODE_MISMATCH');
          // Never update a local wallet balance. Reread the server's ledger state.
          if(sameLogin(login,credentials())){
            globalThis.toastr?.success?.(manualReview?(result.duplicate_after_credited?'คำขอนี้เคยได้รับรางวัลแล้ว และได้บันทึกให้แอดมินตรวจสอบ':'ส่งคำขอสำเร็จ รอแอดมิน Casa อนุมัติ'):virtual?'ทดลองรับแครอทเสมือนแล้ว ไม่ได้เพิ่มยอด Casa จริง':'รับแครอทเข้ากระเป๋า Casa เรียบร้อยแล้ว');
            if(manualReview)await refreshScoresOnly();else await refresh({force:true});
          }
        }catch(error){
          if(sameLogin(login,credentials()))
            globalThis.toastr?.warning?.(String(error?.message||'ไม่สามารถรับรางวัลได้').slice(0,150));
          claim.disabled=false;
        }
      });
      card.append(claim);
      content.append(card);
    }
  }else{
    if(isHalloween2026(cfg)){
      content.append(el('p','cme-raffle-note',
        '🎲 รางวัลทั้ง 3 ระดับใช้การสุ่มผู้โชคดี ไม่ใช่การแจกตามอันดับคะแนน ต้องมีเทิร์นสะสมอย่างน้อย 100 เทิร์นจึงมีสิทธิ์ร่วมสุ่ม เมื่อผ่านเกณฑ์แล้ว ยิ่งมีเทิร์นที่นับตามกติกามาก โอกาสในการสุ่มยิ่งเพิ่มขึ้น แต่ไม่ได้การันตีว่าจะได้รับรางวัล'));
    }
    for(let i=1;i<=3;i++){
      const row=el('article','cme-reward');
      row.append(el('span','cme-reward-icon',['🏆','🎁','🎀'][i-1]));
      const description=el('div');
      description.append(el('strong','',rewardTitle(cfg,i)));
      description.append(el('p','',cfg['reward'+i+'Description']||'รอประกาศของรางวัลจริง'));
      row.append(description,el('span','cme-status','รอประกาศ'));
      content.append(row);
    }
  }
  bodyNode.append(content);
}
// Read only already-server-validated Event scores. Never produce synthetic turns.
async function loadVerifiedScores(event,login,phase=eventPhase){
  const [usage,ranks,missions]=await Promise.all([
    requestJSON(API+'/usage/me',login),loadLeaderboardPage(event,login,phase,leaderboardPage),
    requestJSON(API+'/missions',login)
  ]);
  if([usage,ranks,missions].every(x=>x.event_id===event.id&&x.status!=='no_event')&&
    ((Number.isSafeInteger(usage.turns)&&usage.turns>=0&&
      Number.isSafeInteger(missions.turns)&&missions.turns===usage.turns)
      || (usage.risk_held===true&&missions.risk_held===true&&
          usage.turns===null&&missions.turns===null))&&
    Array.isArray(ranks.ranking)&&Array.isArray(missions.milestones)){
    return {usage,ranking:ranks.ranking,missions,board:ranks};
  }
  return null;
}
// A completed AI reply should update the scoreboard, not reload identity,
// Event Lorebooks and four WebP images on every single generated message.
async function refreshScoresOnly(){
  const event=eventData,login=credentials();
  if(!details?.open||!event||!['live','preview'].includes(eventPhase)||
      !sameLogin(lastReadyLogin,login))return;
  try{
    const scores=await loadVerifiedScores(event,login);
    if(!sameLogin(login,credentials())||eventData!==event||!details.open)return;
    verifiedScores=scores; // null is a fail-closed unknown score, never a made-up zero.
    render();
  }catch{/* Keep existing UI. Server unavailability never means virtual payout. */}
}
async function refresh({force=false}={}){
  const login=credentials();
  const now=Date.now()+offset;
  const validPhase=eventData && (
    eventPhase==='countdown'?now<Date.parse(eventData.starts_at):
    eventPhase==='preview'?now<Date.parse(eventData.starts_at):
    eventPhase==='live'?now<Date.parse(eventData.ends_at):false
  );
  const canReuse=Boolean(validPhase&&sameLogin(lastReadyLogin,login));
  // Instant open; a short per-session cache is only for display, not authorization.
  if(canReuse&&!force&&
     (Date.now()-lastReadyAt<UI_CACHE_MS)){
    if(eventPhase==='countdown')renderPublicCountdown();else render();
    return;
  }
  // Avoid duplicate Catta membership checks when focus/toggle events fire together.
  // A forced transition can still supersede an in-flight ordinary reload.
  if(!force&&sameLogin(inFlightLogin,login))return;
  const id=++sequence;
  if(!canReuse){
    clearTimers();clearImages();eventData=null;verifiedScores=null;observedTelemetry=null;
    clearReady();
    titleNode.textContent='Catta Monthly Events';
    showStatus('กำลังตรวจสอบสมาชิก Catta…');
  }
  if(!/^\d{15,22}$/.test(login.uid)||!login.token){
    clearReady();
    return showStatus('กรุณาเข้าสู่ระบบ Catta Cafe Hub ก่อนใช้งานอีเวนต์');
  }
  inFlightLogin={uid:login.uid,token:login.token};
  let pendingImageUrls=[];
  try{
    // Catta UI's tier is only a request hint: it NEVER grants Event access.
    // /monthly-event/me already verifies Catta membership server-to-server.
    // Avoid a duplicate browser call to /lorebook/me on each refresh.
    // Server rechecks Master/Boss through signed Dante on full-preview requests.
    const adminHint=/(?:^|,)ADMIN(?:,|$)/.test(String(globalThis.CattaUserTier||'').toUpperCase().replace(/\s/g,''));
    const verification=await requestJSON(API+'/me'+(adminHint?'?check_admin=1':''),login);
    if(id!==sequence)return;
    if(String(verification.user?.uid)!==login.uid)throw Error('MEMBER_MISMATCH');
    const current=await requestJSON(API+'/current'+(verification.role==='admin'?'?full_preview=1':''),login);
    if(id!==sequence)return;
    if(!sameLogin(login,credentials()))throw Error('MEMBER_SESSION_CHANGED');
    // Preserve old DOM and image URLs until all replacement data is ready.
    // Revoking blob URLs too early makes the banner/cards flash while loading.
    if(current.server_now)offset=Date.parse(current.server_now)-Date.now();
    if(current.status==='scheduled'&&current.event?.starts_at){
      // Do not load assets, missions, scores or lorebooks before opening.
      if(!generationBusy&&globalThis.SillyTavern?.getContext?.()?.chatMetadata?.[EVENT_CHAT_KEY]?.enabled){
        try{await world.disable();}catch{/* Do not activate any new Lorebook. */}
      }
      if(id!==sequence)return;
      clearTimers();clearImages();
      eventData=current.event;eventPhase='countdown';verifiedScores=null;observedTelemetry=null;
      previewRefreshTriggered=false;
      renderPublicCountdown();markReady(login);return;
    }
    if(!['active','preview'].includes(current.status)||!current.event){
      if(!generationBusy&&current.status==='no_event'){
        // Ended/unpublished Events must not keep injecting World Info forever.
        try{await world.disable();}catch{/* preserve binding if ST unavailable */}
      }
      clearTimers();clearImages();clearReady();
      eventData=null;verifiedScores=null;observedTelemetry=null;
      return showStatus('ยังไม่มีอีเวนต์ที่เปิดใช้งาน');
    }
    if(current.server_now)offset=Date.parse(current.server_now)-Date.now();
    const nextEvent=current.event;
    const nextPhase=current.status==='preview'?'preview':'live';
    let nextTelemetry=null;
    if(nextPhase==='preview'){
      try{
        const o=await requestJSON(API+'/client-observations/me',login);
        if(o?.event_id===nextEvent.id&&o.trust==='client_observed_unverified'&&
           o.eligible_for_rewards===false&&
           Number.isSafeInteger(o.observed_turns)&&o.observed_turns>=0)nextTelemetry=o;
      }catch{/* A telemetry diagnostic must not block the Event UI. */}
    }
    if(id!==sequence)return;
    // Fetch replacements while the old verified DOM and its blob URLs stay alive.
    const imageSlots=['banner',...SLOTS].filter(slot=>nextEvent.images?.[slot]);
    pendingImageUrls=await Promise.all(imageSlots.map(async slot=>{
      try{return [slot,await getImage(nextEvent.images[slot],login)];}
      catch{return [slot,null];}
    }));
    if(id!==sequence)return;
    if(eventData?.id!==nextEvent.id||eventPhase!==nextPhase)clearLeaderboardCache();
    let nextScores=null;
    try{nextScores=await loadVerifiedScores(nextEvent,login,nextPhase);}
    catch{/* No synthetic zero or rank; scores remain unknown. */}
    if(id!==sequence)return;
    // Update the volatile Event Lorebook without overwriting any personal World Info.
    if(!generationBusy){
      try{await world.refreshIfChanged(nextEvent);}
      catch{/* A failed lore update never grants unverified scores or privileges. */}
    }
    if(id!==sequence)return;
    if(!sameLogin(login,credentials()))throw Error('MEMBER_SESSION_CHANGED');
    clearTimers();clearImages();
    eventData=nextEvent;eventPhase=nextPhase;
    verifiedScores=nextScores;observedTelemetry=nextTelemetry;
    previewRefreshTriggered=false;
    for(const [slot,url] of pendingImageUrls)if(url)objectUrls.set(slot,url);
    pendingImageUrls=[]; // ownership transferred to objectUrls
    titleNode.textContent=nextEvent.settings?.title||'Catta Monthly Events';
    render();
    markReady(login);
  }catch{
    if(id===sequence){
      clearTimers();clearImages();eventData=null;verifiedScores=null;observedTelemetry=null;
      clearReady();
      showStatus('ไม่สามารถยืนยันข้อมูลอีเวนต์จากเซิร์ฟเวอร์ได้ กรุณาลองอีกครั้งภายหลัง');
    }
  }finally{
    // Revoke only downloads which were not committed to this UI.
    for(const [,url] of pendingImageUrls)if(url)URL.revokeObjectURL(url);
    if(id===sequence)inFlightLogin=null;
  }
}
async function backgroundLorebookSync({duringGeneration=false}={}){
  const ctx=globalThis.SillyTavern?.getContext?.();
  const saved=ctx?.chatMetadata?.[EVENT_CHAT_KEY];
  if(!saved?.enabled||world.snapshot().busy||(!duringGeneration&&generationBusy))return;
  const startChatId=ctx.chatId;
  const login=credentials();
  if(!/^\d{15,22}$/.test(login.uid)||!login.token){world.forget();return;}
  try{
    const response=await requestJSON(API+'/current',login);
    if(globalThis.SillyTavern?.getContext?.()?.chatId!==startChatId)return;
    if(['active','preview'].includes(response?.status)&&response.event?.id===saved.eventId){
      await world.refreshIfChanged(response.event);
    }else if(response?.status==='no_event'||response?.status==='scheduled'){
      await world.disable();
    }
  }catch{world.forget();/* Offline means no Event prompt/score, never stale lore. */}
}
function start(){
  if(document.getElementById(ID))return;
  const target=document.getElementById('extensions_settings');
  if(!target)return;
  holder=el('section','extension_container cme-release');holder.id=ID;
  details=el('details');
  const summary=el('summary','cme-summary');
  summary.append(el('span','','🎃'));
  titleNode=el('strong','','Catta Monthly Events');
  summary.append(titleNode);details.append(summary);
  bodyNode=el('div','cme-body');details.append(bodyNode);
  holder.append(details);target.append(holder);
  details.addEventListener('toggle',()=>{if(details.open)void refresh();});
  window.addEventListener('focus',()=>{
    void observedMeter.flush();
    if(details.open)void refresh();else void backgroundLorebookSync();
  });
  window.addEventListener('storage',e=>{
    if(e.key==='catta_uid'||e.key==='catta_auth_token'){
      world.forget();observedMeter.reset();clearLeaderboardCache();
      sequence++;clearImages();clearTimers();eventData=null;verifiedScores=null;observedTelemetry=null;clearReady();
      showStatus('กรุณายืนยันบัญชี Catta อีกครั้ง');
      if(details.open)void refresh();
    }
  });
  boardTimer=setInterval(()=>{
    if(!boardBusy&&details?.open&&selection==='leaderboard'&&eventData&&
       verifiedScores?.board&&eventPhase!=='countdown'){
      const login=credentials();
      if(!cachedLeaderboard(eventData,login,eventPhase,leaderboardPage)){
        void refreshScoresOnly();
      }
    }
  },60_000);
  window.addEventListener('pagehide',()=>{
    world.forget();observedMeter.dispose();sequence++;
    clearImages();clearTimers();clearReady();clearLeaderboardCache();
    if(boardTimer){clearInterval(boardTimer);boardTimer=null;}
  });
  const context=globalThis.SillyTavern?.getContext?.();
  // SillyTavern publishes event_types (snake_case); allow older aliases.
  const types=context?.event_types||context?.eventTypes;
  // Rehydrate memory-only lore after a browser reload, without persisting JSON.
  if(context?.chatMetadata?.[EVENT_CHAT_KEY]?.enabled)void backgroundLorebookSync();
  if(context?.eventSource?.on&&types){
    if(types.CHAT_CHANGED)context.eventSource.on(types.CHAT_CHANGED,()=>{
      world.forget();
      observedMeter.stopped();
      if(details.open)void refresh();else void backgroundLorebookSync();
    });
    if(types.GENERATION_STARTED)context.eventSource.on(types.GENERATION_STARTED,()=>{
      world.updatePrompt();
      generationBusy=true;
      observedMeter.start();
    });
    if(types.MESSAGE_SENT)context.eventSource.on(types.MESSAGE_SENT,()=>world.updatePrompt());
    if(types.MESSAGE_RECEIVED)context.eventSource.on(types.MESSAGE_RECEIVED,(messageId)=>{
      observedMeter.received(messageId);
    });
    if(types.GENERATION_ENDED)context.eventSource.on(types.GENERATION_ENDED,()=>{
      generationBusy=false;
      void (async()=>{
        await observedMeter.ended();
        if(details.open)await refreshScoresOnly();
        else await backgroundLorebookSync();
      })();
    });
    if(types.GENERATION_STOPPED)context.eventSource.on(types.GENERATION_STOPPED,()=>{
      generationBusy=false;
      observedMeter.stopped();
    });
  }
}
globalThis.cattaEventVolatileLoreInterceptor=async function(chat){
  if(!world.snapshot().enabled)await backgroundLorebookSync({duringGeneration:true});
  world.updatePrompt(chat);
};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});
else start();
