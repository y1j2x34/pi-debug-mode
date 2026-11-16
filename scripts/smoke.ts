// Smoke test: mocks the host API (registerTool / registerCommand / on / sendMessage) and
// exercises the full debug-loop pipeline. Run with: node scripts/smoke.ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const extPath = new URL("../extensions/index.ts", import.meta.url).pathname;
const { default: register } = await import(extPath);

// ---------- mock host ----------
const tools = {};
const commands = {};
const eventHandlers = {};
const sentMessages = [];

const pi = {
  registerTool: (def) => (tools[def.name] = def),
  registerCommand: (name, opts) => (commands[name] = opts),
  on: (ev, handler) => ((eventHandlers[ev] = eventHandlers[ev] || []).push(handler), () => {}),
  sendMessage: (msg, opts) => sentMessages.push({ msg, opts }),
};

register(pi);

const must = (cond, label) => {
  if (!cond) {
    console.error("FAIL:", label);
    process.exit(1);
  }
  console.log("ok  -", label);
};

// ---------- temporary project ----------
const cwd = mkdtempSync(join(tmpdir(), "pi-debug-smoke-"));
mkdirSync(join(cwd, "src", "auth"), { recursive: true });
const jsFile = join(cwd, "src", "auth", "session.ts");
writeFileSync(jsFile, `export function onRefresh(userId, tokenAge) {\n  const pending = [1, 2, 3];\n  return { userId, tokenAge, queueLen: pending.length };\n}\n`);
writeFileSync(join(cwd, "script.py"), `def refresh(user_id, token_age):\n    pending = [1, 2, 3]\n    return {"user_id": user_id, "queue": len(pending)}\n`);
writeFileSync(join(cwd, "readme.md"), "# hello\n");

const ctx = { cwd, ui: { notify: () => {} } };
const exec = async (name, params) => {
  const res = await tools[name].execute("tc1", params, undefined, undefined, ctx);
  return res;
};

// ---------- 1. tool / command registration ----------
for (const t of ["debug_state", "debug_instrument", "debug_server", "debug_collect", "debug_cleanup"]) {
  must(tools[t], `registers tool ${t}`);
}
for (const c of ["debugmode", "debugmode-repro-done", "debugmode-not-fixed", "debugmode-verified", "debugmode-status", "debugmode-abort"]) {
  must(commands[c], `registers command /${c}`);
}

// ---------- 2. /debugmode injects the loop prompt ----------
await commands["debugmode"].handler("queue leak while refreshing tokens", ctx);
must(sentMessages.length === 1 && sentMessages[0].msg.customType === "pi-debug-mode", "/debugmode injects loop prompt");
must(sentMessages[0].opts.triggerTurn === true, "/debugmode triggers an agent turn");
must(sentMessages[0].msg.content.includes("PAUSE A"), "prompt contains hard pause A");

// ---------- 3. state machine: guard → hypothesis registration → advance ----------
let r = await exec("debug_instrument", { file: "src/auth/session.ts", hypothesis: "h1", after: "const pending" });
must(r.isError === true, "instrumentation rejected before 3 hypotheses exist");
await exec("debug_state", { action: "hypothesis", statement: "tokenAge is computed incorrectly", confirm_signal: "probe sees tokenAge<0", refute_signal: "tokenAge looks sane" });
await exec("debug_state", { action: "hypothesis", statement: "pending queue is never drained", confirm_signal: "queueLen keeps growing", refute_signal: "queueLen stays flat" });
r = await exec("debug_state", { action: "hypothesis", statement: "race: concurrent refreshes overwrite each other", confirm_signal: "two refreshes in the same tick", refute_signal: "refreshes are serialized" });
must(r.content[0].text.includes("Enough hypotheses"), "third hypothesis marks the quota as met");
r = await exec("debug_state", { action: "advance" });
must(r.content[0].text.includes("HYPOTHESIZE"), "advance → HYPOTHESIZE");
r = await exec("debug_state", { action: "advance" });
must(r.content[0].text.includes("INSTRUMENT"), "advance → INSTRUMENT");

