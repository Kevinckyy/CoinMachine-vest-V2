import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import '../extension/core.js';

const source=await readFile(new URL('../extension/native-accounts.js',import.meta.url),'utf8');
const url='https://api-gateway.hz.vestmarkets.com/v3/capital/accounts/active';
const active={id:'account-id',account_type:2,stage:1,status:2,step:2,steps_total:2,attempt_index:163,
  max_daily_loss_pct:'0.03',daily_loss_floor:'4714.01',max_drawdown_limit:'4700',private_field:'unused'};
const storage=new Map([['vest-active-account:user',active.id]]);
const requests=[];
class XHR extends EventTarget {
  open(method,url){this.responseURL=url;}
}
const window={dispatchEvent:()=>{},fetch:()=>new Promise(resolve=>requests.push(resolve))};
const context={window,URL,Event,XMLHttpRequest:XHR,structuredClone,location:{href:'https://next.vestmarkets.com/accounts'},
  sessionStorage:{get length(){return storage.size;},key:i=>[...storage.keys()][i],getItem:key=>storage.get(key)}};
vm.runInNewContext(await readFile(new URL('../extension/archive.js',import.meta.url),'utf8'),context);
vm.runInNewContext(source,context);
vm.runInNewContext(source,context);
const snapshot=window.vestFleetSnapshotsV2;
const rawRisk={initial_capital:5000,max_drawdown_floor:4700,daily_floor:4715.055734,daily_rate:.03,daily_limit:145.83};
const cutoff=Date.parse('2026-11-24T01:00:00Z')/1000;
const metrics=(row,at=cutoff+1,now=cutoff+2)=>VestBridgeCore.nativeCapitalMetrics(row,4872.08,at,now);
assert.deepEqual(metrics({...rawRisk,daily_reset_at:cutoff}),{drawdown:{current:127.92,limit:300},daily_loss:{current:0,limit:145.83}});
assert.deepEqual(metrics(rawRisk,cutoff-1,cutoff),{});
assert.deepEqual(metrics(rawRisk,cutoff,cutoff+331),{});
assert.equal(metrics({...rawRisk,daily_reset_at:cutoff-1}).daily_loss,undefined);
assert.equal(metrics({...rawRisk,daily_rate:0,daily_reset_at:cutoff}).daily_loss,undefined);
assert.deepEqual(VestBridgeCore.nativeCapitalMetrics({...rawRisk,daily_reset_at:cutoff},5000,cutoff,cutoff+1,cutoff-1),{});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function reply(resolve,accounts,extra={}) {
  resolve({status:200,url,clone:()=>({json:async()=>({accounts,...extra})})});
}
assert.equal(snapshot(),null);
window.fetch(url);
window.fetch(url);
assert.ok(snapshot(true).pending_at>0);
assert.equal(requests.length,2);
reply(requests[1],[active,{...active,id:'closed',status:7}]);
await settle();
reply(requests[0],[]);
await settle();
const first=snapshot();
assert.equal(snapshot('selected').selected,active.id);
assert.equal(snapshot(true).pending_at,null);
assert.equal(first.rows.length,1);
assert.equal(first.rows[0].phase,'2/2');
assert.equal(snapshot('selected').row.daily_floor,4714.01);
assert.equal(snapshot('notice','closed').successor_roots.length,0);
assert.equal(snapshot('notice','closed').prior_active,false);
assert.equal(snapshot('selected').row.max_drawdown_floor,4700);
assert.ok(!('daily_floor' in first.rows[0]));
assert.equal(first.rows[0].name,'Account 164');
assert.ok(!('private_field' in first.rows[0]));
first.rows.length=0;
assert.equal(snapshot().rows.length,1);
storage.set('vest-active-account:other','another');
assert.equal(snapshot('selected').selected,null);
storage.delete('vest-active-account:other');

