# @arielsakin/pi-tva-lib

Shared logger for the pi-tva-toolbox extensions. Not a pi package and not a public API; a runtime dependency of pi-time-heist, versioned in lockstep with the toolbox.

`createLogger(tag)` returns a function that appends tagged lines to `~/.pi/agent/tva.log` (the pi agent directory) when `PI_TVA_DEBUG=1` is set. Otherwise it returns a no-op and nothing is written. Nothing leaves your machine either way.
