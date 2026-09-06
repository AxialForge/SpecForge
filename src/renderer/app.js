/* SpecForge renderer. Plain DOM, no framework. State lives in `state`; each
   page has a render function that reads from it. */
const api = window.specforge;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  info: null,
  settings: null,
  report: null, // current scan (fresh or loaded from history)
  bench: null,
  live: { running: false, timer: null, samples: [], history: { cpu: [], temp: [], mem: [], gpu: [], disk: [], net: [] } },
};

const PAGE_TITLES = { dashboard: "Dashboard", hardware: "Hardware", software: "Software", live: "Live monitor", bench: "Benchmark", export: "Export", history: "History", settings: "Settings", about: "About SpecForge" };
const SOFTWARE_IDS = new Set(["os", "security", "programs", "updates", "startup"]);

// ── boot ──────────────────────────────────────────────────────
async function boot() {
  state.info = await api.appInfo();
  state.settings = await api.settings.get();
  applyTheme();
  $("#foot-version").textContent = `v${state.info.version}`;
  $("#about-version").textContent = state.info.version;
  $("#about-electron").textContent = state.info.electron;
  $("#about-chrome").textContent = state.info.chrome.split(".")[0];
  $("#about-userdata").textContent = state.info.userData;
  if (!state.info.isAdmin) $("#admin-btn").classList.remove("hidden");
  renderSettings();
  renderExportOptions();
  renderHistory();
  showUpdateStatus(state.info.updateStatus);
  // auto-load the most recent scan so the app never opens empty
  const list = await api.history.list();
  if (list.length) {
    state.report = await api.history.load(list[0].id);
    renderAll();
  }
}

function applyTheme() {
  document.body.dataset.theme = state.settings.theme === "light" ? "light" : "dark";
}

