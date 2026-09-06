// Software collectors: OS, activation, security, installed programs, updates,
// startup apps. Same contract as hardware.js — return sections, never throw.

const si = require("systeminformation");
const os = require("node:os");
const { cim, psJson, psText } = require("../ps");
const M = require("./model");
const { field: F, item: I, section: S } = M;

const safe = (p, fallback = null) => Promise.resolve(p).then((v) => v, () => fallback);

const EDITION_NAMES = { 0: "Unlicensed", 1: "Licensed", 2: "Out-of-box grace", 3: "Out-of-tolerance grace", 4: "Non-genuine grace", 5: "Notification", 6: "Extended grace" };

async function collectOs(includeProductKey) {
  const [osi, wos, lic, key, uptime] = await Promise.all([
    safe(si.osInfo(), {}),
    cim("Win32_OperatingSystem", ["Caption", "Version", "BuildNumber", "OSArchitecture", "InstallDate", "LastBootUpTime", "RegisteredUser", "SerialNumber", "SystemDrive", "OSLanguage"]),
    psJson("Get-CimInstance SoftwareLicensingProduct -Filter \"PartialProductKey IS NOT NULL AND Name LIKE 'Windows%'\" | Select-Object Name,LicenseStatus,PartialProductKey,ProductKeyChannel"),
    includeProductKey ? psText("(Get-CimInstance SoftwareLicensingService).OA3xOriginalProductKey") : Promise.resolve(null),
    safe(si.time(), {}),
  ]);
  const w = (wos && wos[0]) || {};
  const l = (lic && lic[0]) || {};
  const caption = (w.Caption || osi.distro || "Windows").replace(/^Microsoft\s+/, "");
  const buildNum = Number(w.BuildNumber || osi.build);
  const release = osi.release || (buildNum >= 22000 ? "Windows 11" : buildNum ? "Windows 10" : null);
  const dispVer = await psText("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').DisplayVersion");
  const up = uptime.uptime ? `${Math.floor(uptime.uptime / 86400)}d ${Math.floor((uptime.uptime % 86400) / 3600)}h` : null;
  return S("os", "Operating system", "os", [
    I(caption, [
      F("Edition", caption),
      F("Version", dispVer || null),
      F("Build", w.Version ? `${w.Version}${w.BuildNumber ? "" : ""}` : osi.build),
      F("Architecture", w.OSArchitecture || osi.arch),
      F("Installed", M.wmiDate(w.InstallDate)),
      F("Last boot", M.wmiDate(w.LastBootUpTime)),
      F("Uptime", up),
      F("Activation", l.LicenseStatus !== undefined ? EDITION_NAMES[l.LicenseStatus] || String(l.LicenseStatus) : null),
      F("License channel", l.ProductKeyChannel),
      F("Partial product key", l.PartialProductKey ? `•••••-${l.PartialProductKey}` : null),
      F("Product key (OEM)", key && key !== "" ? key : null, { sensitive: true }),
      F("Windows serial", w.SerialNumber, { sensitive: true }),
      F("Registered to", w.RegisteredUser, { sensitive: true }),
      F("System drive", w.SystemDrive),
      F("Hostname", os.hostname(), { sensitive: true }),
    ]),
  ]);
}

async function collectSecurity() {
  const [av, fw, bl, defender] = await Promise.all([
    psJson("Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | Select-Object displayName,productState"),
    psJson("Get-NetFirewallProfile | Select-Object Name,Enabled"),
    psJson("Get-BitLockerVolume | Select-Object MountPoint,VolumeStatus,ProtectionStatus,EncryptionPercentage"),
    psJson("Get-MpComputerStatus | Select-Object AntivirusEnabled,RealTimeProtectionEnabled,AntivirusSignatureLastUpdated"),
  ]);
  const items = [];
  (Array.isArray(av) ? av : []).forEach((a) => {
    const enabled = a.productState ? ((a.productState >> 12) & 0xf) === 1 : null;
    items.push(I(`Antivirus: ${a.displayName}`, [F("Product", a.displayName), F("Enabled", M.yesNo(enabled))]));
  });
  const d = defender && defender[0];
  if (d) items.push(I("Windows Defender", [F("Antivirus enabled", M.yesNo(d.AntivirusEnabled)), F("Real-time protection", M.yesNo(d.RealTimeProtectionEnabled)), F("Signatures updated", M.wmiDate(d.AntivirusSignatureLastUpdated))]));
  if (Array.isArray(fw) && fw.length) items.push(I("Firewall", fw.map((p) => F(`${p.Name} profile`, M.yesNo(!!p.Enabled)))));
  (Array.isArray(bl) ? bl : []).forEach((v) => items.push(I(`BitLocker ${v.MountPoint}`, [F("Status", v.VolumeStatus), F("Protection", v.ProtectionStatus === 1 ? "On" : v.ProtectionStatus === 0 ? "Off" : String(v.ProtectionStatus)), F("Encrypted", Number.isFinite(v.EncryptionPercentage) ? `${v.EncryptionPercentage}%` : null)])));
  return S("security", "Security", "shield", items);
}

const PROGRAMS_QUERY = `
  $paths = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
           'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
           'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*';
  Get-ItemProperty $paths | Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName -and $_.ReleaseType -ne 'Update' -and $_.DisplayName -notmatch '^(KB\\d+|Update for|Security Update)' } |
    Select-Object DisplayName,DisplayVersion,Publisher,InstallDate,EstimatedSize |
    Sort-Object DisplayName -Unique
`;

async function collectPrograms() {
  const rows = await psJson(PROGRAMS_QUERY, { timeoutMs: 90000 });
  const list = Array.isArray(rows) ? rows : [];
  const items = list.map((p) =>
    I(p.DisplayName, [
      F("Name", p.DisplayName),
      F("Version", p.DisplayVersion),
      F("Publisher", p.Publisher),
      F("Installed", M.wmiDate(p.InstallDate)),
      F("Size", p.EstimatedSize ? M.bytesHuman(p.EstimatedSize * 1024) : null),
    ])
  );
  return S("programs", "Installed programs", "apps", items);
}

async function collectUpdatesAndStartup() {
  const [hot, startup, ps] = await Promise.all([
    psJson("Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 25 HotFixID,Description,InstalledOn"),
    cim("Win32_StartupCommand", ["Name", "Command", "Location"]),
    psText("$PSVersionTable.PSVersion.ToString()"),
  ]);
  const updates = (Array.isArray(hot) ? hot : []).map((h) => I(h.HotFixID, [F("Update", h.HotFixID), F("Type", h.Description), F("Installed", M.wmiDate(h.InstalledOn && h.InstalledOn.value ? h.InstalledOn.value : h.InstalledOn))]));
  const startups = (Array.isArray(startup) ? startup : []).map((s) => I(s.Name, [F("Program", s.Name), F("Location", s.Location), F("Command", s.Command)]));
  const runtime = I("Runtimes", [F("PowerShell", ps), F("Node.js (bundled)", process.versions.node), F(".NET", null)]);
  return [S("updates", "Recent Windows updates", "update", updates), S("startup", "Startup programs", "startup", [...startups, runtime])];
}

/** Run every software collector; `opts.programs` toggles the (slow) program list. */
async function collectSoftware(opts = {}, onProgress = () => {}) {
  const tasks = [
    ["Operating system", () => collectOs(!!opts.productKey)],
    ["Security", collectSecurity],
    ["Updates & startup", collectUpdatesAndStartup],
  ];
  if (opts.programs !== false) tasks.push(["Installed programs", collectPrograms]);
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

module.exports = { collectSoftware };
