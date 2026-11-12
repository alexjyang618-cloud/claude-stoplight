const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stoplight', {
  // widget
  onState: (cb) => ipcRenderer.on('state', (_event, data) => cb(data)),
  onConfig: (cb) => ipcRenderer.on('config', (_event, data) => cb(data)),
  onHover: (cb) => ipcRenderer.on('hover', (_event, data) => cb(data)),
  onReact: (cb) => ipcRenderer.on('react', (_event, data) => cb(data)),
  onUsage: (cb) => ipcRenderer.on('usage', (_event, data) => cb(data)),
  expand: (px) => ipcRenderer.send('widget:expand', px),
  collapse: () => ipcRenderer.send('widget:collapse'),
  focusSession: (id, clawdRect) => ipcRenderer.send('widget:focus-session', id, clawdRect),
  // clawd grab (widget side)
  clawdWarm: () => ipcRenderer.send('clawd:warm'),
  clawdGrab: (rect) => ipcRenderer.send('clawd:grab', rect),
  clawdRelease: () => ipcRenderer.send('clawd:release'),
  onClawdAway: (cb) => ipcRenderer.on('clawd:away', () => cb()),
  onClawdRestore: (cb) => ipcRenderer.on('clawd:restore', () => cb()),
  // clawd escapade overlay
  onClawdBegin: (cb) => ipcRenderer.on('clawd:begin', (_event, data) => cb(data)),
  onClawdCursor: (cb) => ipcRenderer.on('clawd:cursor', (_event, data) => cb(data)),
  onClawdReleased: (cb) => ipcRenderer.on('clawd:released', () => cb()),
  clawdCatchable: (over) => ipcRenderer.send('clawd:catchable', Boolean(over)),
  clawdCaught: () => ipcRenderer.send('clawd:caught'),
  clawdDone: () => ipcRenderer.send('clawd:done'),
  // settings page
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.send('settings:save', s),
});
