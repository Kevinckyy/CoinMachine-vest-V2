// Two real services and a real unpacked extension. All Vest documents are fulfilled locally.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createHash, generateKeyPairSync, randomBytes, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import '../extension/stop-protection.js';
import '../extension/core.js';

const stopJob = {id:'example',type:'open',account_id:'demo',side:'buy',symbol:'NQ-PERP',size_percent:25,
  stop_buffer:20,stop_loss:null,stop_omitted:true,remaining_drawdown:150,omit_stop_below:150.01};
const stopAccount = {accountId:'demo',accountName:'Demo',accountCategory:'eval'};
assert.equal(VestBridgeCore.validateJob(stopJob,stopAccount),stopJob);
assert.throws(()=>VestBridgeCore.validateJob({...stopJob,omit_stop_below:150},stopAccount),/stop_loss/);
assert.throws(()=>VestBridgeCore.validateJob({...stopJob,stop_omitted:false},stopAccount),/stop_loss/);
assert.equal(VestStopProtection.plan({native_sl_absent:true,native_sl_price:null},null).status,'omitted');
for (const [side,trigger] of [['buy',20005.25],['sell',19994.75]]) {
  const checked=VestStopProtection.plan({side,quantity:6,entry_price:20000,native_tp_price:trigger},30.1,'tp',true,30.1);
  assert.equal(checked.status,'verified');
  assert.ok(checked.actual_profit>=30.1);
}

for (const [side,quantity,trigger] of [['buy',2,19930],['sell',2,20070],['buy',6,19976.75],['sell',6,20023.25]]) {
  const position={side,quantity,entry_price:20000,native_sl_price:trigger};
  const check=globalThis.VestStopProtection.plan(position,140,'sl',true);
  assert.equal(check.status,'verified');
  assert.equal(check.target_price,trigger);
  assert.ok(check.actual_risk<=140 && 140-check.actual_risk<quantity*0.25);
  const uncorrected={...position,native_sl_price:trigger+(side==='buy'?-0.25:0.25)};
  assert.equal(globalThis.VestStopProtection.plan(uncorrected,140,'sl',true).status,'mismatch');
}

