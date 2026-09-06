const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../src/main/report");
const { compareVersions, isNewer, updatesAllowed } = require("../src/main/updater");
const M = require("../src/main/collect/model");

const sample = {
  meta: { appVersion: "0.1.0", scannedAt: "2026-09-05T10:00:00.000Z", hostname: "TEST-PC" },
  sections: [
    { id: "cpu", title: "Processor", items: [{ name: "Intel i7", fields: [{ label: "Model", value: "Intel i7" }, { label: "Processor ID", value: "ABC123", sensitive: true }] }] },
    { id: "memory", title: "Memory", items: [{ name: "Total memory", fields: [{ label: "Installed", value: "32 GB" }, { label: "Type", value: "DDR5" }] }] },
    { id: "programs", title: "Installed programs", items: [{ name: "7-Zip", fields: [{ label: "Name", value: '7-Zip, "the" archiver' }, { label: "Version", value: "24.08" }] }] },
  ],
};

test("filterSensitive strips flagged fields by default", () => {
  const r = R.filterSensitive(sample, false);
  const cpu = r.sections[0].items[0].fields.map((f) => f.label);
  assert.deepEqual(cpu, ["Model"]);
  const kept = R.filterSensitive(sample, true).sections[0].items[0].fields.length;
  assert.equal(kept, 2);
});

test("dropSections removes by id", () => {
  const r = R.dropSections(sample, ["programs"]);
  assert.equal(r.sections.length, 2);
});

test("csvEscape quotes commas, quotes and newlines", () => {
  assert.equal(R.csvEscape("plain"), "plain");
  assert.equal(R.csvEscape('a,"b"'), '"a,""b"""');
  assert.equal(R.csvEscape("x\ny"), '"x\ny"');
});

test("toCsv is tall with header and escaped values", () => {
  const csv = R.toCsv(sample);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines[0], "Category,Item,Field,Value");
  assert.ok(lines.includes('Installed programs,7-Zip,Name,"7-Zip, ""the"" archiver"'));
  assert.ok(lines.some((l) => l.startsWith("Processor,Intel i7,Processor ID,ABC123")), "unfiltered input keeps sensitive rows; filtering is the caller's job");
});

test("toCsv with aiPrompt puts the prompt first", () => {
  assert.ok(R.toCsv(sample, { aiPrompt: true }).startsWith('"# You are helping me sell'));
});

test("toCsvWide has one row per item", () => {
  const lines = R.toCsvWide(sample).trim().split("\r\n");
  assert.equal(lines.length, 4); // header + 3 items
  assert.ok(lines[0].includes("Processor › Model"));
});

test("toText renders sections and the prompt", () => {
  const t = R.toText(sample, { aiPrompt: true });
  assert.ok(t.includes("## PROCESSOR"));
  assert.ok(t.includes("Installed   32 GB") || t.includes("Installed  32 GB"));
  assert.ok(t.startsWith("You are helping me sell"));
});

test("summarize pulls headline fields", () => {
  const s = R.summarize(sample);
  assert.equal(s.cpu, "Intel i7");
  assert.equal(s.ram, "32 GB");
  assert.equal(s.ramType, "DDR5");
  assert.equal(s.gpu, null);
});

test("liveToCsv writes one row per sample", () => {
  const csv = R.liveToCsv([{ t: 0, cpu: { load: 10 }, mem: { pct: 50, used: 2 ** 30 }, gpu: {}, disk: null, net: { rx: 2048, tx: 0 } }]);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes("1970-01-01T00:00:00.000Z,10,,,50,1.00"));
});

test("model helpers", () => {
  assert.equal(M.field("x", "  "), null);
  assert.equal(M.field("x", null), null);
  assert.deepEqual(M.field("x", " v ", { sensitive: true }), { label: "x", value: "v", sensitive: true });
  assert.equal(M.bytesToMarketing(1000204886016), "1 TB");
  assert.equal(M.bytesToMarketing(512110190592), "512 GB");
  assert.equal(M.bytesToMarketing(2000398934016), "2 TB");
  assert.equal(M.ghz(3600), "3.60 GHz");
  assert.equal(M.wmiString([68, 69, 76, 76, 0, 0]), "DELL");
  assert.equal(M.wmiDate("20240102093000.000000+000"), "2024-01-02");
  assert.equal(M.section("s", "S", "i", [M.item("a", [null]), M.item("b", [M.field("k", "v")])]).items.length, 1);
});

test("updater version comparison", () => {
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.ok(isNewer("v0.2.0", "0.1.9"));
  assert.ok(!isNewer("0.1.0-beta", "0.1.0"));
  assert.deepEqual(updatesAllowed({ env: { NO_AUTO_UPDATE: "1" }, enabled: true }), { enabled: false, enforced: true });
  assert.deepEqual(updatesAllowed({ env: {}, enabled: false }), { enabled: false, enforced: false });
});
