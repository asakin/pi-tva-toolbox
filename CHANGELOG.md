# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). All packages in this repository share one version and move in lockstep.

## [Unreleased]

## [1.0.0] - 2026-08-25

### pi-tva-toolbox
- First release of the umbrella package, bundling pi-clear, pi-fork-off, pi-pluck, and pi-time-heist.

### @arielsakin/pi-clear
- `/clear`: rewind the active branch to before its first user message and start a new branch there.

### @arielsakin/pi-fork-off
- `/fork-off`: fork one point of a session into several labeled branches.

### @arielsakin/pi-pluck
- `/pluck`: hide the turns matching a regex on the active branch; `/unpluck` restores them.

### @arielsakin/pi-time-heist
- `/heist`: fork a session from any point in its tree into a different working directory.

### @arielsakin/pi-tva-lib
- Shared internals for the extensions. Trace logging to `~/.pi/agent/tva.log` is opt-in via `PI_TVA_DEBUG=1`.

[Unreleased]: https://github.com/asakin/pi-tva-toolbox/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/asakin/pi-tva-toolbox/releases/tag/v1.0.0
