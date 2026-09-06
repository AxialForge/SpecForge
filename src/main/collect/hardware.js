// Hardware collectors. Each `collectX()` returns one section (or null) and
// never throws — a failing source just yields fewer fields.

const si = require("systeminformation");
const os = require("node:os");
const { cim, psJson } = require("../ps");
const M = require("./model");
const { field: F, item: I, section: S } = M;

const safe = (p, fallback = null) => Promise.resolve(p).then((v) => v, () => fallback);

/** Windows reports NVIDIA drivers as 32.0.16.1088; the box says 610.88. */
function nvidiaDriver(vendor, drv) {
  if (!/nvidia/i.test(vendor || "") || !drv) return null;
  const digits = String(drv).replace(/\./g, "");
  if (digits.length < 5) return null;
  const tail = digits.slice(-5);
  return `${tail.slice(0, 3)}.${tail.slice(3)}`;
}

// ── System / chassis ───────────────────────────────────────────
async function collectSystem() {
  const [sys, chassis, cs, uuid] = await Promise.all([
    safe(si.system(), {}),
    safe(si.chassis(), {}),
    cim("Win32_ComputerSystem", ["Manufacturer", "Model", "SystemFamily", "SystemSKUNumber", "PCSystemType", "TotalPhysicalMemory", "Domain", "UserName"]),
    safe(si.uuid(), {}),
  ]);
  const c = (cs && cs[0]) || {};
  const typeMap = { 1: "Desktop", 2: "Mobile / Laptop", 3: "Workstation", 4: "Enterprise Server", 5: "SOHO Server", 6: "Appliance PC", 7: "Performance Server", 8: "Maximum" };
  const clean = (v) => (v && !M.isPlaceholder(v) ? String(v).trim() : "");
  const sysName = `${clean(c.Manufacturer) || clean(sys.manufacturer)} ${clean(c.Model) || clean(sys.model)}`.trim() || "Custom-built PC";
  return S("system", "System", "pc", [
    I(sysName, [
      F("Manufacturer", c.Manufacturer || sys.manufacturer),
      F("Model", c.Model || sys.model),
      F("Product family", c.SystemFamily),
      F("SKU", c.SystemSKUNumber || sys.sku),
      F("Form factor", typeMap[c.PCSystemType] || chassis.type),
      F("Chassis", chassis.type),
      F("Virtual machine", M.yesNo(!!sys.virtual)),
      F("Computer name", os.hostname(), { sensitive: true }),
      F("Logged-in user", c.UserName, { sensitive: true }),
      F("Domain / workgroup", c.Domain, { sensitive: true }),
      F("System serial", sys.serial && sys.serial !== "-" ? sys.serial : null, { sensitive: true }),
      F("Hardware UUID", uuid.hardware, { sensitive: true }),
    ]),
  ]);
}

// ── Motherboard / BIOS ─────────────────────────────────────────
async function collectBoard() {
  const [bb, bios, tpm, sb] = await Promise.all([
    safe(si.baseboard(), {}),
    safe(si.bios(), {}),
    cim("Win32_Tpm", ["SpecVersion", "ManufacturerIdTxt", "ManufacturerVersion", "IsEnabled_InitialValue", "IsActivated_InitialValue"], { namespace: "root/cimv2/Security/MicrosoftTpm" }),
    psJson("try { Confirm-SecureBootUEFI } catch { $null }"),
  ]);
  const t = (tpm && tpm[0]) || null;
  const secure = sb && sb.length ? sb[0] : null;
  return S("board", "Motherboard & BIOS", "board", [
    I(`${bb.manufacturer || ""} ${bb.model || ""}`.trim() || "Motherboard", [
      F("Manufacturer", bb.manufacturer),
      F("Model", bb.model),
      F("Version", bb.version),
      F("Memory slots", bb.memSlots || null),
      F("Max memory", M.bytesToGB(bb.memMax)),
      F("Board serial", bb.serial && bb.serial !== "-" ? bb.serial : null, { sensitive: true }),
    ]),
    I("BIOS / UEFI", [
      F("Vendor", bios.vendor),
      F("Version", bios.version),
      F("Release date", bios.releaseDate),
      F("Revision", bios.revision),
      F("Secure Boot", typeof secure === "boolean" ? M.yesNo(secure) : "Unknown (needs admin)"),
    ]),
    t
      ? I("TPM", [
          F("Spec version", t.SpecVersion),
          F("Manufacturer", t.ManufacturerIdTxt),
          F("Firmware", t.ManufacturerVersion),
          F("Enabled", M.yesNo(t.IsEnabled_InitialValue)),
          F("Activated", M.yesNo(t.IsActivated_InitialValue)),
        ])
      : I("TPM", [F("Status", "Not detected (or needs admin)")]),
  ]);
}

