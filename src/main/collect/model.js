// The one shape everything in SpecForge speaks.
//
// A report is a list of sections. A section is a list of items. An item is a
// named list of fields. That's it — the dashboard, the CSV/JSON/text exporters
// and the history viewer all consume this and nothing else, so a collector only
// has to produce it.
//
//   section = { id, title, icon, items: [ item ] }
//   item    = { name, fields: [ field ] }
//   field   = { label, value, sensitive?: true, unit?: string }
//
// `sensitive` marks serials, product keys, MACs and similar: the export layer
// strips those unless the user has explicitly opted in (Settings → Privacy).

// Strings OEMs leave in SMBIOS when they never filled the field in.
const PLACEHOLDERS = /^(to be filled by o\.?e\.?m\.?|system product name|system manufacturer|system serial number|system version|default string|not specified|not available|none|n\/a|unknown|sku|oem|-|0+|x+|\.+)$/i;
function isPlaceholder(v) {
  return typeof v === "string" && PLACEHOLDERS.test(v.trim());
}

function field(label, value, opts = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && (!value.trim() || isPlaceholder(value))) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const f = { label, value: typeof value === "string" ? value.trim() : value };
  if (opts.sensitive) f.sensitive = true;
  if (opts.unit) f.unit = opts.unit;
  return f;
}

/** Build an item, dropping empty fields. */
function item(name, fields) {
  return { name: name || "Unknown", fields: fields.filter(Boolean) };
}

function section(id, title, icon, items) {
  return { id, title, icon, items: (items || []).filter((it) => it && it.fields.length) };
}

// ── formatting helpers shared by collectors ─────────────────────
const GB = 1024 ** 3;
const MB = 1024 ** 2;

function bytesToGB(b, digits = 1) {
  if (!Number.isFinite(b) || b <= 0) return null;
  return `${(b / GB).toFixed(digits)} GB`;
}
function bytesHuman(b) {
  if (!Number.isFinite(b) || b <= 0) return null;
  if (b >= 1000 * GB) return `${(b / 1024 ** 4).toFixed(2)} TB`;
  if (b >= GB) return `${(b / GB).toFixed(1)} GB`;
  if (b >= MB) return `${Math.round(b / MB)} MB`;
  return `${Math.round(b / 1024)} KB`;
}
/** Marketing capacity — 1 TB drives report ~931 GiB; show what's on the box. */
function bytesToMarketing(b) {
  if (!Number.isFinite(b) || b <= 0) return null;
  const tb = b / 1e12;
  if (tb >= 0.95) return `${Math.round(tb * 2) / 2} TB`;
  return `${Math.round(b / 1e9)} GB`;
}
function ghz(mhz) {
  if (!Number.isFinite(mhz) || mhz <= 0) return null;
  return `${(mhz / 1000).toFixed(2)} GHz`;
}
function yesNo(v) {
  if (v === true) return "Yes";
  if (v === false) return "No";
  return null;
}
/** Decode a WMI UInt16[] string (WmiMonitorID) into text. */
function wmiString(arr) {
  if (!Array.isArray(arr)) return null;
  return String.fromCharCode(...arr.filter((c) => c > 0)).trim() || null;
}
/** WMI DateTime "20240102..." or ISO → YYYY-MM-DD. */
function wmiDate(v) {
  if (!v) return null;
  const s = typeof v === "object" && v.value ? String(v.value) : String(v);
  const m = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const js = s.match(/^\/Date\((-?\d+)\)\/$/); // ConvertTo-Json's DateTime encoding
  if (js) return new Date(Number(js[1])).toISOString().slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

module.exports = { field, item, section, isPlaceholder, bytesToGB, bytesHuman, bytesToMarketing, ghz, yesNo, wmiString, wmiDate, GB, MB };
