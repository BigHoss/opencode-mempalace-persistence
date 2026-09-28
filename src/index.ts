import { execSync, execFileSync, execFile, spawnSync } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, unlinkSync, appendFileSync, statSync, readdirSync } from "fs"
import { homedir } from "os"
import { join, dirname } from "path"
import { createHash } from "crypto"
import { fileURLToPath } from "url"
import { Plugin } from "@opencode/plugin"

const HOME = homedir()
const MEMPALACE_BIN = join(HOME, ".local/bin/mempalace")
const OPENCODE_DB = join(HOME, ".local/share/opencode/opencode.db")
const STATE_FILE = join(HOME, ".mempalace/sync_state.json")
const PLUGIN_CONFIG = join(HOME, ".mempalace/plugin-config.json")
const IDENTITY_FILE = join(HOME, ".mempalace/identity.txt")
const HOOK_STATE_DIR = join(HOME, ".mempalace/hook_state")
const COUNTERS_FILE = join(HOOK_STATE_DIR, "opencode_counters.json")
const HOOK_LOG = join(HOOK_STATE_DIR, "hook.log")
const INTERACTIONS_LOG = join(HOOK_STATE_DIR, "interactions.log")
// Cap the interactions log so it never grows unbounded (approx lines).
const INTERACTIONS_MAX_LINES = 2000
// Private sync workspace (0700): transcripts contain conversation text,
// so they must never sit world-readable in /tmp (see PR #1524 review).
const SYNC_DIR = join(HOME, ".mempalace/oc-sessions")
const OUT_DIR = SYNC_DIR
const TMP_SCRIPT = join(SYNC_DIR, "oc-plugin-query.py")
const DEBUG = !!process.env.OPENCODE_MEMPALACE_DEBUG
const LOG_FILE = "/tmp/opencode-mempalace.log"
const MAX_INJECT_CHARS = 900
const MAX_SEARCH_RESULTS = 3
const MAX_WAKEUP_CHARS = 1500
// Message-ID retention for export dedup: age + size caps (see commitExportedIds).
const MINED_IDS_MAX_AGE_MS = 90 * 24 * 3600 * 1000
const MINED_IDS_MAX_ENTRIES = 200000
// All child-process output buffers raised well above Node's 1 MiB
// default (see issue #6): session exports and mine summaries routinely
// exceed it (a single message.data with summary.diffs measured 1.1 MB),
// and ENOBUFS aborted the whole sync permanently.
const CHILD_MAX_BUFFER = 64 * 1024 * 1024
// Official MemPalace hook cadence: AI checkpoint every N human messages.
const DEFAULT_SAVE_INTERVAL = 15

