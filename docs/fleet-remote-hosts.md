# FLEET: remote-host AI detection and Hermes usage

Design and review notes for the branch that closes the README roadmap's
"Fleet row: other hosts' AI load over SSH/Tailscale" item. Written for
whoever reviews this for a merge — end-user docs live in `README.md`
(`### 🟢 FLEET`, `## Data handling`, `## Requirements`); this file is the
"why," not the "how to use it."

## What this branch adds

Two independent capabilities, four commits, three new files:

1. **Presence detection** (`fleet-remote.ts`) — is a known AI provider
   running on a configured remote host, reached over `ssh`.
2. **Hermes/OpenRouter usage** (`hermes-usage.ts`) — token counts and cost
   for whichever hosts are running Hermes, read from Hermes's own local
   SQLite billing ledger, merged into the existing USAGE & LIMITS card.

Both are gated by one env var, `INFOMARCHY_FLEET_HOSTS` (comma-separated
ssh aliases, `label=host` optional), read the same way `OLLAMA_HOST` and
friends already are. Unconfigured, neither runs — no probe, no SSH
connection, no new state file.

## Why detection reuses `providerOf()` instead of copying it

`collector.ts` already has `PROVIDERS: [string, RegExp][]` and an exported
`providerOf(cmd: string[])` that matches a process's argv against it. A
naive remote implementation would hand-copy that regex table into
`fleet-remote.ts`. Importing `providerOf` directly would create an import
cycle (`collector.ts` already imports from `fleet-remote.ts`), so instead
`fleet-remote.ts` defines a `ProviderMatcher` type and takes the matcher as
a parameter:

```ts
export type ProviderMatcher = (cmd: string[]) => string | null;
export function parseAgents(output: string, providerOf: ProviderMatcher): FleetAgent[]
```

`collector.ts` passes its own `providerOf` in at the call site. This is the
same pattern `github-activity.ts` already uses for its `run()` dependency
(`export type GithubRunner = (cmd: string[], timeoutMs: number) => Promise<string>`),
so it isn't a new idiom — just the second application of an existing one.
The payoff: if the `PROVIDERS` regex table changes upstream, remote
detection changes with it automatically, with zero touches to this file.

Verified live against the real target: a Hermes instance launches as
`/opt/hermes/.venv/bin/python3 /opt/hermes/.venv/bin/hermes dashboard ...`
— argv[0] is the interpreter, not `hermes`. `providerOf`'s existing
interpreter-aware matching (checking argv[1] when argv[0] is
`python[0-9.]*`/`node`/etc.) is what makes this match correctly; a
simplified from-scratch matcher would have missed it. The unit tests use a
deliberately simpler fake matcher for speed and only check argv[0] — that
gap is intentional and called out in the test file; the real detection
path was checked against the real process line, not just the fake.

## Why a disk-persisted store, not an in-memory cache

`collector.ts` is a one-shot process, re-invoked fresh by QML's `Timer`
every 4–5 s (`runCollector()` runs once and exits). There is no long-lived
process to hold an in-memory throttle clock across ticks. `github-activity.ts`
already solves this with a `GithubStore` read from and written to a state
file, refreshed only when `githubRefreshDue()` says the interval has
elapsed. `fleet-remote.ts` and `hermes-usage.ts` copy that shape exactly:
`emptyXStore()`, `xRefreshDue(store, now)`, `refreshX(store, now, ...)`,
and `parseXStoreText()` / `normalizeXStore()` for defensive on-disk
parsing (never trust the file blindly — same posture as
`normalizeGithubStore`). Two new state files:
`$XDG_STATE_HOME/infomarchy/fleet.json` and `.../hermes-usage.json`.

Both also reuse `githubActivity()`'s one-writer-shares-with-overlay
pattern (`const X_WRITER = instanceId() !== "overlay"`), so the background
and overlay collector instances never both dial SSH for the same tick.

## The `collector.ts` diff, and why it's this small

Three seams, matching what was scoped out before writing any code:

```diff
+ import { ... } from "./fleet-remote";
+ import { ... } from "./hermes-usage";
  ...
- const [cpuS, ..., github] = await Promise.all([..., githubActivity()]);
+ const [cpuS, ..., github, fleet, hermesUsage] = await Promise.all([..., githubActivity(), fleetActivity(), hermesUsageActivity()]);
  ...
-       github,
+       github,
+       fleet,
```