// ── navigation ────────────────────────────────────────────────
function go(page) {
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${page}`));
  $("#page-title").textContent = PAGE_TITLES[page] || page;
  if (page === "export") renderExportPreview();
  if (page === "history") renderHistory();
  if (page !== "live" && state.live.running) stopLive();
}
$$(".nav-item").forEach((b) => b.addEventListener("click", () => go(b.dataset.page)));

// ── scan ──────────────────────────────────────────────────────
let scanning = false;
async function runScan() {
  if (scanning) return;
  scanning = true;
  const btn = $("#scan-btn");
  btn.disabled = true;
  btn.querySelector("span").textContent = "Scanning…";
  $("#scan-progress").classList.remove("hidden");
  const prog = { hardware: 0, software: 0, hwTotal: 8, swTotal: 4 };
  const off = api.scan.onProgress((p) => {
    prog[p.phase] = p.done;
    prog[p.phase === "hardware" ? "hwTotal" : "swTotal"] = p.total;
    const pct = Math.round(((prog.hardware + prog.software) / (prog.hwTotal + prog.swTotal)) * 100);
    $("#scan-bar").style.width = `${pct}%`;
    $("#scan-label").textContent = `Collected ${p.label}…`;
  });
  try {
    state.report = await api.scan.run({ programs: state.settings.includePrograms });
    renderAll();
    toast(`Scan complete in ${(state.report.meta.durationMs / 1000).toFixed(1)}s.`);
  } catch (err) {
    toast("Scan failed: " + (err.message || err), true);
  } finally {
    off();
    scanning = false;
    btn.disabled = false;
    btn.querySelector("span").textContent = "Scan this PC";
    $("#scan-bar").style.width = "100%";
    setTimeout(() => $("#scan-progress").classList.add("hidden"), 600);
  }
}
$("#scan-btn").addEventListener("click", runScan);

// ── generic actions (data-action / data-link) ─────────────────
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-action]");
  if (a) {
    const act = a.dataset.action;
    if (act === "scan") runScan();
    if (act === "export") doExport();
    if (act === "copy-ai") copyForAi();
    if (act === "goto-hardware") go("hardware");
    if (act === "goto-software") go("software");
    if (act === "goto-settings") go("settings");
  }
  const l = e.target.closest("[data-link]");
  if (l) api.shell.openExternal(l.dataset.link);
});
$("#admin-btn").addEventListener("click", () => api.relaunchAsAdmin());

// ── render: everything derived from state.report ──────────────
function renderAll() {
  renderDashboard();
  renderSections("hw", (s) => !SOFTWARE_IDS.has(s.id), $("#hw-search").value);
  renderSections("sw", (s) => SOFTWARE_IDS.has(s.id), $("#sw-search").value);
  renderExportPreview();
  renderHistory();
}

function renderDashboard() {
  const r = state.report;
  if (!r) return;
  $("#dash-empty").classList.add("hidden");
  $("#dash-content").classList.remove("hidden");
  const s = r.meta.summary || {};
  const cards = [
    ["Processor", s.cpu, fieldOf(r, "cpu", "Physical cores") ? `${fieldOf(r, "cpu", "Physical cores")} cores / ${fieldOf(r, "cpu", "Threads")} threads · ${fieldOf(r, "cpu", "Max boost clock") || fieldOf(r, "cpu", "Base clock") || ""}` : "", "#7c8cff"],
    ["Graphics", s.gpu, fieldOf(r, "gpu", "VRAM") ? `${fieldOf(r, "gpu", "VRAM")} · driver ${fieldOf(r, "gpu", "NVIDIA driver") || fieldOf(r, "gpu", "Driver version") || "?"}` : "", "#2fd6c8"],
    ["Memory", s.ram, [s.ramType, fieldOf(r, "memory", "Speed"), fieldOf(r, "memory", "Modules") ? `${fieldOf(r, "memory", "Modules")} modules` : null].filter(Boolean).join(" · "), "#ffd166"],
    ["Storage", s.storage, (sectionOf(r, "volumes") || { items: [] }).items.map((v) => `${fieldOf(v, null, "Drive")} ${fieldOf(v, null, "Free")} free`).join(" · "), "#ff8a4d"],
    ["Operating system", s.os, [fieldOf(r, "os", "Version"), fieldOf(r, "os", "Activation")].filter(Boolean).join(" · "), "#4ade80"],
    ["Motherboard", s.board, [fieldOf(r, "board", "Manufacturer"), biosVersion(r) ? `BIOS ${biosVersion(r)}` : null].filter(Boolean).join(" · "), "#f472b6"],
  ];
  $("#hero-grid").innerHTML = cards
    .map(([label, value, sub, c]) => `<div class="hero" style="--c:${c}"><div class="hero-label">${esc(label)}</div><div class="hero-value">${esc(value || "Not detected")}</div><div class="hero-sub">${esc(sub || "")}</div></div>`)
    .join("");
  const when = new Date(r.meta.scannedAt);
  $("#dash-meta").textContent = `Scanned ${when.toLocaleString()} on ${r.meta.hostname} in ${((r.meta.durationMs || 0) / 1000).toFixed(1)}s${r.meta.isAdmin ? " (administrator)" : " (standard user — some fields need admin)"}.`;
  const hl = [];
  const sys = fieldOf(r, "system", "Model");
  if (sys) hl.push(`<b>${esc(fieldOf(r, "system", "Manufacturer") || "")} ${esc(sys)}</b> ${esc(fieldOf(r, "system", "Form factor") || "")}`);
  const disks = sectionOf(r, "storage");
  if (disks) disks.items.forEach((d) => hl.push(`${esc(fieldOf(d, null, "Capacity") || "")} ${esc(fieldOf(d, null, "Type") || "")} <b>${esc(d.name)}</b>${fieldOf(d, null, "Health") ? ` · health ${esc(fieldOf(d, null, "Health"))}` : ""}`));
  const disp = sectionOf(r, "display");
  if (disp) disp.items.forEach((d) => hl.push(`Display <b>${esc(d.name)}</b> ${esc(fieldOf(d, null, "Native resolution") || fieldOf(d, null, "Desktop resolution (scaled)") || "")} ${esc(fieldOf(d, null, "Max refresh rate") || fieldOf(d, null, "Refresh rate") || "")}${fieldOf(d, null, "Size") ? ` · ${esc(fieldOf(d, null, "Size"))}` : ""}`));
  const bat = sectionOf(r, "battery");
  if (bat && bat.items.length) hl.push(`Battery health <b>${esc(fieldOf(r, "battery", "Health") || "?")}</b>`);
  const progs = sectionOf(r, "programs");
  if (progs) hl.push(`<b>${progs.items.length}</b> installed programs`);
  const tpm = fieldOf(r, "board", "Spec version");
  if (tpm) hl.push(`TPM ${esc(tpm)} · Secure Boot ${esc(fieldOf(r, "board", "Secure Boot") || "?")}`);
  $("#dash-highlights").innerHTML = hl.map((h) => `<li>${h}</li>`).join("") || "<li class='muted'>Nothing notable.</li>";
}

function sectionOf(r, id) {
  return r.sections.find((s) => s.id === id);
}
function biosVersion(r) {
  const bios = (sectionOf(r, "board") || { items: [] }).items.find((it) => /bios/i.test(it.name));
  return bios ? fieldOf(bios, null, "Version") : null;
}
/** fieldOf(report, sectionId, label) or fieldOf(item, null, label) */
function fieldOf(rOrItem, id, label) {
  const item = id ? (sectionOf(rOrItem, id) || { items: [] }).items[0] : rOrItem;
  if (!item) return null;
  const f = item.fields.find((x) => x.label === label);
  return f ? String(f.value) + (f.unit ? ` ${f.unit}` : "") : null;
}

const TABLE_SECTIONS = new Set(["programs", "updates", "startup", "volumes", "audio", "usb", "printers"]);
function renderSections(prefix, pick, filter = "") {
  const host = $(`#${prefix}-sections`);
  const r = state.report;
  if (!r) return;
  const q = filter.trim().toLowerCase();
  const secs = r.sections.filter(pick).filter((s) => s.items.length);
  let total = 0;
  host.innerHTML = secs
    .map((s) => {
      const items = q ? s.items.filter((it) => it.name.toLowerCase().includes(q) || it.fields.some((f) => `${f.label} ${f.value}`.toLowerCase().includes(q))) : s.items;
      if (!items.length) return "";
      total += items.length;
      const open = q || !TABLE_SECTIONS.has(s.id) ? "open" : "";
      const body = TABLE_SECTIONS.has(s.id) && items.length > 1 ? renderTable(items) : items.map(renderItem).join("");
      return `<div class="sec ${open}" data-sec="${s.id}"><div class="sec-head"><span class="chev">▶</span><h3>${esc(s.title)}</h3><span class="count">${items.length}</span></div><div class="sec-body">${body}</div></div>`;
    })
    .join("");
  $(`#${prefix}-count`).textContent = `${total} items`;
  $$(".sec-head", host).forEach((h) => h.addEventListener("click", () => h.parentElement.classList.toggle("open")));
}
function renderItem(it) {
  return `<div class="item">${it.fields.length > 1 || it.name !== it.fields[0]?.value ? `<div class="item-name">${esc(it.name)}</div>` : ""}<div class="kv">${it.fields.map((f) => `<div class="k">${esc(f.label)}</div><div class="v ${f.sensitive ? "sens" : ""}" title="${f.sensitive ? "Private — excluded from exports unless enabled in Settings" : ""}">${esc(fmt(f))}</div>`).join("")}</div></div>`;
}
function renderTable(items) {
  const cols = [];
  items.forEach((it) => it.fields.forEach((f) => !cols.includes(f.label) && cols.push(f.label)));
  // A column fewer than a third of the rows fill only makes the table wide.
  const keep = cols.filter((c) => items.filter((it) => it.fields.some((f) => f.label === c)).length >= items.length / 3);
  const rows = items.map((it) => `<tr>${keep.map((c) => `<td>${esc(fmt(it.fields.find((f) => f.label === c)))}</td>`).join("")}</tr>`).join("");
  return `<div class="table-wrap"><table class="grid"><thead><tr>${keep.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function fmt(f) {
  if (!f) return "";
  const v = f.value;
  if (v === true) return "Yes";
  if (v === false) return "No";
  return String(v ?? "") + (f.unit ? ` ${f.unit}` : "");
}
$("#hw-search").addEventListener("input", (e) => renderSections("hw", (s) => !SOFTWARE_IDS.has(s.id), e.target.value));
$("#sw-search").addEventListener("input", (e) => renderSections("sw", (s) => SOFTWARE_IDS.has(s.id), e.target.value));

// ── export ────────────────────────────────────────────────────
function exportPayload() {
  const st = state.settings;
  return { kind: "scan", report: state.report, formats: { csv: $("#x-csv").checked, json: $("#x-json").checked, txt: $("#x-txt").checked }, aiPrompt: $("#x-ai").checked, includePrograms: $("#x-programs").checked, csvLayout: st.csvLayout };
}
function renderExportOptions() {
  const st = state.settings;
  $("#x-csv").checked = st.formats.csv;
  $("#x-json").checked = st.formats.json;
  $("#x-txt").checked = st.formats.txt;
  $("#x-ai").checked = st.aiPrompt;
  $("#x-programs").checked = st.includePrograms;
  const sens = $("#x-sensitive");
  sens.textContent = st.includeSensitive ? "Serials & keys INCLUDED" : "Serials & keys excluded";
  sens.className = "pill " + (st.includeSensitive ? "danger" : "ok");
  $("#x-dir").textContent = st.exportDir || "Ask every time";
  $$(".seg-btn").forEach((b) => b.classList.toggle("on", String(st[b.dataset.seg]) === b.dataset.val));
}
async function renderExportPreview() {
  const ta = $("#export-preview");
  if (!state.report) return (ta.value = "");
  const p = exportPayload();
  p.formats = { txt: true };
  ta.value = await api.renderText(p);
}
["#x-csv", "#x-json", "#x-txt", "#x-ai", "#x-programs"].forEach((id) =>
  $(id).addEventListener("change", async () => {
    const patch = { formats: { csv: $("#x-csv").checked, json: $("#x-json").checked, txt: $("#x-txt").checked }, aiPrompt: $("#x-ai").checked, includePrograms: $("#x-programs").checked };
    state.settings = await api.settings.set(patch);
    renderSettings();
    renderExportPreview();
  })
);
async function doExport() {
  if (!state.report) return toast("Run a scan first.", true);
  const res = await api.exportFiles(exportPayload());
  if (res.canceled) return;
  if (!res.ok) return toast(res.error || "Export failed.", true);
  $("#export-result").innerHTML = `Saved ${res.files.length} file${res.files.length > 1 ? "s" : ""} to <button class="link" id="open-dir">${esc(res.dir)}</button>`;
  $("#open-dir").addEventListener("click", () => api.shell.showInFolder(res.files[0]));
  toast(`Saved ${res.files.map((f) => f.split(/[\\/]/).pop()).join(", ")}`);
}
async function copyForAi() {
  if (!state.report) return toast("Run a scan first.", true);
  const p = exportPayload();
  p.formats = { txt: true };
  const text = await api.renderText(p);
  await navigator.clipboard.writeText(text);
  toast("Copied. Paste it into ChatGPT, Claude or Gemini and ask for a listing.");
}

// ── history ───────────────────────────────────────────────────
async function renderHistory() {
  const list = await api.history.list();
  const host = $("#history-list");
  if (!list.length) return (host.innerHTML = "<p class='muted'>No scans yet.</p>");
  host.innerHTML = list
    .map((h) => {
      const s = h.summary || {};
      return `<div class="hist ${state.report && state.report.id === h.id ? "current" : ""}" data-id="${esc(h.id)}"><div class="when">${new Date(h.scannedAt).toLocaleString()}<div class="muted small">${esc(h.hostname)}</div></div><div class="what">${esc([s.cpu, s.gpu, s.ram, s.storage].filter(Boolean).join(" · ") || "—")}</div><button class="btn btn-sm" data-h="open">Open</button><button class="btn btn-sm" data-h="delete">Delete</button></div>`;
    })
    .join("");
  host.onclick = async (e) => {
    const b = e.target.closest("[data-h]");
    if (!b) return;
    const id = b.closest(".hist").dataset.id;
    if (b.dataset.h === "open") {
      state.report = await api.history.load(id);
      renderAll();
      go("dashboard");
    } else {
      await api.history.delete(id);
      if (state.report && state.report.id === id) state.report = null;
      renderHistory();
    }
  };
}

// ── settings ──────────────────────────────────────────────────
function renderSettings() {
  const st = state.settings;
  $$(".seg-btn").forEach((b) => b.classList.toggle("on", String(st[b.dataset.seg]) === b.dataset.val));
  $("#s-programs").checked = st.includePrograms;
  $("#s-dir").textContent = st.exportDir || "Ask every time";
  $("#s-bench-cpu").value = st.benchCpuSeconds;
  $("#s-bench-disk").value = st.benchDiskMb;
  $("#s-autoupdate").checked = st.autoUpdate;
}
async function saveSetting(patch) {
  state.settings = await api.settings.set(patch);
  applyTheme();
  renderSettings();
  renderExportOptions();
  renderExportPreview();
}
$$(".seg-btn").forEach((b) =>
  b.addEventListener("click", () => {
    const key = b.dataset.seg;
    let val = b.dataset.val;
    if (val === "true") val = true;
    if (val === "false") val = false;
    if (key === "includeSensitive" && val === true) return openModal(() => saveSetting({ includeSensitive: true }));
    saveSetting({ [key]: val });
  })
);
$("#s-programs").addEventListener("change", (e) => saveSetting({ includePrograms: e.target.checked }));
$("#s-autoupdate").addEventListener("change", (e) => saveSetting({ autoUpdate: e.target.checked }));
$("#s-bench-cpu").addEventListener("change", (e) => saveSetting({ benchCpuSeconds: clamp(+e.target.value, 2, 60) }));
$("#s-bench-disk").addEventListener("change", (e) => saveSetting({ benchDiskMb: clamp(+e.target.value, 64, 4096) }));
$("#s-dir-pick").addEventListener("click", async () => {
  const d = await api.shell.chooseFolder();
  if (d) saveSetting({ exportDir: d });
});
$("#s-dir-clear").addEventListener("click", () => saveSetting({ exportDir: "" }));
const clamp = (v, a, b) => (Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : a);

function openModal(onConfirm) {
  const m = $("#modal");
  m.classList.remove("hidden");
  const close = () => m.classList.add("hidden");
  $("#modal-cancel").onclick = close;
  $("#modal-confirm").onclick = () => {
    close();
    onConfirm();
  };
}

// ── live monitor ──────────────────────────────────────────────
$("#live-toggle").addEventListener("click", () => (state.live.running ? stopLive() : startLive()));
$("#live-clear").addEventListener("click", () => {
  state.live.samples = [];
  Object.keys(state.live.history).forEach((k) => (state.live.history[k] = []));
  $("#live-export").disabled = true;
  $("#live-clear").disabled = true;
});
$("#live-export").addEventListener("click", async () => {
  const res = await api.exportFiles({ kind: "live", samples: state.live.samples });
  if (res.ok) toast(`Saved ${res.files[0].split(/[\\/]/).pop()}`);
  else if (!res.canceled) toast(res.error, true);
});
function startLive() {
  state.live.running = true;
  $("#live-toggle").textContent = "Stop monitoring";
  $("#live-status").textContent = "Sampling every 2 s";
  tickLive();
  state.live.timer = setInterval(tickLive, 2000);
}
function stopLive() {
  state.live.running = false;
  clearInterval(state.live.timer);
  $("#live-toggle").textContent = "Start monitoring";
  $("#live-status").textContent = `Stopped · ${state.live.samples.length} samples`;
}
let liveBusy = false;
async function tickLive() {
  if (liveBusy) return;
  liveBusy = true;
  try {
    const s = await api.live.sample();
    state.live.samples.push(s);
    if (state.live.samples.length > 3600) state.live.samples.shift();
    $("#live-export").disabled = false;
    $("#live-clear").disabled = false;
    $("#live-status").textContent = `Sampling every 2 s · ${state.live.samples.length} samples`;
    const H = state.live.history;
    push(H.cpu, s.cpu.load);
    push(H.temp, s.cpu.temp);
    push(H.mem, s.mem.pct);
    push(H.gpu, s.gpu.load);
    push(H.disk, s.disk ? s.disk.tIO : null);
    push(H.net, (s.net.rx + s.net.tx) / 1024);
    $("#g-cpu").textContent = s.cpu.load != null ? `${s.cpu.load}%` : "–";
    $("#g-cpu-sub").textContent = s.cpu.speed ? `${s.cpu.speed.toFixed(2)} GHz` : "";
    $("#g-temp").textContent = s.cpu.temp != null ? `${s.cpu.temp} °C` : "n/a";
    $("#g-temp-sub").textContent = s.cpu.temp != null ? (s.cpu.tempMax ? `max ${s.cpu.tempMax} °C` : "") : "Not exposed by this board (try admin)";
    $("#g-mem").textContent = s.mem.pct != null ? `${s.mem.pct}%` : "–";
    $("#g-mem-sub").textContent = s.mem.total ? `${gb(s.mem.used)} of ${gb(s.mem.total)} GB` : "";
    $("#g-gpu").textContent = s.gpu.load != null ? `${s.gpu.load}%` : s.gpu.temp != null ? `${s.gpu.temp} °C` : "n/a";
    $("#g-gpu-sub").textContent = [s.gpu.name, s.gpu.temp != null && s.gpu.load != null ? `${s.gpu.temp} °C` : null, s.gpu.memUsed ? `${s.gpu.memUsed}/${s.gpu.memTotal} MB` : null].filter(Boolean).join(" · ") || "Load/temp available on NVIDIA GPUs";
    $("#g-disk").textContent = s.disk ? `${Math.round(s.disk.tIO || 0)} IO/s` : "n/a";
    $("#g-disk-sub").textContent = s.disk ? `${Math.round(s.disk.rIO || 0)} read · ${Math.round(s.disk.wIO || 0)} write` : "Per-disk I/O counters aren't exposed on Windows";
    $("#g-net").textContent = `${kbs(s.net.rx)} ↓`;
    $("#g-net-sub").textContent = `${kbs(s.net.tx)} ↑`;
    spark("c-cpu", H.cpu, 100);
    spark("c-temp", H.temp, 100);
    spark("c-mem", H.mem, 100);
    spark("c-gpu", H.gpu, 100);
    spark("c-disk", H.disk);
    spark("c-net", H.net);
    $("#cores").innerHTML = s.cpu.cores.map((c, i) => `<div class="core">Core ${i}<div class="bar"><div style="width:${c || 0}%"></div></div></div>`).join("");
    $("#live-volumes").innerHTML = s.volumes.map((v) => `<div class="vol"><div>${esc(v.mount)} <span class="muted small">${gb(v.used)} / ${gb(v.size)} GB</span></div><div class="bar"><div class="${v.pct > 90 ? "hot" : ""}" style="width:${v.pct}%"></div></div></div>`).join("");
  } catch {
    /* one bad sample is fine */
  } finally {
    liveBusy = false;
  }
}
function push(arr, v) {
  arr.push(v == null ? null : v);
  if (arr.length > 90) arr.shift();
}
const gb = (b) => (b / 1024 ** 3).toFixed(1);
const kbs = (b) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB/s` : `${Math.round(b / 1024)} KB/s`);
function spark(id, data, fixedMax) {
  const c = document.getElementById(id);
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 200;
  const h = 60;
  if (c.width !== w * dpr) {
    c.width = w * dpr;
    c.height = h * dpr;
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const vals = data.filter((v) => v != null);
  if (vals.length < 2) return;
  const max = fixedMax || Math.max(1, ...vals) * 1.1;
  const step = w / 89;
  const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim();
  ctx.beginPath();
  data.forEach((v, i) => {
    if (v == null) return;
    const x = i * step + (w - (data.length - 1) * step);
    const y = h - (Math.min(v, max) / max) * (h - 4) - 2;
    if (ctx._started) ctx.lineTo(x, y);
    else {
      ctx.moveTo(x, y);
      ctx._started = true;
    }
  });
  ctx._started = false;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.lineTo(w, h);
  ctx.lineTo(w - (data.length - 1) * step, h);
  ctx.closePath();
  ctx.fillStyle = accent + "22";
  ctx.fill();
}

// ── benchmark ─────────────────────────────────────────────────
$("#bench-run").addEventListener("click", async () => {
  const btn = $("#bench-run");
  btn.disabled = true;
  $("#bench-progress").classList.remove("hidden");
  $("#bench-status").textContent = "Running… keep the PC idle.";
  const off = api.bench.onProgress((p) => {
    $("#bench-bar").style.width = `${Math.round((p.done / p.total) * 100)}%`;
    $("#bench-label").textContent = p.id === "done" ? "Finished" : `Running ${p.label}…`;
  });
  try {
    state.bench = await api.bench.run({ tests: { cpu: $("#b-cpu").checked, memory: $("#b-mem").checked, disk: $("#b-disk").checked } });
    $("#bench-results").innerHTML = state.bench.tests
      .map((t) => `<div class="bench-card"><div class="name">${esc(t.name)}</div><div class="score">${fmtScore(t.score)}<span class="unit">${esc(t.unit)}</span></div><div class="detail">${esc(t.detail)}${t.extra?.scaling ? ` · ${t.extra.scaling}× single-thread` : ""}</div></div>`)
      .join("");
    $("#bench-export").disabled = false;
    $("#bench-status").textContent = `Done in ${((new Date(state.bench.finishedAt) - new Date(state.bench.startedAt)) / 1000).toFixed(0)}s.`;
  } catch (err) {
    $("#bench-status").textContent = "Benchmark failed: " + (err.message || err);
  } finally {
    off();
    btn.disabled = false;
    setTimeout(() => $("#bench-progress").classList.add("hidden"), 800);
  }
});
$("#bench-export").addEventListener("click", async () => {
  const res = await api.exportFiles({ kind: "bench", bench: state.bench, formats: state.settings.formats });
  if (res.ok) toast(`Saved ${res.files.map((f) => f.split(/[\\/]/).pop()).join(", ")}`);
  else if (!res.canceled) toast(res.error, true);
});
const fmtScore = (n) => (n >= 1000 ? n.toLocaleString() : String(n));

// ── updates ───────────────────────────────────────────────────
$("#about-update").addEventListener("click", async () => {
  $("#about-update-status").textContent = "Checking…";
  showUpdateStatus(await api.update.check());
});
api.update.onStatus(showUpdateStatus);
function showUpdateStatus(s) {
  if (!s) return;
  const el = $("#about-update-status");
  const pill = $("#foot-update");
  const msgs = {
    idle: "",
    checking: "Checking for updates…",
    current: "You're on the latest version.",
    available: `Version ${s.version} is available — downloading in the background.`,
    downloading: `Downloading update… ${s.percent || 0}%`,
    ready: `Version ${s.version} is downloaded and will install when you close SpecForge.`,
    error: s.message || "Couldn't check for updates.",
  };
  el.textContent = msgs[s.state] ?? "";
  el.classList.toggle("muted", s.state !== "ready");
  if (s.state === "ready") {
    el.innerHTML += ` <button class="link" id="restart-now">Restart now</button>`;
    $("#restart-now").onclick = () => api.update.installNow();
    pill.textContent = "Update ready";
    pill.className = "pill ok";
  } else if (s.state === "available" || s.state === "downloading") {
    pill.textContent = "Updating…";
    pill.className = "pill warn";
  } else pill.className = "pill hidden";
}

// ── utils ─────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
let toastTimer;
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
}

boot();
