const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, clipboard } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { execFile, spawn } = require("node:child_process");

const { Store, safeName } = require("./store");
const report = require("./report");
const { collectHardware } = require("./collect/hardware");
const { collectSoftware } = require("./collect/software");
const live = require("./collect/live");
const bench = require("./bench");
const updater = require("./updater");

const isDev = process.argv.includes("--dev") || !app.isPackaged;
let win = null;
let store = null;
let isAdmin = false;
let lastUpdateStatus = { state: "idle" };

// ── window ───────────────────────────────────────────────────────
function createWindow() {
  const dark = store.get().theme !== "light";
  nativeTheme.themeSource = dark ? "dark" : "light";
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: dark ? "#0f1218" : "#f4f6fa",
    titleBarStyle: "hidden",
    titleBarOverlay: overlayColors(dark),
    icon: path.join(__dirname, "..", "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
  if (isDev && process.argv.includes("--devtools")) win.webContents.openDevTools({ mode: "detach" });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

function overlayColors(dark) {
  return dark ? { color: "#0f1218", symbolColor: "#c9d1e0", height: 40 } : { color: "#f4f6fa", symbolColor: "#2b3345", height: 40 };
}

// ── admin detection ──────────────────────────────────────────────
function detectAdmin() {
  return new Promise((resolve) => {
    execFile("fltmc.exe", [], { windowsHide: true }, (err) => resolve(!err));
  });
}

// ── IPC ──────────────────────────────────────────────────────────
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

ipcMain.handle("app:info", () => ({
  name: "SpecForge",
  version: app.getVersion(),
  isAdmin,
  isPackaged: app.isPackaged,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  userData: app.getPath("userData"),
  repo: "https://github.com/AxialForge/SpecForge",
  updateStatus: lastUpdateStatus,
}));

ipcMain.handle("settings:get", () => store.get());
ipcMain.handle("settings:set", (_e, patch) => {
  const s = store.set(patch || {});
  if (patch && patch.theme && win) {
    const dark = s.theme !== "light";
    nativeTheme.themeSource = dark ? "dark" : "light";
    win.setTitleBarOverlay(overlayColors(dark));
    win.setBackgroundColor(dark ? "#0f1218" : "#f4f6fa");
  }
  return s;
});

ipcMain.handle("scan:run", async (_e, opts = {}) => {
  const started = Date.now();
  const settings = store.get();
  const progress = (phase) => (p) => send("scan:progress", { phase, ...p });
  const [hw, sw] = await Promise.all([
    collectHardware(progress("hardware")),
    collectSoftware({ programs: opts.programs ?? settings.includePrograms, productKey: settings.includeSensitive }, progress("software")),
  ]);
  const r = {
    meta: { app: "SpecForge", appVersion: app.getVersion(), scannedAt: new Date().toISOString(), hostname: os.hostname(), durationMs: Date.now() - started, isAdmin },
    sections: [...hw, ...sw],
  };
  r.meta.summary = report.summarize(r);
  r.id = store.saveScan(r);
  return r;
});

ipcMain.handle("live:sample", () => live.sample());

ipcMain.handle("bench:run", async (_e, opts = {}) => {
  const s = store.get();
  return bench.runSuite({ cpuSeconds: opts.cpuSeconds || s.benchCpuSeconds, diskMb: opts.diskMb || s.benchDiskMb, diskDir: opts.diskDir || app.getPath("temp"), tests: opts.tests }, (p) => send("bench:progress", p));
});

// Build the export text for a given payload — shared by "save" and "copy".
function buildOutputs(payload, settings) {
  const includeSensitive = !!settings.includeSensitive;
  const outputs = [];
  if (payload.kind === "scan") {
    let r = report.filterSensitive(payload.report, includeSensitive);
    if (payload.includePrograms === false || (payload.includePrograms == null && !settings.includePrograms)) r = report.dropSections(r, ["programs"]);
    const ai = payload.aiPrompt ?? settings.aiPrompt;
    const fmts = payload.formats || settings.formats;
    const base = `SpecForge_${safeName(r.meta.hostname)}_${r.meta.scannedAt.slice(0, 19).replace(/[:T]/g, "-")}`;
    if (fmts.csv) outputs.push({ name: `${base}.csv`, text: (payload.csvLayout || settings.csvLayout) === "wide" ? report.toCsvWide(r) : report.toCsv(r, { aiPrompt: ai }) });
    if (fmts.json) outputs.push({ name: `${base}.json`, text: report.toJson(r) });
    if (fmts.txt) outputs.push({ name: `${base}.txt`, text: report.toText(r, { aiPrompt: ai }) });
  } else if (payload.kind === "bench") {
    const meta = { app: "SpecForge", appVersion: app.getVersion(), scannedAt: payload.bench.startedAt, hostname: os.hostname() };
    const r = report.benchToReport(payload.bench, meta);
    const base = `SpecForge_Benchmark_${safeName(os.hostname())}_${payload.bench.startedAt.slice(0, 19).replace(/[:T]/g, "-")}`;
    outputs.push({ name: `${base}.csv`, text: report.toCsv(r) });
    if (payload.formats?.json) outputs.push({ name: `${base}.json`, text: report.toJson({ ...r, raw: payload.bench }) });
    if (payload.formats?.txt) outputs.push({ name: `${base}.txt`, text: report.toText(r) });
  } else if (payload.kind === "live") {
    const base = `SpecForge_Live_${safeName(os.hostname())}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
    outputs.push({ name: `${base}.csv`, text: report.liveToCsv(payload.samples || []) });
  }
  return outputs;
}

ipcMain.handle("export:text", (_e, payload) => {
  const outputs = buildOutputs(payload, store.get());
  const pick = outputs.find((o) => o.name.endsWith(".txt")) || outputs[0];
  return pick ? pick.text : "";
});

ipcMain.handle("export:files", async (_e, payload) => {
  const settings = store.get();
  const outputs = buildOutputs(payload, settings);
  if (!outputs.length) return { ok: false, error: "No export formats enabled. Turn one on in Settings." };
  let dir = settings.exportDir;
  if (!dir) {
    const r = await dialog.showOpenDialog(win, { title: "Choose where to save the export", properties: ["openDirectory", "createDirectory"], defaultPath: app.getPath("documents") });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    dir = r.filePaths[0];
  }
  await fs.mkdir(dir, { recursive: true });
  const files = [];
  for (const o of outputs) {
    const p = path.join(dir, o.name);
    await fs.writeFile(p, "﻿" + o.text, "utf8"); // BOM so Excel reads UTF-8
    files.push(p);
  }
  if (payload.copy) clipboard.writeText(outputs[0].text);
  return { ok: true, files, dir };
});

ipcMain.handle("history:list", () => store.listScans());
ipcMain.handle("history:load", (_e, id) => {
  const r = store.loadScan(id);
  r.id = id;
  return r;
});
ipcMain.handle("history:delete", (_e, id) => store.deleteScan(id));

ipcMain.handle("update:check", async () => {
  if (!app.isPackaged) return (lastUpdateStatus = { state: "error", message: "Updates only run in the installed app." });
  if (!store.get().autoUpdate) return (lastUpdateStatus = { state: "error", message: "Automatic updates are turned off in Settings." });
  try {
    const { autoUpdater } = require("electron-updater");
    await autoUpdater.checkForUpdates();
  } catch (err) {
    lastUpdateStatus = { state: "error", message: "Couldn't check for updates. " + (/net::|ENOTFOUND|EAI_AGAIN|getaddrinfo|ETIMEDOUT/i.test(String(err)) ? "You appear to be offline." : String(err.message || err).slice(0, 120)) };
    send("update:status", lastUpdateStatus);
  }
  return lastUpdateStatus;
});
ipcMain.handle("update:installNow", () => updater.installNow());

ipcMain.handle("shell:openExternal", (_e, url) => (/^https?:/i.test(url) ? shell.openExternal(url) : null));
ipcMain.handle("shell:showInFolder", (_e, p) => shell.showItemInFolder(p));
ipcMain.handle("dialog:chooseFolder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("admin:relaunch", () => {
  const exe = process.execPath;
  const args = app.isPackaged ? [] : [path.resolve(".")];
  const argList = args.length ? `-ArgumentList '${args.map((a) => a.replace(/'/g, "''")).join("','")}'` : "";
  spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", `Start-Process -FilePath '${exe.replace(/'/g, "''")}' ${argList} -Verb RunAs`], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  setTimeout(() => app.quit(), 300);
  return true;
});

// ── lifecycle ────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    store = new Store(app.getPath("userData"));
    isAdmin = await detectAdmin();
    createWindow();
    updater.start({
      enabled: store.get().autoUpdate,
      onStatus: (s) => {
        lastUpdateStatus = s.state === "error" ? { state: "error", message: "Couldn't check for updates. " + s.message } : s;
        send("update:status", lastUpdateStatus);
      },
    });
  });
  app.on("window-all-closed", () => app.quit());
}