`fleetActivity()` and `hermesUsageActivity()` are new, self-contained
functions (same shape as `githubActivity()`), added beside it — not
inline edits to existing functions. Nothing in the existing detection
code (`PROVIDERS`, `providerOf`) or the existing usage cache path
(`agentsUsage()`'s reading of `omarchy.agents`) was touched; Hermes usage
is merged in *after* `agentsUsage()` runs, with the same
real-cache-wins-over-inference priority `grokUsage()`'s own fallback
already uses:

```ts
const usage = agentsUsage();
if (!usage.hermes && hermesUsage) usage.hermes = hermesUsage;
```

The intent throughout was a diff small enough to rebase against upstream
`master` without fighting unrelated changes, and — if the maintainer wants
it — clean enough to open as a PR as-is.

## The one deliberate deviation: Hermes's cost figure bypasses `pricing.json`

`pricing.json` is a pinned LiteLLM snapshot with **zero** entries for any
`deepseek/*` model id (checked directly, not assumed). Feeding Hermes's
token counts through the standard `valueSummary()`/`estimateValue()` path
would silently report the whole row as *unpriced* — technically consistent
with every other provider, but wrong, because Hermes already computed a
real cost estimate itself (`session_model_usage.estimated_cost_usd`,
`cost_source: provider_models_api` — Hermes resolves live OpenRouter
pricing on its own end). `hermesUsageActivity()` in `collector.ts` calls
`normalizeUsage()` as usual for shape/limits/model-breakdown, then
overwrites just the `.value` field with Hermes's own summed cost:

```ts
usage.value = { lifetime: summary.costLifetimeUsd, today: summary.costTodayUsd, pricedShare: priced ? 1 : 0, unpriced: [], totals };
```

This is the only place in the new code that departs from "everything
flows through the existing normalization path unchanged." It's called out
here because it's the one design call a reviewer might reasonably want to
push back on — the alternative (hand-adding OpenRouter model entries to
`pricing.json`) was rejected because it means maintaining a competing,
easily-stale price list for exactly the models least likely to be updated
in a pinned upstream snapshot.

One observed limitation, not hidden: `actual_cost_usd` was `0.0` on every
row read from the real ledger — Hermes doesn't appear to reconcile a
verified billed figure yet, only its own estimate. `estimated_cost_usd` is
what's used, and the card's `usageStatusText` says "estimated by Hermes,"
not "verified."

## Security model for the two SSH probes

- The remote command is a **fixed string** in both files
  (`FLEET_PROBE_CMD`, `HERMES_USAGE_QUERY`) — never built from
  `INFOMARCHY_FLEET_HOSTS` beyond the host argument itself, so there is no
  argument-injection or SQL-injection surface in what that variable can
  reach.
- Host/label values are validated against a strict charset
  (`HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252})$/`, plus `isIP()` for
  literal addresses) that rejects anything starting with `-` — the actual
  attack this matters for is an entry that ssh's argv parser would read as
  a flag, not a shell-metacharacter concern (both files use array-form
  `Bun.spawn`, so there's no shell in between). Covered by tests that
  specifically target the host slot after label/host splitting, not just
  the whole raw string.
- `ssh -o BatchMode=yes` means an unknown host key or a password prompt
  **fails the probe**, never hangs or falls back to interactive auth.
- `sqlite3 -readonly` is defense in depth on top of the query already
  being a `SELECT`.
- No credential of any kind is introduced. Auth is whatever `ssh <alias>`
  already does on this machine (`~/.ssh/config`), same as every other tool
  the user already runs by hand.
- Both probes degrade to a failure state (`ok: false` / `null`) rather
  than fabricating data, matching the project's existing stated posture
  for every other optional source.

## The QML side: one real bug caught before it shipped

The USAGE & LIMITS card needed **zero QML changes** — it already iterates
`Object.keys(usage)` generically (`InfoView.qml`, filtered on
`.ready !== false`), so `usage.hermes` renders through existing code the
moment the collector produces it.

The new FLEET card (`InfoView.qml`) follows the `Card`/`moveId`/
`sectionEnabled` pattern exactly, modeled on the LOCAL AI card's delegate.
The one thing that needed care: `InfoSettings.qml`'s `definitions` array
isn't just display order — `Overlay.qml` maps keyboard digits 1–9/0
positionally to `definitions[0..9]` (documented in
`info-ui.test.ts`: *"Key n toggles definitions[n-1]; 0 is the tenth."*).
The first draft inserted `{ id: "fleet", ... }` right after `localAi`,
which is the intuitive spot — and which would have silently pushed
`projects` from index 9 to index 10, reassigning keyboard digit `0` away
from PROJECTS for anyone who uses that shortcut. Caught by re-deriving the
shifted indices against `info-ui.test.ts`'s own pinned-position
assertions before trusting the change, not by qmllint or by inspection.
Fixed by appending `fleet` at the very end of `definitions` instead —
same treatment MEDIA already gets, beyond the keyboard's ten slots — which
leaves every existing shortcut's index untouched.

`qml-resolve.test.ts`'s `InfoView.qml` ceiling moved 473 → 493. Diffed
qmllint's raw output before/after rather than assuming: the delta is
20 `[unqualified]` findings, and they're the same false-positive shape
(`Repeater` + `required property` + references to the outer `view`/`Style`
scope) the structurally identical LOCAL AI delegate already produces
~26 of. Confirmed by grepping qmllint's output around both delegate blocks
side by side before bumping the ceiling — this is the codebase's known,
accepted cost for this exact idiom, not a new class of problem.

## What was verified live, not just in `bun test`

- `ssh -o BatchMode=yes vps 'echo OK; ps -eo pid=,args= | head -5'` —
  confirmed the exact probe shape works non-interactively before writing
  any TypeScript around it.
- `bun collector.ts` run directly (not through Quickshell) in: demo mode,
  real mode unconfigured (0.18 s, `fleet: []`), real mode against a
  deliberately nonexistent host (fails in ~6 ms, `ok: false`, persists
  correctly, throttle holds on an immediate repeat run), and real mode
  against the actual Hermes VPS.
- Fleet detection against the real VPS: `hermes` detected with 2 matching
  processes; cross-checked both pids directly against the VPS's own `ps`
  output (not just trusted the collector's own report) — both were
  genuine Hermes processes (`hermes dashboard`, `hermes gateway run`).
- Hermes usage against the real VPS: lifetime cost, today's cost, token
  totals and per-model session count all cross-checked against raw
  `sqlite3 -json` query output by hand — not just against the collector's
  own transformation of that output.
- `omarchy-shell infomarchy` activation: `hl.env(...)` in
  `~/.config/hypr/autostart.lua` only executes at Hyprland's own session
  start, confirmed by checking `/proc/<pid>/environ` on the live
  Hyprland and quickshell processes after both `hyprctl reload` and
  `omarchy restart shell` — neither picked up a var added after login.
  Noted here because it isn't obvious from the README's existing "the
  desk is black/empty" FAQ entry, which covers a QML reload, not an env
  var added to autostart.

## Test coverage

`fleet-remote.test.ts` (18 tests) and `hermes-usage.test.ts` (12 tests):
config parsing and its three injection-adjacent rejection cases, argv[0]-
only matching, throttle timing, disk round-trip (including a deliberately
malformed/oversized/wrong-shaped store file), aggregation math (tokens,
cost, sessions, day-bucketing) across multiple hosts including one that
failed, and a runner that throws. `bun test`: 265/266 at time of writing;
the one failure is `Infomarchy.qml`'s qmllint ceiling, pre-existing and
unrelated — reproduces identically on `master`, confirmed with `git
stash` before assuming it wasn't this branch's doing.

## Open follow-ups, not attempted here

- No fleet-wide dimension in USAGE & LIMITS: if Hermes ever runs on more
  than one configured host, usage is summed across all of them into one
  `usage.hermes` row, matching the fact that the card has no per-host
  concept for any provider today.
- `ps`-based remote argv reconstruction (whitespace-joined) is coarser
  than local detection's exact null-delimited `/proc/pid/cmdline` read —
  fine for launcher-name matching, not exact for anything finer. Called
  out in `fleet-remote.ts`'s own header comment.
- `HERMES_HOME` overrides aren't resolvable remotely without a second SSH
  round trip; only the default `~/.hermes` location is read.