// ── CPU ────────────────────────────────────────────────────────
async function collectCpu() {
  const [cpu, proc] = await Promise.all([
    safe(si.cpu(), {}),
    cim("Win32_Processor", ["Name", "NumberOfCores", "NumberOfLogicalProcessors", "MaxClockSpeed", "L2CacheSize", "L3CacheSize", "SocketDesignation", "ProcessorId", "VirtualizationFirmwareEnabled"]),
  ]);
  const p = (proc && proc[0]) || {};
  const name = (p.Name || cpu.brand || "").replace(/\s+/g, " ").trim();
  const cache = cpu.cache || {};
  const physical = p.NumberOfCores || cpu.physicalCores;
  const threads = p.NumberOfLogicalProcessors || cpu.cores;
  // systeminformation reports P/E cores unreliably on Windows (it returned
  // 24 P-cores for a 16-core i7-13700K); only trust it when the split adds up.
  const hybrid = cpu.performanceCores && cpu.efficiencyCores && cpu.performanceCores + cpu.efficiencyCores === physical;
  const base = M.ghz(p.MaxClockSpeed) || M.ghz(cpu.speed * 1000);
  const boost = cpu.speedMax && cpu.speedMax * 1000 > (p.MaxClockSpeed || 0) + 50 ? M.ghz(cpu.speedMax * 1000) : null;
  const socket = [cpu.socket, p.SocketDesignation].find((s) => s && !/^(other|unknown)$/i.test(s)) || null;
  return S("cpu", "Processor", "cpu", [
    I(name || "Processor", [
      F("Model", name),
      F("Manufacturer", cpu.manufacturer),
      F("Family / model / stepping", [cpu.family, cpu.model, cpu.stepping].filter(Boolean).join(" / ") || null),
      F("Physical cores", physical),
      F("Performance cores", hybrid ? cpu.performanceCores : null),
      F("Efficiency cores", hybrid ? cpu.efficiencyCores : null),
      F("Threads", threads),
      F("Base clock", base),
      F("Max boost clock", boost),
      F("Socket", socket),
      F("L2 cache", cache.l2 ? M.bytesHuman(cache.l2) : p.L2CacheSize ? `${p.L2CacheSize} KB` : null),
      F("L3 cache", cache.l3 ? M.bytesHuman(cache.l3) : p.L3CacheSize ? `${p.L3CacheSize} KB` : null),
      F("Virtualization", cpu.virtualization ? "Supported" : M.yesNo(p.VirtualizationFirmwareEnabled)),
      F("Processor ID", p.ProcessorId, { sensitive: true }),
    ]),
  ]);
}

// ── Memory ─────────────────────────────────────────────────────
async function collectMemory() {
  const [mem, sticks] = await Promise.all([
    safe(si.mem(), {}),
    cim("Win32_PhysicalMemory", ["BankLabel", "DeviceLocator", "Capacity", "Speed", "ConfiguredClockSpeed", "Manufacturer", "PartNumber", "SerialNumber", "SMBIOSMemoryType", "FormFactor", "ConfiguredVoltage"]),
  ]);
  const typeMap = { 20: "DDR", 21: "DDR2", 24: "DDR3", 26: "DDR4", 34: "DDR5", 35: "LPDDR5" };
  const ffMap = { 8: "DIMM", 12: "SO-DIMM" };
  const list = Array.isArray(sticks) ? sticks : [];
  const totalSticks = list.reduce((a, s) => a + (Number(s.Capacity) || 0), 0);
  const items = [
    I("Total memory", [
      F("Installed", M.bytesToGB(totalSticks || mem.total, 0)),
      F("Modules", list.length || null),
      F("Type", typeMap[list[0] && list[0].SMBIOSMemoryType] || null),
      F("Speed", list[0] && list[0].ConfiguredClockSpeed ? `${list[0].ConfiguredClockSpeed} MT/s` : list[0] && list[0].Speed ? `${list[0].Speed} MT/s` : null),
      F("Channels", list.length >= 2 ? `${list.length} modules populated` : null),
    ]),
    ...list.map((s, i) =>
      I(`${s.DeviceLocator || s.BankLabel || `Slot ${i + 1}`}`, [
        F("Capacity", M.bytesToGB(Number(s.Capacity), 0)),
        F("Type", typeMap[s.SMBIOSMemoryType] || null),
        F("Form factor", ffMap[s.FormFactor] || null),
        F("Rated speed", s.Speed ? `${s.Speed} MT/s` : null),
        F("Running speed", s.ConfiguredClockSpeed ? `${s.ConfiguredClockSpeed} MT/s` : null),
        F("Voltage", s.ConfiguredVoltage ? `${(s.ConfiguredVoltage / 1000).toFixed(2)} V` : null),
        F("Manufacturer", s.Manufacturer),
        F("Part number", s.PartNumber),
        F("Serial", s.SerialNumber, { sensitive: true }),
      ])
    ),
  ];
  return S("memory", "Memory", "ram", items);
}

