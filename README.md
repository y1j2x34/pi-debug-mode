# pi-debug-mode

A replica of Cursor Debug Mode's runtime-evidence debug loop, packaged as one extension that runs on both [pi](https://pi.dev) and [oh-my-pi (omp)](https://omp.sh).

A normal coding agent only has two information channels when fixing a bug: static source code and the user's prose. It has never seen the program's internal state at the moment the bug occurs, so for races, timing issues, performance problems and regressions it can only guess. This plugin wires in a third channel — **runtime evidence**:

```
Normal agent:  read code → guess a cause → one large patch → manual trial and error
Debug Mode:    hypotheses → probes → you reproduce → read runtime logs → 2-3 line fix → you verify → probes removed
```

## The loop (state machine)

```
DESCRIBE → HYPOTHESIZE → INSTRUMENT → REPRODUCE → ANALYZE → FIX → VERIFY → CLEANUP
                                          [PAUSE A]              [PAUSE B]
```

- **At least 3 falsifiable hypotheses** are required before any probe can be inserted (hard constraint, so the agent cannot skip theorizing and just scatter logs)
- **Two hard pause points**, driven by explicit resume commands: reproduction and the final "is it actually fixed?" verdict always stay with the human
- Still broken → `/debugmode-not-fixed` → **back to INSTRUMENT, not FIX** (add evidence, do not swap guesses)
- Cleanup is mechanical (sentinel markers), so the final diff is clean and shippable

## Why it runs on both pi and omp

Three hard constraints, all required:

1. **Zero host-package imports**: no `@mariozechner/*`, no `@oh-my-pi/*`, and no typebox/zod package imports. omp runs as a Bun-compiled binary, and host package resolution fails silently inside its virtual filesystem (the conclusion of omp issue #1215: sticking to the injected APIs such as `pi.registerTool` is the only reliable path).
2. **Plain JSON Schema tool parameters**: TypeBox is just JSON Schema, and both hosts validate plain JSON Schema directly.
3. **Dual manifest**: `package.json` declares both `"pi": {"extensions": [...]}` and `"omp": {"extensions": [...]}` (omp accepts the legacy `pi` field, pi only reads `pi`; declaring both is the safe option).

The host API surface used here is identical on both sides: `pi.registerTool` / `pi.registerCommand` / `pi.sendMessage` / `pi.on("session_start" | "session_shutdown")` / `ctx.cwd` / `ctx.ui.notify`.

## Install

### pi

```bash
# Option 1: install from a local directory (recommended)
pi install /path/to/pi-debug-mode-plugin

# Option 2: copy into the auto-discovery directory
cp -r pi-debug-mode-plugin ~/.pi/agent/extensions/pi-debug-mode

# Option 3: quick trial
pi -e /path/to/pi-debug-mode-plugin/extensions/index.ts
```

### omp

```bash
# Option 1: install from a local directory
omp install /path/to/pi-debug-mode-plugin

# Option 2: copy into the auto-discovery directory
cp -r pi-debug-mode-plugin ~/.omp/agent/extensions/pi-debug-mode
# or project-local: .omp/extensions/pi-debug-mode

# Option 3: quick trial
omp --extension /path/to/pi-debug-mode-plugin/extensions/index.ts
```

Restart the session (or run `/reload` / `/reload-plugins`) after installing; the `debug_*` tools will appear.

## Usage

```
You:  /debugmode occasional duplicate refresh when the token is renewed
      → the agent enters the loop: explore code → register hypotheses → insert probes →
        print reproduction steps and stop
You:  (operate the real app, trigger the bug)
You:  /debugmode-repro-done      ← resume point A
      → the agent pulls logs, checks hypotheses against their refutation signals,
        pinpoints the root cause and applies a minimal fix
You:  (reproduce once more to verify)
You:  /debugmode-verified        ← fixed: the agent removes every probe and reports the clean diff
   or /debugmode-not-fixed       ← still broken: back to instrumentation with more evidence
```

Other commands: `/debugmode-status` shows the current loop state; `/debugmode-abort` aborts and removes all probes.

## Tools (LLM-callable)

| Tool | Purpose | Key design |
|---|---|---|
| `debug_state` | Loop state machine, hypothesis registration, phase advance | Hypotheses must carry confirmation + refutation signals; `debug_instrument` refuses to run until 3 exist |
| `debug_instrument` | Insert probes (JS/TS and Python) | Strictly additive; every line carries the sentinel `[pi-debug:id\|hyp]`; auto-starts the log server; `sample` parameter protects hot paths |
| `debug_server` | Local log server (127.0.0.1, random port) | CORS open (required for browser probes); reuses the previous port on restart so old probes keep working; parallel sessions fall back to a random port |
| `debug_collect` | Fetch probe logs | Filters by hypothesis / probe / reproduction round and aggregates into "hits per probe + samples" so raw logs never flood the context |
| `debug_cleanup` | Remove all probes | Sentinel sweep across the workspace (including unregistered orphans), then verifies zero residue |

Probe transport: business code calls `fetch('127.0.0.1:port/probe', { keepalive: true })` (browser) or a daemon thread + urllib (Python); the server appends to `.pi-debug/logs.jsonl`, and `debug_collect` aggregates. Logs are on disk, so a server restart loses nothing.

## Project layout

```
pi-debug-mode-plugin/
├── package.json          # dual pi + omp manifest
├── extensions/
│   └── index.ts          # entry: 5 tools + 6 commands + lifecycle hooks
├── lib/
│   ├── store.ts          # .pi-debug/ state store (state / probes / server / logs)
│   ├── server.ts         # local log server (127.0.0.1, round-boundary backfill)
│   ├── probes.ts         # probe generation / insertion / sentinel sweep / cleanup
│   └── loop-prompt.ts    # 8-phase loop prompt (phase discipline)
└── scripts/
    └── smoke.ts          # smoke test (node scripts/smoke.ts, 38 assertions)
```

State lives in `.pi-debug/` inside the project being debugged, so it survives restarts (`session_start` notifies you about an unfinished session).

## Verified

- 38 smoke assertions pass: tool/command registration, hard constraints (instrumentation refused without hypotheses, language and line-range validation), additive JS + Python instrumentation, server health/CORS/ingest, collect aggregation and filtering, resume-point injection, cleanup restoration and residue check.
- Real end-to-end run: a probe executed inside a Node child process, sampling at 1/20 fired exactly 5 times, `total`/`i` values flowed back correctly, and after cleanup the file was byte-identical to its pre-instrumentation content.

## Known limits

- Probe languages are JS/TS family (including .vue/.svelte) and Python; other languages produce a clear error instead of a broken insertion.
- Python probe sampling counters reset per call when the probe sits inside a function (module-level probes behave normally).
- omp's npm install path (`omp install npm:...`) has not been exercised; local directory and auto-discovery paths are the verified ones.
- For extremely hot code paths use `sample: 50-200` to avoid a log flood.
