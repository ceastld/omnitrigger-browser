const status = document.querySelector('#status');
const state = document.querySelector('#state');
const toggle = document.querySelector('#toggle');
const name = document.querySelector('#name');
const profileName = document.querySelector('#profile-name');
const settingsForm = document.querySelector('#connection-settings');
const save = document.querySelector('#save');
const settingsNote = document.querySelector('#settings-note');
let enabled;
let changingConnection = false;
let savedName = '';

document.querySelector('#extension-id').textContent = chrome.runtime.id;

const connectionViews = {
  connected: ['已连接', 'ClipHost 和 OmniTrigger 可以使用此浏览器。'],
  connecting: ['连接中', '正在连接本机 Windows 连接器。'],
  disconnected: ['未连接', '启动本机连接器后，扩展会自动重连。'],
  disabled: ['已暂停', '恢复后，本机应用可再次使用此浏览器。'],
};

function showConnection(phase, message) {
  const [label, description] = connectionViews[phase];
  state.dataset.state = phase;
  state.textContent = label;
  status.textContent = message || description;
}

function showFeedback(element, message, error = false) {
  element.textContent = message;
  element.dataset.error = String(error);
}

async function askBridge(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result) throw new Error('无法读取扩展状态，请重新打开弹窗。');
  if (result.error) throw new Error(result.error);
  return result;
}

async function refreshConnection() {
  try {
    const result = await askBridge({ type: 'bridge.status' });
    enabled = result.settings.bridgeEnabled;
    const phase = result.status.state;
    const phaseKnown = Object.hasOwn(connectionViews, phase);
    showConnection(phaseKnown ? phase : 'disconnected', phaseKnown ? undefined : result.status.message);
    profileName.textContent = result.settings.browserName;
    if (name.value === savedName) name.value = result.settings.browserName;
    savedName = result.settings.browserName;
    toggle.textContent = enabled ? '暂停连接' : '恢复连接';
  } catch (error) {
    enabled = undefined;
    showConnection('disconnected', error.message);
  } finally {
    toggle.disabled = changingConnection || enabled === undefined;
  }
}

toggle.addEventListener('click', async () => {
  if (changingConnection || enabled === undefined) return;
  changingConnection = true;
  toggle.disabled = true;
  try {
    await askBridge({ type: 'bridge.enable', enabled: !enabled });
    await refreshConnection();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    changingConnection = false;
    toggle.disabled = enabled === undefined;
  }
});

settingsForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (save.disabled) return;
  const updatedName = name.value.trim();
  if (!updatedName) {
    showFeedback(settingsNote, '请输入浏览器名称。', true);
    return;
  }
  save.disabled = true;
  showFeedback(settingsNote, '');
  try {
    await askBridge({ type: 'bridge.rename', name: updatedName });
    if (name.value.trim() === updatedName) name.value = updatedName;
    await refreshConnection();
    showFeedback(settingsNote, '名称已保存。');
  } catch (error) {
    showFeedback(settingsNote, error.message, true);
  } finally {
    save.disabled = false;
  }
});

name.addEventListener('input', () => showFeedback(settingsNote, ''));
chrome.storage.onChanged.addListener((_, area) => {
  if (area === 'session') void refreshConnection();
});
void refreshConnection();
