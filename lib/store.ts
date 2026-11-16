// Session state and probe registry for .pi-debug/ — works on pi and oh-my-pi with zero external deps.
// Design notes:
// - All state lives under <cwd>/.pi-debug/ (state.json / probes.json / server.json / logs.jsonl),
//   so it survives a restart and behaves identically on both hosts.
// - State machine: DESCRIBE → HYPOTHESIZE → INSTRUMENT → REPRODUCE → ANALYZE → FIX → VERIFY → CLEANUP
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export const PHASES = [
  "DESCRIBE",
  "HYPOTHESIZE",
  "INSTRUMENT",
  "REPRODUCE",
  "ANALYZE",
  "FIX",
  "VERIFY",
  "CLEANUP",
];

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export class DebugStore {
  constructor(cwd) {
    this.cwd = cwd;
    this.dir = join(cwd, ".pi-debug");
    this.stateFile = join(this.dir, "state.json");
    this.probesFile = join(this.dir, "probes.json");
    this.serverFile = join(this.dir, "server.json");
    this.logsFile = join(this.dir, "logs.jsonl");
  }

  // ---------- state machine ----------
  getState() {
    return readJson(this.stateFile, null);
  }

  initPhaseState(bugDescription) {
    const state = {
      version: 1,
      phase: "DESCRIBE",
      round: 0,
      bugDescription: bugDescription || "",
      hypotheses: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeJson(this.stateFile, state);
    return state;
  }

  setState(patch) {
    const prev = this.getState() || this.initPhaseState("");
    const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    writeJson(this.stateFile, next);
    return next;
  }

  advancePhase() {
    const cur = this.getState();
    if (!cur) return null;
    const idx = PHASES.indexOf(cur.phase);
    if (idx < 0 || idx >= PHASES.length - 1) return cur;
    return this.setState({ phase: PHASES[idx + 1] });
  }

  resetState() {
    for (const f of [this.stateFile, this.probesFile, this.serverFile, this.logsFile]) {
      try {
        unlinkSync(f);
      } catch {
        /* absent files are fine */
      }
    }
  }

  // ---------- hypotheses ----------
  // h: { id?, statement, confirm?, refute?, probePlan? }; ids auto-assign as h1/h2/... when omitted.
  addHypothesis(h) {
    const state = this.getState() || this.initPhaseState("");
    state.hypotheses = state.hypotheses || [];
    let id = h.id;
    if (!id) {
      let n = state.hypotheses.length + 1;
      id = "h" + n;
      while (state.hypotheses.some((x) => x.id === id)) {
        n += 1;
        id = "h" + n;
      }
    }
    const existing = state.hypotheses.find((x) => x.id === id);
    if (existing) {
      Object.assign(existing, h, { id });
    } else {
      state.hypotheses.push({
        id,
        statement: h.statement || "",
        confirm: h.confirm || "",
        refute: h.refute || "",
        probePlan: h.probePlan || "",
      });
    }
    this.setState({ hypotheses: state.hypotheses });
    return id;
  }

  getHypothesis(id) {
    const state = this.getState();
    return state && state.hypotheses ? state.hypotheses.find((h) => h.id === id) : null;
  }

  // ---------- probe registry ----------
  getProbes() {
    const data = readJson(this.probesFile, { probes: [] });
    return data.probes || [];
  }

  addProbe(p) {
    const probes = this.getProbes();
    probes.push(p);
    writeJson(this.probesFile, { probes });
    return p;
  }

  clearProbes() {
    writeJson(this.probesFile, { probes: [] });
  }

  // ---------- server info ----------
  readServerInfo() {
    return readJson(this.serverFile, null);
  }

  writeServerInfo(info) {
    writeJson(this.serverFile, info);
  }

  clearServerInfo() {
    try {
      unlinkSync(this.serverFile);
    } catch {
      /* absent file is fine */
    }
  }

  appendLogLine(record) {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.logsFile, JSON.stringify(record) + "\n", { flag: "a" });
  }

  rewriteLogs(records) {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.logsFile, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""), "utf8");
  }

  readLogs() {
    const lines = [];
    try {
      const raw = readFileSync(this.logsFile, "utf8");
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          lines.push(JSON.parse(t));
        } catch {
          /* skip malformed lines */
        }
      }
    } catch {
      /* no logs yet */
    }
    return lines;
  }
}
