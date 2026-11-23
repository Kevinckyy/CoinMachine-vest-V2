'use strict';

const $ = id => document.getElementById(id);
async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({
    type,
    ...extra
  });
  if (!response.ok) throw Error(response.error);
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
  $('status').textContent = state.diagnostic || '本机桥 · 127.0.0.1:8877';
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
