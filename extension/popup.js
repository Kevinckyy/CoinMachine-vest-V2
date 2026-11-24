'use strict';

const $ = id => document.getElementById(id);
async function send(type, extra = {}) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({type, ...extra});
  } catch (err) {
    if (/receiving end does not exist|extension context invalidated/i.test(err.message))
      throw Error('插件后台未连接，请关闭弹窗再打开。若仍未连接，请在扩展管理页重新加载 Vest Fleet。');
    throw err;
  }
  if (!response?.ok) throw Error(response?.error || '插件后台尚未就绪，请重新打开弹窗');
  return response.value;
}
async function refresh() {
  const state = await send('ui.state');
  $('label').value = state.label;
  $('token').value = '';
  $('token').placeholder = state.paired ? '已保存，留空可沿用' : '节点的 VEST_PLUGIN_TOKEN';
  $('mode').textContent = {
    execute: '执行',
    readonly: '只读',
    unbound: '未绑定'
  }[state.mode];
  $('status').textContent = '插件 '+state.plugin_version+' · '+(state.diagnostic || '本机桥 · 127.0.0.1:8877') +
    (state.cacheCount == null ? '' : ' · 已缓存 '+state.cacheCount+' 个活动账户');
}
for (const [id, type, notice] of [
  ['refreshCards','ui.refresh','已请求全量拉取账户列表'],
  ['readAll','ui.readAll','已请求批量读取账户响应，可在中心查看结果']
]) {
  $(id).onclick = async () => {
    $(id).disabled = true;
    try { await send(type); $('status').textContent=notice; }
    catch (err) { $('status').textContent=err.message; }
    finally { $(id).disabled=false; }
  };
}
for (const id of ['readonly', 'execute', 'disconnect']) {
  $(id).onclick = async () => {
    const buttons = [...document.querySelectorAll('button')];
    buttons.forEach(button => {
      button.disabled = true;
    });
    try {
      await send(id === 'disconnect' ? 'ui.disconnect' : 'ui.bind', {
        mode: id,
        label: $('label').value,
        token: $('token').value
      });
      await refresh();
    } catch (err) {
      $('status').textContent = err.message;
    } finally {
      buttons.forEach(button => {
        button.disabled = false;
      });
    }
  };
}
refresh().catch(err => {
  $('status').textContent = err.message;
});
