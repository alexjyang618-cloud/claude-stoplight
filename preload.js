const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stoplight', {
  // widget
  onState: (cb) => ipcRenderer.on('state', (_event, data) => cb(data)),
  onConfig: (cb) => ipcRenderer.on('config', (_event, data) => cb(data)),
  onHover: (cb) => ipcRenderer.on('hover', (_event, data) => cb(data)),
  onReact: (cb) => ipcRenderer.on('react', (_event, data) => cb(data)),
  onUsage: (cb) => ipcRenderer.on('usage', (_event, data) => cb(data)),
  // which part of the window is the widget right now: { open, reach }
  live: (region) => ipcRenderer.send('widget:live', region),
  focusSession: (id) => ipcRenderer.send('widget:focus-session', id),
  // settings page
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.send('settings:save', s),
});
