# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-06

### Added

- Full hardware scan: system, motherboard/BIOS/TPM/Secure Boot, CPU, every
  memory module, GPUs, displays (native resolution from EDID), drives with
  health, volumes, network adapters, Wi-Fi, Bluetooth, battery, audio, USB,
  printers.
- Software scan: Windows edition/version/build, activation status and
  channel, security (antivirus, Defender, firewall, BitLocker), installed
  programs, recent updates, startup programs.
- Dashboard with headline cards and highlights; searchable Hardware and
  Software pages.
- Export as tall or wide CSV, JSON and plain text, with an optional
  "write me a listing" AI prompt; copy-to-clipboard for pasting into an AI.
- Privacy setting (off by default, behind a warning) that controls whether
  serials, product key, MAC/IP, hostname and user name appear in exports.
- Live monitor tab (CPU load/clock/temp, memory, GPU, disk, network, per-core
  bars, volumes) with its own CSV export of collected samples.
- Benchmark tab (CPU single/multi-thread, memory bandwidth, disk sequential
  read/write) with export.
- Local scan history with reopen and delete.
- Dark (default) and light themes.
- One-click per-user installer, silent auto-update from GitHub Releases, and
  an About page with a manual "Check for updates" that reports offline
  failures plainly.
- One-click "Relaunch as admin" for fields that need elevation.