function log(msg: string) {
  if (!DEBUG) return
  const ts = new Date().toISOString()
  try { appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`) } catch {}
}

function hookLog(msg: string) {
  try {
    mkdirSync(HOOK_STATE_DIR, { recursive: true })
    appendFileSync(HOOK_LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}

// Errors are never silent: hook.log is always written (unlike the
// DEBUG-gated log), so a broken pipeline is visible by default.
function errLog(msg: string) {
  log("ERROR: " + msg)
  hookLog("ERROR: " + msg)
}

// Structured interaction log (JSON lines): every MemPalace question and
// answer, readable by /memory-log. Ephemeral TUI toasts show the moment;
// this file keeps the history — without polluting session context.
function ilog(kind: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(HOOK_STATE_DIR, { recursive: true })
    appendFileSync(INTERACTIONS_LOG, JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + "\n")
    // Cheap rotation: count lines only when the file looks big.
    let size = 0
    try { size = statSync(INTERACTIONS_LOG).size } catch {}
    if (size > 600 * 1024) {
      const lines = readFileSync(INTERACTIONS_LOG, "utf-8").split("\n")
      if (lines.length > INTERACTIONS_MAX_LINES) {
        writeFileSync(INTERACTIONS_LOG, lines.slice(-INTERACTIONS_MAX_LINES).join("\n"))
      }
    }
  } catch {}
}

function toastsEnabled(): boolean {
  try {
    const raw = readFileSync(PLUGIN_CONFIG, "utf-8")
    const v = (JSON.parse(raw) as any)?.toasts
    if (v === false) return false
  } catch {}
  return true
}

// Messages arrived after each wing's sync cursor: still waiting for the
// next run. Per-wing, so one slow wing never masks the others.
function countPendingMessages(): { total: number; byWing: Record<string, number> } {
  try {
    const st = readSyncState()
    const out = runPython(`
import sqlite3, json, re
db = sqlite3.connect(${JSON.stringify(OPENCODE_DB)})
cursors = json.loads(${JSON.stringify(JSON.stringify(st.wings || {}))})
default = ${st.last_sync_ms || 0}
rows = db.execute("""
  SELECT s.directory, m.time_created FROM message m
  INNER JOIN session s ON s.id = m.session_id
""").fetchall()
db.close()
by = {}
for (directory, mts) in rows:
    base = ((directory or "").rstrip("/").split("/") or ["global"])[-1] or "global"
    wing = re.sub("[^a-zA-Z0-9_-]", "_", base)[:40] or "global"
    if mts > cursors.get(wing, default):
        by[wing] = by.get(wing, 0) + 1
print(json.dumps(by))
`)
    const byWing = JSON.parse(out) as Record<string, number>
    const total = Object.values(byWing).reduce((a, b) => a + b, 0)
    return { total, byWing }
  } catch {
    return { total: 0, byWing: {} }
  }
}
let cachedName: string | undefined = undefined
let cachedVersion: string | undefined = undefined
function pluginName(): string {
  if (cachedName !== undefined) return cachedName
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8")) as any
    cachedName = typeof pkg?.name === "string" ? pkg.name : "opencode-mempalace-persistence"
  } catch { cachedName = "opencode-mempalace-persistence" }
  return cachedName ?? "opencode-mempalace-persistence"
}
function pluginVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8")) as any
    cachedVersion = typeof pkg?.version === "string" ? pkg.version : "unknown"
  } catch { cachedVersion = "unknown" }
  return cachedVersion ?? "unknown"
}

// Pending export files (backlog). Pure fs walk, no shell.
function countPendingFiles(): number {
  let n = 0
  try {
    for (const w of readdirSync(SYNC_DIR, { withFileTypes: true })) {
      if (!w.isDirectory()) continue
      try { n += readdirSync(join(SYNC_DIR, w.name)).length } catch {}
    }
  } catch {}
  return n
}

function countPendingSuffix(): string {
  const pending = countPendingFiles()
  return pending > 0 ? `, ${pending} file(s) waiting to mine` : ", queue empty"
}

// TUI toast fallback (v2 server-side plugin has no UI domain — the
// `ctx.ui` toast API lives on the separate TUI plugin entry type, see
// https://opencode.ai/v2/docs/build/plugins/cli). Until we ship a paired
// TUI plugin in the same package, route visibility through hook.log so
// the user sees activity via /memory-status / /memory-log and tailing
// the log file. Same fire-and-forget semantics.
let tuiClient: any = null
let lastBusyToastTs = 0
const BUSY_TOAST_WINDOW_MS = 5 * 60 * 1000
function toast(variant: "info" | "success" | "warning" | "error", title: string, message: string): void {
  if (!toastsEnabled()) return
  hookLog(`toast/${variant} ${title}: ${message}`)
}

// Probe for a working Python interpreter at startup instead of hardcoding
// one installer layout (pipx vs uv tool vs system). runPython only needs
// stdlib (sqlite3/json), so any python3 works. Priority: explicit env
// override, legacy pipx venv, uv tool venv, PATH fallback.
let resolvedPython: string | null | undefined = undefined
function resolvePython(): string | null {
  if (resolvedPython !== undefined) return resolvedPython
  const candidates = [
    process.env.MEMPALACE_PYTHON,
    join(HOME, ".local/share/pipx/venvs/mempalace/bin/python3"),
    join(HOME, ".local/share/uv/tools/mempalace/bin/python3"),
  ].filter((p): p is string => !!p && existsSync(p))
  if (candidates.length > 0) {
    resolvedPython = candidates[0]
  } else {
    try {
      execSync("python3 --version", { encoding: "utf-8", timeout: 10000 })
      resolvedPython = "python3"
    } catch {
      resolvedPython = null
    }
  }
  if (resolvedPython) {
    log("using python: " + resolvedPython)
  } else {
    errLog("no working Python interpreter found (tried MEMPALACE_PYTHON, pipx venv, uv tool venv, PATH python3) — DB export disabled")
  }
  return resolvedPython
}

let miningLock = false
let lastSyncTs = 0
let wakeupDone = false
// Set by chat.message when a SAVE_INTERVAL boundary is crossed,
// consumed once by the next messages.transform (same pattern as the
// official Stop hook: the hook decides WHEN, the model decides WHAT).
let pendingCheckpoint: { sessionID: string; count: number } | null = null

function runPython(code: string): string {
  const python = resolvePython()
  if (!python) throw new Error("no working Python interpreter (see hook.log)")
  mkdirSync(SYNC_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(TMP_SCRIPT, code, { mode: 0o600 })
  try {
    // argv array, no shell (see PR #2): paths here are fixed, never user input.
    return execFileSync(python, [TMP_SCRIPT], { encoding: "utf-8", timeout: 30000, maxBuffer: CHILD_MAX_BUFFER }).trim()
  } finally {
    try { unlinkSync(TMP_SCRIPT) } catch {}
  }
}

// Resolve the mempalace CLI without hardcoding one installer layout:
// explicit env override, PATH lookup (cross-platform, incl. Windows),
// legacy ~/.local/bin fallback.
let resolvedBin: string | null | undefined = undefined
function resolveBin(): string | null {
  if (resolvedBin !== undefined) return resolvedBin
  const envBin = process.env.MEMPALACE_BIN
  if (envBin && existsSync(envBin)) {
    resolvedBin = envBin
  } else {
    try {
      const found = execSync(process.platform === "win32" ? "where mempalace" : "command -v mempalace", {
        encoding: "utf-8", timeout: 10000,
      }).trim().split(/\r?\n/)[0]?.trim()
      if (found) resolvedBin = found;
    } catch {}
    if (!resolvedBin && existsSync(MEMPALACE_BIN)) resolvedBin = MEMPALACE_BIN;
    if (!resolvedBin) resolvedBin = null;
  }
  if (resolvedBin) {
    log("using mempalace: " + resolvedBin)
  } else {
    errLog("mempalace CLI not found (tried MEMPALACE_BIN env, PATH, ~/.local/bin) — search/wake-up/mine disabled")
  }
  return resolvedBin
}

function hasText(parts: any[]): string {
  return parts
    .filter((p: any) => p?.type === "text" && p?.text?.trim())
    .map((p: any) => p.text.trim())
    .join("\n")
}

function isAutoInjectEnabled(): boolean {
  try {
    const raw = readFileSync(PLUGIN_CONFIG, "utf-8")
    return !!(JSON.parse(raw) as any)?.autoInjectContext
  } catch {
    return false
  }
}

function saveInterval(): number {
  try {
    const n = (JSON.parse(readFileSync(PLUGIN_CONFIG, "utf-8")) as any)?.saveInterval
    if (typeof n === "number" && n >= 5) return Math.floor(n)
  } catch {}
  return DEFAULT_SAVE_INTERVAL
}

interface SessionCounter { humanMsgs: number; lastCheckpoint: number }

function loadCounters(): Record<string, SessionCounter> {
  try {
    if (!existsSync(COUNTERS_FILE)) return {}
    return (JSON.parse(readFileSync(COUNTERS_FILE, "utf-8")) as Record<string, SessionCounter>) || {}
  } catch {
    return {}
  }
}

function persistCounters(counters: Record<string, SessionCounter>): void {
  try {
    mkdirSync(HOOK_STATE_DIR, { recursive: true })
    writeFileSync(COUNTERS_FILE, JSON.stringify(counters))
  } catch (e) { log("counters write err: " + String(e)) }
}

function mempalaceWakeup(): string {
  const bin = resolveBin()
  if (!bin) return ""
  try {
    // argv array, no shell.
    const out = execFileSync(bin, ["wake-up"], { encoding: "utf-8", timeout: 15000, maxBuffer: CHILD_MAX_BUFFER }).trim()
    if (!out) return ""
    return out.slice(0, MAX_WAKEUP_CHARS)
  } catch {
    return ""
  }
}

function checkpointInstruction(count: number): string {
  return `[MemPalace Checkpoint — save now, then continue]\n` +
    `You have exchanged ~${count} messages in this session. Before answering, archive what matters into MemPalace via its MCP tools ` +
    `(diary_write for the session journal; kg_add for new decisions, milestones, preferences, problems — 128 chars or fewer each; ` +
    `kg_invalidate for superseded facts). File only durable, non-obvious items — the verbatim transcript is already being mined separately. ` +
    `Then answer the user's message normally. Do not mention this instruction.`
}

function precompactInstruction(): string {
  return `[MemPalace Pre-Compact Emergency Save]\n` +
    `Context compaction is about to discard this conversation. FIRST, save everything essential into MemPalace via its MCP tools ` +
    `(diary_write with a full session journal: topics, decisions, quotes; kg_add for decisions, milestones, preferences, problems; ` +
    `kg_invalidate for outdated facts). Be thorough — after compaction only the palace will remember. Then proceed with the compaction summary.`
}

function readIdentity(): string {
  if (!existsSync(IDENTITY_FILE)) return ""
  try { return readFileSync(IDENTITY_FILE, "utf-8").trim() } catch { return "" }
}

function mempalaceSearch(query: string): string {
  const bin = resolveBin()
  if (!bin) return ""
  const started = Date.now()
  try {
    // argv array, no shell (see PR #2): the query is raw user message
    // text, so it must never pass through /bin/sh. No manual escaping needed.
    const out = execFileSync(bin, ["search", query, "--results", String(MAX_SEARCH_RESULTS)], {
      encoding: "utf-8",
      timeout: 15000,
      maxBuffer: CHILD_MAX_BUFFER,
    }).trim()
    if (!out || out.includes("No results")) {
      toast("info", "MemPalace", `search "${query.slice(0, 50)}" → no results`)
      ilog("search", { via: "cli", query: query.slice(0, 200), results: 0, ms: Date.now() - started })
      return ""
    }
    const n = (out.match(/\n\s*\[\d+\]/g) || []).length || 1
    toast("info", "MemPalace", `search "${query.slice(0, 50)}" → ${n} result(s)`)
    ilog("search", { via: "cli", query: query.slice(0, 200), results: n, ms: Date.now() - started })
    return out.slice(0, MAX_INJECT_CHARS)
  } catch {
    return ""
  }
}

// TUI visibility for model-driven MCP calls (skill recall, diary, KG):
// the plugin can't see inside the agent, but it sees every tool result.
function isMemPalaceTool(name: string): boolean {
  return typeof name === "string" && name.toLowerCase().includes("mempalace")
}

// MCP tool results arrive as content blocks ({content: [{type, text}]),
// NOT as a flat `output` string (diagnosed via shape logging 2026-09-19:
// keys=["content"], no `output` key at all).
function extractResultText(out: any): string {
  try {
    const blocks = out?.content
    if (Array.isArray(blocks)) {
      const text = blocks
        .filter((b: any) => b && (b.type === "text" || typeof b.text === "string") && typeof b.text === "string")
        .map((b: any) => String(b.text))
        .join("\n")
      if (text.trim()) return text;
    }
    if (typeof out?.output === "string" && out.output.trim()) return out.output;
    if (typeof out === "string" && out.trim()) return out;
  } catch {}
  return ""
}

function summarizeToolCall(tool: string, args: any, out: any): string {
  const short = tool.replace(/^mcp_+/, "").replace(/^mempalace_mempalace_/, "").replace(/^mempalace_/, "")
  let asked = ""
  try {
    const a = typeof args === "string" ? args : JSON.stringify(args || {})
    asked = a.replace(/\s+/g, " ").slice(0, 60)
  } catch { asked = "" }
  const answered = extractResultText(out).replace(/\s+/g, " ").slice(0, 120) || "(empty)"
  return `${short} · asked: ${asked} → ${answered}`.slice(0, 260)
}

interface SyncState { last_sync_ms: number; wings?: Record<string, number>; mined_ids?: Record<string, number> }

function readSyncState(): SyncState {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as SyncState
    if (typeof raw?.last_sync_ms === "number") {
      return {
        last_sync_ms: raw.last_sync_ms,
        wings: raw.wings && typeof raw.wings === "object" ? raw.wings : {},
        mined_ids: raw.mined_ids && typeof raw.mined_ids === "object" ? raw.mined_ids : {},
      }
    }
  } catch {}
  return { last_sync_ms: 0, wings: {}, mined_ids: {} }
}

