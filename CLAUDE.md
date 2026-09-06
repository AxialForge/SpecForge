# SpecForge — project guide for Claude Code

Windows desktop app (Electron) that scans a PC's hardware and software and
exports the result as CSV / JSON / text for AI-written marketplace listings or
audit records. Ships as a one-click NSIS installer with silent auto-update from
GitHub Releases. It is **not** a monitoring suite: the live and benchmark tabs
are there to enrich a listing, not to compete with HWiNFO.

## Non-negotiables (don't regress these)

- **Nothing leaves the machine except the update check.** No telemetry, no
  accounts, no cloud. Exports are files on disk or the clipboard.
- **Private data is opt-in for export.** Any field that identifies the specific
  machine or owner (serial, product key, MAC, IP, hostname, user name, UUID) is
  tagged `sensitive: true` at collection time and stripped by
  `report.filterSensitive()` unless `settings.includeSensitive` is on. The
  Settings toggle for that sits behind a warning modal. New collectors MUST tag
  such fields; the export layer will not guess.
- **A collector never throws.** Every source is wrapped in `safe()` and every
  PowerShell query resolves to `null` on failure. One broken WMI class must
  yield fewer fields, never a failed scan.
- **No native Node modules.** `systeminformation` is pure JS; everything else
  Windows-specific goes through PowerShell (`src/main/ps.js`). This keeps
  `npm install` working on Node 24 (see the ClangCL trap in the global notes)
  and keeps CI trivial.
- **The renderer has no Node access.** `contextIsolation` + `sandbox`; the
  only surface is `window.specforge` from `preload.js`.
- **Installer stays one-click, per-user.** `oneClick: true` + `perMachine:
  false` is what makes the silent updater silent. Releases must attach
  `latest.yml` and the `.blockmap`, not just the `.exe` — CI does this.

## Commands

```bash
npm install          # Node 22+; Node 24 works (no native modules)
npm run dev          # run from source (add --devtools for the inspector)
npm test             # node --test; pure modules only, no Electron needed
npm run dist         # dist/specforge-<ver>-setup.exe, no publish
```

## Architecture

Main process collects, shapes and writes. Renderer only renders and asks.

```
renderer  --window.specforge (preload, IPC invoke)-->  main.js
                                                        ├─ collect/hardware.js   systeminformation + PowerShell/WMI
                                                        ├─ collect/software.js   OS, activation, security, programs
                                                        ├─ collect/live.js       one sample per call (Live tab polls)
                                                        ├─ bench/                worker_threads CPU, memory copy, disk file
                                                        ├─ report.js             filter → rows → csv/json/txt (pure)
                                                        ├─ store.js              settings.json + history/*.json in userData
                                                        └─ updater.js            silent electron-updater (template drop-in)
```

### The report shape (collect/model.js)

```
report  = { meta, sections: [section] }
section = { id, title, icon, items: [item] }
item    = { name, fields: [field] }
field   = { label, value, sensitive?, unit? }
```

Every collector returns sections. Every consumer (dashboard, hardware/software
pages, exporters, history list) reads sections. `field()` drops empty values and
OEM placeholder strings ("To be filled by O.E.M.", "System Product Name"...),
so collectors can pass raw values without null-checking.

### Directory map

```
src/main/main.js            window, IPC handlers, export file writing, admin relaunch
src/main/preload.js         the whole renderer API surface
src/main/ps.js              PowerShell → JSON runner (psJson / psText / cim)
src/main/collect/model.js   field/item/section builders + formatting helpers
src/main/collect/hardware.js
src/main/collect/software.js
src/main/collect/live.js
src/main/bench/index.js     runSuite(); worker.js is the CPU workload
src/main/report.js          pure shaping/export; fully unit-tested
src/main/store.js           settings defaults live here (DEFAULTS)
src/main/updater.js         from AxialForge/project-template, unmodified
src/renderer/index.html     all pages are sections in one file
src/renderer/app.js         state + render functions per page
src/renderer/styles.css     tokens on :root, [data-theme="light"] overrides
assets/icon.svg             source of icon.png / icon.ico (regenerate with sharp + png-to-ico)
test/report.test.js
```

## The extension point: adding a field or section

1. In `collect/hardware.js` or `collect/software.js`, add `F("Label", value)`
   to an existing item, or a new `S(id, title, icon, [I(name, [...])])`.
   Tag identifying values `{ sensitive: true }`.
2. For Windows-only data use `cim("Win32_Class", ["Prop", ...])` or
   `psJson("<expression>")` from `ps.js`; both return arrays or `null`.
3. If the section is a long list (programs, updates), add its id to
   `TABLE_SECTIONS` in `app.js` so it renders as a table, collapsed by default.
   If it is software, add the id to `SOFTWARE_IDS` so it lands on the
   Software page.
4. If it should appear on the dashboard, read it via `fieldOf()` in
   `renderDashboard()` or `summarize()` in `report.js`.

Exports need no changes — they walk the sections.

## Gotchas / constraints

- **ConvertTo-Json emits dates as `/Date(1784678400000)/`.** Symptom: driver
  and install dates show as that literal. `M.wmiDate()` handles both that and
  the WMI `20240102...` form; always route dates through it.
- **`ConvertTo-Json` collapses a one-element array to an object.** `psJson`
  wraps the expression in `@( )` and re-wraps the parse result, so callers
  always get an array. Don't bypass it with your own `execFile`.
- **`systeminformation` P/E core counts are wrong on Windows.** It reported
  24 performance cores for a 16-core i7-13700K. `collectCpu` only shows the
  split when perf + eff == physical cores; `speedMax` is likewise ignored
  unless it is clearly above the WMI base clock.
- **Display resolution from Electron/`systeminformation` is DPI-scaled**
  (2752×1152 for a 3440×1440 monitor at 125 %). Native resolution comes from
  `WmiMonitorListedSupportedSourceModes` (largest listed mode);
  `PreferredSourceModeIndex` is null on many monitors so it cannot be used.
- **`fsSize().fs` is the drive letter, not the file system.** Use `.type`.
- **VPN adapters look like real NICs.** NordLynx/OpenVPN/WireGuard show up in
  `networkInterfaces()` with a zero MAC; `collectNetwork` filters by name
  regex and by MAC.
- **`.gitignore` ignores `build/`**, so electron-builder resources live in
  `assets/` (`directories.buildResources: assets`).
- **npm's install-script gate blocked Electron's binary download** on this
  machine. `package.json` carries `allowScripts` for electron and
  electron-winstaller; if `node_modules/electron/dist` is missing, run
  `node node_modules/electron/install.js`.

## Roadmap (unbuilt)

- Windows 10 verification (should work; nothing used is 11-only).
- Multi-PC comparison export (wide CSV already exists; needs a merge UI).
- Optional per-drive SMART detail via `smartctl` if present on PATH.
- Light-theme title bar polish.

## Release

Bump `version` in `package.json` and update `CHANGELOG.md` in one commit, then:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

CI builds the installer and attaches it, `latest.yml` and the `.blockmap` to
the GitHub Release.
