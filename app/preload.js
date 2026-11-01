'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dshift', {
  getState: () => ipcRenderer.invoke('state:get'),
  newTab: () => ipcRenderer.invoke('tab:new'),
  closeTab: id => ipcRenderer.invoke('tab:close', id),
  activateTab: id => ipcRenderer.invoke('tab:activate', id),
  setTabModel: (id, m) => ipcRenderer.invoke('tab:model', id, m),
  clearChat: id => ipcRenderer.invoke('chat:clear', id),
  send: (tabId, q) => ipcRenderer.invoke('chat:send', tabId, q),
  stop: () => ipcRenderer.invoke('chat:stop'),
  openMemory: () => ipcRenderer.invoke('memory:open'),
  listMemory: () => ipcRenderer.invoke('memory:list'),
  readMemory: rel => ipcRenderer.invoke('memory:read', rel),
  writeMemory: (rel, c) => ipcRenderer.invoke('memory:write', rel, c),
  undoMemory: rel => ipcRenderer.invoke('memory:undo', rel),
  saveSettings: patch => ipcRenderer.invoke('settings:save', patch),
  setKey: (provider, key) => ipcRenderer.invoke('settings:key', provider, key),
  detectCodex: () => ipcRenderer.invoke('codex:detect'),
  codexDecision: approved => ipcRenderer.send('codex:decision', approved),
  on: (channel, fn) => ipcRenderer.on(channel, (_e, data) => fn(data)),
});
