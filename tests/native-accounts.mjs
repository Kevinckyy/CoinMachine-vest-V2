import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../extension/native-accounts.js',import.meta.url),'utf8');
const url='https://api-gateway.hz.vestmarkets.com/v3/capital/accounts/active';
const active={id:'account-id',account_type:2,stage:1,status:2,step:2,steps_total:2,attempt_index:163,
  max_daily_loss_pct:'0.03',daily_loss_floor:'4714.01',max_drawdown_limit:'4700',private_field:'unused'};
const storage=new Map([['vest-active-account:user',active.id]]);
const requests=[];
class XHR extends EventTarget {
  open(method,url){this.responseURL=url;}
}
const window={fetch:()=>new Promise(resolve=>requests.push(resolve))};
const context={window,URL,XMLHttpRequest:XHR,structuredClone,location:{href:'https://next.vestmarkets.com/accounts'},
  sessionStorage:{get length(){return storage.size;},key:i=>[...storage.keys()][i],getItem:key=>storage.get(key)}};
vm.runInNewContext(source,context);
vm.runInNewContext(source,context);
const snapshot=window.vestFleetActiveAccountsV1;
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
assert.equal(first.selected,active.id);
assert.equal(snapshot(true).pending_at,null);
assert.equal(first.rows.length,1);
assert.equal(first.rows[0].phase,'2/2');
assert.equal(first.rows[0].daily_floor,4714.01);
assert.equal(first.rows[0].max_drawdown_floor,4700);
assert.equal(first.rows[0].name,'Account 164');
assert.ok(!('private_field' in first.rows[0]));
first.rows.length=0;
assert.equal(snapshot().rows.length,1);
storage.set('vest-active-account:other','another');
assert.equal(snapshot().selected,null);
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
assert.equal(snapshot().rows[0].daily_unlimited,true);
assert.equal(snapshot().rows[0].daily_floor,null);
assert.equal(snapshot().rows[0].daily_reset_equity,null);
const total=requests.length;
for(let i=0;i<100;i++) snapshot();
assert.equal(requests.length,total);
console.log('Native active-account observer passed');