// ── Graphics & displays ────────────────────────────────────────
async function collectGraphics() {
  const [gfx, vc, mon, modes] = await Promise.all([
    safe(si.graphics(), { controllers: [], displays: [] }),
    cim("Win32_VideoController", ["Name", "DriverVersion", "DriverDate", "AdapterRAM", "VideoProcessor", "CurrentHorizontalResolution", "CurrentVerticalResolution", "CurrentRefreshRate", "PNPDeviceID"]),
    cim("WmiMonitorID", ["InstanceName", "ManufacturerName", "UserFriendlyName", "ProductCodeID", "SerialNumberID", "YearOfManufacture", "WeekOfManufacture"], { namespace: "root/wmi" }),
    // Native (unscaled) resolution: the monitor's preferred EDID mode. Every
    // other API returns DPI-scaled numbers from a non-DPI-aware process.
    // PreferredSourceModeIndex is null on many monitors, so take the largest listed mode.
    psJson(
      "Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorListedSupportedSourceModes | ForEach-Object { $best = $_.MonitorSourceModes | Sort-Object { $_.HorizontalActivePixels * $_.VerticalActivePixels }, { $_.VerticalRefreshRateNumerator } -Descending | Select-Object -First 1; $hz = $_.MonitorSourceModes | Where-Object { $_.HorizontalActivePixels -eq $best.HorizontalActivePixels } | ForEach-Object { [math]::Round($_.VerticalRefreshRateNumerator / [math]::Max(1,$_.VerticalRefreshRateDenominator)) } | Sort-Object -Descending | Select-Object -First 1; [pscustomobject]@{ InstanceName=$_.InstanceName; W=$best.HorizontalActivePixels; H=$best.VerticalActivePixels; Hz=$hz } }"
    ),
  ]);
  const drivers = Array.isArray(vc) ? vc : [];
  const gpus = (gfx.controllers || []).map((g, i) => {
    const d = drivers.find((x) => x.Name === g.model) || drivers[i] || {};
    const vramMb = g.vram || (d.AdapterRAM ? Math.round(d.AdapterRAM / M.MB) : null);
    const drv = d.DriverVersion || g.driverVersion;
    return I(g.model || d.Name || `GPU ${i + 1}`, [
      F("Model", g.model || d.Name),
      F("Vendor", g.vendor),
      F("VRAM", vramMb ? `${vramMb >= 1024 ? (vramMb / 1024).toFixed(0) + " GB" : vramMb + " MB"}` : null),
      F("VRAM type", g.vramDynamic === true ? "Shared / dynamic" : g.vramDynamic === false ? "Dedicated" : null),
      F("Bus", g.bus),
      F("Sub-device", g.subDeviceId),
      F("Driver version", drv),
      F("NVIDIA driver", nvidiaDriver(g.vendor, drv)),
      F("Driver date", M.wmiDate(d.DriverDate)),
      F("Current mode", d.CurrentHorizontalResolution ? `${d.CurrentHorizontalResolution} × ${d.CurrentVerticalResolution} @ ${d.CurrentRefreshRate} Hz` : null),
    ]);
  });
  const monitors = Array.isArray(mon) ? mon : [];
  const nativeModes = Array.isArray(modes) ? modes : [];
  const displays = (gfx.displays || []).map((d, i) => {
    const m = monitors[i] || {};
    const nat = nativeModes.find((x) => x.InstanceName === m.InstanceName) || nativeModes[i] || {};
    const name = M.wmiString(m.UserFriendlyName) || d.model || `Display ${i + 1}`;
    return I(name, [
      F("Model", name),
      F("Manufacturer", M.wmiString(m.ManufacturerName) || d.vendor),
      F("Product code", M.wmiString(m.ProductCodeID)),
      F("Connection", d.connection),
      F("Native resolution", nat.W ? `${nat.W} × ${nat.H}` : null),
      F("Max refresh rate", nat.Hz ? `${nat.Hz} Hz` : null),
      F("Desktop resolution (scaled)", d.resolutionX ? `${d.resolutionX} × ${d.resolutionY}` : null),
      F("Refresh rate", d.currentRefreshRate ? `${d.currentRefreshRate} Hz` : null),
      F("Size", d.sizeX ? `${Math.round(Math.hypot(d.sizeX, d.sizeY) / 2.54)}"` : null),
      F("Primary", M.yesNo(d.main)),
      F("Built-in", M.yesNo(d.builtin)),
      F("Manufactured", m.YearOfManufacture ? `${m.YearOfManufacture} (week ${m.WeekOfManufacture})` : null),
      F("Serial", M.wmiString(m.SerialNumberID), { sensitive: true }),
    ]);
  });
  return [S("gpu", "Graphics", "gpu", gpus), S("display", "Displays", "display", displays)];
}