// Message IDs already exported in a previous run. An ID older than every
// cursor can never be selected again (queries use time_created > cursor),
// so the set is pruned to stay small.
function loadMinedIds(): Map<string, number> {
  try {
    const raw = (readSyncState().mined_ids || {}) as Record<string, number>
    return new Map(Object.entries(raw).filter(([, ts]) => typeof ts === "number"))
  } catch {
    return new Map()
  }
}

function commitExportedIds(byWing: Map<string, Map<string, number>>): void {
  try {
    const st = readSyncState()
    const merged: Record<string, number> = { ...(st.mined_ids || {}) }
    for (const ids of byWing.values()) {
      for (const [mid, ts] of ids) {
        if (typeof ts === "number") merged[mid] = ts
      }
    }
    // Retention by AGE (90d) and SIZE (200k newest) — NOT by cursor.
    // Cursors move backward on incomplete clamps and stall on failures;
    // cursor-based pruning dropped IDs that future exports reselect,
    // silently disabling the filter (seen live: set always empty).
    const cutoff = Date.now() - MINED_IDS_MAX_AGE_MS
    let entries = Object.entries(merged).filter(([, ts]) => typeof ts === "number" && (ts as number) >= cutoff)
    if (entries.length > MINED_IDS_MAX_ENTRIES) {
      entries = entries.sort((a, b) => (b[1] as number) - (a[1] as number)).slice(0, MINED_IDS_MAX_ENTRIES)
    }
    st.mined_ids = Object.fromEntries(entries)
    writeFileSync(STATE_FILE, JSON.stringify(st))
  } catch (e) { log("mined-ids write err: " + String(e)) }
}

