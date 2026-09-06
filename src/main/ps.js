// Tiny PowerShell runner. Everything Windows-specific that `systeminformation`
// doesn't cover (RAM sticks, product key, activation, monitors, installed
// programs...) comes through here as JSON.
//
// Every query is wrapped so a failure yields `null` rather than a rejected
// promise: one broken WMI class must never sink the whole scan.

const { execFile } = require("node:child_process");

const PS = "powershell.exe";
const BASE_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

/**
 * Run a PowerShell expression and parse its ConvertTo-Json output.
 * Always resolves; returns `null` on any failure. Arrays are always arrays
 * (ConvertTo-Json collapses a single element to an object — we re-wrap).
 */
function psJson(expr, { timeoutMs = 60000, depth = 4 } = {}) {
  const script =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
    "$ErrorActionPreference='SilentlyContinue'; " +
    `$r = @(${expr}); if ($r.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $r -Depth ${depth} -Compress }`;
  return new Promise((resolve) => {
    execFile(
      PS,
      [...BASE_ARGS, script],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const text = String(stdout || "").trim();
        if (!text) return resolve([]);
        try {
          const v = JSON.parse(text);
          resolve(Array.isArray(v) ? v : [v]);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/** Run PowerShell and return raw trimmed text (or null). */
function psText(expr, { timeoutMs = 30000 } = {}) {
  const script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference='SilentlyContinue'; " + expr;
  return new Promise((resolve) => {
    execFile(PS, [...BASE_ARGS, script], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout || "").trim() || null);
    });
  });
}

/** Get-CimInstance shorthand: class + property list, as JSON rows. */
function cim(cls, props, opts = {}) {
  const sel = props && props.length ? ` | Select-Object ${props.join(",")}` : "";
  const ns = opts.namespace ? ` -Namespace ${opts.namespace}` : "";
  return psJson(`Get-CimInstance -ClassName ${cls}${ns}${sel}`, opts);
}

module.exports = { psJson, psText, cim };