// ---------- 4. instrumentation (JS by line / JS by anchor / Python) ----------
r = await exec("debug_instrument", { file: "src/auth/session.ts", hypothesis: "h1", line: 1, capture: ["userId", "tokenAge"], note: "onRefresh entry" });
must(!r.isError && r.content[0].text.includes("inserted at"), "JS probe inserted");
r = await exec("debug_instrument", { file: "src/auth/session.ts", hypothesis: "h2", after: "return {", capture: ["queueLen"], sample: 5 });
must(!r.isError, "JS probe inserted by anchor with sampling");
r = await exec("debug_instrument", { file: "script.py", hypothesis: "h3", line: 2, capture: ["user_id"] });
must(!r.isError, "Python probe inserted");
r = await exec("debug_instrument", { file: "readme.md", hypothesis: "h1", line: 1 });
must(r.isError === true, "unsupported language rejected");
r = await exec("debug_instrument", { file: "src/auth/session.ts", hypothesis: "hX", line: 999 });
must(r.isError === true, "out-of-range line rejected");

const jsAfter = readFileSync(jsFile, "utf8");
const pyAfter = readFileSync(join(cwd, "script.py"), "utf8");
must(jsAfter.split("\n").length === 7, "JS file stays additive (3 original + 2 probe lines + trailing newline)");
must(!jsAfter.split("\n").some((l, i) => i < 3 && l !== readFileSync(jsFile, "utf8").split("\n")[i] && !l.includes("[pi-debug:")), "original code lines untouched");
must(pyAfter.includes("urllib.request"), "Python probe carries its own transport");
must(pyAfter.split("\n").filter((l) => l.includes("[pi-debug:")).length === 13, "every Python probe line carries the sentinel");

// ---------- 5. server accepts data ----------
const saved = JSON.parse(readFileSync(join(cwd, ".pi-debug", "server.json"), "utf8"));
must(saved.port > 0, `server started (port ${saved.port})`);
const health = await (await fetch(`http://127.0.0.1:${saved.port}/health`)).json();
must(health.kind === "pi-debug-mode" && health.cwd === cwd, "/health check passes");

const postProbe = (body) =>
  fetch(`http://127.0.0.1:${saved.port}/probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
for (let i = 0; i < 3; i++) await postProbe({ probe: "paaa1", hypothesis: "h1", where: "src/auth/session.ts:2 onRefresh", data: { userId: 7, tokenAge: -1 } });
await postProbe({ probe: "pbbb2", hypothesis: "h2", where: "src/auth/session.ts:4", data: { queueLen: 99 } });

// CORS preflight (the path every browser probe takes)
const opt = await fetch(`http://127.0.0.1:${saved.port}/probe`, { method: "OPTIONS" });
must(opt.status === 204 && opt.headers.get("access-control-allow-origin") === "*", "CORS preflight 204 + ACAO:*");

// ---------- 6. collect aggregation ----------
r = await exec("debug_collect", { hypothesis: "h1" });
must(r.content[0].text.includes("3 hits") && r.content[0].text.includes("tokenAge"), "collect filters by hypothesis and aggregates");
r = await exec("debug_collect", { probe: "pbbb2" });
must(r.content[0].text.includes("queueLen"), "collect filters by probe");
r = await exec("debug_collect", { session: 99 });
must(r.content[0].text.includes("No matching probe data"), "collect reports no match for empty round");

// ---------- 7. resume point: reproduction done → session boundary ----------
await commands["debugmode-repro-done"].handler("", ctx);
must(sentMessages[sentMessages.length - 1].msg.content.includes("round 1"), "/debugmode-repro-done injects the continue instruction");
r = await exec("debug_collect", { session: 1 });
must(r.content[0].text.includes("hits"), "session=1 data queryable after the boundary");

// ---------- 8. cleanup restores the workspace ----------
await commands["debugmode-verified"].handler("", ctx);
r = await exec("debug_cleanup", {});
must(!r.isError && r.content[0].text.includes("Residue check passed"), "cleanup removes all probes with zero residue");
must(readFileSync(jsFile, "utf8") === `export function onRefresh(userId, tokenAge) {\n  const pending = [1, 2, 3];\n  return { userId, tokenAge, queueLen: pending.length };\n}\n`, "JS file restored to its pre-instrumentation content");
must(readFileSync(join(cwd, "script.py"), "utf8").split("\n").filter((l) => l.includes("[pi-debug:")).length === 0, "all Python probes removed");

// ---------- 9. abort path ----------
await commands["debugmode-abort"].handler("", ctx);
console.log("\nAll smoke tests passed");
rmSync(cwd, { recursive: true, force: true });
process.exit(0);