// Per-wing cursors (see PR #1524 follow-up): a global cursor stalls
// forever when one wing keeps failing while others succeed. Each wing
// advances independently; last_sync_ms stays the min for compatibility.
function getLastSync(wing?: string): number {
  if (!existsSync(STATE_FILE)) return 0
  const st = readSyncState()
  if (wing && st.wings && typeof st.wings[wing] === "number") return st.wings[wing] as number
  return st.last_sync_ms || 0
}

function dbSync(): void {
  if (miningLock) return
  try { doDbSync() } catch (e) { errLog("sync err: " + String(e)) }
}

function backfillRequested(): boolean {
  return !!process.env.OPENCODE_MEMPALACE_BACKFILL
}

// Export sessions with new messages as flat transcripts, grouped by
// project wing. cursorFor(wing) gives each wing its own cursor (null =
// discovery floor: sessions with anything newer anywhere). Filenames
// embed a content hash, so re-exports are naturally idempotent.
function exportNewSessions(
  cursorFor: (wing: string | null) => number,
): { wings: Map<string, string[]>; now: number; exportedIds: Map<string, Map<string, number>> } {
  const sinceMs = cursorFor(null)
  const sessions = runPython(`
import sqlite3, json
db = sqlite3.connect(${JSON.stringify(OPENCODE_DB)})
rows = db.execute("""
  SELECT DISTINCT s.id, s.title, p.worktree, s.directory, s.slug, s.time_created
  FROM session s
  LEFT JOIN project p ON s.project_id = p.id
  INNER JOIN message m ON m.session_id = s.id
  WHERE m.time_created > ${sinceMs}
  ORDER BY s.time_created
""").fetchall()
db.close()
print(json.dumps(rows))
`)

  let sessionsArr: any[][]
  try { sessionsArr = JSON.parse(sessions) } catch { return { wings: new Map(), now: Date.now(), exportedIds: new Map() } }
  if (!sessionsArr || sessionsArr.length === 0) return { wings: new Map(), now: Date.now(), exportedIds: new Map() }

  const now = Date.now()
  // Never advance the cursor past an in-flight reply: anything skipped
  // as incomplete is revisited by the next sync (idle/exit/startup).
  let cursor = now
  const wings = new Map<string, string[]>()
  // Already-mined IDs loaded ONCE per export (state file can be MBs).
  const seen = loadMinedIds()
  // Message IDs written to export files, PER WING. Recorded only when
  // that wing mines successfully — recording another wing's IDs early
  // would skip its content forever on failure.
  const exportedByWing = new Map<string, Map<string, number>>()
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 })

  for (const sess of sessionsArr) {
  try {
    const [sessId, title, , directory] = sess
    const wing = (((directory as string) || "").split("/").filter(Boolean).pop() || "global")
      .replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "global"
    const label = (title || "").replace(/[^a-zA-Z0-9 _-]/g, "_") || (sessId || "").slice(0, 12)
    const prefix = `${new Date().toISOString().slice(0, 10)}_${label.slice(0, 30)}_${(sessId || "").slice(0, 8)}`
    const wingSince = cursorFor(wing)

    const msgs = runPython(`
import sqlite3, json
db = sqlite3.connect(${JSON.stringify(OPENCODE_DB)})
rows = db.execute("""
  SELECT m.id, m.time_created, m.data FROM message m
  WHERE m.session_id = ${JSON.stringify(sessId)} AND m.time_created > ${wingSince}
  ORDER BY m.time_created
""").fetchall()
texts = []
incomplete = []
for (mid, mts, mdata_raw) in rows:
    try: mdata = json.loads(mdata_raw)
    except: mdata = {}
    role = mdata.get("role", "unknown")
    # Completion tracking (see PR #1524 review): the assistant message row
    # is created when a reply STARTS, parts stream in afterwards, and
    # finish is set only on completion. Exporting mid-reply would
    # snapshot partial parts while the cursor advances past the message
    # timestamp — losing the rest of the reply forever. So unfinished
    # replies are skipped and revisited next sync — BUT only while
    # recently active. A reply with no new parts for a while is dead
    # (killed session, crashed run): treating it as perpetually
    # in-flight would pin the cursor forever (seen live: a stillborn
    # message froze sync for 7h). Dead replies are exported as-is.
    now_ms = int(__import__("time").time() * 1000)
    STALE_PART_MS = 30 * 60 * 1000
    STALE_EMPTY_MS = 10 * 60 * 1000
    if role == "assistant" and not mdata.get("finish"):
        max_part = db.execute("SELECT MAX(time_created) FROM part WHERE message_id = ?", (mid,)).fetchone()[0]
        if max_part is None:
            alive = (now_ms - mts) < STALE_EMPTY_MS
        else:
            alive = (now_ms - max_part) < STALE_PART_MS
        if alive:
            incomplete.append(mts)
            continue
    for (pdata_raw,) in db.execute("SELECT data FROM part WHERE message_id = ? ORDER BY time_created", (mid,)).fetchall():
        try:
            pdata = json.loads(pdata_raw)
            if pdata.get("type") == "text" and pdata.get("text","").strip():
                texts.append({"mid": mid, "role": role, "text": pdata.get("text").strip(), "ts": mts})
        except: pass
db.close()
print(json.dumps({"texts": texts, "incomplete": incomplete}))
`)

    let msgList: Array<{ mid: string; role: string; text: string; ts: number }>
    let incompleteTs: number[] = []
    try {
      const parsed = JSON.parse(msgs) as { texts: typeof msgList; incomplete: number[] }
      // Message-level dedup: each message is exported exactly once ever.
      // Repeated boilerplate (system prompts re-sent every turn) across
      // overlapping windows was the main duplicate source mempalace's
      // file-level dedup cannot catch (different files, same paragraph).
      msgList = (parsed.texts || []).filter((m) => m && m.mid && !seen.has(m.mid))
      incompleteTs = parsed.incomplete || []
    } catch { continue }
    if (incompleteTs.length > 0) {
      cursor = Math.min(cursor, Math.min(...incompleteTs) - 1)
    }
    if (msgList.length < 2 && incompleteTs.length === 0) continue

    const lines: string[] = [
      `# ${title || label}`,
      `Date: ${new Date().toISOString().slice(0, 10)}`,
      `Session: ${sessId}`,
      "",
    ]
    for (const m of msgList) {
      const ts = m.ts ? new Date(m.ts).toISOString().slice(11, 19) : ""
      lines.push(`## ${m.role.toUpperCase()} \u2014 ${ts}`)
      lines.push("")
      lines.push(m.text)
      lines.push("")
    }

    const content = lines.join("\n").trim()
    if (!content) continue

    const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 12)
    const wingDir = join(OUT_DIR, wing)
    mkdirSync(wingDir, { recursive: true, mode: 0o700 })
    const fname = `sync_${prefix}_${contentHash}.txt`
    writeFileSync(join(wingDir, fname), content + "\n", { mode: 0o600 })
    if (!exportedByWing.has(wing)) exportedByWing.set(wing, new Map())
    const wingIds = exportedByWing.get(wing)!
    for (const m of msgList) {
      if (m && m.mid && typeof m.ts === "number") wingIds.set(m.mid, m.ts)
    }
    if (!wings.has(wing)) wings.set(wing, [])
    wings.get(wing)!.push(join(wingDir, fname))
  } catch (e) {
    // One pathological session (oversized payload, corrupt row) must
    // never abort the whole export — skip it, log, continue with the
    // rest (see issue #6).
    try {
      errLog(`export skipped session ${(sess as any[])?.[0] || "?"}: ${String(e).slice(0, 160)}`)
    } catch {}
    continue
  }
  }

  return { wings, now: cursor, exportedIds: exportedByWing }
}

