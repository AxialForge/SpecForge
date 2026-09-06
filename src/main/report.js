// Report shaping and export formats. Pure functions — no Electron, no I/O —
// so `node --test` covers them without a window.
//
// A report: { meta: {...}, sections: [ section ] }  (see collect/model.js)

const AI_PROMPT = [
  "You are helping me sell a computer. Below is a complete specification export from SpecForge.",
  "Using ONLY the facts listed, write:",
  "1. A concise, attention-grabbing marketplace title (under 80 characters).",
  "2. A friendly, honest listing description that highlights the CPU, GPU, RAM, storage and condition, and explains what the machine is good for (gaming, office, creative work, etc).",
  "3. A bullet list of key specs for the listing.",
  "4. A suggested price range in my local currency with a one-line justification, based on the components' typical used-market value.",
  "Do not invent details that aren't in the data. If something important is missing, ask me for it.",
  "",
].join("\n");

/** Remove sensitive fields unless `includeSensitive` is set. */
function filterSensitive(report, includeSensitive) {
  if (includeSensitive) return report;
  const meta = { ...(report.meta || {}) };
  delete meta.hostname; // JSON export carried it even with sensitive fields stripped
  return {
    ...report,
    meta,
    sections: report.sections.map((s) => ({ ...s, items: s.items.map((it) => ({ ...it, fields: it.fields.filter((f) => !f.sensitive) })).filter((it) => it.fields.length) })),
  };
}

/** Optionally drop whole sections (e.g. installed programs) by id. */
function dropSections(report, ids) {
  const set = new Set(ids || []);
  return { ...report, sections: report.sections.filter((s) => !set.has(s.id)) };
}

/** Flatten to tall rows: one line per field. */
function toRows(report) {
  const rows = [];
  for (const s of report.sections) {
    for (const it of s.items) {
      for (const f of it.fields) rows.push({ category: s.title, item: it.name, field: f.label, value: formatValue(f) });
    }
  }
  return rows;
}

function formatValue(f) {
  const v = f.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.join("; ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v) + (f.unit ? ` ${f.unit}` : "");
}

function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Tall CSV: Category,Item,Field,Value — with optional metadata header rows. */
function toCsv(report, { aiPrompt = false } = {}) {
  const lines = [];
  if (aiPrompt) lines.push(csvEscape("# " + AI_PROMPT.trim().replace(/\n/g, " ")), "");
  lines.push(["Category", "Item", "Field", "Value"].map(csvEscape).join(","));
  const meta = report.meta || {};
  lines.push(["Report", "SpecForge", "Generated", meta.scannedAt || ""].map(csvEscape).join(","));
  lines.push(["Report", "SpecForge", "App version", meta.appVersion || ""].map(csvEscape).join(","));
  for (const r of toRows(report)) lines.push([r.category, r.item, r.field, r.value].map(csvEscape).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Wide one-row-per-item CSV — handy for listing several PCs side by side later. */
function toCsvWide(report) {
  const fieldNames = [];
  const seen = new Set();
  for (const r of toRows(report)) {
    const k = `${r.category} › ${r.field}`;
    if (!seen.has(k)) {
      seen.add(k);
      fieldNames.push(k);
    }
  }
  const header = ["Category", "Item", ...fieldNames];
  const lines = [header.map(csvEscape).join(",")];
  for (const s of report.sections) {
    for (const it of s.items) {
      const map = new Map(it.fields.map((f) => [`${s.title} › ${f.label}`, formatValue(f)]));
      lines.push([s.title, it.name, ...fieldNames.map((k) => map.get(k) || "")].map(csvEscape).join(","));
    }
  }
  return lines.join("\r\n") + "\r\n";
}

function toJson(report) {
  return JSON.stringify(report, null, 2);
}

/** Human/AI-readable plain text summary. */
function toText(report, { aiPrompt = false } = {}) {
  const out = [];
  if (aiPrompt) out.push(AI_PROMPT, "=".repeat(60), "");
  const meta = report.meta || {};
  out.push("SPECFORGE SYSTEM REPORT", `Generated: ${meta.scannedAt || ""}`, `SpecForge ${meta.appVersion || ""}`, "");
  for (const s of report.sections) {
    if (!s.items.length) continue;
    out.push(`## ${s.title.toUpperCase()}`);
    for (const it of s.items) {
      if (s.items.length > 1) out.push(`  ${it.name}`);
      const pad = Math.max(...it.fields.map((f) => f.label.length), 8);
      for (const f of it.fields) out.push(`    ${f.label.padEnd(pad)}  ${formatValue(f)}`);
    }
    out.push("");
  }
  return out.join("\n");
}

/** Short headline summary used on the dashboard and in file names. */
function summarize(report) {
  const get = (id, label) => {
    const s = report.sections.find((x) => x.id === id);
    if (!s || !s.items.length) return null;
    const f = s.items[0].fields.find((x) => x.label === label);
    return f ? formatValue(f) : null;
  };
  const storage = report.sections.find((x) => x.id === "storage");
  return {
    system: get("system", "Model") || get("system", "Manufacturer"),
    cpu: get("cpu", "Model"),
    gpu: get("gpu", "Model"),
    ram: get("memory", "Installed"),
    ramType: get("memory", "Type"),
    storage: storage ? storage.items.map((d) => `${d.fields.find((f) => f.label === "Capacity")?.value || ""} ${d.fields.find((f) => f.label === "Type")?.value || ""}`.trim()).filter(Boolean).join(", ") : null,
    os: get("os", "Edition"),
    board: get("board", "Model"),
  };
}

/** Flatten a benchmark result into a report-shaped section for export. */
function benchToReport(bench, meta) {
  return {
    meta,
    sections: [
      {
        id: "benchmark",
        title: "Benchmark",
        icon: "bench",
        items: [
          { name: "Run", fields: [{ label: "Started", value: bench.startedAt }, { label: "Finished", value: bench.finishedAt }, { label: "CPU", value: bench.cpuModel }, { label: "Threads", value: bench.threads }] },
          ...bench.tests.map((t) => ({ name: t.name, fields: [{ label: "Score", value: t.score, unit: t.unit }, { label: "Detail", value: t.detail }, ...(t.extra ? Object.entries(t.extra).map(([k, v]) => ({ label: k, value: v })) : [])] })),
        ],
      },
    ],
  };
}

/** Live samples → CSV (one row per sample). */
function liveToCsv(samples) {
  const header = ["Time", "CPU load %", "CPU temp °C", "CPU GHz", "RAM used %", "RAM used GB", "GPU load %", "GPU temp °C", "GPU VRAM used MB", "Disk IO/s", "Net RX KB/s", "Net TX KB/s"];
  const lines = [header.map(csvEscape).join(",")];
  for (const s of samples) {
    lines.push(
      [
        new Date(s.t).toISOString(),
        s.cpu.load ?? "",
        s.cpu.temp ?? "",
        s.cpu.speed ?? "",
        s.mem.pct ?? "",
        s.mem.used ? (s.mem.used / 1024 ** 3).toFixed(2) : "",
        s.gpu.load ?? "",
        s.gpu.temp ?? "",
        s.gpu.memUsed ?? "",
        s.disk ? Math.round(s.disk.tIO || 0) : "",
        Math.round((s.net.rx || 0) / 1024),
        Math.round((s.net.tx || 0) / 1024),
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return lines.join("\r\n") + "\r\n";
}

module.exports = { AI_PROMPT, filterSensitive, dropSections, toRows, toCsv, toCsvWide, toJson, toText, csvEscape, summarize, benchToReport, liveToCsv, formatValue };
