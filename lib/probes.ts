// Probe generation / insertion / cleanup — sentinel-comment strategy (guide sections 3.1 and 3.3).
// Invariants:
// 1. Probes are strictly additive: brand-new lines are inserted, existing statements are never
//    modified, so cleanup can always be executed mechanically.
// 2. Every inserted probe line carries the sentinel marker [pi-debug:<id>|<hyp>]; cleanup is
//    therefore "delete every line containing the marker", which also works if the registry is lost.
// 3. Probes ship their own transport (browser fetch with keepalive / Node fetch / Python thread +
//    urllib). keepalive matters: many bugs end with a navigation or a crash, and plain logs are lost.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";

export const SENTINEL_PREFIX = "[pi-debug:";
export const SENTINEL_RE = /\[pi-debug:[A-Za-z0-9_-]+\|[^\]]*\]/;

const JS_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"]);

export function detectLang(file) {
  const e = extname(file).toLowerCase();
  if (JS_EXTS.has(e)) return "js";
  if (e === ".py") return "python";
  return null;
}

function genId() {
  return "p" + Math.random().toString(16).slice(2, 6) + Math.random().toString(16).slice(2, 4);
}

function jsProbe({ id, hyp, port, where, capture, sample }) {
  const capSrc = capture.length ? capture.map((n) => `${JSON.stringify(n)}:T(()=>${n})`).join(",") : "";
  const line =
    `;(()=>{try{const T=(f)=>{try{return f()}catch(e){return "<unavailable>"}};` +
    `const C=(globalThis.__piDebugCnt=globalThis.__piDebugCnt||{});` +
    `C[${JSON.stringify(id)}]=(C[${JSON.stringify(id)}]||0)+1;` +
    `if((C[${JSON.stringify(id)}]-1)%${sample}!==0)return;` +
    `fetch("http://127.0.0.1:${port}/probe",{method:"POST",keepalive:true,` +
    `headers:{"content-type":"application/json"},` +
    `body:JSON.stringify({probe:${JSON.stringify(id)},hypothesis:${JSON.stringify(hyp)},` +
    `ts:Date.now(),where:${JSON.stringify(where)},data:{${capSrc}}})}).catch(()=>{})` +
    `}catch(e){}})() ` +
    `// ${SENTINEL_PREFIX}${id}|${hyp}] pi-debug probe (auto-inserted, safe to delete)`;
  return [line];
}

function pythonProbe({ id, hyp, port, where, capture, sample }) {
  const tag = ` # ${SENTINEL_PREFIX}${id}|${hyp}] pi-debug probe (auto-inserted, safe to delete)`;
  const names = JSON.stringify(capture);
  return [
    `try: __piDebugCnt${tag}`,
    `except NameError: __piDebugCnt = {}${tag}`,
    `__piDebugCnt[${JSON.stringify(id)}] = __piDebugCnt.get(${JSON.stringify(id)}, 0) + 1${tag}`,
    `if (__piDebugCnt[${JSON.stringify(id)}] - 1) % ${sample} == 0:${tag}`,
    `    import json as _pdj_${id}, threading as _pdt_${id}, urllib.request as _pdr_${id}${tag}`,
    `    _pd_data_${id} = {}${tag}`,
    `    for _pd_n_${id} in ${names}:${tag}`,
    `        try: _pd_data_${id}[_pd_n_${id}] = eval(_pd_n_${id})${tag}`,
    `        except Exception: _pd_data_${id}[_pd_n_${id}] = None${tag}`,
    `    def _pd_send_${id}():${tag}`,
    `        try: _pdr_${id}.urlopen(_pdr_${id}.Request("http://127.0.0.1:${port}/probe", data=_pdj_${id}.dumps({"probe":${JSON.stringify(id)},"hypothesis":${JSON.stringify(hyp)},"ts":__import__("time").time(),"where":${JSON.stringify(where)},"data":_pd_data_${id}}).encode(), headers={"content-type":"application/json"}), timeout=2)${tag}`,
    `        except Exception: pass${tag}`,
    `    _pdt_${id}.Thread(target=_pd_send_${id}, daemon=True).start()${tag}`,
  ];
}

