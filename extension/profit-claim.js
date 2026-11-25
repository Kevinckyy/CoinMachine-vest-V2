/* Verify a profit claim on the bound Portfolio page, with one authorized submit. */
(() => {
  'use strict';
  function units(value) {
    const text=String(value),match=text.match(/^(\d+)(?:\.(\d{1,6}))?$/);
    if(!match)throw new Error('领取金额精度不明确');
    return BigInt(match[1])*1000000n+BigInt((match[2]||'').padEnd(6,'0'));
  }
  function expectedAmount(available,policy) {
    const total=units(available);
    if(policy.live_payout_mode==='all')return Number(total)/1e6;
    if(policy.live_payout_mode==='amount')return Number(units(policy.live_payout_amount))/1e6;
    const text=String(policy.live_payout_percent),m=text.match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
    if(!m)throw new Error('领取比例无效或过小');
    const exponent=Number(m[3]||0)-(m[2]||'').length;
    const scale=10n**BigInt(Math.max(0,-exponent));
    const numerator=BigInt(m[1]+(m[2]||''))*10n**BigInt(Math.max(0,exponent));
    return Number(total*numerator/(100n*scale))/1e6;
  }
  async function withdraw(a,cmd) {
    const deadline=Date.now()+90000;
    const policy=cmd.strategy_payout || {live_payout_recipient:'main',
      live_payout_mode:cmd.params.all_available ? 'all' : 'amount',live_payout_amount:cmd.params.amount};
    const matchesBalance=(a,b)=>Number.isFinite(a) && Number.isFinite(b) &&
      Math.abs(Math.round(a*1e6)-Math.round(b*1e6))<=5000;
    const dialogs=()=>[...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]')].filter(a.visible);
    function own() {
      a.guard();
      const identity=a.identity();
      if (location.origin!=='https://next.vestmarkets.com' || location.pathname.replace(/\/$/,'')!=='/portfolio' ||
          identity.name!==cmd.account || identity.phase!=='live' || !['funded','live'].includes(identity.category))
        throw Error('领取期间 Portfolio 页面、账户或 Live 阶段已变化');
    }
    function one(selector,scope=document,fallback=null) {
      const found=[...scope.querySelectorAll(selector)].filter(a.visible);
      if(!found.length&&fallback)return one(fallback,scope);
      if(found.length!==1)throw new Error('领取组件不唯一或不可见：'+selector);
      return found[0];
    }
    function readDialog() {
      const all=dialogs();if(!all.length)return null;
      if(all.length!==1||!all[0].matches('[role="dialog"],dialog[open]')||all[0].getAttribute('role')==='alertdialog')throw new Error('领取流程出现未知确认窗口');
      const dialog=all[0];
      const title=a.text(one('[data-slot="dialog-title"]',dialog,'h2,[role="heading"]'));
      if(/^(领取利润|Claim Profits?)$/i.test(title))return {dialog,kind:'form'};
      if(/^(利润领取请求已提交|Profit Claim Request Submitted)$/i.test(title))return {dialog,kind:'submitted'};
      throw new Error('领取流程出现未识别窗口：'+title);
    }
    function modal() {
      const current=readDialog();
      if(current&&current.kind!=='form')throw new Error('提交前出现领取结果窗口，请核对实际余额');
      return current?.dialog;
    }
    function submittedNotice(dialog,expectedReceived) {
      const description=a.text(one('[data-slot="dialog-description"]',dialog,'p'));
      const amountText=description.match(/^\$\s*([\d,]+(?:\.\d{1,6})?)\s*正在转入您的主账户[，,]\s*将在\s*24\s*小时后到账[。.]?$/)?.[1]
        ?? description.match(/^\$\s*([\d,]+(?:\.\d{1,6})?)\s+is being transferred to your (?:primary|main) account and will arrive in 24 hours\.?$/i)?.[1];
      const amount=a.money(amountText);
      if(!(amount>0)||Math.abs(amount-expectedReceived)>0.0000005||
        dialog.querySelector('form,[data-testid="claim-profit-submit"],[data-testid="confirm-order-submit"],[data-testid="close-submit"]')){
        throw new Error('领取确认窗口的到账金额或主账户信息与已提交请求不符');
      }
      const buttons=[...dialog.querySelectorAll('button')].filter(e=>a.visible(e)&&/^(知道了|Got It)$/i.test(a.text(e))&&!e.form);
      if(buttons.length!==1)throw new Error('无法唯一识别领取确认窗口的「知道了」按钮');
      return buttons[0];
    }
    function received(dialog) {
      const labels=[...dialog.querySelectorAll('p,span,div')].filter(e=>a.visible(e)&&/^(您将收到|You will receive)$/i.test(a.text(e))&&
        ![...e.children].some(c=>/^(您将收到|You will receive)$/i.test(a.text(c))));
      if(labels.length!==1)throw new Error('无法唯一识别到账预览标签');
      let row=labels[0];
      for(let i=0;i<3;i++){
        row=row.parentElement;if(!row||!dialog.contains(row))break;
        const values=[...row.querySelectorAll('p,span,div')].filter(a.visible).map(a.text)
          .filter(t=>/^\$\s*[\d,]+(?:\.\d+)?$/.test(t)).map(a.money);
        const unique=[...new Set(values.filter(v=>v!==null))];
        if(unique.length===1)return unique[0];
      }
      throw new Error('无法唯一读取实际到账预览');
    }
    function quote(dialog) {
      const recipient=[...dialog.querySelectorAll('input[data-slot="input"]')].filter(e=>a.visible(e)&&!e.getAttribute('data-testid')&&!e.name);
      if(recipient.length!==1||recipient[0].value.trim()!==''||
        !/(?:收款人|Recipient)/i.test(a.text(recipient[0].parentElement))||
        ![...recipient[0].parentElement.querySelectorAll('span,div')].some(e=>a.visible(e)&&/^(主账户|Primary Account|Main Account)$/i.test(a.text(e)))) {
        throw new Error('收款人未明确保持为主账户，禁止领取');
      }
      const available=a.money(a.text(one('[data-testid="claim-profit-available"]',dialog)));
      const value=one('input[name="amount"][data-slot="form-control"]',dialog).value;
      const amount=Number(units(value))/1e6,receive=received(dialog);
      if(!(available>0&&amount>0&&amount<=available&&receive>0&&receive<=amount))throw new Error('可领取金额、申请金额或到账预览无效');
      return {available,amount,received:receive,recipient:'main'};
    }
    function portfolioFlat() {
      const banners=[...document.querySelectorAll('div.sticky.top-14')].filter(a.visible);
      if(banners.length!==1)throw new Error('无法唯一核对持仓页的账户占用指标');
      const text=String(banners[0].innerText).replace(/\s+/g,' ').trim();
      const read=pattern=>{const matches=[...text.matchAll(new RegExp(pattern,'gi'))];
        if(matches.length!==1)throw new Error('持仓页的空仓/挂单指标不明确');return Number(matches[0][1].replace(/,/g,''));};
      const leverage=read('(?:杠杆|槓桿|Leverage)\\s*[:：]?\\s*([\\d,.]+)\\s*x');
      const position_margin=read('(?:仓位占用|倉位佔用|Position Margin|Position Utilization)\\s*[:：]?\\s*\\$?\\s*([\\d,.]+)');
      const order_margin=read('(?:订单占用|訂單佔用|Order Margin|Order Utilization)\\s*[:：]?\\s*\\$?\\s*([\\d,.]+)');
      if(leverage!==0||position_margin!==0||order_margin!==0)throw new Error('持仓页显示持仓或挂单占用，禁止领取');
      return {leverage,position_margin,order_margin,observed_at:Date.now()/1000};
    }
    function edit(input,value) {
      if(!(input instanceof HTMLInputElement)||input.disabled||input.readOnly)throw new Error('领取输入框不可编辑');
      own();input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(value));
      input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
    }
    let platformId=cmd.read_card_id;
    async function balances() {
      own();
      const source=await a.nativeAccounts('payout');
      own();
      if (source?.selected) {
        if (platformId && platformId!==source.selected || source.phase && source.phase!=='live')
          throw Error('Portfolio 账户 ID 或阶段与领取目标不一致');
        platformId=source.selected;
      }
      const root=one('[data-testid="portfolio-root"]');
      const values=[...root.querySelectorAll('[data-testid="account-value"]')].filter(a.visible);
      const busy='[aria-busy="true"],[data-loading="true"],[data-slot="skeleton"],.animate-pulse';
      const el=values.length===1 ? values[0] : null;
      const display=el && !el.closest(busy) && !el.querySelector(busy) ? a.money(a.text(el)) : null;
      const at=source?.at, now=Date.now()/1000;
      const cash=platformId && source?.selected===platformId && source.phase==='live' &&
        Number.isFinite(at) && at<=now && now-at<=180 && Number.isFinite(source.balance) ? source.balance : null;
      return {cash,at,display};
    }
    own();
    if (dialogs().length) throw Error('打开领取前存在额外弹窗');
    portfolioFlat();
    // A DOM value can briefly belong to the previous selection. Anchor it to the confirmed flat balance.
    let before, sampled;
    const readyBy=Date.now()+8000;
    do {
      const sample=await balances();
      const value=sample.cash ?? sample.display;
      if (value>0 && (cmd.flat_balance==null ? sample.cash!==null : matchesBalance(value,cmd.flat_balance))
          && value===sampled) {
        before=value;
        break;
      }
      sampled=value;
      await a.delay(180);
    } while (Date.now()<readyBy);
    if (before===undefined) throw Error('Portfolio 领取前余额未就绪或与平仓后余额不一致');
    if (policy.live_payout_recipient!=='main') throw Error('领取收款参数不是主账户');
    const button=one('button[data-testid="withdraw-open"]');
    if (button.type!=='button' || button.disabled) throw Error('领取入口尚不可用');
    a.click(button);
    let dialog;
    while (!(dialog=modal())) {
      own();
      if (Date.now()>=deadline) throw Error('领取表单未打开');
      await a.delay(180);
    }
    if (policy.live_payout_mode==='amount') edit(one('input[name="amount"]',dialog),policy.live_payout_amount);
    else edit(one('[data-testid="claim-profit-amount-slider-percentage"]',dialog),policy.live_payout_mode==='all'?100:policy.live_payout_percent);
    await a.delay(220);
    own();
    dialog=modal();
    if (!dialog) throw Error('领取预览意外关闭');
    const q=quote(dialog);
    if (q.amount!==expectedAmount(q.available,policy) || q.amount!==cmd.params.amount)
      throw Error('页面领取金额与指令不符');
    function submitButton(form) {
      const el=one('button[data-testid="claim-profit-submit"]',form);
      if (el.type!=='submit' || el.disabled || el.getAttribute('aria-disabled')==='true') throw Error('领取提交按钮尚不可用');
      return el;
    }
    submitButton(dialog);
    // The bridge persists the intent and the background worker journals its permission before returning.
    await a.intent('withdraw',{...q,balance_before:before,flat:portfolioFlat()});
    const last=await balances();
    dialog=modal();
    if (!matchesBalance(last.cash ?? last.display,before) || !dialog || JSON.stringify(quote(dialog))!==JSON.stringify(q))
      throw Error('提交前领取余额、金额或收款状态变化');
    portfolioFlat();
    const confirmed=submitButton(dialog);
    const clickedAt=Date.now()/1000;
    a.click(confirmed);
    let dismissed=false;
    while (Date.now()<deadline) {
      await a.delay(250);
      own();
      const current=readDialog();
      if (current?.kind==='submitted') {
        const ok=submittedNotice(current.dialog,q.received);
        if (!dismissed && !ok.disabled && ok.getAttribute('aria-disabled')!=='true' && ok.getAttribute('aria-busy')!=='true') {
          dismissed=true;
          a.click(ok);
        }
        continue;
      }
      if (current) {
        if (dismissed) throw Error('领取结果关闭后输入窗口再次出现，请核对实际余额');
        continue;
      }
      const sample=await balances();
      // A fresh cash response takes precedence. For the rounded display require a visible change from before the click.
      const native=sample.cash!==null && sample.at>clickedAt;
      const after=native ? sample.cash : sample.display;
      if (!matchesBalance(after,before-q.amount) || after<0 || after>=before) continue;
      if (!native && (!matchesBalance(last.display,before) || last.display===after)) continue;
      portfolioFlat();
      if (policy.target_balance!=null && policy.live_payout_mode==='all' && Math.abs(after-policy.target_balance)>0.005)
        throw Error('领取后余额与原指令起始余额不符');
      return {observation:{name:cmd.account,category:'funded',phase:'live',snapshot:{
        observed_at:Date.now()/1000,balance:after,equity:after,unrealized_pnl:0,position_open:false}},
        amount:q.amount,expected_received:q.received,recipient:'main',balance_before:before,balance_after:after,
        balance_source:native ? 'portfolio_accounts_response' : 'portfolio_account_value',verification:'source_balance_debited'};
    }
    throw Error('领取已提交，Portfolio 余额尚未确认实际扣款，请核对平台记录');
  }
  async function readAvailable(a) {
    const check = () => {
      a.guard();
      const id=a.identity();
      if(id.name!==a.account || id.phase!=='live' || !['funded','live'].includes(id.category) ||
          location.pathname.replace(/\/$/,'')!=='/portfolio') throw Error('读取可领额期间来源账户发生变化');
    };
    const shown = (root,sel) => [...root.querySelectorAll(sel)].filter(a.visible);
    const dialogs = () => shown(document,'[role="dialog"],[role="alertdialog"],dialog[open]');
    check();
    if(dialogs().length) throw Error('读取可领额前存在其他弹窗');
    const buttons=shown(document,'button[data-testid="withdraw-open"]');
    if(buttons.length!==1 || buttons[0].type!=='button') throw Error('未找到唯一的领取预览入口');
    const open=buttons[0];
    if(!open.disabled && open.getAttribute('aria-disabled')!=='true') a.click(open);
    let prior;
    const deadline=Date.now()+5000;
    do {
      check();
      const list=dialogs();
      if(list.length>1) throw Error('领取预览弹窗不唯一');
      const dialog=list[0];
      if(dialog) {
        const heading=dialog.querySelector('[data-slot="dialog-title"],h2,[role="heading"]');
        if(heading && !/^(领取利润|Claim Profits?)$/i.test(a.text(heading))) throw Error('未识别的领取预览弹窗');
        if(!heading) { await new Promise(r=>setTimeout(r,150)); continue; }
      }
      const amounts=shown(dialog || document,'[data-testid="claim-profit-available"]');
      const value=amounts.length===1 ? a.money(a.text(amounts[0])) : null;
      if(value!==null && value>=0 && value===prior) {
        const result={account:a.account,phase:'live',available:value,observed_at:Date.now()/1000};
        if(dialog) {
          dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}));
          const closeBy=Date.now()+2000;
          while(dialogs().includes(dialog) && Date.now()<closeBy) {
            check();
            await new Promise(r=>setTimeout(r,100));
          }
          if(dialogs().length) throw Error('领取预览未关闭，无法继续领取');
        }
        return result;
      }
      prior=value;
      await new Promise(r=>setTimeout(r,150));
    } while(Date.now()<deadline);
    throw Error('平台未明确显示可领取金额');
  }
  globalThis.VestProfitClaimFlow={withdraw,readAvailable};
})();