for (const [accounts,extra] of [[[active,active],{}],[[{...active,status:99}],{}],[[active],{has_more:true}]]) {
  window.fetch(url);
  reply(requests.at(-1),accounts,extra);
  await settle();
  assert.equal(snapshot(),null);
}
const xhr=new XHR();
xhr.open('GET',url);
xhr.status=200;
xhr.responseType='json';
xhr.response={accounts:[{...active,max_daily_loss_pct:'0',daily_reset_balance:'0'}]};
xhr.dispatchEvent(new Event('loadend'));
assert.equal(snapshot('selected').row.daily_unlimited,true);
assert.equal(snapshot('selected').row.daily_floor,null);
assert.equal(snapshot('selected').row.daily_reset_balance,0);
assert.equal(snapshot('selected').row.daily_reset_equity,null);
const opened=url.replace('/capital/accounts/active','/positions/opened');
async function get(path,body) {
  window.fetch(path);
  requests.at(-1)({status:200,url:path,clone:()=>({json:async()=>body})});
  await settle();
}
const pos={accountId:active.id,positionId:'p',symbol:'NDX-USD-PERP',side:'long',quantity:'0.0911',openPrice:'26900.75',openDate:Date.now()-1000,pnl:'0',orders:[{user_id:'hidden'}]};
await get(opened,{positions:[pos]});
assert.equal(snapshot('inventory').rows[0].active_positions,1);
assert.equal(snapshot('selected').position.quantity,0.0911);
assert.equal(snapshot('selected').position.opened_at,pos.openDate/1000);
assert.ok(!('pnl' in snapshot('selected').position));
const working={status:'awaiting',executionType:'market',sizeMode:'full_position',triggerPrice:'26800.25'};
await get(opened,{positions:[{...pos,takeProfits:[],stopLosses:[working]}]});
assert.equal(snapshot('selected').position.native_sl_price,26800.25);
assert.equal(snapshot('selected').position.native_tp_absent,true);
await get(opened,{positions:[{...pos,stopLosses:[{...working,status:'cancelled'},working]}]});
assert.equal(snapshot('selected').position.native_sl_price,26800.25);
await get(opened,{positions:[{...pos,stopLosses:[{...working,status:'triggered'}]}]});
assert.equal(snapshot('selected').position.native_sl_absent,true);
for(const legs of [[working,working],[{...working,status:'unknown'}],[{...working,sizeMode:'fixed',quantity:'0.01'}]]){
  await get(opened,{positions:[{...pos,stopLosses:legs}]});
  assert.equal(snapshot('selected').position.native_sl_price,null);
  assert.equal(snapshot('selected').position.native_sl_absent,false);
}
for(const positions of [[],[pos,{...pos,positionId:'other'}],[{...pos,accountId:'other'}],[{...pos,symbol:'OTHER'}]]){
  await get(opened,{positions}); assert.equal(snapshot('selected').position,undefined);
}
const history=url.replace('/capital/accounts/active','/history/orders?account_id=old');
const row={id:'order-1',symbol:'NDX-USD-PERP',created_at:1795482303139,quantity:'1',user_id:'private'};
await get(history,{items:[row,{...row,id:'wrong',account_id:'other'}]});
const batch=window.vestFleetReadArchiveV1();
assert.equal(batch.items.length,1);
assert.equal(batch.items[0].source_account_id,'old');
assert.ok(!('user_id' in batch.items[0]));
assert.ok(!window.vestFleetReadArchiveV1(batch.seq));
await get(history,{items:[row]});
assert.equal(window.vestFleetReadArchiveV1(),null);
const total=requests.length;
for(let i=0;i<100;i++) snapshot();
assert.equal(requests.length,total);
const gateway=new URL(url).origin;
await get(url,{accounts:[{...active,initial_capital:'5000',daily_reset_base_limit:'150',daily_reset_at:Date.now()}]});
await get(gateway+'/v3/accounts?active=true&limit=500',{accounts:[{account_id:active.id,amount:'4900'}]});
await get(opened,{positions:[]});
const orderPath=gateway+'/v3/positions/opened-orders';
await get(orderPath,{orders:[]});
const bulk=snapshot('bulk'), row0=bulk.rows[0];
assert.equal(snapshot('selected').flat.equity,4900);
assert.equal(snapshot('selected').flat.at,snapshot(true).trade_at);
assert.equal(row0.equity,4900);
assert.equal(row0.active_positions,0);
const detail=VestBridgeCore.bulkCapitalValues(row0,bulk.at,Date.now()/1000);
await get(opened,{positions:null});
assert.equal(snapshot('inventory').rows[0].active_positions,0);
assert.ok(snapshot('inventory').position_at);
assert.equal(snapshot('selected').flat.equity,4900);
for (const bad of [{},{positions:null,total:1},{positions:null,next:'more'},{positions:null,error:'unavailable'}]) {
  await get(opened,bad);
  assert.equal(snapshot('inventory').rows[0].active_positions,null);
  assert.equal(snapshot('selected').flat.count,null);
  assert.equal(snapshot('selected').flat.equity,null);
}
await get(opened,{positions:null});
assert.equal(detail.drawdown,100);
assert.equal(detail.health,67);
await get(orderPath,{orders:[{account_id:active.id}]});
assert.equal(snapshot('selected').flat.reserved,true);
assert.equal(snapshot('selected').flat.equity,null);
assert.equal(snapshot('bulk').rows[0].equity,null);
await get(gateway+'/v3/trading-performance/series',{items:[{account_id:active.id,ts:Date.now(),equity_value:'4901.25'}]});
assert.equal(snapshot('bulk').rows[0].equity,4901.25);
assert.equal(snapshot('selected').flat.equity,null);
await get(orderPath,{orders:[],has_more:true});
assert.equal(snapshot('selected').flat.reserved,null);
await get(orderPath,{orders:[]});
await get(opened,{positions:[pos]});
assert.equal(snapshot('selected').flat.count,1);
assert.equal(snapshot('selected').flat.equity,null);
const posPath=gateway+'/v3/positions?account_id=closed';
await get(posPath,{positions:[{...pos,accountId:'closed',closeDate:Date.now(),pnl:'-13.42'},
  {...pos,accountId:'closed',positionId:'openOnly'}, {...pos,closeDate:Date.now()}]});
const archivedPosition=window.vestFleetReadArchiveV1();
assert.equal(archivedPosition.items.length,1);
assert.equal(archivedPosition.items[0].pnl,-13.42);
assert.equal(archivedPosition.items[0].source_account_id,'closed');
console.log('Native active-account observer passed');