function markSynced(now: number, wing?: string): void {
  try {
    const st = readSyncState()
    if (wing) {
      st.wings = st.wings || {}
      st.wings[wing] = now
      const vals = Object.values(st.wings)
      st.last_sync_ms = vals.length > 0 ? Math.min(...vals) : now
    } else {
      st.last_sync_ms = now
    }
    writeFileSync(STATE_FILE, JSON.stringify(st))
  } catch (e) { log("state write err: " + String(e)) }
  lastSyncTs = Date.now()
}

// Default `exchange` extraction: one drawer per exchange pair, verbatim,
// no paraphrasing (see PR #1524 review). Intelligent filing (decisions,
// KG facts, diary) happens through AI checkpoints, not the miner.
// Agent tag keeps opencode-mined drawers attributable.
// One wing per project (official multi-project pattern).
// Argv array, no shell (see PR #2): wing names are sanitized, but the
// spawn path stays shell-free regardless.
function mineArgs(wingDir: string, wing: string): string[] {
  return ["mine", wingDir, "--mode", "convos", "--agent", "opencode", "--wing", wing]
}

function cleanupExport(wings: Map<string, string[]>): void {
  // Wipe whole wing dirs: a successful mine filed everything in them,
  // including orphan files from previously failed runs.
  for (const wing of wings.keys()) {
    try {
      for (const f of readdirSync(join(OUT_DIR, wing))) {
        try { unlinkSync(join(OUT_DIR, wing, f)) } catch {}
      }
    } catch {}
    try { rmdirSync(join(OUT_DIR, wing)) } catch {}
  }
  try { rmdirSync(OUT_DIR) } catch {}
}

function wingCount(wings: Map<string, string[]>): number {
  let n = 0
  for (const files of wings.values()) n += files.length
  return n
}

