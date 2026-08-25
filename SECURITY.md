# Security

These extensions run inside pi with the full permissions of the user who started it. pi has no sandbox; an extension is ordinary TypeScript executed by the pi process (see pi's security.md). Install only what you have read.

## What each extension touches

- pi-clear, pi-fork-off, pi-pluck: append entries to the current session file through pi's SessionManager. Nothing is deleted.
- pi-time-heist: creates a new session file in pi's session store for the directory you choose. The source session is not modified. Nothing is written inside the target working directory.
- No extension collects or sends telemetry, and none opens a network connection. pi-time-heist can write a local trace to `~/.pi/agent/tva.log`, only when `PI_TVA_DEBUG=1` is set.

## Reporting

Use GitHub private vulnerability reporting on this repository or email asakin@gmail.com. Do not open a public issue for something exploitable. Acknowledgement within 7 days; fixes ship as a patch release of the affected package and the umbrella.

## Supported versions

The latest 1.x release. All packages move in lockstep.

## Scope

In scope: an extension reading, writing, or deleting files it is not documented to touch; session content causing an extension to write outside the session store or execute commands; a documented safety check (the pluck confirmation, for example) that can be bypassed.

Out of scope: that extensions run unsandboxed; prompt injection reaching the model; data loss from a documented destructive command used as documented; vulnerabilities in pi itself (report those to earendil-works/pi-mono).
