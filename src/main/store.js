// Settings + scan history, persisted as JSON under Electron's userData folder.
// Everything is synchronous and tiny; there is no database.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = {
  theme: "dark",
  includeSensitive: false, // serials, product keys, MACs, hostnames
  includePrograms: true, // installed-program list in scans and exports
  formats: { csv: true, json: false, txt: true },
  csvLayout: "tall", // "tall" | "wide"
  aiPrompt: true, // prepend the listing prompt to txt/csv exports
  exportDir: "", // "" = ask every time; otherwise a folder path
  autoUpdate: true,
  benchCpuSeconds: 5,
  benchDiskMb: 512,
};

class Store {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.settingsFile = path.join(userDataDir, "settings.json");
    this.historyDir = path.join(userDataDir, "history");
    fs.mkdirSync(this.historyDir, { recursive: true });
    this.settings = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsFile, "utf8"));
      return { ...DEFAULTS, ...raw, formats: { ...DEFAULTS.formats, ...(raw.formats || {}) } };
    } catch {
      return { ...DEFAULTS, formats: { ...DEFAULTS.formats } };
    }
  }

  get() {
    return this.settings;
  }

  set(patch) {
    this.settings = { ...this.settings, ...patch, formats: { ...this.settings.formats, ...(patch.formats || {}) } };
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    return this.settings;
  }

  // ── history ──────────────────────────────────────────────────
  saveScan(report) {
    const id = `${report.meta.scannedAt.replace(/[:.]/g, "-")}_${safeName(report.meta.hostname)}`;
    fs.writeFileSync(path.join(this.historyDir, `${id}.json`), JSON.stringify(report));
    return id;
  }

  listScans() {
    return fs
      .readdirSync(this.historyDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(this.historyDir, f), "utf8"));
          return { id: f.replace(/\.json$/, ""), scannedAt: r.meta.scannedAt, hostname: r.meta.hostname, summary: r.meta.summary || {}, sections: r.sections.length, durationMs: r.meta.durationMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (a.scannedAt < b.scannedAt ? 1 : -1));
  }

  loadScan(id) {
    return JSON.parse(fs.readFileSync(path.join(this.historyDir, `${safeName(id)}.json`), "utf8"));
  }

  deleteScan(id) {
    fs.rmSync(path.join(this.historyDir, `${safeName(id)}.json`), { force: true });
  }
}

function safeName(s) {
  return String(s || "pc").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80);
}

module.exports = { Store, DEFAULTS, safeName };