export function buildProbeCode(opts) {
  const lang = opts.lang || detectLang(opts.file);
  if (lang === "python") return pythonProbe(opts);
  return jsProbe(opts);
}

// Insert probe lines after line N of `file`, or after the first line containing `after`.
// Returns { id, line, where, lang, lines }; throws on invalid input.
export function insertProbe({ cwd, file, hypothesis, capture, sample, lang, note, line, after, port }) {
  const abs = join(cwd, file);
  let raw;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    throw new Error(`File not found or unreadable: ${file}`);
  }
  const detected = lang || detectLang(file);
  if (!detected) {
    throw new Error(`Cannot detect language from extension "${extname(file)}"; pass lang explicitly ("js" or "python")`);
  }

  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);

  let anchorIdx = -1;
  if (after) {
    anchorIdx = lines.findIndex((l) => l.includes(after));
    if (anchorIdx < 0) throw new Error(`Anchor text not found: ${JSON.stringify(after)} (in ${file})`);
  } else if (Number.isInteger(line) && line > 0) {
    if (line > lines.length) throw new Error(`Line number out of range: ${line} > ${lines.length} (${file})`);
    anchorIdx = line - 1;
  } else {
    throw new Error("Provide either line (1-based) or after (anchor text)");
  }

  const indent = (lines[anchorIdx].match(/^[ \t]*/) || [""])[0];
  const id = genId();
  const where = `${file}:${anchorIdx + 1}${note ? " " + note : ""}`;
  const codeLines = buildProbeCode({
    id,
    hyp: hypothesis,
    port,
    where,
    capture: capture || [],
    sample: Math.max(1, sample || 1),
    lang: detected,
    file,
  });

  const indented = codeLines.map((l) => indent + l);
  lines.splice(anchorIdx + 1, 0, ...indented);
  writeFileSync(abs, lines.join(eol), "utf8");

  return {
    id,
    hypothesis,
    file,
    anchorLine: anchorIdx + 1,
    insertedLines: indented.length,
    where,
    lang: detected,
    capture: capture || [],
    sample: Math.max(1, sample || 1),
  };
}

// Recursively scan the workspace for sentinel lines (cleanup fallback + residue verification).
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".pi-debug", ".omp", ".pi", "dist", "build", "out",
  ".next", "coverage", "__pycache__", ".venv", "venv", "target", ".cache",
]);
const SKIP_FILES = new Set(["package-lock.json", "bun.lockb", "pnpm-lock.yaml", "yarn.lock"]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function scanSentinels(cwd) {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 12) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(p, depth + 1);
        continue;
      }
      if (!ent.isFile() || SKIP_FILES.has(ent.name)) continue;
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.size > MAX_FILE_BYTES) continue;
      let content;
      try {
        content = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      if (!content.includes(SENTINEL_PREFIX)) continue;
      const lines = content.split(/\r?\n/);
      lines.forEach((l, i) => {
        if (SENTINEL_RE.test(l)) {
          hits.push({ file: relative(cwd, p).split("\\").join("/"), line: i + 1, text: l.trim().slice(0, 160) });
        }
      });
    }
  };
  walk(cwd, 0);
  return hits;
}

// Remove every sentinel line in the workspace (including orphaned probes missing from the registry).
// Returns { removedByFile: [{file, removed}], removedTotal, remaining }.
export function removeAllProbes(cwd) {
  const hits = scanSentinels(cwd);
  const byFile = new Map();
  for (const h of hits) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file).push(h.line);
  }
  const removedByFile = [];
  let removedTotal = 0;
  for (const [file, lineNos] of byFile) {
    const abs = join(cwd, file);
    let raw;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const before = raw.split(/\r?\n/);
    const removedSet = new Set(lineNos);
    const after = before.filter((_, i) => !removedSet.has(i + 1));
    writeFileSync(abs, after.join(eol), "utf8");
    removedByFile.push({ file, removed: lineNos.length });
    removedTotal += lineNos.length;
  }
  const remaining = scanSentinels(cwd);
  return { removedByFile, removedTotal, remaining };
}
