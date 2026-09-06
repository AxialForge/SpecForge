// Benchmark suite: CPU single-thread, CPU multi-thread, memory bandwidth,
// disk sequential write/read. Each test reports progress through `onProgress`
// and the whole run resolves to a result object the renderer renders and the
// exporter flattens.

const { Worker } = require("node:worker_threads");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const crypto = require("node:crypto");

const WORKER = path.join(__dirname, "worker.js");

function runWorkers(count, durationMs) {
  return Promise.all(
    Array.from({ length: count }, () =>
      new Promise((resolve, reject) => {
        const w = new Worker(WORKER, { workerData: { durationMs } });
        w.once("message", (m) => resolve(m.iters));
        w.once("error", reject);
      })
    )
  );
}

async function cpuSingle(durationMs) {
  const [iters] = await runWorkers(1, durationMs);
  return Math.round(iters / (durationMs / 1000) / 1000); // k-iterations per second
}

async function cpuMulti(durationMs) {
  const threads = os.cpus().length || 1;
  const all = await runWorkers(threads, durationMs);
  const total = all.reduce((a, b) => a + b, 0);
  return { score: Math.round(total / (durationMs / 1000) / 1000), threads };
}

/** Memory bandwidth: copy a 256 MB buffer repeatedly; report GB/s. */
function memoryBandwidth() {
  const size = 256 * 1024 * 1024;
  const a = new Float64Array(size / 8);
  const b = new Float64Array(size / 8);
  for (let i = 0; i < a.length; i += 4096) a[i] = i;
  const passes = 6;
  const t0 = process.hrtime.bigint();
  for (let p = 0; p < passes; p += 1) (p % 2 ? a : b).set(p % 2 ? b : a);
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  // each pass reads + writes `size` bytes
  return Math.round(((passes * size * 2) / secs / 1e9) * 10) / 10;
}

/** Disk sequential write then read of a temp file on the given drive. */
async function diskSequential(dir, sizeMb = 512) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `specforge-bench-${process.pid}.tmp`);
  const chunk = crypto.randomBytes(8 * 1024 * 1024);
  const chunks = Math.ceil(sizeMb / 8);
  let write = 0;
  let read = 0;
  try {
    const fh = await fs.open(file, "w");
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < chunks; i += 1) await fh.write(chunk);
    await fh.sync();
    await fh.close();
    write = (chunks * chunk.length) / (Number(process.hrtime.bigint() - t0) / 1e9) / 1e6;

    const rh = await fs.open(file, "r");
    const buf = Buffer.allocUnsafe(chunk.length);
    const t1 = process.hrtime.bigint();
    let pos = 0;
    for (;;) {
      const { bytesRead } = await rh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      pos += bytesRead;
    }
    await rh.close();
    read = pos / (Number(process.hrtime.bigint() - t1) / 1e9) / 1e6;
  } finally {
    try {
      fsSync.unlinkSync(file);
    } catch {}
  }
  return { writeMBs: Math.round(write), readMBs: Math.round(read) };
}

/**
 * Run the full suite.
 * @param {object} opts  { cpuSeconds=5, diskDir, diskMb=512, tests: {cpu,memory,disk} }
 */
async function runSuite(opts = {}, onProgress = () => {}) {
  const cpuMs = (opts.cpuSeconds || 5) * 1000;
  const tests = Object.assign({ cpu: true, memory: true, disk: true }, opts.tests || {});
  const startedAt = new Date().toISOString();
  const result = { startedAt, cpuModel: (os.cpus()[0] || {}).model || null, threads: os.cpus().length, tests: [] };
  const steps = [];
  if (tests.cpu) steps.push("cpu-single", "cpu-multi");
  if (tests.memory) steps.push("memory");
  if (tests.disk) steps.push("disk");
  let i = 0;
  const step = (id, label) => onProgress({ id, label, done: i++, total: steps.length });

  if (tests.cpu) {
    step("cpu-single", "CPU single-thread");
    const s = await cpuSingle(cpuMs);
    result.tests.push({ id: "cpu-single", name: "CPU single-thread", score: s, unit: "k-iter/s", detail: `1 thread, ${cpuMs / 1000}s` });
    step("cpu-multi", "CPU multi-thread");
    const m = await cpuMulti(cpuMs);
    result.tests.push({ id: "cpu-multi", name: "CPU multi-thread", score: m.score, unit: "k-iter/s", detail: `${m.threads} threads, ${cpuMs / 1000}s`, extra: { scaling: Math.round((m.score / s) * 10) / 10 } });
  }
  if (tests.memory) {
    step("memory", "Memory bandwidth");
    const gbps = memoryBandwidth();
    result.tests.push({ id: "memory", name: "Memory bandwidth", score: gbps, unit: "GB/s", detail: "256 MB copy" });
  }
  if (tests.disk) {
    step("disk", "Disk sequential");
    const dir = opts.diskDir || os.tmpdir();
    const d = await diskSequential(dir, opts.diskMb || 512);
    result.tests.push({ id: "disk-write", name: "Disk sequential write", score: d.writeMBs, unit: "MB/s", detail: `${opts.diskMb || 512} MB on ${path.parse(dir).root}` });
    result.tests.push({ id: "disk-read", name: "Disk sequential read", score: d.readMBs, unit: "MB/s", detail: `${opts.diskMb || 512} MB on ${path.parse(dir).root}` });
  }
  onProgress({ id: "done", label: "Done", done: steps.length, total: steps.length });
  result.finishedAt = new Date().toISOString();
  return result;
}

module.exports = { runSuite };
