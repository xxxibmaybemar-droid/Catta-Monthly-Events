// Catta Monthly Events: volatile prompt-only Lorebook runtime.
// NEVER call SillyTavern saveWorldInfo(); no user-visible World Info book.
// This is a retention/UX improvement, NOT confidentiality from client DevTools.
// Metadata stores only event/book IDs, revisions, and a boolean (never content).
export const EVENT_CHAT_KEY='catta_monthly_events_beta_chat_v1';
export const EVENT_PROMPT_TAG='catta_monthly_events_volatile_lore';
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const LEGACY_NAME=/^Catta Event [a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}-[a-f0-9]{16}$/i;
const MAX_ENTRIES=2000;
const MAX_PROMPT_CHARS=30000;
const loginValid=login=>/^\d{15,22}$/.test(login?.uid||'')&&
  typeof login?.token==='string'&&!!login.token;
const normal=x=>String(x??'').trim();
const validLegacyName=name=>typeof name==='string'&&LEGACY_NAME.test(name);
const keyOf=ctx=>String(ctx?.characterId??'')+'\u001f'+String(ctx?.chatId??'');
function rowsOf(book){
  if(!book||typeof book!=='object'||Array.isArray(book))throw Error('LOREBOOK_INVALID');
  const obj=book.entries;
  if(!obj||typeof obj!=='object'||Array.isArray(obj)&&obj.length===0)
    throw Error('LOREBOOK_INVALID');
  const rows=Array.isArray(obj)?obj:Object.values(obj);
  if(!rows.length||rows.length>MAX_ENTRIES||
     rows.some(e=>!e||typeof e!=='object'||Array.isArray(e)||
      typeof e.content!=='string'))
    throw Error('LOREBOOK_ENTRIES_INVALID');
  return rows;
}
function scanText(chat){
  const messages=Array.isArray(chat)?chat:[];
  // Approximate native WI keyword scanning in-memory. Never persist chat text.
  return messages.slice(-12).map(item=>{
    if(typeof item==='string')return item;
    return typeof item?.mes==='string'?item.mes:
      typeof item?.content==='string'?item.content:'';
  }).join('\n').slice(-24000);
}
function matches(entry,history){
  if(entry.disable===true)return false;
  if(entry.constant===true)return true;
  const keys=Array.isArray(entry.key)?entry.key:[];
  const clean=keys.filter(x=>typeof x==='string'&&x.trim());
  if(!clean.length)return false;
  const text=entry.caseSensitive?history:history.toLocaleLowerCase();
  const found=clean.some(k=>{
    const needle=entry.caseSensitive?k:k.toLocaleLowerCase();
    // Avoid regex metacharacters from user-editable Lorebooks.
    if(entry.matchWholeWords){
      const start=0;let at=text.indexOf(needle,start);
      while(at>=0){
        const before=at===0?'':text[at-1];
        const after=text[at+needle.length]||'';
        if(!/[\p{L}\p{N}_]/u.test(before)&&!/[\p{L}\p{N}_]/u.test(after))return true;
        at=text.indexOf(needle,at+needle.length);
      }
      return false;
    }
    return text.includes(needle);
  });
  if(!found)return false;
  const secondary=Array.isArray(entry.keysecondary)?
    entry.keysecondary.filter(x=>typeof x==='string'&&x.trim()):[];
  if(!entry.selective||secondary.length===0)return true;
  const hits=secondary.map(k=>text.includes(entry.caseSensitive?k:k.toLocaleLowerCase()));
  // ST AND_ANY (0), AND_ALL (1), NOT_ANY (2), NOT_ALL (3).
  switch(entry.selectiveLogic){
    case 1:return hits.every(Boolean);
    case 2:return !hits.some(Boolean);
    case 3:return !hits.every(Boolean);
    default:return hits.some(Boolean);
  }
}
export function composeVolatileLore(entries,chat){
  if(!Array.isArray(entries))throw Error('LOREBOOK_ENTRIES_INVALID');
  const context=scanText(chat);
  const active=entries.filter(e=>matches(e,context))
    .sort((a,b)=>(Number(b.order)||0)-(Number(a.order)||0));
  let prompt='';
  for(const item of active){
    const content=normal(item.content);
    if(!content)continue;
    if(prompt.length+content.length+2>MAX_PROMPT_CHARS)continue;
    prompt+= (prompt?'\n\n':'')+content;
  }
  return prompt;
}
async function defaultLegacyDelete(name,ctx,fetcher){
  if(!validLegacyName(name))throw Error('NON_EVENT_LOREBOOK_DELETE_DENIED');
  // Use ST's own CSRF headers; never carry Cafe Hub credentials here.
  const module=await import('/script.js');
  if(typeof module.getRequestHeaders!=='function')throw Error('ST_CSRF_HEADERS_UNAVAILABLE');
  const r=await fetcher('/api/worldinfo/delete',{
    method:'POST',headers:module.getRequestHeaders(),
    body:JSON.stringify({name}),cache:'no-store',credentials:'same-origin'
  });
  if(!r.ok)throw Error('OLD_EVENT_LOREBOOK_DELETE_FAILED');
  await ctx.updateWorldInfoList?.();
}
async function defaultListLegacyWorlds(ctx,fetcher){
  const module=await import('/script.js');
  if(typeof module.getRequestHeaders!=='function')throw Error('ST_CSRF_HEADERS_UNAVAILABLE');
  const response=await fetcher('/api/settings/get',{
    method:'POST',headers:module.getRequestHeaders(),body:JSON.stringify({}),
    cache:'no-store',credentials:'same-origin'
  });
  if(!response.ok)throw Error('ST_WORLD_INFO_LIST_UNAVAILABLE');
  const data=await response.json();
  if(!Array.isArray(data.world_names))throw Error('ST_WORLD_INFO_LIST_INVALID');
  return data.world_names;
}
export function createEventLorebookSync({
  getContext,credentials,baseUrl,fetcher=globalThis.fetch,
  removeLegacyWorld=defaultLegacyDelete,
  listLegacyWorlds=defaultListLegacyWorlds
}){
  if(typeof getContext!=='function'||typeof credentials!=='function')
    throw TypeError('MISSING_CONTEXT');
  const origin=new URL(baseUrl).origin;
  if(!origin.startsWith('https://'))throw Error('HTTPS_ONLY');
  let busy=false,lastError=null,memory=null;
  const context=()=>getContext();
  function clearPrompt(ctx=context()){
    // Emptying our private prompt key must never touch other extensions' prompts.
    if(typeof ctx?.setExtensionPrompt==='function')
      ctx.setExtensionPrompt(EVENT_PROMPT_TAG,'',0,0);
  }
  function forget(){
    const prev=memory;memory=null;
    clearPrompt();
    return !!prev;
  }
  function snapshot(){
    const ctx=context(),saved=ctx?.chatMetadata?.[EVENT_CHAT_KEY];
    const active=!!(ctx?.chatId&&saved?.enabled&&saved.mode==='volatile'&&
      memory?.chatKey===keyOf(ctx)&&memory?.eventId===saved.eventId);
    return {busy,enabled:active,eventId:active?memory.eventId:null,
      revision:active?memory.revision:0,lastError};
  }
  async function downloadBook(eventId,bookId,login){
    const response=await fetcher(origin+'/v1/monthly-event/books/'+eventId+'/'+bookId,{
      method:'GET',headers:{'x-uid':login.uid,'x-token':login.token},
      credentials:'omit',cache:'no-store',redirect:'error',
      signal:AbortSignal.timeout(14000)
    });
    if(!response.ok)throw Error('EVENT_LOREBOOK_DOWNLOAD_FAILED');
    const data=await response.json();
    if(data?.success!==true)throw Error('EVENT_LOREBOOK_INVALID');
    return data.book;
  }
  function validateEvent(event){
    if(!event||!ID.test(event.id)||!Number.isInteger(event.version)||event.version<1)
      throw Error('EVENT_NOT_PUBLISHED');
    if(!Array.isArray(event.lorebooks)||!event.lorebooks.length||
      event.lorebooks.length>3)throw Error('EVENT_LOREBOOKS_UNAVAILABLE');
    if(event.lorebooks.some(x=>!ID.test(x.id)||!Number.isInteger(x.revision)||
      x.revision<1))throw Error('EVENT_LOREBOOK_REVISION_INVALID');
  }
  async function removeLegacy(ctx,saved){
    // Names and IDs belong solely to older Catta-generated files.
    const oldName=saved?.bookName;
    if(!validLegacyName(oldName))return false;
    if(ctx?.chatMetadata?.world_info!==oldName)return false;
    // Detach from chat before deleting. Do not delete a player's other book.
    delete ctx.chatMetadata.world_info;
    try{await ctx.saveMetadata();}
    catch(e){ctx.chatMetadata.world_info=oldName;throw e;}
    await removeLegacyWorld(oldName,ctx,fetcher);
    return true;
  }
  async function install(event,ids){
    if(busy)throw Error('EVENT_SYNC_BUSY');
    validateEvent(event);
    if(!Array.isArray(ids)||!ids.length||ids.length>3||
      new Set(ids).size!==ids.length||
      ids.some(id=>!event.lorebooks.some(b=>b.id===id)))
      throw Error('INVALID_EVENT_BOOK_SELECTION');
    const ctx=context();
    if(!ctx?.chatId||ctx.groupId||!ctx.chatMetadata||
      typeof ctx.saveMetadata!=='function'||typeof ctx.setExtensionPrompt!=='function')
      throw Error('VOLATILE_PROMPT_API_UNAVAILABLE');
    const login=credentials();
    if(!loginValid(login))throw Error('CAFE_HUB_LOGIN_REQUIRED');
    const chatKey=keyOf(ctx),meta=ctx.chatMetadata;
    const prior=meta[EVENT_CHAT_KEY];
    // Native user World Info may coexist with our independent volatile prompt.
    // We never change a personal world_info binding.
    busy=true;lastError=null;
    try{
      if(prior?.bookName&&validLegacyName(prior.bookName)){
        await removeLegacy(ctx,prior);
        // A file saved by an older release has now been deleted via ST API.
      }
      const books=event.lorebooks.filter(b=>ids.includes(b.id));
      const entries=[];
      for(const book of books){
        const rows=rowsOf(await downloadBook(event.id,book.id,login));
        entries.push(...rows);
        if(entries.length>MAX_ENTRIES)throw Error('EVENT_LOREBOOK_TOO_LARGE');
      }
      if(context()?.chatMetadata!==meta||keyOf(context())!==chatKey)
        throw Error('EVENT_CHAT_CHANGED');
      const fresh=credentials();
      if(!loginValid(fresh)||fresh.uid!==login.uid||fresh.token!==login.token)
        throw Error('CAFE_HUB_SESSION_CHANGED');
      const next={enabled:true,mode:'volatile',eventId:event.id,bookIds:ids,
        revision:event.version,
        bookRevisions:Object.fromEntries(books.map(x=>[x.id,x.revision]))};
      const before=meta[EVENT_CHAT_KEY];
      meta[EVENT_CHAT_KEY]=next;
      try{await ctx.saveMetadata();}
      catch(e){if(before===undefined)delete meta[EVENT_CHAT_KEY];
               else meta[EVENT_CHAT_KEY]=before;throw e;}
      memory={chatKey,eventId:event.id,revision:event.version,entries};
      updatePrompt(ctx.chat);
      return {ok:true,revision:event.version,books:ids.length,entries:entries.length};
    }catch(e){lastError=String(e?.message||'EVENT_SYNC_FAILED');forget();throw e;}
    finally{busy=false;}
  }
  function updatePrompt(chat){
    const ctx=context(),metadata=ctx?.chatMetadata?.[EVENT_CHAT_KEY];
    if(!ctx?.chatId||!metadata?.enabled||metadata.mode!=='volatile'||
      !memory||keyOf(ctx)!==memory.chatKey||metadata.eventId!==memory.eventId){
      clearPrompt(ctx);return false;
    }
    if(typeof ctx.setExtensionPrompt!=='function'){
      forget();return false;
    }
    ctx.setExtensionPrompt(EVENT_PROMPT_TAG,composeVolatileLore(memory.entries,chat??ctx.chat),0,0);
    return true;
  }
  async function disable(){
    if(busy)throw Error('EVENT_SYNC_BUSY');
    const ctx=context(),meta=ctx?.chatMetadata;
    if(!ctx?.chatId||!meta||typeof ctx.saveMetadata!=='function')
      throw Error('CHAT_UNAVAILABLE');
    const saved=meta[EVENT_CHAT_KEY];
    if(!saved?.enabled){forget();return {ok:true};}
    if(saved.bookName&&validLegacyName(saved.bookName)){
      await removeLegacy(ctx,saved);
    }
    delete meta[EVENT_CHAT_KEY];
    try{await ctx.saveMetadata();}
    catch(e){meta[EVENT_CHAT_KEY]=saved;throw e;}
    forget();
    return {ok:true};
  }
  async function refreshIfChanged(event){
    const ctx=context(),saved=ctx?.chatMetadata?.[EVENT_CHAT_KEY];
    if(!saved?.enabled||saved.eventId!==event?.id){
      forget();return {ok:false,skipped:true};
    }
    const selected=(saved.bookIds||[]).filter(id=>
      event?.lorebooks?.some(b=>b.id===id));
    if(!selected.length||selected.length!==(saved.bookIds||[]).length){
      lastError='EVENT_SELECTED_BOOK_REVOKED';forget();
      return {ok:false,stale:true};
    }
    const newer=event?.lorebooks?.some(b=>selected.includes(b.id)&&
      saved.bookRevisions?.[b.id]!==b.revision);
    if(!memory||memory.chatKey!==keyOf(ctx)||saved.mode!=='volatile'||
      newer||saved.revision!==event.version){
      return install(event,selected);
    }
    updatePrompt(ctx.chat);
    return {ok:true,unchanged:true};
  }
  async function cleanupLegacyGeneratedWorlds(confirmCleanup=globalThis.confirm){
    // Explicit user approval for deleting older persistent Event-owned files.
    // NEVER match ordinary user World Info, even if it contains Catta in its title.
    if(busy)throw Error('EVENT_SYNC_BUSY');
    const ctx=context();
    const names=await listLegacyWorlds(ctx,fetcher);
    if(!Array.isArray(names))throw Error('ST_WORLD_INFO_LIST_INVALID');
    const targets=[...new Set(names.filter(validLegacyName))];
    if(!targets.length)return {deleted:0,found:0};
    const message='ลบไฟล์ World Info กิจกรรมรุ่นเก่า '+targets.length+
      ' ไฟล์ออกจาก SillyTavern ถาวรหรือไม่?\n'+
      targets.slice(0,8).join('\n')+
      (targets.length>8?'\n...':'')+
      '\nจะไม่ลบ Lorebook อื่นของคุณ';
    if(typeof confirmCleanup!=='function'||confirmCleanup(message)!==true)
      return {deleted:0,found:targets.length,cancelled:true};
    let count=0;
    for(const name of targets){
      const metadata=ctx?.chatMetadata;
      if(metadata?.world_info===name &&
         metadata?.[EVENT_CHAT_KEY]?.bookName===name){
        const before=metadata[EVENT_CHAT_KEY];
        delete metadata.world_info;delete metadata[EVENT_CHAT_KEY];
        try{await ctx.saveMetadata();}
        catch(e){metadata.world_info=name;metadata[EVENT_CHAT_KEY]=before;throw e;}
      }
      await removeLegacyWorld(name,ctx,fetcher);
      count++;
    }
    forget();
    return {deleted:count,found:targets.length};
  }
  return {snapshot,install,disable,refreshIfChanged,updatePrompt,forget,
    cleanupLegacyGeneratedWorlds};
}
