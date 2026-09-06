// CPU benchmark worker. Runs a fixed workload for `durationMs` and reports how
// many iterations it completed. Scores are only meaningful relative to other
// SpecForge runs — they are not comparable to Cinebench/Geekbench numbers.

const { parentPort, workerData } = require("node:worker_threads");

// Mixed integer + float workload: a small xorshift PRNG, some sqrt/sin, and a
// tight loop that the JIT can't optimise away because the result is consumed.
function work(durationMs) {
  const end = Date.now() + durationMs;
  let x = 0x9e3779b9 | 0;
  let acc = 0;
  let iters = 0;
  const buf = new Float64Array(4096);
  while (Date.now() < end) {
    for (let i = 0; i < 20000; i += 1) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      const idx = (x >>> 0) & 4095;
      buf[idx] = Math.sqrt(Math.abs(buf[idx] + x * 1e-9)) + Math.sin(i);
      acc += buf[idx];
    }
    iters += 20000;
  }
  return { iters, acc };
}

const r = work(workerData.durationMs);
parentPort.postMessage({ iters: r.iters, checksum: r.acc });
