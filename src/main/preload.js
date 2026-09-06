// The only bridge between the renderer and the main process. Nothing else is
// exposed; the renderer has no Node access.
const { contextBridge, ipcRenderer } = require("electron");

const on = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("specforge", {
  appInfo: () => ipcRenderer.invoke("app:info"),
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
  },
  scan: {
    run: (opts) => ipcRenderer.invoke("scan:run", opts),
    onProgress: (cb) => on("scan:progress", cb),
  },
  live: { sample: () => ipcRenderer.invoke("live:sample") },
  bench: {
    run: (opts) => ipcRenderer.invoke("bench:run", opts),
    onProgress: (cb) => on("bench:progress", cb),
  },
  exportFiles: (payload) => ipcRenderer.invoke("export:files", payload),
  renderText: (payload) => ipcRenderer.invoke("export:text", payload),
  history: {
    list: () => ipcRenderer.invoke("history:list"),
    load: (id) => ipcRenderer.invoke("history:load", id),
    delete: (id) => ipcRenderer.invoke("history:delete", id),
  },
  update: {
    check: () => ipcRenderer.invoke("update:check"),
    installNow: () => ipcRenderer.invoke("update:installNow"),
    onStatus: (cb) => on("update:status", cb),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
    showInFolder: (p) => ipcRenderer.invoke("shell:showInFolder", p),
    chooseFolder: () => ipcRenderer.invoke("dialog:chooseFolder"),
  },
  relaunchAsAdmin: () => ipcRenderer.invoke("admin:relaunch"),
});
