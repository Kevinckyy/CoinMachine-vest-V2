// Added to the first unpacked installation on a dedicated Windows profile.
// Use the extension's normal binding and heartbeat checks. Later releases replace this bootstrap.
(() => {
  let busy = false;
  async function pair(tabId) {
    const done = await chrome.storage.local.get('fleetSetupPaired');
    if (done.fleetSetupPaired || await binding()) return true;
    const [active] = await chrome.tabs.query({active: true, currentWindow: true});
    if (active?.id !== tabId || active.url !== VEST + '/accounts') return false;
    const response = await fetch(chrome.runtime.getURL('fleet-pair.json'));
    if (!response.ok) throw Error('Missing managed browser settings');
    const {label, token} = await response.json();
    const saved = await settings();
    if (saved.token && saved.token !== token) return true;
    await setBinding({type: 'ui.bind', mode: 'readonly', label, token});
    await chrome.storage.local.set({fleetSetupPaired: true});
    return true;
  }
  function firstAccountPage(message, sender) {
    if (busy || message.type !== 'poll' || sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
        !sender.tab?.active || sender.tab.url !== VEST + '/accounts') return;
    busy = true;
    exclusive(() => pair(sender.tab.id)).then(done => {
      if (done) chrome.runtime.onMessage.removeListener(firstAccountPage);
    }).catch(() => {}).finally(() => { busy = false; });
  }
  chrome.runtime.onMessage.addListener(firstAccountPage);
})();
