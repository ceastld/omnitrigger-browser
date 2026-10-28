// Compatibility metadata only: every method uses the same dispatcher.
// Promise modes are for the minimum Chrome 120 worker context. Chrome still
// enforces permission, argument and version requirements at invocation time.
const namespaces = {
  bookmarks: 'create get getChildren getRecent getSubTree getTree move remove removeTree search update',
  tabs: 'captureVisibleTab create detectLanguage discard duplicate get getCurrent getZoom getZoomSettings goBack goForward group highlight move query reload remove sendMessage setZoom setZoomSettings ungroup update',
  windows: 'create get getAll getCurrent getLastFocused remove update',
  permissions: 'contains getAll remove request',
  history: 'addUrl deleteAll deleteRange deleteUrl getVisits search',
  sessions: 'getDevices getRecentlyClosed restore',
  runtime: 'getContexts getPlatformInfo openOptionsPage requestUpdateCheck setUninstallURL',
  alarms: 'clear clearAll create get getAll',
  scripting: 'executeScript insertCSS removeCSS getRegisteredContentScripts registerContentScripts unregisterContentScripts updateContentScripts',
};

export const API_MODES = Object.create(null);
for (const [namespace, methods] of Object.entries(namespaces)) {
  for (const method of methods.split(' ')) API_MODES[`${namespace}.${method}`] = 'promise';
}
for (const area of ['local', 'sync', 'session', 'managed']) {
  for (const method of ['get', 'getBytesInUse']) API_MODES[`storage.${area}.${method}`] = 'promise';
  if (area !== 'managed') {
    for (const method of ['set', 'remove', 'clear']) API_MODES[`storage.${area}.${method}`] = 'promise';
  }
}
for (const method of ['getManifest', 'getURL']) API_MODES[`runtime.${method}`] = 'sync';
Object.freeze(API_MODES);