// ── Storage ────────────────────────────────────────────────────
async function collectStorage() {
  const [layout, fs, phys, rel] = await Promise.all([
    safe(si.diskLayout(), []),
    safe(si.fsSize(), []),
    psJson("Get-PhysicalDisk | Select-Object FriendlyName,SerialNumber,MediaType,BusType,Size,HealthStatus,FirmwareVersion,Model,Manufacturer,SpindleSpeed"),
    psJson("Get-PhysicalDisk | Get-StorageReliabilityCounter | Select-Object DeviceId,Temperature,PowerOnHours,Wear,ReadErrorsTotal,WriteErrorsTotal"),
  ]);
  const pd = Array.isArray(phys) ? phys : [];
  const relList = Array.isArray(rel) ? rel : [];
  const disks = (layout || []).map((d, i) => {
    const p = pd.find((x) => x.FriendlyName && d.name && x.FriendlyName.trim() === d.name.trim()) || pd[i] || {};
    const r = relList[i] || {};
    const type = p.MediaType && p.MediaType !== "Unspecified" ? p.MediaType : d.type;
    return I(d.name || p.FriendlyName || `Disk ${i + 1}`, [
      F("Model", d.name || p.FriendlyName),
      F("Capacity", M.bytesToMarketing(d.size || p.Size)),
      F("Exact size", M.bytesHuman(d.size || p.Size)),
      F("Type", type),
      F("Interface", p.BusType || d.interfaceType),
      F("Vendor", d.vendor || p.Manufacturer),
      F("Firmware", d.firmwareRevision || p.FirmwareVersion),
      F("Health", p.HealthStatus || d.smartStatus),
      F("Temperature", r.Temperature ? `${r.Temperature} °C` : null),
      F("Power-on hours", r.PowerOnHours || null),
      F("Wear", Number.isFinite(r.Wear) ? `${r.Wear}%` : null),
      F("Spindle speed", p.SpindleSpeed ? `${p.SpindleSpeed} RPM` : null),
      F("Serial", d.serialNum || p.SerialNumber, { sensitive: true }),
    ]);
  });
  const volumes = (fs || [])
    .filter((v) => v.size > 0)
    .map((v) =>
      I(`${v.mount} ${v.type ? "(" + v.type + ")" : ""}`.trim(), [
        F("Drive", v.mount),
        F("File system", v.type),
        F("Size", M.bytesHuman(v.size)),
        F("Used", M.bytesHuman(v.used)),
        F("Free", M.bytesHuman(v.available)),
        F("Used %", Number.isFinite(v.use) ? `${Math.round(v.use)}%` : null),
      ])
    );
  return [S("storage", "Storage drives", "disk", disks), S("volumes", "Volumes", "volume", volumes)];
}

