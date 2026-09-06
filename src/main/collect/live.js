// Live readings: CPU load/clock/temperature, memory, GPU, disk I/O, network
// throughput. Polled by the renderer's Live tab; each call returns one sample.

const si = require("systeminformation");

const safe = (p, fallback = null) => Promise.resolve(p).then((v) => v, () => fallback);

async function sample() {
  const [load, temp, speed, mem, gfx, disk, net, fs, bat] = await Promise.all([
    safe(si.currentLoad(), {}),
    safe(si.cpuTemperature(), {}),
    safe(si.cpuCurrentSpeed(), {}),
    safe(si.mem(), {}),
    safe(si.graphics(), { controllers: [] }),
    safe(si.disksIO(), null),
    safe(si.networkStats(), []),
    safe(si.fsSize(), []),
    safe(si.battery(), {}),
  ]);
  const gpu = (gfx.controllers || []).find((g) => Number.isFinite(g.utilizationGpu) || Number.isFinite(g.temperatureGpu)) || (gfx.controllers || [])[0] || {};
  const netTotal = (Array.isArray(net) ? net : []).reduce((a, n) => ({ rx: a.rx + (n.rx_sec || 0), tx: a.tx + (n.tx_sec || 0) }), { rx: 0, tx: 0 });
  return {
    t: Date.now(),
    cpu: {
      load: round(load.currentLoad),
      loadUser: round(load.currentLoadUser),
      loadSystem: round(load.currentLoadSystem),
      cores: (load.cpus || []).map((c) => round(c.load)),
      temp: Number.isFinite(temp.main) && temp.main > 0 ? round(temp.main) : null,
      tempMax: Number.isFinite(temp.max) && temp.max > 0 ? round(temp.max) : null,
      speed: Number.isFinite(speed.avg) ? speed.avg : null,
      speedMax: Number.isFinite(speed.max) ? speed.max : null,
    },
    mem: { total: mem.total, used: mem.active || mem.used, free: mem.available || mem.free, pct: mem.total ? round(((mem.active || mem.used) / mem.total) * 100) : null, swapUsed: mem.swapused, swapTotal: mem.swaptotal },
    gpu: { name: gpu.model || null, load: Number.isFinite(gpu.utilizationGpu) ? round(gpu.utilizationGpu) : null, temp: Number.isFinite(gpu.temperatureGpu) ? round(gpu.temperatureGpu) : null, memUsed: gpu.memoryUsed || null, memTotal: gpu.memoryTotal || null, fan: Number.isFinite(gpu.fanSpeed) ? gpu.fanSpeed : null, power: Number.isFinite(gpu.powerDraw) ? gpu.powerDraw : null, clock: gpu.clockCore || null },
    disk: disk ? { rIO: disk.rIO_sec, wIO: disk.wIO_sec, tIO: disk.tIO_sec } : null,
    net: { rx: netTotal.rx, tx: netTotal.tx },
    volumes: (fs || []).filter((v) => v.size > 0).map((v) => ({ mount: v.mount, size: v.size, used: v.used, pct: round(v.use) })),
    battery: bat.hasBattery ? { percent: bat.percent, charging: bat.isCharging, timeRemaining: bat.timeRemaining } : null,
  };
}

function round(v) {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}

module.exports = { sample };
