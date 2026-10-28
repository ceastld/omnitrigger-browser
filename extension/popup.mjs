const status = document.querySelector('#status');
const name = document.querySelector('#name');
const toggle = document.querySelector('#toggle');
let enabled = true;
document.querySelector('#extension-id').textContent = chrome.runtime.id;
async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: 'bridge.status' });
  if (result.error) throw new Error(result.error);
  status.textContent = result.status.message;
  enabled = result.settings.bridgeEnabled;
  if (document.activeElement !== name) name.value = result.settings.browserName;
  toggle.textContent = enabled ? '停用连接' : '连接';
}
toggle.addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'bridge.enable', enabled: !enabled });
  if (result.error) status.textContent = result.error;
  else await refresh();
});
document.querySelector('#save').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'bridge.rename', name: name.value });
  if (result.error) status.textContent = result.error;
  else await refresh();
});
chrome.storage.onChanged.addListener((_, area) => { if (area === 'session') void refresh(); });
void refresh().catch(error => { status.textContent = error.message; });