// ── Network ────────────────────────────────────────────────────
async function collectNetwork() {
  const [ifaces, wifi, bt] = await Promise.all([
    safe(si.networkInterfaces(), []),
    safe(si.wifiInterfaces(), []),
    safe(si.bluetoothDevices(), []),
  ]);
  const VIRTUAL = /virtual|vethernet|loopback|bluetooth|nordlynx|openvpn|wireguard|wintun|tap-|tunnel|vpn|hyper-v|vmware|virtualbox|npcap|wan miniport/i;
  const list = (Array.isArray(ifaces) ? ifaces : [ifaces]).filter((n) => !n.internal && !VIRTUAL.test(n.ifaceName || n.iface || "") && n.mac && n.mac !== "00:00:00:00:00:00");
  const adapters = list.map((n) =>
    I(n.ifaceName || n.iface, [
      F("Adapter", n.ifaceName || n.iface),
      F("Type", n.type === "wireless" ? "Wi-Fi" : n.type === "wired" ? "Ethernet" : n.type),
      F("Link speed", n.speed ? `${n.speed >= 1000 ? n.speed / 1000 + " Gbps" : n.speed + " Mbps"}` : null),
      F("Status", n.operstate),
      F("DHCP", M.yesNo(n.dhcp)),
      F("IPv4", n.ip4, { sensitive: true }),
      F("MAC", n.mac, { sensitive: true }),
    ])
  );
  const items = [...adapters];
  if (Array.isArray(wifi) && wifi.length) {
    wifi.forEach((w) => items.push(I(`Wi-Fi: ${w.model || w.iface}`, [F("Model", w.model), F("Vendor", w.vendor), F("MAC", w.mac, { sensitive: true })])));
  }
  if (Array.isArray(bt) && bt.length) {
    const ctrl = bt.filter((b) => /adapter|controller|radio/i.test(b.name || ""));
    (ctrl.length ? ctrl : bt.slice(0, 1)).forEach((b) => items.push(I(`Bluetooth: ${b.name}`, [F("Device", b.name), F("Manufacturer", b.manufacturer), F("Connected", M.yesNo(b.connected))])));
  }
  return S("network", "Network", "net", items);
}

// ── Audio, USB, battery, printers ──────────────────────────────
async function collectPeripherals() {
  const [audio, usb, battery, printers] = await Promise.all([
    safe(si.audio(), []),
    safe(si.usb(), []),
    safe(si.battery(), {}),
    safe(si.printer(), []),
  ]);
  const audioItems = (audio || []).map((a) => I(a.name, [F("Device", a.name), F("Manufacturer", a.manufacturer), F("Type", a.type), F("Default", M.yesNo(a.default)), F("Status", a.status)]));
  const seen = new Set();
  const usbItems = [];
  (usb || []).forEach((u) => {
    const key = `${u.name}|${u.type}`;
    if (!u.name || seen.has(key)) return;
    seen.add(key);
    usbItems.push(I(u.name, [F("Device", u.name), F("Type", u.type), F("Vendor", u.vendor || u.manufacturer)]));
  });
  const printerItems = (printers || []).map((p) => I(p.name, [F("Printer", p.name), F("Model", p.model), F("Default", M.yesNo(p.default)), F("Status", p.status)]));
  const bat = battery || {};
  const batItem = bat.hasBattery
    ? I("Battery", [
        F("Present", "Yes"),
        F("Design capacity", bat.designedCapacity ? `${bat.designedCapacity} ${bat.capacityUnit || "mWh"}` : null),
        F("Full-charge capacity", bat.maxCapacity ? `${bat.maxCapacity} ${bat.capacityUnit || "mWh"}` : null),
        F("Health", bat.designedCapacity && bat.maxCapacity ? `${Math.round((bat.maxCapacity / bat.designedCapacity) * 100)}%` : null),
        F("Cycle count", bat.cycleCount || null),
        F("Charge", Number.isFinite(bat.percent) ? `${bat.percent}%` : null),
        F("Manufacturer", bat.manufacturer),
        F("Model", bat.model),
        F("Serial", bat.serial, { sensitive: true }),
      ])
    : null;
  return [S("battery", "Battery", "battery", batItem ? [batItem] : []), S("audio", "Audio devices", "audio", audioItems), S("usb", "USB devices", "usb", usbItems), S("printers", "Printers", "printer", printerItems)];
}

/** Run every hardware collector in parallel; report progress by section. */
async function collectHardware(onProgress = () => {}) {
  const tasks = [
    ["System", collectSystem],
    ["Motherboard & BIOS", collectBoard],
    ["Processor", collectCpu],
    ["Memory", collectMemory],
    ["Graphics & displays", collectGraphics],
    ["Storage", collectStorage],
    ["Network", collectNetwork],
    ["Peripherals", collectPeripherals],
  ];
  let done = 0;
  const results = await Promise.all(
    tasks.map(async ([label, fn]) => {
      const r = await safe(fn(), null);
      done += 1;
      onProgress({ label, done, total: tasks.length });
      return r;
    })
  );
  return results.flat().filter(Boolean);
}

module.exports = { collectHardware };