function doDbSync(): void {
  if (lastSyncTs && Date.now() - lastSyncTs < 5000) return

  const sinceMs = backfillRequested() ? 0 : getLastSync()
  if (backfillRequested()) log("backfill requested: exporting full history")
  const cursorFor = backfillRequested()
    ? (_wing: string | null) => 0
    : (wing: string | null) => (wing ? getLastSync(wing) : getLastSync())

  const { wings, now, exportedIds } = exportNewSessions(cursorFor)
  if (wings.size === 0) return

  miningLock = true
  log(`mining ${wingCount(wings)} sessions across ${wings.size} wings`)

  const entries = [...wings.entries()]
  // Per-wing drawers tally for the final toast (parsed from mine stdout).
  const wingDrawers = new Map<string, number>()
  const parseDrawers = (stdout: unknown): number => {
    const m = String(stdout || "").match(/Drawers filed:\s*(\d+)/i)
    return m ? parseInt(m[1], 10) : 0
  }
  // Retry schedule for lock contention: two instances (or an MCP write)
  // interleave wing by wing instead of starving each other. Total ~10min
  // of retries per wing, then give up until the next trigger (idle/exit).
  // miningLock stays held during backoff so one process never piles up.
  const RETRY_DELAYS_MS = [15000, 30000, 60000, 120000, 180000, 300000]
  const jitter = (ms: number) => ms + Math.floor(Math.random() * 10000)
  const mineNext = (i: number, attempt = 0): void => {
    if (i >= entries.length) {
      miningLock = false
      cleanupExport(wings)
      log("mine done")
      const names = [...wings.keys()].join(", ")
      const totalDrawers = [...wingDrawers.values()].reduce((a, b) => a + b, 0)
      const detail = totalDrawers > 0 ? ` (${totalDrawers} drawers)` : ""
      // Anything that arrived while this mine was running stays pending.
      const remaining = countPendingMessages()
      const tail = remaining.total > 0 ? `, ${remaining.total} message(s) still waiting` : ", queue empty"
      toast("success", "MemPalace", `mined ${wingCount(wings)} session(s) → ${names}${detail}${tail}`)
      ilog("mine", { outcome: "ok", sessions: wingCount(wings), wings: [...wings.keys()], drawers: totalDrawers, remaining: remaining.total })
      return
    }
    const [wing, files] = entries[i]
    // No timeout here by design (see PR #4): Node would kill only the
    // wrapper shell and orphan the python mine process, which keeps
    // holding the palace lock while the next mine piles up. miningLock
    // already serializes concurrent mines; long mines run to completion.
    const bin = resolveBin()
    if (!bin) { miningLock = false; errLog("mine skipped: mempalace CLI not found"); return }
    execFile(bin, mineArgs(join(OUT_DIR, wing), wing), {
      encoding: "utf-8",
      maxBuffer: CHILD_MAX_BUFFER,
    }, (err, stdout) => {
      if (err) {
        const msg = err.message || String(err)
        // Lock contention (second opencode instance mining, or an MCP
        // write in flight) is routine, not a failure: back off and retry
        // the same wing — the holder releases between its own wings, so
        // concurrent instances interleave instead of starving. Anything
        // else is a real error.
        if (/is held by/i.test(msg) && attempt < RETRY_DELAYS_MS.length) {
          const wait = jitter(RETRY_DELAYS_MS[attempt])
          log(`palace busy (${wing}), retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${Math.round(wait / 1000)}s`)
          const nowTs = Date.now()
          if (nowTs - lastBusyToastTs > BUSY_TOAST_WINDOW_MS) {
            lastBusyToastTs = nowTs
            toast("info", "MemPalace", "palace busy (another instance mining?) — backing off, will retry")
          }
          setTimeout(() => mineNext(i, attempt + 1), wait)
          return
        }
        miningLock = false
        if (/is held by/i.test(msg)) {
          log(`mine skipped, palace busy (${wing}) after ${attempt} retries — next trigger will retry`)
          ilog("mine", { outcome: "busy", wing })
          return
        }
        errLog(`mine err (${wing}): ${msg}`)
        toast("error", "MemPalace", `mine failed (${wing}): ${msg.slice(0, 120)}`)
        ilog("mine", { outcome: "error", wing, error: msg.slice(0, 200) })
        return
      }
      log(`mined wing ${wing} (${files.length} sessions)`)
      wingDrawers.set(wing, parseDrawers(stdout))
      // Per-wing cursor: this wing's progress is banked even if a later
      // wing fails — the counter never stalls on one slow wing again.
      // Only THIS wing's message IDs are recorded: other wings' content
      // is not filed yet, recording it would skip it forever on failure.
      markSynced(now, wing)
      commitExportedIds(new Map([[wing, exportedIds.get(wing) || new Map()]]))
      for (const f of files) { try { unlinkSync(f) } catch {} }
      try { rmdirSync(join(OUT_DIR, wing)) } catch {}
      // Truthful progress: one toast per completed wing (an exact % is
      // impossible — the mine CLI is a black box with ~4s startup cost
      // per invocation, so per-file mines would only add overhead).
      toast("info", "MemPalace", `wing ${wing} done (${i + 1}/${entries.length})`)
      mineNext(i + 1)
    })
  }
  mineNext(0)
}

// Best-effort synchronous save for process exit (SIGINT/SIGTERM/exit):
// only synchronous calls are allowed here. Bounded by EXIT_BUDGET_MS so
// shutdown stays fast; miningLock is deliberately ignored here because
// any in-flight async mine dies with the process — at exit this sync
// mine takes ownership (see PR #1524 review).
const EXIT_BUDGET_MS = 45000
const EXIT_WING_TIMEOUT_MS = 30000
function exitSync(): void {
  try {
    const bin = resolveBin()
    if (!bin) return
    const { wings, now, exportedIds } = exportNewSessions((wing) => (wing ? getLastSync(wing) : getLastSync()))
    if (wings.size === 0) return
    const deadline = Date.now() + EXIT_BUDGET_MS
    const done: string[] = []
    for (const [wing] of wings) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) { log("exit save: budget exhausted, rest covered next startup"); break }
      log(`exit save: mining wing ${wing}`)
      const res = spawnSync(bin, mineArgs(join(OUT_DIR, wing), wing), {
        encoding: "utf-8",
        timeout: Math.min(EXIT_WING_TIMEOUT_MS, remaining),
        maxBuffer: CHILD_MAX_BUFFER,
      })
      if (res.error || res.status !== 0) {
        const why = (res.error as any)?.message || (res as any).signal || res.status
        errLog(`exit mine err (${wing}): ${String(why)}`)
        return
      }
      markSynced(now, wing)
      commitExportedIds(new Map([[wing, exportedIds.get(wing) || new Map()]]))
      done.push(wing)
    }
    for (const wing of done) {
      for (const f of wings.get(wing) || []) { try { unlinkSync(f) } catch {} }
      try { rmdirSync(join(OUT_DIR, wing)) } catch {}
    }
    try { rmdirSync(OUT_DIR) } catch {}
    log("exit save done")
  } catch (e) { errLog("exit save err: " + String(e)) }
}

// ============================================================================
// v2 entrypoint: Plugin.define({ id, setup })
// ============================================================================

// v2 sessionID: the docs don't put it on every event. For the prompt hook
// it's the session the prompt is admitted into; metadata may carry it.
// Fall back to "global" if absent — counters stay per-session but degrade
// gracefully if opencode doesn't surface it.
function sessionIdFromEvent(event: any): string {
  return event?.metadata?.sessionID || event?.sessionID || "global"
}

