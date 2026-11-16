// Local probe log server — 127.0.0.1, random port, zero external deps (node:http).
// Responsibilities (guide section 3.2):
// - POST /probe  accept probe payloads (single JSON or NDJSON), append to .pi-debug/logs.jsonl
// - GET  /health health check (returns kind + cwd so parallel sessions can identify port ownership)
// - markSession  record a "reproduction round" boundary so rounds can be compared
//                (the verification phase needs before-fix vs after-fix evidence)
// CORS must be open: probes running inside a browser page are cross-origin requests
// (page origin != 127.0.0.1:port).
import { createServer } from "node:http";

const MAX_BODY = 1024 * 1024; // 1MB

export class DebugServer {
  constructor(store, preferredPort) {
    this.store = store;
    this.preferredPort = preferredPort || 0;
    this.port = 0;
    this.httpServer = null;
    this.running = false;
    this.session = 0;
  }

  // Resolves true when the server is up (also true when an existing instance was reused).
  async start() {
    if (this.running) return true;
    const saved = this.store.readServerInfo();
    this.session = saved && saved.session ? saved.session : 0;

    const health = await this.probeExisting(this.preferredPort);
    if (health && health.kind === "pi-debug-mode" && health.cwd === this.store.cwd) {
      // A live instance already serves this project (e.g. pi and omp sessions side by side): reuse it.
      this.port = this.preferredPort;
      this.session = health.session || this.session;
      this.running = true;
      this.persist();
      return true;
    }

    this.httpServer = createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        if (err && err.code === "EADDRINUSE") {
          // Port taken: fall back to a random port so parallel sessions never collide.
          this.httpServer = createServer((req, res) => this.handle(req, res));
          this.httpServer.listen(0, "127.0.0.1", () => resolve());
          this.httpServer.on("error", reject);
        } else {
          reject(err);
        }
      };
      this.httpServer.once("error", onError);
      if (this.preferredPort > 0) {
        this.httpServer.listen(this.preferredPort, "127.0.0.1", () => resolve());
      } else {
        this.httpServer.listen(0, "127.0.0.1", () => resolve());
      }
    });
    this.port = this.httpServer.address().port;
    this.running = true;
    this.persist();
    return true;
  }

  persist() {
    this.store.writeServerInfo({ port: this.port, session: this.session, startedAt: new Date().toISOString() });
  }

  probeExisting(port) {
    if (!port) return Promise.resolve(null);
    return fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(600) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j)
      .catch(() => null);
  }

  handle(req, res) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/health")) {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      res.end(JSON.stringify({ kind: "pi-debug-mode", cwd: this.store.cwd, port: this.port, session: this.session }));
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/probe")) {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        let accepted = 0;
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          // Accept both a single JSON object and an NDJSON batch flush.
          for (const line of text.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            let rec;
            try {
              rec = JSON.parse(t);
            } catch {
              continue;
            }
            if (Array.isArray(rec)) {
              for (const r of rec) this.acceptRecord(r);
              accepted += rec.length;
            } else {
              this.acceptRecord(rec);
              accepted += 1;
            }
          }
        } catch {
          /* drop malformed payloads; probes fail silently so business code is never affected */
        }
        res.writeHead(200, { "content-type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true, accepted }));
      });
      return;
    }

    res.writeHead(404, cors);
    res.end("not found");
  }

  acceptRecord(rec) {
    if (!rec || typeof rec !== "object") return;
    const record = {
      ts: rec.ts || Date.now(),
      // Round number is unknown at probe time (reproduction happens before the boundary is
      // recorded), so records start as "pending" and are backfilled by markSession().
      session: rec.session || "pending",
      probe: String(rec.probe || "unknown"),
      hypothesis: String(rec.hypothesis || "unknown"),
      where: String(rec.where || ""),
      data: rec.data === undefined ? null : rec.data,
    };
    this.store.appendLogLine(record);
  }

  // Reproduction boundary: called once per finished reproduction round (/debugmode-repro-done).
  // Probe records are written as "pending" because the round is unknown while the user reproduces;
  // this backfills them with the actual round number.
  markSession(round) {
    const records = this.store.readLogs();
    const rewritten = records.map((r) =>
      r && r.type !== "boundary" && r.session === "pending" ? { ...r, session: round } : r,
    );
    this.store.rewriteLogs(rewritten);
    this.store.appendLogLine({ type: "boundary", ts: Date.now(), session: round });
    this.persist();
    return round;
  }

  stop() {
    if (this.httpServer) {
      try {
        this.httpServer.close();
      } catch {
        /* ignore */
      }
    }
    this.httpServer = null;
    this.running = false;
  }
}
