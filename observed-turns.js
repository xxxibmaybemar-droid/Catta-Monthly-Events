// Client-observed turns for SillyTavern when the member uses their OWN AI API.
// These records are NEVER cryptographically trusted and NEVER authorize prizes.
// Official ST events can fire on failures. Require START + RECEIVED + END,
// then inspect the actual assistant message and an active volatile Event Lorebook.
import {EVENT_CHAT_KEY} from './lorebook-sync.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER=/^\d{15,22}$/;
const HASH=/^[a-f0-9]{64}$/;
const MAX_QUEUE=40;
const MAX_CACHE=1024;

function binding(context){
  const selection=context?.chatMetadata?.[EVENT_CHAT_KEY];
  if(!selection?.enabled||!UUID.test(selection.eventId)||!context?.chatId||
     context.groupId||selection.mode!=='volatile'||!Array.isArray(selection.bookIds)||
     selection.bookIds.length<1||selection.bookIds.length>3||
     selection.bookIds.some(id=>!UUID.test(id)))return null;
  return {eventId:selection.eventId,chatId:String(context.chatId),
    characterId:String(context.characterId??''),
    bookIds:[...selection.bookIds].sort()};
}
function equalBinding(a,b){
  return !!a&&!!b&&a.eventId===b.eventId&&a.chatId===b.chatId&&
    a.characterId===b.characterId&&
    a.bookIds.join(',')===b.bookIds.join(',');
}
function messageAt(context,index){
  if(!Number.isSafeInteger(index)||index<0||!Array.isArray(context?.chat)||
     index>=context.chat.length)return null;
  const msg=context.chat[index];
  // MESSAGE_RECEIVED alone is not proof of completion, and system/user
  // messages, empty output, manual edits, and failed/stopped runs do not count.
  if(!msg||msg.is_user!==false||msg.is_system===true||
     typeof msg.mes!=='string'||!msg.mes.trim())return null;
  return msg;
}
async function digest(value){
  const data=new TextEncoder().encode(value);
  const buf=await globalThis.crypto.subtle.digest('SHA-256',data);
  return Array.from(new Uint8Array(buf),x=>x.toString(16).padStart(2,'0')).join('');
}
function validLogin(login){
  return USER.test(login?.uid??'')&&typeof login?.token==='string'&&login.token.length>0;
}

export function createObservedTurnMeter({
  getContext,credentials,report,isEventActive,clock=()=>Date.now(),uuid=()=>globalThis.crypto.randomUUID(),
}){
  if(typeof getContext!=='function'||typeof credentials!=='function'||
     typeof report!=='function'||typeof isEventActive!=='function')
    throw TypeError('METER_DEPENDENCIES_REQUIRED');
  let run=null,disposed=false,flushing=false;
  const seen=new Set(),pending=[];
  const metrics={observed:0,queued:0,delivered:0,duplicates:0,rejected:0};
  function clearRun(){run=null;}
  // A chat metadata flag is not proof that the volatile Event Lorebook is active.
  // Only the loaded, active in-memory Event prompt can qualify a reply.
  const activeBinding=ctx=>isEventActive()?binding(ctx):null;
  function start(){
    if(disposed)return;
    // Reject overlapping starts: if previous completion never reached END
    // there is no client-observed completed turn to report for that run.
    const context=getContext(),selected=activeBinding(context),login=credentials();
    run=selected&&validLogin(login)&&typeof context?.chat?.length==='number'
      ?{selected,uid:login.uid,token:login.token,at:clock(),baseline:context.chat.length,got:null,stopped:false}
      :null;
  }
  function received(index){
    if(disposed||!run||run.stopped)return;
    const context=getContext(),selected=activeBinding(context);
    if(!equalBinding(run.selected,selected))return clearRun();
    // Official MESSAGE_RECEIVED uses a chat-index argument on common ST
    // releases. If a future version changes it, FAIL CLOSED rather than
    // guessing which message to credit.
    const value=typeof index==='number'?index:
      (typeof index==='string'&&/^\d+$/.test(index)?Number(index):NaN);
    // Existing assistant messages and swipe/regeneration of the same slot
    // do not earn another turn. Require an assistant message newly appended.
    if(!Number.isSafeInteger(value)||value<run.baseline||!messageAt(context,value))return;
    if(run.got!==null&&run.got!==value)return clearRun();
    run.got=value;
  }
  function stopped(){if(run)run.stopped=true;clearRun();}
  async function ended(){
    if(disposed||!run)return;
    const completed=run;clearRun();
    const context=getContext(),selected=activeBinding(context),login=credentials();
    if(completed.stopped||completed.got===null||!equalBinding(completed.selected,selected)||
       !validLogin(login)||login.uid!==completed.uid||login.token!==completed.token||
       !messageAt(context,completed.got))return;
    const end=clock();
    if(!Number.isFinite(end)||end<completed.at||end-completed.at>15*60*1000)return;
    // Deterministic per-chat/per-assistant-index key collapses swipes and
    // the same reply replayed after a reload. This is still client-controlled!
    let key;
    try{key=await digest(completed.uid+'\n'+selected.eventId+'\n'+
      selected.characterId+'\n'+selected.chatId+'\n'+completed.got);}catch{metrics.rejected++;return;}
    if(disposed||!equalBinding(selected,activeBinding(getContext()))||
       !validLogin(credentials())||credentials().uid!==completed.uid)return;
    if(!HASH.test(key))return;
    if(seen.has(key)){metrics.duplicates++;return;}
    seen.add(key);
    if(seen.size>MAX_CACHE)seen.delete(seen.values().next().value);
    if(pending.length>=MAX_QUEUE){metrics.rejected++;return;}
    const attemptId=uuid();
    if(!UUID.test(attemptId)){metrics.rejected++;return;}
    pending.push({
      login:{uid:completed.uid,token:completed.token},
      observation:{
        event_id:selected.eventId,attempt_id:attemptId,assistant_key:key,
        book_ids:selected.bookIds,started_at:Math.floor(completed.at/1000),
        ended_at:Math.floor(end/1000)
      },
    });
    metrics.observed++;metrics.queued=pending.length;
    await flush();
  }
  async function flush(){
    if(disposed||flushing)return;
    flushing=true;
    try{
      while(!disposed&&pending.length){
        const next=pending[0],login=credentials();
        // A user switch MUST NOT send an observation with another account.
        if(!validLogin(login)||login.uid!==next.login.uid||
           login.token!==next.login.token)break;
        try{
          const ack=await report(next.observation,next.login);
          if(ack?.success!==true||ack?.trust!=='client_observed_unverified'||
             ack?.eligible_for_rewards!==false)break;
          pending.shift();metrics.delivered++;
          metrics.queued=pending.length;
        }catch{break;} // retry ONLY after focus/next successful generation
      }
    }finally{flushing=false;}
  }
  function snapshot(){return {...metrics,queued:pending.length,active:!!run};}
  function reset(){run=null;pending.length=0;seen.clear();}
  function dispose(){disposed=true;reset();}
  return {start,received,ended,stopped,flush,snapshot,reset,dispose};
}