// Build a status report for `/memory-status`. Read-only — touches no state.
function buildStatusReport(): string {
  const lines: string[] = []
  lines.push(`MemPalace status (plugin v${pluginVersion()})`)
  lines.push("=".repeat(48))

  try {
    const st = readSyncState()
    const last = st.last_sync_ms ? new Date(st.last_sync_ms).toISOString() : "never"
    const wingKeys = Object.keys(st.wings || {})
    const wingDetail = wingKeys.length > 0
      ? wingKeys.map((w) => `${w}=${new Date((st.wings as any)[w]).toISOString()}`).join(", ")
      : "none"
    lines.push(`Sync: last=${last}`)
    lines.push(`Wings: ${wingDetail}`)
  } catch (e) { lines.push(`Sync: read err ${e}`) }

  try {
    const pending = countPendingMessages()
    const wingEntries = Object.entries(pending.byWing)
    const detail = wingEntries.length > 0
      ? ` across ${wingEntries.length} wing(s): ${wingEntries.map(([w, n]) => `${w}=${n}`).join(", ")}`
      : ""
    lines.push(`Pending: ${pending.total} message(s)${detail}`)
  } catch {}

  try {
    const raw = existsSync(PLUGIN_CONFIG) ? JSON.parse(readFileSync(PLUGIN_CONFIG, "utf-8")) : {}
    lines.push("Config:")
    lines.push(`  autoInjectContext: ${(raw as any)?.autoInjectContext ?? false}`)
    lines.push(`  saveInterval: ${(raw as any)?.saveInterval ?? DEFAULT_SAVE_INTERVAL}`)
    lines.push(`  toasts: ${(raw as any)?.toasts ?? true}`)
  } catch {}

  try {
    if (existsSync(HOOK_LOG)) {
      const raw = readFileSync(HOOK_LOG, "utf-8")
      const tail = raw.split("\n").filter(Boolean).slice(-5)
      if (tail.length > 0) {
        lines.push("")
        lines.push("Recent log (last 5):")
        tail.forEach((l) => lines.push(`  ${l}`))
      }
    }
  } catch {}

  try {
    if (existsSync(INTERACTIONS_LOG)) {
      const raw = readFileSync(INTERACTIONS_LOG, "utf-8")
      const recent = raw.split("\n").filter(Boolean).slice(-100)
      const counts: Record<string, number> = {}
      for (const line of recent) {
        try {
          const obj = JSON.parse(line)
          if (typeof obj.kind === "string") counts[obj.kind] = (counts[obj.kind] || 0) + 1
        } catch {}
      }
      if (Object.keys(counts).length > 0) {
        lines.push("")
        lines.push(`Activity (last ${recent.length} entries):`)
        Object.entries(counts).forEach(([k, n]) => lines.push(`  ${k}: ${n}`))
      }
    }
  } catch {}

  return lines.join("\n")
}

// Parse `/memory-log N filter` arg tail (the command name is already stripped).
function parseArgsFromText(text: string): { n: number; filter?: string } {
  const stripped = text.replace(/^\s*\/memory-log\b\s*/i, "").trim()
  const tokens = stripped.split(/\s+/)
  const nStr = tokens.shift()
  const n = parseInt(nStr ?? "20", 10)
  return {
    n: Number.isFinite(n) && n > 0 ? n : 20,
    filter: tokens.length > 0 ? tokens.join(" ") : undefined,
  }
}

// Tail the interactions log for `/memory-log`.
function readInteractionsLog({ n, filter }: { n: number; filter?: string }): string {
  if (!existsSync(INTERACTIONS_LOG)) return "no interactions log yet"
  try {
    const raw = readFileSync(INTERACTIONS_LOG, "utf-8")
    const all = raw.split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter((x): x is Record<string, unknown> => x !== null)
    let filtered = all
    if (filter) {
      const f = filter.toLowerCase()
      filtered = all.filter((e) => JSON.stringify(e).toLowerCase().includes(f))
    }
    const tail = filtered.slice(-n)
    if (tail.length === 0) return "no matching entries"
    const head = `Memory log (${tail.length} ${filter ? "matching" : "most recent"} entries, newest last):`
    const out: string[] = [head]
    for (const e of tail) {
      const ts = (e.ts as string) || "?"
      const kind = (e.kind as string) || "?"
      const { ts: _, kind: __, ...rest } = e
      const detail = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : ""
      out.push(`  [${ts}] ${kind}${detail}`)
    }
    return out.join("\n")
  } catch (e) { return `log read err: ${e}` }
}

