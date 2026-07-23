# Version Sentinel

A memory-refresh layer for autonomous agents. When an agent pins a dependency
version from its training data, that memory is often months or years stale — a
mistake it makes silently, especially while running unsupervised. This sentinel
catches it at the moment of writing and hands the agent current information, so
it corrects itself without you in the loop.

## What it is not

- **Not a "find the newest version" tool.** That's what a registry and Dependabot
  already do.
- **Not a vulnerability scanner.** That's Snyk, Mend, OSV, Xray. It has no CVE
  knowledge and doesn't try to.

Those tools run *after the fact* — on committed manifests, in CI, on a schedule.
This runs *at the agent's write moment*, before the version reaches disk. It's the
earliest tripwire in a defense-in-depth stack, aimed at a failure mode those tools
were never built for: an agent recalling a version wrong.

## What it does

On Pi's `tool_call` event, before an `edit` or `write` lands, it reads only the
text being written, extracts any dependency versions, and checks each against the
registry's latest **stable major**. If the agent is about to pin a version behind
the current major, the tool call is blocked with a reason:

```
T.V.A. version sentinel — this write pins a variant that has diverged from the
sacred timeline (latest stable):
  • typescript ^5.0.0 → latest stable 7.0.2 (2 majors behind)
A version recalled from training data is suspect. Verify against the registry,
then re-issue this write to proceed (it passes the second time).
```

This is **not** human-in-the-loop. A blocked tool call is feedback to the *agent*,
which retries on its own — the same way it retries an `edit` whose `oldText` no
longer matches. It either writes a current version (which passes) or re-issues the
same one deliberately (which also passes — **block once, then defer**), so an
unsupervised loop never deadlocks. The net effect: the odds of a stale-version
mistake drop sharply, even at 3am with no one watching.

## Scope

- **Write payload only.** It inspects what's being written this edit, not the file
  on disk or the wider project. It is not a repo monitor.
- **Major-behind only.** Minor and patch drift is Dependabot's lane.
- **Fail-open.** Any error — unreachable registry, odd spec, parse failure —
  allows the write. It never stops work.

## Ecosystems

npm (`package.json`), PyPI (`requirements*.txt`, `pyproject.toml`), Cargo
(`Cargo.toml`), Go (`go.mod`), RubyGems (`Gemfile`), and GitHub Actions
(`uses: owner/repo@ref` in `.github/workflows/*`).

## Roadmap

The registry check is a freshness signal. The natural next step is to layer richer
knowledge from tools already in the repo — OSV for known advisories, Snyk or
Artifactory Xray when configured, and the org's private registry as the source of
"latest" — detected at runtime, degrading gracefully to the freshness check.
Always as a nudge the agent acts on, never a scanner competing with them.

## License

Apache 2.0
