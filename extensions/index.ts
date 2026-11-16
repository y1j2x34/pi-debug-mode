// pi-debug-mode — a Cursor Debug Mode replica (extension for pi / oh-my-pi, one codebase for both).
//
// Three hard constraints that make a single extension work on both hosts (all required, see README):
// 1. Zero host-package imports: no @mariozechner/*, no @oh-my-pi/*, no typebox — omp runs as a
//    Bun-compiled binary and host package resolution fails silently inside /$bunfs (omp issue #1215).
// 2. Tool parameters are plain JSON Schema objects (TypeBox is just JSON Schema), both hosts validate them.
// 3. package.json declares both "pi" and "omp" extension manifest fields.
import { DebugStore } from "../lib/store.ts";
import { DebugServer } from "../lib/server.ts";
import { insertProbe, removeAllProbes } from "../lib/probes.ts";
import { buildLoopPrompt } from "../lib/loop-prompt.ts";

// ---------- schema helpers (plain JSON Schema; never import typebox/zod) ----------
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const strArr = (description) => ({ type: "array", items: { type: "string" }, description });

export default function (pi) {
  // One server per extension instance; lazily started on first instrumentation.
  let server = null;

  const getStore = (ctx) => new DebugStore(ctx.cwd);

  // Lazy server startup: hosts forbid background resources inside the extension factory,
  // so the listener is created only when a tool or command actually needs it.
  async function ensureServer(ctx) {
    const st = getStore(ctx);
    if (server && server.running) return server;
    const saved = st.readServerInfo();
    const candidate = new DebugServer(st, saved && saved.port ? saved.port : 0);
    await candidate.start();
    server = candidate;
    return server;
  }

  async function stopServer(st) {
    if (server && server.running) {
      server.stop();
      st.clearServerInfo();
    }
    server = null;
  }

  function toolText(text, details) {
    return { content: [{ type: "text", text }], details: details || {} };
  }

  function toolError(text) {
    return { content: [{ type: "text", text: "Error: " + text }], isError: true, details: {} };
  }

  function statusLine(st) {
    const s = st.getState();
    if (!s) return "No active debug session (start one with /debugmode <bug description>)";
    const probes = st.getProbes();
    return `Phase ${s.phase} | round ${s.round} | ${s.hypotheses.length} hypotheses | ${probes.length} active probes`;
  }

  // ============================================================
  // Tool 1: debug_state — read / advance / reset the loop state machine, register hypotheses
  // ============================================================
  pi.registerTool({
    name: "debug_state",
    label: "Debug State",
    description:
      "Read or mutate the debug loop state machine (DESCRIBE→HYPOTHESIZE→INSTRUMENT→REPRODUCE→ANALYZE→FIX→VERIFY→CLEANUP). " +
      "action=get returns current state; action=hypothesis registers a root-cause hypothesis " +
      "(requires a confirmation signal and a refutation signal); action=advance moves to the next phase; " +
      "action=reset wipes the session. At least 3 falsifiable hypotheses must be registered before any probe can be inserted.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "hypothesis", "advance", "reset"], description: "Operation to perform" },
        statement: str("(action=hypothesis) One-sentence statement of the hypothesis"),
        confirm_signal: str("(action=hypothesis) Confirmation signal: what a probe should observe if the hypothesis is true"),
        refute_signal: str("(action=hypothesis) Refutation signal: what a probe should NOT observe if the hypothesis is false"),
        probe_plan: str("(action=hypothesis) Suggested probe locations (file:function) and variables to capture"),
      },
      required: ["action"],
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const st = getStore(ctx);
      if (params.action === "get") {
        const s = st.getState();
        if (!s) return toolText("No active debug session. Ask the user to run /debugmode <bug description> first.");
        return toolText(JSON.stringify({ ...s, activeProbes: st.getProbes().length }, null, 2), { phase: s.phase });
      }
      if (params.action === "hypothesis") {
        const s = st.getState();
        if (!s) return toolError("No debug session. Ask the user to run /debugmode <bug description> first.");
        if (!params.statement) return toolError("A hypothesis requires a statement");
        const id = st.addHypothesis({
          statement: params.statement,
          confirm: params.confirm_signal || "",
          refute: params.refute_signal || "",
          probePlan: params.probe_plan || "",
        });
        const count = st.getState().hypotheses.length;
        return toolText(
          `Hypothesis ${id} registered (${count} total). ${
            count < 3
              ? `${3 - count} more needed: keep registering until you have at least 3 competing hypotheses before instrumenting.`
              : "Enough hypotheses: move to INSTRUMENT (advance, then debug_instrument)."
          }`,
          { hypothesisId: id, count },
        );
      }
      if (params.action === "advance") {
        const s = st.advancePhase();
        if (!s) return toolError("No debug session to advance.");
        const notes = {
          REPRODUCE:
            "This is a hard pause point: hand clear reproduction steps to the user, then stop. The user resumes with /debugmode-repro-done.",
          ANALYZE:
            "Use debug_collect to pull logs and check every hypothesis against its confirmation/refutation signals. If evidence is insufficient, go back to INSTRUMENT and add probes.",
          VERIFY:
            "This is a hard pause point: ask the user to reproduce again. The user then runs /debugmode-verified or /debugmode-not-fixed.",
          CLEANUP: "Call debug_cleanup to remove all probes, verify zero residue, then report the final diff.",
        };
        return toolText(`Phase advanced to ${s.phase}. ${notes[s.phase] || ""}`, { phase: s.phase });
      }
      // reset
      await stopServer(st);
      st.resetState();
      return toolText("Debug session reset; .pi-debug/ has been cleared.");
    },
  });

  // ============================================================
  // Tool 2: debug_instrument — insert probes (additive only, sentinel-tagged)
  // ============================================================
  pi.registerTool({
    name: "debug_instrument",
    label: "Debug Instrument",
    description:
      "Insert a debug probe into source code (sentinel comment [pi-debug:id|hyp], auto-posts to the local log server). " +
      "Only adds new lines, never rewrites existing code. Params: file plus either line or after (insertion point), " +
      "hypothesis (id such as h1), capture (variable names to record), sample (emit every Nth hit, for hot paths), " +
      "note (location label). Never hand-write console.log/print as a probe — always use this tool so cleanup stays mechanical.",
    parameters: {
      type: "object",
      properties: {
        file: str("Target file, relative to cwd"),
        hypothesis: str("Hypothesis id this probe belongs to (e.g. h1); auto-registered as a placeholder if unknown"),
        line: num("Insertion point: insert after line N (1-based)"),
        after: str("Insertion point: insert after the first line containing this text"),
        capture: strArr("Variable names to capture"),
        sample: num("Sampling: emit one log every N executions (10-100 for hot paths)"),
        lang: { type: "string", enum: ["js", "python"], description: "Explicit language (defaults to extension-based detection)" },
        note: str("Location label (e.g. function name), recorded in the where field"),
      },
      required: ["file", "hypothesis"],
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const st = getStore(ctx);
      const state = st.getState();
      if (!state) return toolError("No debug session. Ask the user to run /debugmode <bug description> first.");
      if (!state.hypotheses || state.hypotheses.length < 3) {
        return toolError(
          `Only ${(state.hypotheses || []).length} hypotheses registered. Discipline: register at least 3 competing hypotheses with debug_state before instrumenting (prevents scattering logs without a theory).`,
        );
      }
      if (!st.getHypothesis(params.hypothesis)) {
        st.addHypothesis({ id: params.hypothesis, statement: "(Placeholder auto-registered at instrumentation time; please fill in the statement)" });
      }

      let srv;
      try {
        srv = await ensureServer(ctx);
      } catch (e) {
        return toolError("Log server failed to start: " + e.message);
      }

      let result;
      try {
        result = insertProbe({
          cwd: ctx.cwd,
          file: params.file,
          hypothesis: params.hypothesis,
          capture: params.capture || [],
          sample: params.sample || 1,
          lang: params.lang,
          note: params.note,
          line: params.line,
          after: params.after,
          port: srv.port,
        });
      } catch (e) {
        return toolError(e.message);
      }

      st.addProbe({
        id: result.id,
        hypothesis: result.hypothesis,
        file: result.file,
        anchorLine: result.anchorLine,
        lines: result.insertedLines,
        where: result.where,
        lang: result.lang,
        capture: result.capture,
        sample: result.sample,
        port: srv.port,
        insertedAt: new Date().toISOString(),
      });

      return toolText(
        `Probe ${result.id} inserted at ${result.where} (hypothesis ${result.hypothesis}, ` +
          `${result.capture.length || 0} variables captured, sampling 1/${result.sample}). ` +
          `Logs post to http://127.0.0.1:${srv.port}/probe.\n` +
          `Next: once all planned probes are in place, call debug_state advance to reach REPRODUCE, ` +
          `then print reproduction steps and STOP and wait (the user resumes with /debugmode-repro-done).`,
        { probeId: result.id, where: result.where, port: srv.port },
      );
    },
  });

  // ============================================================
  // Tool 3: debug_server — start / stop / inspect the local log server
  // ============================================================
  pi.registerTool({
    name: "debug_server",
    label: "Debug Server",
    description:
      "Manage the local probe log server (127.0.0.1). action=start (instrument starts it automatically, so this is rarely needed); " +
      "action=status shows port and session count; action=stop shuts it down. Probe data is persisted in .pi-debug/logs.jsonl, so a restart loses nothing.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "status", "stop"], description: "Operation to perform" },
      },
      required: ["action"],
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const st = getStore(ctx);
      if (params.action === "start") {
        const srv = await ensureServer(ctx);
        return toolText(`Log server running at http://127.0.0.1:${srv.port}`, { port: srv.port });
      }
      if (params.action === "status") {
        const saved = st.readServerInfo();
        const running = server && server.running;
        return toolText(
          running
            ? `Running: http://127.0.0.1:${server.port}`
            : saved
              ? `Not running (last port ${saved.port}; that port is preferred on restart)`
              : "Not running",
        );
      }
      await stopServer(st);
      return toolText("Log server stopped.");
    },
  });

  // ============================================================
  // Tool 4: debug_collect — fetch and aggregate probe logs
  // ============================================================
  pi.registerTool({
    name: "debug_collect",
    label: "Debug Collect",
    description:
      "Read probe logs (filter by hypothesis / probe / reproduction round) and return an aggregated summary: " +
      "hit count per probe plus first/last samples (truncated), so raw logs never flood the context. " +
      "Params: hypothesis (e.g. h1), probe (e.g. p3a2f), session (reproduction round, 1 = first round), " +
      "max_samples (samples per probe, default 3). Full raw logs live in .pi-debug/logs.jsonl.",
    parameters: {
      type: "object",
      properties: {
        hypothesis: str("Filter by hypothesis id (e.g. h1)"),
        probe: str("Filter by probe id (e.g. p3a2f)"),
        session: num("Filter by reproduction round (1 = first round)"),
        max_samples: num("Max samples returned per probe (default 3)"),
      },
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const st = getStore(ctx);
      const records = st.readLogs().filter((r) => r && r.type !== "boundary");
      let filtered = records;
      if (params.hypothesis) filtered = filtered.filter((r) => r.hypothesis === params.hypothesis);
      if (params.probe) filtered = filtered.filter((r) => r.probe === params.probe);
      if (params.session !== undefined) filtered = filtered.filter((r) => r.session === params.session);

      if (filtered.length === 0) {
        const sessions = [...new Set(records.map((r) => r.session))].sort();
        return toolText(
          `No matching probe data (${records.length} records total; rounds seen: ${sessions.join(", ") || "none"}). ` +
            `Likely causes: the user has not reproduced yet, the probe was never executed, or probe POSTs were blocked by a firewall/network policy.`,
        );
      }

      // Aggregate: hit count plus representative samples per probe.
      const byProbe = new Map();
      for (const r of filtered) {
        if (!byProbe.has(r.probe)) byProbe.set(r.probe, []);
        byProbe.get(r.probe).push(r);
      }
      const maxSamples = Math.max(1, params.max_samples || 3);
      const trunc = (v) => {
        const s = JSON.stringify(v);
        return s && s.length > 400 ? s.slice(0, 400) + `...(truncated, ${s.length} chars)` : s;
      };
      const parts = [`${filtered.length} records across ${byProbe.size} probe(s):`];
      for (const [pid, recs] of byProbe) {
        const first = recs[0];
        const step = Math.max(1, Math.floor(recs.length / maxSamples));
        const samples = recs.filter((_, i) => i % step === 0).slice(0, maxSamples);
        parts.push(`\n[${pid}] hypothesis ${first.hypothesis} @ ${first.where} — ${recs.length} hits (session ${first.session})`);
        for (const s of samples) {
          parts.push(`  ts=${s.ts} data=${trunc(s.data)}`);
        }
        if (recs.length > maxSamples) parts.push(`  (${recs.length - samples.length} more in .pi-debug/logs.jsonl)`);
      }
      parts.push("\nAnalysis rule: check each hypothesis against its confirmation/refutation signal; if evidence is insufficient, go back to INSTRUMENT and add probes. Never claim a root cause without evidence.");
      return toolText(parts.join("\n"), { total: filtered.length, probes: byProbe.size });
    },
  });

  // ============================================================
  // Tool 5: debug_cleanup — remove every probe (registry + sentinel sweep)
  // ============================================================
  pi.registerTool({
    name: "debug_cleanup",
    label: "Debug Cleanup",
    description:
      "Delete every debug probe in the workspace (precise line removal by sentinel marker [pi-debug:...], " +
      "including orphaned probes that were never registered) and verify zero residue. " +
      "Must be called after the user confirms the fix (/debugmode-verified), and when aborting a session.",
    parameters: { type: "object", properties: {} },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const st = getStore(ctx);
      const result = removeAllProbes(ctx.cwd);
      st.clearProbes();
      const lines = [`Removed ${result.removedTotal} probe line(s):`];
      for (const f of result.removedByFile) lines.push(`  ${f.file}: ${f.removed} line(s)`);
      if (result.remaining.length > 0) {
        lines.push(`WARNING: ${result.remaining.length} probe line(s) still present (cleanup anomaly, manual check required):`);
        for (const h of result.remaining.slice(0, 10)) lines.push(`  ${h.file}:${h.line}`);
        return toolText(lines.join("\n"), { removed: result.removedTotal, remaining: result.remaining.length });
      }
      lines.push("Residue check passed: no probes left in the workspace; the diff is clean and shippable.");
      await stopServer(st);
      return toolText(lines.join("\n"), { removed: result.removedTotal, remaining: 0 });
    },
  });

  // ============================================================
  // Commands (human-in-the-loop resume points)
  // ============================================================
  pi.registerCommand("debugmode", {
    description: "Start a Cursor-style runtime-evidence debug loop (usage: /debugmode <bug description>)",
    handler: async (args, ctx) => {
      const desc = (args || "").trim();
      if (!desc) {
        if (ctx.ui) ctx.ui.notify("Usage: /debugmode <bug description (repro steps / error / expected vs actual)>", "warning");
        return;
      }
      const st = getStore(ctx);
      const prev = st.getState();
      if (prev && prev.phase !== "CLEANUP") {
        if (ctx.ui) ctx.ui.notify("An unfinished debug session was found; resetting and starting a new one", "info");
        await stopServer(st);
      }
      st.resetState();
      st.initPhaseState(desc);
      pi.sendMessage(
        {
          customType: "pi-debug-mode",
          content: buildLoopPrompt({ bugDescription: desc, round: 0 }),
          display: true,
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    },
  });

  pi.registerCommand("debugmode-repro-done", {
    description: "Resume point: reproduction finished, let the agent analyze (hard pause A)",
    handler: async (_args, ctx) => {
      const st = getStore(ctx);
      const state = st.getState();
      if (!state) {
        if (ctx.ui) ctx.ui.notify("No active debug session", "warning");
        return;
      }
      const srv = await ensureServer(ctx);
      const round = (state.round || 0) + 1;
      srv.markSession(round);
      st.setState({ round, phase: "ANALYZE" });
      pi.sendMessage(
        {
          customType: "pi-debug-mode",
          content:
            `The user finished reproduction round ${round} (session boundary recorded). ` +
            `Immediately pull this round's logs with debug_collect (session=${round}) and check every hypothesis ` +
            `against its confirmation/refutation signals. With sufficient evidence, state the root cause and make a minimal fix; ` +
            `if evidence is insufficient, go back to INSTRUMENT and add probes.`,
          display: true,
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    },
  });

  pi.registerCommand("debugmode-not-fixed", {
    description: "Resume point: bug still reproduces, go back to instrumentation (do not just try another fix)",
    handler: async (_args, ctx) => {
      const st = getStore(ctx);
      const state = st.getState();
      if (!state) {
        if (ctx.ui) ctx.ui.notify("No active debug session", "warning");
        return;
      }
      st.setState({ phase: "INSTRUMENT" });
      pi.sendMessage(
        {
          customType: "pi-debug-mode",
          content:
            `The user reproduced and reported: not fixed. Discipline: go back to INSTRUMENT, not FIX — ` +
            `add or adjust probes to gather more evidence instead of swapping in another fix attempt. ` +
            `Use debug_collect to diff this round (session=${state.round}) against the previous one for clues.`,
          display: true,
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    },
  });

  pi.registerCommand("debugmode-verified", {
    description: "Resume point: verification passed, let the agent clean up probes and report the final diff (hard pause B)",
    handler: async (_args, ctx) => {
      const st = getStore(ctx);
      const state = st.getState();
      if (!state) {
        if (ctx.ui) ctx.ui.notify("No active debug session", "warning");
        return;
      }
      st.setState({ phase: "CLEANUP" });
      pi.sendMessage(
        {
          customType: "pi-debug-mode",
          content:
            "The user confirmed the fix works. Immediately call debug_cleanup to remove all probes, verify zero residue, " +
            "then report the root-cause explanation plus the minimal fix diff (instrumentation changes must not appear in the final diff).",
          display: true,
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    },
  });

  pi.registerCommand("debugmode-status", {
    description: "Show the current debug loop status",
    handler: async (_args, ctx) => {
      const st = getStore(ctx);
      const text = statusLine(st);
      if (ctx.ui) ctx.ui.notify(text, "info");
      pi.sendMessage({ customType: "pi-debug-mode", content: `[pi-debug] ${text}`, display: false }, {});
    },
  });

  pi.registerCommand("debugmode-abort", {
    description: "Abort the debug loop: remove all probes and reset state",
    handler: async (_args, ctx) => {
      const st = getStore(ctx);
      const result = removeAllProbes(ctx.cwd);
      st.clearProbes();
      await stopServer(st);
      st.resetState();
      if (ctx.ui) ctx.ui.notify(`Debug aborted: ${result.removedTotal} probe line(s) removed, ${result.remaining.length} remaining`, "info");
    },
  });

  // ============================================================
  // Lifecycle
  // ============================================================
  pi.on("session_start", async (_event, ctx) => {
    const st = getStore(ctx);
    const s = st.getState();
    if (s && s.phase && s.phase !== "CLEANUP") {
      if (ctx.ui) ctx.ui.notify(`[pi-debug] resuming an active debug session: ${statusLine(st)}`, "info");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const st = getStore(ctx);
    await stopServer(st);
  });
}