const root=fileURLToPath(new URL('../',import.meta.url));
const browser=process.env.VEST_TEST_BROWSER || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium','/usr/bin/google-chrome'
].find(existsSync);
if (!browser) throw Error('Set VEST_TEST_BROWSER to a Chromium or Edge executable');
const tmp=await mkdtemp(path.join(tmpdir(),'vest-fleet-smoke-'));
const services=[], sockets=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=25000) {
  const end=Date.now()+timeout;
  let reason='';
  while (Date.now()<end) {
    try {const v=await fn();if(v)return v;} catch(err){reason=err.message;}
    await sleep(180);
  }
  throw Error('Timeout: '+label+' '+reason);
}
async function port() {
  const s=createServer();
  await new Promise(r=>s.listen(0,'127.0.0.1',r));
  const n=s.address().port;await new Promise(r=>s.close(r));return n;
}
function launch(file,args,env={}) {
  const child=spawn(file,args,{cwd:root,windowsHide:true,env:{...process.env,...env},stdio:'ignore'});
  services.push(child);return child;
}
async function cdp(url) {
  const ws=new WebSocket(url);
  await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no;});sockets.push(ws);
  let id=0;const pending=new Map(),events=new Map();
  ws.onmessage=e=>{
    const p=JSON.parse(e.data);
    if(p.id && pending.has(p.id)) {
      const {ok,no,timer}=pending.get(p.id);pending.delete(p.id);clearTimeout(timer);
      p.error?no(Error(p.error.message)):ok(p.result);
    } else if(events.has(p.method)) events.get(p.method)(p.params).catch(err=>{console.error(err.message);});
  };
  const send=(method,params={})=>new Promise((ok,no)=>{
    const key=++id, timer=setTimeout(()=>{pending.delete(key);no(Error('CDP timeout '+method));},7000);
    pending.set(key,{ok,no,timer});ws.send(JSON.stringify({id:key,method,params}));
  });
  return {send,on:(name,cb)=>events.set(name,cb),evaluate:async expression=>{
    const res=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(res.exceptionDetails)throw Error(res.exceptionDetails.exception?.description||res.exceptionDetails.text);
    return res.result.value;
  }};
}
const token=()=>randomBytes(30).toString('hex');
const admin=token(), nodeToken=token(), pluginToken=token(), spareToken=token();
const centerPort=await port(), bridgePort=await port(), secondPort=await port();
const centerURL='http://127.0.0.1:'+centerPort, bridgeURL='http://127.0.0.1:'+bridgePort;
let browserCdp;
async function api(uri,method='GET',body) {
  const r=await fetch(centerURL+'/v1/'+uri,{method,headers:{Authorization:'Bearer '+admin,'Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body)});
  const result=await r.json();if(!r.ok)throw Error(result.error);return result;
}
try {
  const python=process.env.VEST_TEST_PYTHON || 'python';
  launch(python,['-m','fleet','center','--port',String(centerPort),'--db',path.join(tmp,'center.db')],{VEST_ADMIN_TOKEN:admin});
  launch(python,['-m','fleet','bridge','--node-id','spare','--port',String(secondPort),'--db',path.join(tmp,'second.db')],
    {VEST_NODE_TOKEN:spareToken,VEST_PLUGIN_TOKEN:token()});
  const repo=path.join(tmp,'source'), stateDir=path.join(tmp,'node-state');
  await mkdir(repo);
  await cp(path.join(root,'fleet'),path.join(repo,'fleet'),{recursive:true,filter:p=>!p.includes('__pycache__')});
  const sourceExt=path.join(repo,'extension'), ext=path.join(stateDir,'extension');
  await cp(path.join(root,'extension'),sourceExt,{recursive:true});
  // Redirect Git only for this test process. Both published commits live in this temporary repository.
  const env={GIT_CONFIG_GLOBAL:path.join(tmp,'gitconfig'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_COUNT:'1',
    GIT_CONFIG_KEY_0:'url.'+pathToFileURL(repo).href+'.insteadOf',GIT_CONFIG_VALUE_0:'https://github.com/Kevinckyy/CoinMachine-vest-V2.git'};
  function git(...args) {
    return execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@localhost',...args],
      {cwd:repo,encoding:'utf8',windowsHide:true,env:{...process.env,...env}}).trim();
  }
  const background=path.join(sourceExt,'background.js');
  await writeFile(background,(await readFile(background,'utf8')).replace('127.0.0.1:8877','127.0.0.1:'+bridgePort));
  const pub=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'});
  const eid=createHash('sha256').update(pub).digest('hex').slice(0,32).replace(/[0-9a-f]/g,x=>'abcdefghijklmnop'[parseInt(x,16)]);
  const manifestPath=path.join(sourceExt,'manifest.json');
  const manifest={...JSON.parse(await readFile(manifestPath,'utf8')),key:pub.toString('base64')};
  await writeFile(manifestPath,JSON.stringify(manifest));
  git('init','-q','-b','main');git('add','fleet','extension');git('commit','-qm','first release');
  const first=git('rev-parse','HEAD');
  await writeFile(manifestPath,JSON.stringify({...manifest,description:'Read-only local release fixture'}));
  git('add','extension/manifest.json');git('commit','-qm','second release');
  const second=git('rev-parse','HEAD');
  const agent=path.join(root,'deploy','node_agent.py');
  execFileSync(python,['-B',agent,'init','--state',stateDir,'--revision',first],
    {env:{...process.env,...env},windowsHide:true});
  launch(python,['-B',agent,'run','--state',stateDir,'--db',path.join(tmp,'bridge.db'),'--port',String(bridgePort)],
    {...env,VEST_NODE_ID:'lab',VEST_CENTER_URL:centerURL,VEST_NODE_TOKEN:nodeToken,VEST_PLUGIN_TOKEN:pluginToken});
  await until(async()=>(await fetch(centerURL+'/healthz')).ok&&(await fetch(bridgeURL+'/healthz')).ok,'local managed bridge');
  const profile=path.join(tmp,'browser');
  launch(browser,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run',
    '--disable-extensions-except='+ext,'--load-extension='+ext,'--no-proxy-server',
    '--host-resolver-rules=MAP * 127.0.0.1','--disable-background-networking','--disable-sync',
    '--disable-component-update','--disable-gpu','about:blank']);
  const debugPort=await until(async()=>Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]),'browser');
  const debug='http://127.0.0.1:'+debugPort;
  browserCdp=await cdp((await (await fetch(debug+'/json/version')).json()).webSocketDebuggerUrl);
  async function tab() {
    const {targetId}=await browserCdp.send('Target.createTarget',{url:'about:blank'});
    const target=await until(async()=>(await (await fetch(debug+'/json/list')).json()).find(t=>t.id===targetId),'tab');
    return {...await cdp(target.webSocketDebuggerUrl),targetId};
  }
  const ui=await tab();
  await ui.send('Emulation.setDeviceMetricsOverride',{width:1400,height:950,deviceScaleFactor:1,mobile:false});
  await ui.send('Page.navigate',{url:centerURL});
  await until(()=>ui.evaluate("typeof document.querySelector('#loginForm')?.onsubmit === 'function' && document.querySelector('#loginSubmit')?.disabled === false"),'login UI');
  await ui.evaluate(`document.querySelector('#loginForm input').value=${JSON.stringify(admin)};document.querySelector('#loginForm').requestSubmit()`);
  await until(async()=>{
    const info=await ui.evaluate("({ready:!document.getElementById('app').hidden,error:document.getElementById('loginError').textContent || document.getElementById('banner').textContent})");
    if(!info.ready)throw Error(info.error || 'waiting for authenticated state');
    return true;
  },'dashboard');
  await ui.evaluate("document.querySelector('[data-op=addNode]').click()");
  await ui.evaluate(`(() => {const f=document.getElementById('dialogForm');Object.entries(${JSON.stringify({id:'lab',label:'本地测试节点',url:bridgeURL,token:nodeToken})}).forEach(([k,v])=>f.elements[k].value=v);f.requestSubmit();})()`);
  await until(async()=>(await api('state')).nodes[0]?.online,'registered node');
  const vest=await tab(), fixture=await readFile(path.join(root,'tests','vest-readonly.html'));
  await vest.send('Fetch.enable',{patterns:[{urlPattern:'https://next.vestmarkets.com/*'}]});
  vest.on('Fetch.requestPaused',p=>vest.send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:p.resourceType==='Document'?200:404,
    responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:p.resourceType==='Document'?fixture.toString('base64'):''}));
  await vest.send('Page.navigate',{url:'https://next.vestmarkets.com/trade/NQ-PERP'});
  await until(()=>vest.evaluate("!!document.querySelector('[data-testid=account-selector-trigger]')"),'synthetic Vest page');
  async function openUnboundPopup() {
    const target=await tab();
    await target.send('Page.navigate',{url:'chrome-extension://'+eid+'/popup.html'});
    await until(()=>target.evaluate("!!document.querySelector('#readonly')?.onclick && document.getElementById('mode').textContent==='未绑定'"),'installed extension popup');
    return target;
  }
  const identifyVestTab = `chrome.tabs.query({url:'https://next.vestmarkets.com/*'}).then(([tab])=>
    chrome.tabs.sendMessage(tab.id,{type:'fleet.identify'},{frameId:0}))`;
  const originalPopup=await openUnboundPopup();
  await until(async()=>(await originalPopup.evaluate(identifyVestTab))?.pageId,'original Vest receiver');
  const documentTime=await vest.evaluate('performance.timeOrigin');
  const targets=async()=>await (await fetch(debug+'/json/list')).json();
  const oldWorker=(await targets()).find(t=>t.type==='service_worker' && t.url==='chrome-extension://'+eid+'/background.js');
  assert.ok(oldWorker);
  await originalPopup.evaluate("setTimeout(()=>chrome.runtime.reload(),50); true");
  await until(async()=>!(await targets()).some(t=>t.id===oldWorker.id),'old extension worker unloaded');
  const popup=await openUnboundPopup();
  assert.equal(await vest.evaluate('performance.timeOrigin'),documentTime);
  await assert.rejects(popup.evaluate(identifyVestTab),/Receiving end does not exist/);
  await browserCdp.send('Target.activateTarget',{targetId:ui.targetId});
  const wrongTab=await popup.evaluate("chrome.runtime.sendMessage({type:'ui.bind',mode:'readonly',label:'本地浏览器'})");
  assert.equal(wrongTab.ok,false);
  assert.match(wrongTab.error,/Vest 标签页/);
  await browserCdp.send('Target.activateTarget',{targetId:vest.targetId});
  await popup.evaluate(`document.getElementById('label').value='本地浏览器';document.getElementById('token').value=${JSON.stringify(pluginToken)};document.getElementById('readonly').click()`);
  await until(async()=>{
    const info=await popup.evaluate("({mode:document.getElementById('mode').textContent,detail:document.getElementById('status').textContent})");
    if(info.mode!=='只读')throw Error(info.detail);
    return true;
  },'bound active Vest tab',9000);
  await until(async()=>{
    const data=await api('state');
    if(!data.accounts.length || data.accounts.some(a=>!a.fresh))throw Error(JSON.stringify({workers:data.workers.map(w=>[w.mode,w.error,w.page]), accounts:data.accounts.map(a=>[a.name,a.read_error,a.fresh])}));
    return data.accounts.length===2 && data.accounts.every(a=>a.fresh);
  },'extension account discovery');
  const data=await api('state'),worker=data.workers[0];
  assert.equal(worker.mode,'readonly');
  assert.equal(worker.plugin_version,manifest.version);
  assert.equal(worker.version_status,'current');
  assert.equal((await popup.evaluate(identifyVestTab)).plugin_version,manifest.version);
  assert.deepEqual(data.accounts.map(a=>[a.name,a.card.equity,a.card.active_positions]),[['Alpha',1050,0],['Beta',2000,1]]);
  assert.equal(await vest.evaluate('location.pathname'),'/accounts');
  assert.equal(await vest.evaluate("Number(sessionStorage.getItem('opens'))"),0);
  const existingPage=await popup.evaluate(identifyVestTab);
  const attachedId=await popup.evaluate(`(async()=>{
    const [tab]=await chrome.tabs.query({url:'https://next.vestmarkets.com/*'});
    const [frame]=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},
      files:chrome.runtime.getManifest().content_scripts[0].js});
    return frame.result;
  })()`);
  assert.equal(attachedId,existingPage.pageId);
  assert.equal((await popup.evaluate(identifyVestTab)).pageId,existingPage.pageId);
  assert.equal(data.accounts[1].card.pnl,111.50);
  assert.equal(data.accounts[1].card.drawdown_limit,300);
  assert.equal(data.accounts[1].card.daily_limit,145.96);
  await vest.evaluate(`(() => {const ps=[...document.querySelectorAll('#deskAccounts .grid > a:last-of-type p')];
    ps.find(p=>p.textContent.includes('(+10.77%)')).textContent='-$12.75 (-1.20%)';
    ps.find(p=>p.textContent==='回撤').nextElementSibling.textContent='$36.50 / $300';
    ps.find(p=>p.textContent==='每日亏损').nextElementSibling.textContent='$4.25 / $145.96';})()`);
  const quote=await until(async()=>{
    const rows=(await api('position-metrics?node_id=lab')).items;
    return rows.length===1 && rows[0].pnl===-12.75 && rows[0];
  },'live PnL and both loss metrics reach the center on the fast channel',5500);
  assert.deepEqual([quote.drawdown,quote.daily_loss],[36.5,4.25]);
  assert.ok(!('snapshot' in quote) && !('side' in quote));
  await vest.evaluate("sessionStorage.setItem('partialDirectory','1')");
  const partial=await api('nodes/lab/accounts/refresh','POST',{});
  await until(async()=>{
    const s=await api('state?node_id=lab');
    return s.workers[0].error.includes('未读到完整') && s.workers[0].card_generation!==partial.generation;
  },'incomplete card grid cannot acknowledge the new generation',35000);
  assert.deepEqual((await api('state?node_id=lab')).accounts.filter(a=>a.present).map(a=>a.name),['Alpha','Beta']);
  assert.equal(await popup.evaluate("chrome.storage.local.get('cardCache').then(s=>s.cardCache.items.length)"),2);
  await vest.evaluate("sessionStorage.removeItem('partialDirectory');document.querySelector('#deskAccounts .grid').removeAttribute('aria-busy');renderCards()");
  await until(async()=>(await api('state?node_id=lab')).workers[0].card_generation===partial.generation,'full directory recovers');
  await api('nodes/lab/strategy/start','POST',{});
  await until(async()=>{
    const s=await api('state?node_id=lab');
    return s.nodes[0].card_generation>0 && s.workers[0].card_generation===s.nodes[0].card_generation;
  },'strategy waits for a new full directory read');
  await vest.evaluate("sessionStorage.setItem('purchased','yes');const p=document.createElement('p');p.setAttribute('role','status');p.textContent='Your Funded Account is ready to trade.';document.body.append(p)");
  await until(async()=>(await api('state?node_id=lab')).accounts.find(a=>a.name==='Gamma')?.in_pool,'new purchase joins a running strategy');
  await api('nodes/lab/strategy/stop','POST',{});
  await vest.evaluate("sessionStorage.removeItem('purchased')");
  const manual=await api('nodes/lab/accounts/refresh','POST',{});
  await until(async()=>{
    const s=await api('state?node_id=lab');
    return s.workers[0].card_generation===manual.generation && !s.accounts.find(a=>a.name==='Gamma').present;
  },'manual full refresh replaces deleted accounts');
  assert.equal(await vest.evaluate("Number(sessionStorage.getItem('opens'))"),0);
  // The loaded page and the plugin cache still contain Beta. Only a fresh directory visit can discover Gamma.
  await vest.evaluate("sessionStorage.setItem('scanReplacement','1');sessionStorage.setItem('scanTrace','[]')");
  const scans=await api('nodes/lab/accounts/read-all','POST',{});
  assert.equal(scans.commands.length,1);
  const scanned=await until(async()=>{
    const c=await api('commands/'+scans.commands[0]);
    if(c.status!=='succeeded')throw Error(c.status+' '+c.error+' '+JSON.stringify(c.result));
    return c;
  },'full portfolio read after authoritative directory replacement',50000);
  assert.equal(scanned.result.read,2);
  assert.deepEqual(scanned.result.accounts.map(a=>a.name),['Alpha','Gamma']);
  assert.deepEqual(scanned.result.accounts.map(a=>[a.values.equity,a.values.health,a.values.daily_limit,a.values.drawdown_limit]),
    [[1050,90,30,300],[1275,83,38.25,255]]);
  const cached=await popup.evaluate("chrome.storage.local.get('cardCache').then(s=>s.cardCache)");
  assert.deepEqual(cached.items.map(a=>a.name),['Alpha','Gamma']);
  assert.equal(cached.portfolios.Gamma.drawdown,18.25);
  await until(()=>vest.evaluate("location.pathname==='/accounts'"),'card monitoring resumes after full read');
  const trace=await vest.evaluate("JSON.parse(sessionStorage.getItem('scanTrace'))");
  assert.deepEqual(trace.filter(([event])=>event==='page').map(e=>e[1]),['/accounts','/portfolio','/accounts']);
  assert.deepEqual(trace.filter(([event])=>event==='menu').map(e=>e[1]),['/portfolio','/portfolio']);
  assert.deepEqual(trace.filter(([event])=>event==='select').map(e=>e[1]),['Gamma']);

  await vest.evaluate("sessionStorage.setItem('partialDirectory','1');sessionStorage.setItem('scanTrace','[]')");
  const localScan=await popup.evaluate("chrome.runtime.sendMessage({type:'ui.readAll'})");
  assert.equal(localScan.ok,true);
  await until(async()=>{
    const s=(await api('state')).workers[0].portfolio_scan;
    return s?.id===localScan.value.id && s.status==='failed' && s.error.includes('拉取账户列表失败');
  },'incomplete first step preserves cache and skips all portfolio switches',35000);
  assert.deepEqual(await popup.evaluate("chrome.storage.local.get('cardCache').then(s=>s.cardCache.items.map(a=>a.name))"),['Alpha','Gamma']);
  assert.deepEqual(await vest.evaluate("JSON.parse(sessionStorage.getItem('scanTrace'))"),[['page','/accounts']]);
  await vest.evaluate("sessionStorage.removeItem('scanReplacement');sessionStorage.removeItem('partialDirectory');sessionStorage.removeItem('scanTrace')");
  const restored=await api('nodes/lab/accounts/refresh','POST',{});
  await until(async()=>{
    const s=await api('state');
    return s.workers[0].card_generation===restored.generation && s.accounts.some(a=>a.name==='Beta' && a.present);
  },'restore test inventory');
  for (const account of ['Alpha','Beta']) {
    const key=randomUUID();
    await api('commands/'+key,'PUT',{node_id:'lab',worker_id:worker.worker_id,account,action:'history.read',params:{}});
    await until(async()=>{const c=await api('commands/'+key);if(c.status!=='succeeded')throw Error(c.status+' '+c.error);return true;},'targeted history '+account,45000);
  }
  const report=await until(async()=>{
    const data=await api('analytics?node_id=lab');return data.summary.settled===3 && data;
  },'persisted native position history');
  assert.deepEqual([report.summary.wins,report.summary.losses,report.summary.flat,report.summary.realized_pnl],[1,1,1,13.25]);
  assert.deepEqual(report.nodes[0].stages.map(s=>s.realized_pnl),[20.5,-7.25,0]);
  await until(async()=>(await api('analytics?section=order')).total===3,'native orders from both accounts');
  const payouts=await until(async()=>{
    const p=await api('analytics?section=payout');return p.total===2 && p;
  },'read-only portfolio payout history');
  assert.equal(payouts.summary.total_paid,40);
  assert.equal(payouts.summary.total_withdrawn,0);
  assert.deepEqual([...new Set(payouts.items.map(i=>i.account))],['Beta']);
  await browserCdp.send('Target.activateTarget',{targetId:ui.targetId});
  await ui.evaluate("document.getElementById('refresh').click();document.querySelector('[data-value=accounts]').click()");
  await until(()=>ui.evaluate("!!document.querySelector('[data-op=account]')"),'account management');
  await ui.evaluate("document.querySelector('[data-op=account]').click();const f=document.getElementById('dialogForm');f.elements.alias.value='一号账户';f.requestSubmit()");
  await until(async()=>(await api('state')).accounts[0].alias==='一号账户','saved account alias');
  await until(()=>ui.evaluate("!document.getElementById('dialog').open"),'metadata dialog closed');
  await ui.evaluate("document.querySelector('[data-op=accountCmd]').click();document.getElementById('dialogForm').requestSubmit()");
  const receipt=await until(async()=>{
    const c=(await api('state')).commands[0];
    if(c?.status==='failed')throw Error(c.error);
    return c?.status==='succeeded'&&await api('commands/'+c.id);
  },'read command receipt');
  assert.equal(receipt.result.observation.name,'Alpha');assert.equal(receipt.result.observation.snapshot.equity,1050);
  assert.equal(receipt.result.observation.snapshot.daily_reset_equity,1000);
  assert.equal(receipt.result.observation.snapshot.daily_floor,970);
  await browserCdp.send('Target.activateTarget',{targetId:vest.targetId});
  const syncId=randomUUID();
  await api('commands/'+syncId,'PUT',{node_id:'lab',worker_id:worker.worker_id,account:'Alpha',action:'history.read',params:{}});
  const sync=await until(async()=>{
    const c=await api('commands/'+syncId);
    if(c.status!=='succeeded') throw Error(c.status+' '+c.error+' '+JSON.stringify(c.result));
    return c;
  },'explicit read-only history sync',45000);
  assert.equal(sync.result.tables.position.rows_read,1);
  assert.equal(sync.result.tables.order.rows_read,2);
  assert.equal(sync.result.tables.order.bottom_seen,true);
  await until(async()=>(await api('analytics?section=order')).total===3,'older orders retained after scrolling');
  await browserCdp.send('Target.activateTarget',{targetId:ui.targetId});
  await api('nodes/spare','PUT',{label:'备用节点',url:'http://127.0.0.1:'+secondPort,token:spareToken});
  await until(async()=>(await api('state?node_id=spare')).nodes[0].online,'second local bridge');
  await ui.evaluate("document.getElementById('refresh').click()");
  await until(()=>ui.evaluate("document.querySelector('#nodeScope')?.options.length===2"),'node switcher');
  await ui.evaluate("const scope=document.getElementById('nodeScope');scope.value='spare';scope.dispatchEvent(new Event('change'))");
  assert.equal(await ui.evaluate("document.querySelectorAll('[data-op=account]').length"),0);
  await ui.evaluate("document.querySelector('[data-value=strategy]').click()");
  assert.equal(await ui.evaluate("document.querySelectorAll('.strategy-card').length"),2);
  assert.deepEqual(await ui.evaluate("Array.from(document.querySelectorAll('[data-node=lab] dd'),n=>n.textContent)"),['1','0','1']);
  const openPolicyGroups = () => ui.evaluate("document.querySelectorAll('#policyFields details').forEach(group=>group.open=true)");
  const setPolicy = (name,value) => ui.evaluate(`(() => {
    const field = document.getElementById('dialogForm').elements.namedItem(${JSON.stringify(name)});
    if (field.disabled) throw Error('Disabled field: '+field.name);
    if (field.type==='checkbox') {
      if (field.checked!==${JSON.stringify(value)}) field.click();
    } else {
      field.value=${JSON.stringify(value)};
      field.dispatchEvent(new Event(field.matches('select') ? 'change' : 'input',{bubbles:true}));
    }
    return field.type==='checkbox' ? field.checked : field.value;
  })()`);
  async function checkFields(expected) {
    const states = await ui.evaluate(`Object.fromEntries(${JSON.stringify(Object.keys(expected))}.map(name=>{
      const field=document.getElementById('dialogForm').elements.namedItem(name);
      return [name,[field.getClientRects().length>0,!field.disabled]];
    }))`);
    for (const [name,active] of Object.entries(expected)) assert.deepEqual(states[name],[active,active],name);
  }
  const savePolicy = () => ui.evaluate("document.getElementById('dialogForm').requestSubmit()");
  await ui.evaluate("document.querySelector('[data-op=strategyDefaults]').click()");
  await checkFields({live_default_locked:true});
  assert.equal(await ui.evaluate("document.querySelector('[name=live_default_locked]').checked"),true);
  await openPolicyGroups();
  assert.equal(await ui.evaluate("document.querySelector('[name=take_profit]')===null"),true);
  await checkFields({size_percent:true,phase2_size_percent:true,live_take_profit:true,live_reward_ratio:false});
  await setPolicy('live_take_profit_mode','ratio');
  await checkFields({live_reward_ratio:true,live_min_take_profit:true,live_size_percent:true,live_take_profit:false});
  await setPolicy('live_take_profit_mode','entries');
  await checkFields({live_first_take_profit:true,live_repeat_take_profit:true,live_first_size_percent:true,live_repeat_size_percent:true,live_size_percent:false,live_min_take_profit:false});
  await setPolicy('live_take_profit_mode','fixed');
  await checkFields({same_stage_full_batch:false,exam_pool_limit:false,live_pool_limit:false,dynamic_exam_slots:false,
    dynamic_live_target:false,dynamic_reserve_low:false,account_priority_order:true,drawdown_stop_loss_threshold:false,
    live_drawdown_stop_loss_threshold:false,live_payout_amount:false,live_payout_percent:false});
  await setPolicy('pool_strategy','same_stage');
  await checkFields({same_stage_full_batch:true,dynamic_live_target:false});
  await setPolicy('pool_strategy','dynamic');
  await checkFields({same_stage_full_batch:false,dynamic_live_target:true,dynamic_exam_slots:true,dynamic_reserve_high:false});
  await setPolicy('pool_limits_enabled',true);
  await checkFields({exam_pool_limit:true,live_pool_limit:true,dynamic_live_target:false,dynamic_reserve_low:true,dynamic_reserve_high:true});
  await setPolicy('live_pool_limit','∞');
  await checkFields({dynamic_live_target:true,dynamic_reserve_low:false,dynamic_reserve_high:false});
  await setPolicy('batch_size',1);
  await checkFields({dynamic_exam_slots:false,order_delay_min:false,batch_delay_min:true});
  await setPolicy('batch_size',4);
  assert.equal(await ui.evaluate("document.querySelector('[name=dynamic_exam_slots]').max"),'3');
  await setPolicy('live_priority',false);
  await checkFields({account_priority_order:false});
  await setPolicy('skip_stop_loss_on_low_drawdown',true);
  await checkFields({drawdown_stop_loss_threshold:true,live_drawdown_stop_loss_threshold:false});
  await setPolicy('skip_stop_loss_on_low_drawdown',false);
  await setPolicy('live_skip_stop_loss_on_low_drawdown',true);
  await checkFields({drawdown_stop_loss_threshold:false,live_drawdown_stop_loss_threshold:true,live_default_locked:true});
  await setPolicy('live_payout_mode','amount');
  await checkFields({live_payout_amount:true,live_payout_percent:false});
  await setPolicy('live_payout_amount',7);
  await setPolicy('live_payout_mode','percent');
  await checkFields({live_payout_percent:true,live_payout_amount:false});
  await setPolicy('live_payout_mode','amount');
  assert.equal(await ui.evaluate("document.querySelector('[name=live_payout_amount]').value"),'7');
  await setPolicy('live_payout_amount','');
  await setPolicy('live_payout_mode','all');
  assert.equal(await ui.evaluate("document.getElementById('dialogForm').checkValidity()"),true);
  await savePolicy();
  await until(async()=>(await api('state')).strategy_settings.defaults.batch_size===4,'center defaults');
  const savedDefaults=(await api('state')).strategy_settings.defaults;
  assert.equal(savedDefaults.live_payout_amount,1);
  assert.equal(savedDefaults.same_stage_full_batch,true);
  assert.equal(savedDefaults.live_pool_limit,'infinity');
  await until(()=>ui.evaluate("!document.getElementById('dialog').open && state.strategy_settings.defaults.batch_size===4"),'default settings saved');
  await ui.evaluate("document.querySelector('[data-op=strategyPresets]').click();document.querySelector('[data-op=editPreset]').click();document.querySelector('[name=presetName]').value='晚间'");
  await openPolicyGroups();
  await checkFields({dynamic_live_target:true,live_payout_amount:false,live_drawdown_stop_loss_threshold:true});
  await setPolicy('live_pool_limit','10');
  await setPolicy('batch_size',3);
  await setPolicy('stop_buffer',0);
  await setPolicy('live_size_percent',75);
  await setPolicy('live_payout_mode','percent');
  await setPolicy('live_payout_percent',35);
  assert.equal(await setPolicy('live_default_locked',false),false);
  await savePolicy();
  await until(async()=>(await api('state')).strategy_settings.presets.some(p=>p.name==='晚间'),'preset saved');
  await until(()=>ui.evaluate("!document.getElementById('dialog').open && state.strategy_settings.presets.length===1"),'preset available for node');
  await ui.evaluate("document.querySelector('[data-node=spare] [data-op=strategyConfig]').click();const src=document.getElementById('presetSource');src.value=src.options[2].value;src.dispatchEvent(new Event('change'))");
  await openPolicyGroups();
  await checkFields({dynamic_live_target:false,dynamic_reserve_high:true,live_payout_percent:true,live_payout_amount:false,live_default_locked:true});
  await savePolicy();
  await until(async()=>(await api('state?node_id=spare')).strategy.config.batch_size===3,'node-only preset application');
  assert.equal((await api('state?node_id=lab')).strategy.config.batch_size,2);
  assert.equal((await api('state?node_id=spare')).strategy.config.live_size_percent,75);
  assert.equal((await api('state?node_id=spare')).strategy.config.stop_buffer,0);
  assert.equal((await api('state?node_id=spare')).strategy.config.live_default_locked,false);
  assert.equal((await api('state?node_id=spare')).strategy.config.live_payout_percent,35);
  await until(()=>ui.evaluate("!document.getElementById('dialog').open"),'settings saved');
  for (const locked of [false,true]) {
    await ui.evaluate("document.querySelector('[data-node=lab] [data-op=strategyConfig]').click()");
    await checkFields({live_default_locked:true});
    assert.equal(await setPolicy('live_default_locked',locked),locked);
    await savePolicy();
    await until(async()=>{
      const s=await api('state?node_id=lab'), live=s.accounts.find(a=>a.name==='Beta');
      return s.strategy.config.live_default_locked===locked && live.live_default_locked===locked && live.in_pool===!locked;
    },'Live default lock changes pool membership');
    await until(()=>ui.evaluate("!document.getElementById('dialog').open && state.strategies.find(s=>s.node_id==='lab').config.live_default_locked==="+locked),'saved node lock visible');
  }
  await api('nodes/offline','PUT',{label:'离线模拟节点',url:'http://127.0.0.1:'+await port(),token:token()});
  assert.equal((await api('state?node_id=offline')).strategy.config.batch_size,4);
  await ui.evaluate("document.querySelector('[data-node=spare] [data-op=start]').click();document.getElementById('dialogForm').requestSubmit()");
  await until(()=>ui.evaluate("document.querySelector('[data-node=offline] .tag.bad') && document.querySelector('[data-node=spare] .tag.good')?.textContent==='执行中' && document.querySelector('[data-node=lab] .tag.info')?.textContent==='在线'"),'three distinct node states');
  await ui.evaluate("document.querySelector('[data-node=spare] [data-op=stop]').click()");
  await until(async()=>!(await api('state?node_id=spare')).strategy.enabled,'explicit node stop');
  await ui.evaluate("document.querySelector('[data-node=lab] a').click()");
  await until(()=>ui.evaluate("location.hash==='#strategy/lab' && document.getElementById('content').textContent.includes('Alpha') && document.getElementById('content').textContent.includes('Beta')"),'node details pool and open position');
  const displayed = await ui.evaluate(`(() => {
    const beta=state.accounts.find(a=>a.name==='Beta');
    const el=document.createElement('div');
    el.innerHTML=positions([{...beta,card:{...beta.card,pnl:-8.25,daily_loss:7.50,drawdown:36},
      card_at:1900000000,tracked_position_id:'display-test',position_detail:{position_id:'display-test',symbol:'NQ-PERP',
        side:'sell',quantity:2,entry_price:25980.5,take_profit:180,stop_loss:'omitted',submitted_at:1800000000}}]);
    return [...el.querySelectorAll('tbody td')].map(td=>td.textContent);
  })()`);
  assert.deepEqual(displayed.slice(1,9),['NQ-PERP','做空','2','25,980.50','-8.25','36.00 / 300.00','7.50 / 145.96','180.00 / 未设置']);
  assert.notEqual(displayed[9],displayed[10]);
  // Serve a synthetic cooldown to a separate dashboard tab. Its clock deliberately differs from the browser.
  const cooldown=await tab(), sample=await api('state?node_id=lab'), startTime=Date.now();
  const serverNow=()=>1700000000+(Date.now()-startTime)/1000;
  let nextBatch=serverNow()+3700, message='批间等待';
  await cooldown.send('Fetch.enable',{patterns:[{urlPattern:centerURL+'/v1/state*'}]});
  cooldown.on('Fetch.requestPaused',p=>{
    sample.now=serverNow();
    Object.assign(sample.strategies[0],{enabled:true,members:[],next_at:nextBatch,message});
    return cooldown.send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:200,
      responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(sample)).toString('base64')});
  });
  await browserCdp.send('Target.activateTarget',{targetId:cooldown.targetId});
  await cooldown.send('Page.navigate',{url:centerURL+'/#strategy'});
  await until(()=>cooldown.evaluate("!!document.querySelector('#loginForm')?.onsubmit"),'cooldown dashboard login');
  await cooldown.evaluate(`document.querySelector('#loginForm input').value=${JSON.stringify(admin)};document.querySelector('#loginForm').requestSubmit()`);
  await until(async()=>{
    const view=await cooldown.evaluate("({timer:document.querySelector('.card-message time')?.textContent,hidden:document.hidden,error:document.getElementById('loginError').textContent || document.getElementById('banner').textContent})");
    if (!/^1:\d{2}:\d{2}$/.test(view.timer)) throw Error(JSON.stringify(view));
    return true;
  },'node card cooldown in server time');
  await cooldown.evaluate("window.originalTimer=document.querySelector('.card-message time');window.initialText=originalTimer.textContent");
  await until(()=>cooldown.evaluate("originalTimer.isConnected && originalTimer.textContent!==initialText"),'countdown ticks without replacing node card');
  nextBatch=serverNow()+3;
  await cooldown.evaluate("document.querySelector('[data-node=lab] a').click();document.getElementById('refresh').click()");
  await until(()=>cooldown.evaluate("/^00:0[1-3]$/.test(document.querySelector('.strategy-line time')?.textContent)"),'node detail countdown');
  await until(()=>cooldown.evaluate("document.querySelector('.strategy-line time')?.textContent==='00:00'"),'expired timer holds at zero');
  message='等待本批全部持仓确认结束';
  await cooldown.evaluate("document.getElementById('refresh').click()");
  await until(()=>cooldown.evaluate("document.querySelector('.strategy-line')?.textContent==='等待本批全部持仓确认结束' && !document.querySelector('[data-batch-until]')"),'new batch state removes countdown');
  await browserCdp.send('Target.closeTarget',{targetId:cooldown.targetId});
  await browserCdp.send('Target.activateTarget',{targetId:ui.targetId});
  await ui.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await ui.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),true);
  await ui.evaluate('history.back()');
  await until(()=>ui.evaluate("location.hash==='#strategy' && document.querySelectorAll('.strategy-card').length===3"),'back to fleet strategy cards');
  assert.equal(await ui.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),true);
  await ui.send('Emulation.setDeviceMetricsOverride',{width:1400,height:950,deviceScaleFactor:1,mobile:false});
  await ui.evaluate("document.querySelector('[data-value=logs]').click()");
  await until(()=>ui.evaluate("document.querySelector('#logTable')?.textContent.includes('更新策略参数')"),'per-node runtime logs');
  await ui.evaluate("document.querySelector('[data-value=analytics]').click()");
  await until(()=>ui.evaluate("document.querySelector('#reportResults')?.textContent.includes('13.25')"),'analytics UI');
  await ui.evaluate("const rf=document.getElementById('reportFilters');Object.entries({node_id:'lab',account:'Beta',phase:'2/2',from_date:'2026-11-23',to_date:'2026-11-23',start_time:'22:00',end_time:'02:00'}).forEach(([k,v])=>rf.elements[k].value=v);rf.requestSubmit()");
  await until(()=>ui.evaluate("document.querySelector('.report-metrics .count')?.textContent==='-7.25'"),'filtered overnight stage report');
  await ui.evaluate("document.querySelector('[data-op=resetReport]').click()");
  await until(()=>ui.evaluate("document.querySelector('.report-metrics .count')?.textContent==='13.25'"),'reset filters');
  await ui.evaluate("document.querySelector('[data-op=reportSection][data-value=order]').click()");
  await until(()=>ui.evaluate("document.getElementById('reportResults').textContent.includes('abcd...0002')"),'platform order history table');
  await ui.evaluate("document.querySelector('[data-op=reportSection][data-value=payout]').click()");
  await until(()=>ui.evaluate("document.getElementById('reportResults').textContent.includes('已退款')"),'platform payout details');
  await ui.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await ui.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),true);
  await ui.send('Emulation.setDeviceMetricsOverride',{width:1400,height:950,deviceScaleFactor:1,mobile:false});
  const id=randomUUID();
  await api('commands/'+id,'PUT',{node_id:'lab',worker_id:worker.worker_id,action:'page.navigate',params:{destination:'portfolio'}});
  await until(async()=>(await api('commands/'+id)).status==='succeeded','verified page navigation');
  assert.equal(await vest.evaluate('location.pathname'),'/portfolio');
  const returnId=randomUUID();
  await until(async()=>{
    const w=(await api('state?node_id=lab')).workers[0];
    return w.page==='/portfolio' && w.session_id!==worker.session_id;
  },'new session on portfolio');
  await api('commands/'+returnId,'PUT',{node_id:'lab',worker_id:worker.worker_id,action:'page.navigate',params:{destination:'trade'}});
  await until(async()=>(await api('commands/'+returnId)).status==='succeeded','return to the trading page for account reads');
  await until(async()=>{
    const state=await api('state?node_id=lab');
    return state.workers[0].page.startsWith('/trade/');
  },'trade page before update');
  await browserCdp.send('Target.activateTarget',{targetId:vest.targetId});
  await popup.evaluate("document.getElementById('execute').click()");
  const beforeUpdate=await until(async()=>{
    const w=(await api('state?node_id=lab')).workers[0];
    return w.mode==='execute' && w;
  },'prior profile mode on the isolated fixture');
  await until(async()=>{
    const s=await api('state?node_id=lab');
    return s.workers[0].card_session===beforeUpdate.session_id && s.accounts.find(a=>a.name==='Alpha')?.fresh;
  },'execute profile has its own active directory');
  await vest.evaluate("sessionStorage.setItem('tradeSelector','missing')");
  const opensBeforeTimeout=await vest.evaluate("sessionStorage.getItem('opens')");
  const missingId=randomUUID();
  await api('commands/'+missingId,'PUT',{node_id:'lab',worker_id:worker.worker_id,account:'Alpha',action:'order.open',params:{side:'buy',micro:1}});
  const missing=await until(async()=>{
    const c=await api('commands/'+missingId);
    return c.status==='failed' && c;
  },'unavailable account selector times out before opening an order');
  assert.match(missing.error,/账户选择器.*超时.*\/trade\/NQ-PERP/);
  assert.deepEqual(missing.intents,{});
  assert.equal(await vest.evaluate("sessionStorage.getItem('opens')"),opensBeforeTimeout);
  await until(()=>vest.evaluate("location.pathname === '/accounts'"),'directory restored after the selector timeout');
  await vest.evaluate("sessionStorage.setItem('tradeSelector','delayed');sessionStorage.setItem('tradeEquity','$1,040.00');sessionStorage.setItem('equityDuringFill','$1,038.00')");
  const staleId=randomUUID();
  await api('commands/'+staleId,'PUT',{node_id:'lab',worker_id:worker.worker_id,account:'Alpha',action:'order.open',params:{side:'buy',micro:1}});
  const stale=await until(async()=>{
    const c=await api('commands/'+staleId);
    if (c.status!=='succeeded') throw Error(c.status+' '+c.error);
    return c;
  },'a late account selector and name allow the original order to reach risk preflight');
  assert.equal(stale.intents.open.proof.stop_loss,48);
  assert.equal(stale.result.observation.snapshot.stop_check.target_risk,48);
  assert.equal(stale.result.observation.snapshot.take_profit_check.status,'omitted');
  assert.equal(await vest.evaluate("sessionStorage.getItem('submittedOrders')"),'1');
  assert.equal(stale.params.stop_buffer,20);
  await until(async()=>{
    const s=await api('state?node_id=lab'), a=s.accounts.find(a=>a.name==='Alpha');
    return s.workers[0].page==='/accounts' && a.risk.equity===1038 && a.daily_floor.verified;
  },'corrected risk cached after return to account cards');
  const accountCache = await popup.evaluate("chrome.storage.local.get('cardCache').then(s=>s.cardCache)");
  assert.equal(accountCache.risks.Alpha.equity,1038);
  assert.equal(accountCache.floors.Alpha.floor,970);
  await vest.evaluate("sessionStorage.removeItem('tradeSelector')");
  await vest.evaluate("sessionStorage.setItem('testPayout','yes')");
  const quoteId=randomUUID();
  await api('commands/'+quoteId,'PUT',{node_id:'lab',worker_id:worker.worker_id,account:'Beta',action:'profit.available',params:{}});
  const pageQuote=await until(async()=>{
    const c=await api('commands/'+quoteId);
    if(c.status!=='succeeded')throw Error(c.status+' '+c.error);
    return c.result;
  },'read the platform withdrawable amount with no financial click');
  assert.equal(pageQuote.available,40);
  assert.equal(await vest.evaluate("sessionStorage.getItem('testPayoutDebited')"),null);
  const readLive=randomUUID();
  await api('commands/'+readLive,'PUT',{node_id:'lab',worker_id:worker.worker_id,account:'Beta',action:'account.read',params:{}});
  await until(async()=>(await api('commands/'+readLive)).status==='succeeded','read funded test account before its claim');
  const claim=randomUUID();
  await api('commands/'+claim,'PUT',{node_id:'lab',worker_id:worker.worker_id,account:'Beta',action:'profit.withdraw',
    params:{amount:40,all_available:true}});
  const claimed=await until(async()=>{
    const c=await api('commands/'+claim);
    if(c.status!=='succeeded')throw Error(c.status+' '+c.error);
    return c;
  },'full claim across directly loaded documents with no navigation bar',45000);
  assert.deepEqual([claimed.result.amount,claimed.result.expected_received,claimed.result.balance_after],[40,32,1960]);
  assert.equal(await vest.evaluate("sessionStorage.getItem('testPayoutDebited')"),'1');
  const emptyQuote=randomUUID();
  await api('commands/'+emptyQuote,'PUT',{node_id:'lab',worker_id:worker.worker_id,account:'Beta',action:'profit.available',params:{}});
  await until(async()=>(await api('commands/'+emptyQuote)).result?.available===0,'read zero withdrawable after the debit');
  assert.equal(await vest.evaluate("sessionStorage.getItem('testPayoutDebited')"),'1');
  await ui.evaluate("document.querySelector('[data-value=nodes]').click();document.querySelector('[data-op=deployUpdate]').click()");
  await ui.evaluate(`(() => {const f=document.getElementById('dialogForm'); for(const box of f.querySelectorAll('[name=target]')) box.checked=box.value==='lab'; f.elements.revision.value=${JSON.stringify(second)}; f.requestSubmit();})()`);
  await until(async()=>{
    const data=await api('state?node_id=lab'), node=data.nodes[0], browser=data.workers.find(w=>w.worker_id===worker.worker_id);
    if(node.update?.state!=='succeeded' || browser?.release!==second)
      throw Error([node.update?.state,node.update?.detail,node.release,browser?.release,browser?.error].join(' '));
    assert.equal(browser.mode,'readonly');
    assert.notEqual(browser.session_id,beforeUpdate.session_id);
    return node.release===second && node.update.confirmed.includes(worker.worker_id);
  },'center release installed and confirmed by the reloaded MV3 worker',95000);
  const afterReload=randomUUID();
  await api('commands/'+afterReload,'PUT',{node_id:'lab',worker_id:worker.worker_id,action:'accounts.list',params:{}});
  await until(async()=>{
    const command=await api('commands/'+afterReload);
    if(command.status!=='succeeded')throw Error(command.status+' '+command.error);
    assert.deepEqual(command.result.inventory.map(a=>a.name),['Alpha','Beta']);
    return true;
  },'bound read command after automatic upgrade');
  assert.equal((await api('state?node_id=spare')).nodes[0].update,null);
  await ui.evaluate("document.querySelector('[data-value=overview]').click();document.getElementById('refresh').click()");
  await until(()=>ui.evaluate("document.querySelector('#content').textContent.includes('本地测试节点')"),'overview data');
  assert.equal(await ui.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),true);
  if(process.env.VEST_TEST_SCREENSHOT) {
    const {data}=await ui.send('Page.captureScreenshot',{format:'png'});
    await writeFile(process.env.VEST_TEST_SCREENSHOT,Buffer.from(data,'base64'));
  }
  await ui.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await ui.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),true);
  console.log('PASS: extension rebind, cached accounts, portfolio scans, risk preflight, stop threshold, history, analytics, fleet strategy cards, scoped presets, node details, mobile layout and center-issued upgrade');
} finally {
  if(browserCdp) await browserCdp.send('Browser.close').catch(()=>{});
  for(const ws of sockets)ws.close();
  for(const child of services)if(child.exitCode===null)child.kill();
  if(path.dirname(tmp)===path.resolve(tmpdir()) && path.basename(tmp).startsWith('vest-fleet-smoke-'))
    await rm(tmp,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