export default Plugin.define({
  id: "opencode-mempalace-persistence",
  async setup(ctx) {
    // v2 ctx is typed: domains like ctx.session, ctx.tool, ctx.command,
    // ctx.event. No raw client. Toast visibility falls back to hook.log
    // (see toast() above) until a paired TUI plugin entry ships.

    mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 })
    mkdirSync(HOOK_STATE_DIR, { recursive: true })

    const autoInject = isAutoInjectEnabled()
    const identity = readIdentity()
    const interval = saveInterval()
    log(`loaded (autoInjectContext: ${autoInject}, saveInterval: ${interval})`)
    hookLog(`plugin loaded: v${pluginVersion()}`)

    // Background catch-up + startup toast. Timers live for plugin lifetime.
    setTimeout(() => dbSync(), 10_000)
    setTimeout(() => {
      toast("info", "MemPalace", `${pluginName()} v${pluginVersion()} loaded${countPendingSuffix()}`)
      log(`startup toast fired (${pluginName()} v${pluginVersion()})`)
    }, 15_000)

    // ── session hooks ─────────────────────────────────────────────────────

    // Replaces v1 "chat.message": count human messages, arm checkpoint
    // at the saveInterval boundary.
    await ctx.session.hook("prompt", (event: any) => {
      const text = event.prompt?.text
      if (!text) return
      const sessionID = sessionIdFromEvent(event)

      const counters = loadCounters()
      const c = counters[sessionID] || { humanMsgs: 0, lastCheckpoint: 0 }
      c.humanMsgs += 1
      const boundary = Math.floor(c.humanMsgs / interval)
      if (boundary > c.lastCheckpoint) {
        c.lastCheckpoint = boundary
        pendingCheckpoint = { sessionID, count: c.humanMsgs }
        hookLog(`session ${sessionID}: ${c.humanMsgs} human msgs — checkpoint armed`)
        ilog("checkpoint", { sessionID, count: c.humanMsgs })
        toast("info", "MemPalace", `checkpoint armed (~${c.humanMsgs} msgs): the model will file memories now`)
      }
      counters[sessionID] = c
      persistCounters(counters)
    })

    // Replaces v1 "experimental.chat.messages.transform": inject identity,
    // recall, and checkpoint blocks before the model sees the prompt.
    await ctx.session.hook("context", (event: any) => {
      if (!event.messages?.length) return

      const injectParts: any[] = []
      const lastUser = [...event.messages].reverse().find((m: any) => m.info?.role === "user")

      // Checkpoint injection (works with or without autoInject: filing is
      // done by the model via MCP tools; the hook only decides WHEN).
      if (pendingCheckpoint && lastUser) {
        injectParts.push({
          id: `mp-checkpoint-${Date.now()}`,
          type: "text",
          synthetic: true,
          text: checkpointInstruction(pendingCheckpoint.count),
        })
        log(`checkpoint injected (~${pendingCheckpoint.count} msgs)`)
        hookLog(`checkpoint injected for session ${pendingCheckpoint.sessionID}`)
        pendingCheckpoint = null
      }

      if (!autoInject) {
        if (injectParts.length > 0 && lastUser) lastUser.parts.push(...injectParts)
        return
      }
      if (!lastUser) return

      const query = hasText(lastUser.parts || [])
      if (!query && injectParts.length === 0) return

      if (!wakeupDone) {
        wakeupDone = true
        if (identity) {
          injectParts.push({
            id: `mp-identity-${Date.now()}`,
            type: "text",
            synthetic: true,
            text: `[MemPalace Identity]\n${identity}\n[/MemPalace Identity]`,
          })
        }
      }

      if (query) {
        const memories = mempalaceSearch(query)
        if (memories) {
          injectParts.push({
            id: `mp-recall-${Date.now()}`,
            type: "text",
            synthetic: true,
            text: `[MemPalace Recall]\n${memories}\n[/MemPalace Recall]`,
          })
        }
      }

      if (injectParts.length > 0) {
        lastUser.parts.push(...injectParts)
        log(`injected ${injectParts.length} context blocks`)
      }
    })

    // Replaces v1 "experimental.session.compacting": pre-compact emergency
    // save + rescue context (identity + wake-up re-attached so the summary
    // cannot lose them).
    await ctx.session.hook("compaction", (event: any) => {
      const sessionID = sessionIdFromEvent(event)
      log(`compacting session ${sessionID} - emergency save + rescue`)
      hookLog(`pre-compact emergency save for session ${sessionID}`)
      event.context.push(precompactInstruction())
      const rescue: string[] = []
      if (identity) rescue.push(`[MemPalace Identity]\n${identity}`)
      const wakeup = mempalaceWakeup()
      if (wakeup) rescue.push(`[MemPalace Wake-up]\n${wakeup}`)
      if (rescue.length > 0) {
        event.context.push(`[MemPalace Rescue — core memory, must survive compaction]\n${rescue.join("\n\n")}`)
      }
    })

    // ── tool hook ─────────────────────────────────────────────────────────

    // Replaces v1 "tool.execute.after": toast when the model drives a
    // MemPalace MCP tool (recall / diary / KG). Same shape as v1 — log
    // the tool name, args preview, result preview.
    await ctx.tool.hook("execute.after", (event: any) => {
      try {
        const name = event.tool || ""
        if (!isMemPalaceTool(name)) return
        const args = event.input?.args ?? event.input
        const summary = summarizeToolCall(name, args, event.output)
        log(`tool: ${summary}`)
        toast("info", "MemPalace", summary)
        const outAny = event.output || {}
        ilog("tool", {
          tool: String(name).replace(/^mcp_+/, "").replace(/^mempalace_mempalace_/, "").replace(/^mempalace_/, ""),
          asked: (() => { try { return JSON.stringify(args || {}).replace(/\s+/g, " ").slice(0, 200) } catch { return "" } })(),
          answered: extractResultText(event.output).replace(/\s+/g, " ").slice(0, 300),
          shape: {
            keys: Object.keys(outAny),
            title: outAny.title,
            metaKeys: outAny.metadata && typeof outAny.metadata === "object" ? Object.keys(outAny.metadata) : typeof outAny.metadata,
            raw: JSON.stringify(outAny).slice(0, 300),
          },
        })
      } catch {}
    })

    // ── event subscription (replaces v1 event hook) ─────────────────────

    // v1's `event: async ({ event }) => {}` becomes an async iterable
    // bound to an AbortController. Cleanup function from setup() aborts it.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const t = (event as any)?.type
          if (t === "session.idle" || t === "session.deleted") {
            log(`${t} - queue sync`)
            setTimeout(() => dbSync(), 3000)
          }
        }
      } catch (e) {
        log(`event subscription ended: ${e}`)
      }
    })()

    // ── slash commands (NEW in v2; replaces external Markdown files) ─────

    await ctx.command.transform((editor) => {
      editor.add({
        name: "memory-status",
        description: "Show MemPalace health: sync state, pending backlog, active config, recent activity",
        execute: async ({ sessionID, prompt, delivery }: any) => {
          const text = buildStatusReport()
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: `[memory-status]\n${text}\n[/memory-status]`,
            delivery,
          })
        },
      })
      editor.add({
        name: "memory-log",
        description: "Show interaction history (searches, tool calls, mines, checkpoints). Args: [N] [filter]",
        execute: async ({ sessionID, prompt, delivery }: any) => {
          const args = parseArgsFromText(prompt.text || "")
          const text = readInteractionsLog(args)
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: `[memory-log]\n${text}\n[/memory-log]`,
            delivery,
          })
        },
      })
    })

    // ── signal handlers (best-effort exit sync across opencode restarts) ─

    let exitHandled = false
    const onExit = () => {
      if (exitHandled) return
      exitHandled = true
      exitSync()
    }
    process.once("SIGINT", onExit)
    process.once("SIGTERM", onExit)
    process.once("SIGHUP", onExit)
    process.once("exit", onExit)

    // Cleanup returned from setup() runs when the plugin unloads.
    return () => {
      controller.abort()
    }
  },
})

