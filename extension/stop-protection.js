/* Verify the filled NQ position and apply at most one native TP/SL amendment. */
(() => {
  'use strict';
  const NQ_PRICE_TICK = 0.25;
  const legs = [
    { key:'sl', setting:'stop_loss', report:'stop_check', label:'止损', amount:'risk' },
    { key:'tp', setting:'take_profit', report:'take_profit_check', label:'止盈', amount:'profit' },
  ];
  const direction = (side, leg) => (side === 'buy') === (leg === 'tp') ? 1 : -1;
  const valid = check => ['verified','omitted'].includes(check.status);

  function plan(position, target, key='sl', capped=false) {
    const {label, amount}=legs.find(leg=>leg.key===key);
    const targetKey='target_'+amount, actualKey='actual_'+amount;
    if(target==null){
      const absent=position[`native_${key}_absent`]===true&&position[`native_${key}_price`]==null;
      return {status:absent?'omitted':'mismatch',[targetKey]:null,[actualKey]:null,target_price:null};
    }
    const {entry_price:entry,quantity,side}=position;
    if (![entry,quantity,target].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>0)||!['buy','sell'].includes(side)) {
      throw Error(label+'校验缺少真实成交均价、数量或方向');
    }
    const sign=direction(side,key), ticks=(entry+sign*target/quantity)/NQ_PRICE_TICK;
    if(!Number.isFinite(ticks))throw Error('无法计算有效'+label+'触发价');
    const nearestTick=capped && key==='sl' ? (sign===1?Math.floor(ticks+1e-9):Math.ceil(ticks-1e-9)) :
      sign===1?Math.ceil(ticks-0.5):Math.floor(ticks+0.5);
    const price=nearestTick*NQ_PRICE_TICK;
    if(!(price>0&&sign*(price-entry)>0))throw Error(label+'金额对应的触发价无效，请核对当前成交价和数量');
    const trigger=position[`native_${key}_price`];
    const actual=typeof trigger==='number'&&Number.isFinite(trigger)&&trigger>0?sign*(trigger-entry)*quantity:null;
    return {status:actual>0&&Math.abs(trigger-price)<1e-6?'verified':'mismatch',[targetKey]:target,
      [actualKey]:actual==null?null:Math.round(actual*1e8)/1e8,target_price:price};
  }

  async function correct(a, job, filled, requested = legs.map(leg => leg.setting)) {
    const core=globalThis.VestBridgeCore;
    const selected = legs.filter(leg => requested.includes(leg.setting));
    let dialog=null, validEditor=false, submitted=false, changes=[];
    const read=()=>{
      a.guard(job);a.noDialogs(dialog);
      const current=a.read();
      if(!core.matchesPosition(current,filled)||!core.sameQuantity(current.entry_price,filled.entry_price)) {
        throw Error('止盈止损校正期间账户、持仓或成交均价变化');
      }
      return current;
    };
    const checkLegs=current=>Object.fromEntries(selected.map(({key,setting,report})=>{
      try{return [report,plan(current,job[setting],key,job.stop_buffer!=null)];}
      catch(error){return [report,{status:'failed',error:error.message}];}
    }));
    try {
      let current=read(), checks=checkLegs(current);
      changes=selected.filter(({report})=>!valid(checks[report]));
      if(!changes.length)return {...current,...checks};
      for(const {setting,report,label} of changes){
        if(checks[report].status==='failed')throw Error(checks[report].error);
        if(job[setting]==null)throw Error('本单要求不设'+label+'，持仓列表未确认该保护为空');
      }
      const targets=Object.fromEntries(changes.map(({key,report})=>[key,checks[report].target_price]));
      a.click(a.one(`[data-testid="tpsl-edit-open-${CSS.escape(filled.position_id)}"]`,document,true));
      const until=Date.now()+4000;
      while(Date.now()<until){
        await a.delay(100);a.guard(job);
        const dialogs=[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(a.visible);
        if(!dialogs.length)continue;
        if(dialogs.length!==1||dialogs[0].getAttribute('role')!=='dialog')throw Error('止盈止损编辑窗口不唯一');
        dialog=dialogs[0];break;
      }
      if(!dialog)throw Error('止盈止损编辑窗口未打开');
      const one=id=>a.one(`[data-testid="${id}"]`,dialog,true);
      const text=e=>core.normalized(e?.textContent);
      const editedIds=new Set(changes.map(({key})=>`tpsl-edit-${key}-input-0`));
      const otherSettings=()=>JSON.stringify([...dialog.querySelectorAll('input,button[role="combobox"],button[data-testid*="unit-"]')]
        .filter(e=>!editedIds.has(e.dataset.testid))
        .map(e=>[e.dataset.testid,e instanceof HTMLInputElement?e.value:text(e)]));
      const validate=()=>{
        const live=read();
        if(!/^(?:编辑 NQ 止盈\/止损|Edit NQ (?:TP\/SL|Take Profit\/Stop Loss))$/i.test(text(dialog.querySelector('h2')))) {
          throw Error('无法确认 NQ 止盈止损编辑窗口');
        }
        if(!core.sameQuantity(core.parseMoney(text(one('position-entry-'+filled.position_id))),filled.entry_price))throw Error('编辑窗口成交均价不匹配');
        validEditor=true;
        for(const {key,label} of changes){
          const prefix=`tpsl-edit-${key}-`;
          if(!(live.price>0&&direction(live.side,key)*(targets[key]-live.price)>0))throw Error('行情已越过目标'+label+'价，请核对实际仓位');
          if(dialog.querySelectorAll(`[data-testid^="${prefix}input-"]`).length!==1)throw Error('多级'+label+'不能自动修改，请核对');
          if(!/^(?:价格|Price)$/i.test(text(one(prefix+'unit-0')))||text(one(prefix+'size-unit-0'))!=='%'||
            !core.sameQuantity(core.parseMoney(one(prefix+'qty-0').value),100)||
            !/^(?:市价|Market)$/i.test(text(one(prefix+'execution-0'))))throw Error(label+'必须是价格触发、100% 持仓的市价单');
          const quantityText=text(one(prefix+'size-equiv-0'));
          if(!/\bNQ$/.test(quantityText)||!core.sameQuantity(core.parseMoney(quantityText),filled.quantity))throw Error('编辑窗口'+label+'数量不匹配');
        }
        return live;
      };
      validate();
      const original=otherSettings();
      for(const {key,label} of changes){
        const input=one(`tpsl-edit-${key}-input-0`);
        if(!(input instanceof HTMLInputElement)||input.disabled||input.readOnly)throw Error(label+'价格不可编辑');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(targets[key]));
        input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
      }
      function verifiedEditor() {
        const live=validate();
        const accepted=changes.every(({key})=>{
          const input=one(`tpsl-edit-${key}-input-0`);
          return core.sameQuantity(core.parseMoney(input.value),targets[key])&&input.getAttribute('aria-invalid')!=='true';
        });
        if(otherSettings()!==original||!accepted)throw Error('保护价格或其他保护设置变化，未保存');
        return live;
      }
      await a.delay(180);
      const intent=await a.intent(job,verifiedEditor(),targets);
      verifiedEditor();
      if(intent.authorize_click!==true||!changes.every(({key})=>core.sameQuantity(intent.target_prices?.[key],targets[key]))) {
        throw Error('止盈止损校正未获确认，禁止重复保存');
      }
      const save=one('tpsl-edit-submit');
      if(save.type!=='submit'||save.getAttribute('aria-busy')==='true')throw Error('无法确认止盈止损保存按钮');
      submitted=true;a.click(save);
      const deadline=Date.now()+8000;
      while(Date.now()<deadline){
        await a.delay(150);a.guard(job);
        if(dialog?.isConnected&&a.visible(dialog))continue;
        dialog=null;current=read();checks=checkLegs(current);
        if(Object.values(checks).every(valid)){
          for(const {report} of changes)checks[report].corrected=true;
          return {...current,...checks};
        }
      }
      throw Error('止盈止损校正后未确认持仓列表已更新，请核对');
    }catch(error){
      if(dialog&&validEditor&&!submitted){
        try{
          const cancel=[...dialog.querySelectorAll('button[data-slot="dialog-close"]')].find(e=>a.visible(e)&&/^(?:取消|Cancel)$/.test(core.normalized(e.textContent)));
          if(cancel){a.guard(job);a.click(cancel);await a.delay(100);}
        }catch{}
      }
      let observed=filled;
      try{const current=a.read();if(core.matchesPosition(current,filled))observed=current;}catch{}
      const checks=checkLegs(observed);
      for(const {report} of (changes.length?changes:selected)){
        checks[report]={...checks[report],status:'failed',error:String(error.message).slice(0,250),submitted};
      }
      return {...observed,...checks};
    }
  }
  globalThis.VestStopProtection={plan,correct};
})();
