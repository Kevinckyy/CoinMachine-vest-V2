/* Runs in the page world before Vest starts. Observe only the native, complete active-account GET. */
(() => {
  'use strict';
  if (Object.hasOwn(window,'vestFleetActiveAccountsV1')) return;
  let snapshot = null, sequence = 0, pendingAt = null;
  const endpoint = 'https://api-gateway.hz.vestmarkets.com/v3/capital/accounts/active';
  const money = value => (typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) &&
    Number.isFinite(Number(value)) && Number(value)>=0 && Number(value)<=1e12 ? Number(value) : null;
  function matches(url) {
    try { return new URL(url,location.href).href === endpoint; } catch { return false; }
  }
  function accept(payload, ticket, at) {
    if (ticket !== sequence) return;
    pendingAt = null;
    snapshot = null;
    if (!Array.isArray(payload?.accounts) || payload.accounts.length>500 || payload.next_cursor || payload.has_more) return;
    const rows = [], ids = new Set();
    for (const raw of payload.accounts) {
      if (!raw || typeof raw.id!=='string' || !raw.id || raw.id.length>160 || ids.has(raw.id)) return;
      ids.add(raw.id);
      // Vest Capital types 2/3 and stages 1/2 denote Evaluation and Funded.
      const type = raw.account_type, status = raw.status;
      if (type===1 || type===8) continue;
      if (![2,3].includes(type) || ![1,2,3,4,5,6,7].includes(status)) return;
      if (status!==2 || raw.blocked_at) continue;
      const live = type===3;
      if (raw.stage!==(live?2:1)) return;
      const step = raw.step ?? 1, steps = raw.steps_total ?? 1;
      const phase = live ? 'live' : steps===2 && [1,2].includes(step) ? step+'/2' : null;
      const index = raw.attempt_index;
      const name = Number.isSafeInteger(index) && index>=0 ? 'Account '+String(index+1).padStart(2,'0') : 'Legacy Account';
      const rate = money(raw.max_daily_loss_pct);
      rows.push({id:raw.id,name,phase,category:live?'funded':'eval',daily_unlimited:rate===0,
        daily_floor:rate===0 ? null : money(raw.daily_loss_floor),max_drawdown_floor:money(raw.max_drawdown_limit),
        daily_reset_equity:money(raw.daily_reset_balance) || null});
    }
    snapshot={at,rows};
  }
  // The extension reads a copy from the exact bound document. No request headers, tokens,
  // page functions, or unrelated response bodies are passed across worlds.
  Object.defineProperty(window,'vestFleetActiveAccountsV1',{value:(timingOnly=false) => {
    if (timingOnly) return {at:snapshot?.at ?? null,pending_at:pendingAt};
    if (!snapshot) return null;
    const selected = new Set();
    for (let i=0;i<sessionStorage.length;i++) {
      const key=sessionStorage.key(i);
      if (key?.startsWith('vest-active-account:')) {
        const id=sessionStorage.getItem(key);
        if (id) selected.add(id);
      }
    }
    return {...structuredClone(snapshot),selected:selected.size===1 ? [...selected][0] : null};
  }});
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method,url,...rest) {
    const result = open.call(this,method,url,...rest);
    if (String(method).toUpperCase()==='GET' && matches(url)) {
      const ticket=++sequence, at=Date.now()/1000;
      snapshot=null;
      pendingAt=at;
      this.addEventListener('loadend',()=>{
        if (ticket!==sequence) return;
        try {
          const ok=this.status===200 && matches(this.responseURL);
          accept(ok ? (this.responseType==='json'?this.response:JSON.parse(this.responseText)) : null,ticket,at);
        } catch { accept(null,ticket,at); }
      },{once:true});
    }
    return result;
  };
  const fetch = window.fetch;
  window.fetch = function(input,init) {
    const result=fetch.apply(this,arguments);
    if (String(init?.method ?? input?.method ?? 'GET').toUpperCase()==='GET' && matches(input?.url ?? input)) {
      const ticket=++sequence, at=Date.now()/1000;
      snapshot=null;
      pendingAt=at;
      result.then(async response=>{
        const body=response.status===200 && matches(response.url) ? await response.clone().json() : null;
        accept(body,ticket,at);
      }).catch(()=>accept(null,ticket,at));
    }
    return result;
  };
})();
