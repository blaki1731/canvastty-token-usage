// CanvasTTY plugin service: token usage per model for local CLI agents.
// Runs as a CanvasTTY plugin service (Node, ESM). Speaks JSON-RPC 2.0 NDJSON over stdio.
// Stateless: every request re-reads the local logs/databases, so no baseline can go stale.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const DAY_MS = 86400000;
const RETENTION_MS = 30 * DAY_MS;

// ---------------------------------------------------------------- JSON-RPC IO

let ctx = { pluginId: "", serviceId: "", dataDir: "", locale: "en", hostVersion: "" };

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result: result ?? null });
}

function sendError(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(message).slice(0, 240) } });
}

readline
  .createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (typeof message.method === "string") {
      if (message.id === undefined || message.id === null) {
        // Host notification. canvastty.initialize is the only one we care about.
        if (message.method === "canvastty.initialize" && message.params && typeof message.params === "object") {
          ctx = { ...ctx, ...message.params };
        }
        return;
      }
      void dispatch(message.method, message.params ?? {}).then(
        (result) => sendResult(message.id, result),
        (error) => sendError(message.id, error instanceof Error ? error.message : String(error)),
      );
    }
  });

async function dispatch(method, params) {
  if (method === "status") {
    return {
      ok: true,
      apiVersion: 1,
      plugin: ctx.pluginId,
      service: ctx.serviceId,
      hostVersion: ctx.hostVersion,
      node: process.version,
      platform: process.platform,
      sources: describeSources(),
    };
  }
  if (method === "apps.list") {
    const report = await buildReport("all", null, null);
    return {
      apps: report.apps,
      sources: report.sources,
      generatedAt: report.generatedAt,
    };
  }
  if (method === "usage.query") {
    const app = typeof params.app === "string" && params.app ? params.app : "all";
    const now = Date.now();
    const to = finiteNumber(params.to) ?? now;
    const from = finiteNumber(params.from) ?? to - RETENTION_MS;
    if (!(to >= from)) throw new Error("Invalid time range.");
    return buildReport(app, from, to);
  }
  throw new Error(`Unknown method: ${String(method).slice(0, 80)}`);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------- helpers

const isRecord = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const asInt = (value) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);
const asIntOrZero = (value) => {
  const parsed = asInt(value);
  return parsed === null ? 0 : parsed;
};
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value) => String(value ?? "").trim();
const ms = (value) => {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? Math.round(parsed * 1000) : null;
};
const epochMs = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

function label(name) {
  return name.replace(/[^\w.@+-]/g, "_").slice(0, 64) || "unnamed";
}

function pluralRu(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function dayKey(atMs) {
  const date = new Date(atMs);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function covers(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value >= b[index]);
}

function walk(root, maxDepth = 8) {
  const out = [];
  const seen = new Set();
  const visit = (directory, depth) => {
    let real;
    try {
      real = fs.realpathSync(directory);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(real, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(real, entry.name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) visit(full, depth + 1);
      else if (stat.isFile() && entry.name.endsWith(".jsonl")) out.push({ path: full, mtime: stat.mtimeMs, size: stat.size });
    }
  };
  visit(root, 0);
  return out;
}

function homeDir() {
  return os.homedir();
}

function envDir(env, name) {
  const value = env[name]?.trim();
  return value && path.isAbsolute(value) ? path.normalize(value) : null;
}

// ---------------------------------------------------------------- sources

function hermesHomes(env) {
  const homes = new Map();
  const add = (dir, name) => {
    if (!dir) return;
    const key = path.resolve(dir);
    if (!homes.has(key)) homes.set(key, name);
  };
  const hermesHome = envDir(env, "HERMES_HOME");
  if (hermesHome) {
    if (path.basename(path.dirname(hermesHome)) === "profiles") {
      add(path.dirname(path.dirname(hermesHome)), "default");
      add(hermesHome, label(path.basename(hermesHome)));
    } else {
      add(hermesHome, label(path.basename(hermesHome)) || "default");
    }
  }
  const localAppData = envDir(env, "LOCALAPPDATA");
  if (localAppData) add(path.join(localAppData, "hermes"), "default");
  add(path.join(homeDir(), ".hermes"), "default");
  for (const base of [...homes.keys()]) {
    let entries;
    try {
      entries = fs.readdirSync(path.join(base, "profiles"), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
      add(path.join(base, "profiles", entry.name), label(entry.name));
    }
  }
  return [...homes.entries()].map(([path, name]) => ({ path, name }));
}

function logRoots(env) {
  const roots = [];
  const codexHome = envDir(env, "CODEX_HOME");
  const claudeConfig = envDir(env, "CLAUDE_CONFIG_DIR");
  const add = (source, base, folders, name, profile) => {
    if (!base) return;
    for (const folder of folders) roots.push({ source, path: path.join(base, folder), label: `${name}/${folder}`, profile });
  };
  add("codex", path.join(homeDir(), ".codex"), ["sessions", "archived_sessions"], "~/.codex", "default");
  if (codexHome && path.resolve(codexHome) !== path.resolve(path.join(homeDir(), ".codex"))) {
    add("codex", codexHome, ["sessions", "archived_sessions"], "CODEX_HOME", label(path.basename(codexHome)));
  }
  add("claude", path.join(homeDir(), ".claude"), ["projects"], "~/.claude", "default");
  add("claude", path.join(homeDir(), ".config", "claude"), ["projects"], "~/.config/claude", "default");
  if (claudeConfig && path.resolve(claudeConfig) !== path.resolve(path.join(homeDir(), ".claude"))) {
    add("claude", claudeConfig, ["projects"], "CLAUDE_CONFIG_DIR", label(path.basename(claudeConfig)));
  }
  return roots;
}

function opencodeHomes(env) {
  const homes = new Map();
  const add = (dir, name) => {
    if (!dir) return;
    const key = path.resolve(dir);
    if (!homes.has(key)) homes.set(key, name);
  };
  const xdg = envDir(env, "XDG_DATA_HOME");
  if (xdg) add(path.join(xdg, "opencode"), "default");
  if (process.platform === "win32") {
    const localAppData = envDir(env, "LOCALAPPDATA");
    if (localAppData) add(path.join(localAppData, "opencode"), "default");
    add(path.join(homeDir(), ".local", "share", "opencode"), "default");
  } else {
    add(path.join(homeDir(), ".local", "share", "opencode"), "default");
  }
  const opencodeHome = envDir(env, "OPENCODE_HOME");
  if (opencodeHome) add(opencodeHome, label(path.basename(opencodeHome)));
  return [...homes.entries()].map(([path, name]) => ({ path, name }));
}

function describeSources() {
  const env = process.env;
  const sources = [];
  for (const home of hermesHomes(env)) {
    const db = path.join(home.path, "state.db");
    sources.push({ id: "hermes", app: "hermes", path: db, exists: fs.existsSync(db), profile: home.name });
  }
  if (!sources.some((source) => source.app === "hermes")) {
    sources.push({ id: "hermes", app: "hermes", path: path.join(homeDir(), ".hermes", "state.db"), exists: false, profile: "default" });
  }
  for (const root of logRoots(env)) {
    sources.push({ id: root.source, app: root.source, path: root.path, exists: fs.existsSync(root.path), profile: root.profile });
  }
  for (const home of opencodeHomes(env)) {
    const db = path.join(home.path, "opencode.db");
    sources.push({ id: "opencode", app: "opencode", path: db, exists: fs.existsSync(db), profile: home.name });
  }
  if (!sources.some((source) => source.app === "opencode")) {
    sources.push({ id: "opencode", app: "opencode", path: path.join(homeDir(), ".local", "share", "opencode", "opencode.db"), exists: false, profile: "default" });
  }
  return sources;
}

// ---------------------------------------------------------------- sqlite

function openReadOnly(database) {
  return new DatabaseSync(database, { readOnly: true });
}

function hermesRecords(env, events, status) {
  let databases = 0;
  let rowsCount = 0;
  for (const home of hermesHomes(env)) {
    const database = path.join(home.path, "state.db");
    let db;
    try {
      db = openReadOnly(database);
    } catch (error) {
      continue;
    }
    databases += 1;
    try {
      const tableInfo = db.prepare("SELECT name FROM pragma_table_info('session_model_usage')").all();
      const hasModel = tableInfo.some((row) => row.name === "model");
      const rows = db
        .prepare(
          `SELECT 'm' AS k, session_id AS id,
                  COALESCE(model, '') AS model, COALESCE(task, '') AS task,
                  COALESCE(billing_provider, '') AS provider,
                  COALESCE(input_tokens, 0) AS i, COALESCE(output_tokens, 0) AS o,
                  COALESCE(cache_read_tokens, 0) AS cr, COALESCE(cache_write_tokens, 0) AS cw,
                  COALESCE(reasoning_tokens, 0) AS r, COALESCE(api_call_count, 0) AS calls,
                  first_seen AS fs, last_seen AS ls
           FROM session_model_usage
           UNION ALL
           SELECT 's', id, COALESCE(model, ''), '',
                  COALESCE(billing_provider, ''),
                  COALESCE(input_tokens, 0), COALESCE(output_tokens, 0),
                  COALESCE(cache_read_tokens, 0), COALESCE(cache_write_tokens, 0),
                  COALESCE(reasoning_tokens, 0), COALESCE(api_call_count, 0),
                  started_at, NULL
           FROM sessions
           WHERE NOT EXISTS (SELECT 1 FROM session_model_usage u WHERE u.session_id = sessions.id)`,
        )
        .all();
      for (const row of rows) {
        rowsCount += 1;
        const from = ms(row.fs);
        if (from === null) continue;
        const to = ms(row.ls) ?? from;
        const input = asIntOrZero(row.i) + asIntOrZero(row.cr) + asIntOrZero(row.cw);
        const output = asIntOrZero(row.o);
        const cached = asIntOrZero(row.cr);
        const reasoning = asIntOrZero(row.r);
        if (!input && !output) continue;
        const model = text(row.model) || text(row.provider) || text(row.task) || "unknown";
        events.push({
          app: "hermes",
          profile: home.name,
          session: text(row.id) || "unknown",
          model,
          input,
          output,
          cached,
          reasoning,
          calls: asIntOrZero(row.calls),
          from,
          to,
          timing: "span",
        });
      }
      status.hermes = {
        state: "ok",
        detail: `${databases} ${pluralRu(databases, "база", "базы", "баз")}, ${rowsCount} ${pluralRu(rowsCount, "запись", "записи", "записей")}`,
      };
    } catch (error) {
      status.hermes = { state: "error", detail: String(error?.message ?? error).slice(0, 200) };
    } finally {
      try {
        db.close();
      } catch {}
    }
  }
  if (!databases) status.hermes = { state: "missing", detail: "state.db не найдена" };
  return events;
}

function opencodeRecords(env, events, status) {
  let databases = 0;
  let rowsCount = 0;
  for (const home of opencodeHomes(env)) {
    const database = path.join(home.path, "opencode.db");
    let db;
    try {
      db = openReadOnly(database);
    } catch {
      continue;
    }
    databases += 1;
    try {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
      if (!tables.has("session_v2")) {
        status.opencode = { state: "missing", detail: "база без таблицы session_v2" };
        continue;
      }
      const rows = db
        .prepare(
          `SELECT id, COALESCE(model, '') AS model,
                  COALESCE(tokens_input, 0) AS i, COALESCE(tokens_output, 0) AS o,
                  COALESCE(tokens_reasoning, 0) AS r,
                  COALESCE(tokens_cache_read, 0) AS cr, COALESCE(tokens_cache_write, 0) AS cw,
                  time_created AS c, time_updated AS u
           FROM session_v2`,
        )
        .all();
      for (const row of rows) {
        rowsCount += 1;
        const from = epochMs(row.c);
        const to = epochMs(row.u) ?? from;
        if (from === null) continue;
        const input = asIntOrZero(row.i) + asIntOrZero(row.cr) + asIntOrZero(row.cw);
        const output = asIntOrZero(row.o);
        if (!input && !output) continue;
        events.push({
          app: "opencode",
          profile: home.name,
          session: text(row.id),
          model: text(row.model) || "unknown",
          input,
          output,
          cached: asIntOrZero(row.cr),
          reasoning: asIntOrZero(row.r),
          calls: 0,
          from,
          to: to ?? from,
          timing: "span",
        });
      }
      status.opencode = { state: "ok", detail: `${rowsCount} ${pluralRu(rowsCount, "сессия", "сессии", "сессий")}` };
    } catch (error) {
      status.opencode = { state: "error", detail: String(error?.message ?? error).slice(0, 200) };
    } finally {
      try {
        db.close();
      } catch {}
    }
  }
  if (!databases) status.opencode = { state: "missing", detail: "opencode.db не найдена" };
  return events;
}

// ---------------------------------------------------------------- codex / claude logs

function codexTokens(value) {
  const usage = isRecord(value) ? value : {};
  const input = asInt(usage.input_tokens);
  const output = asInt(usage.output_tokens);
  const cached = usage.cached_input_tokens === undefined || usage.cached_input_tokens === null ? 0 : asInt(usage.cached_input_tokens);
  const reasoning =
    usage.reasoning_output_tokens === undefined || usage.reasoning_output_tokens === null ? 0 : asInt(usage.reasoning_output_tokens);
  if (input === null || output === null || cached === null || reasoning === null || cached > input) return null;
  return { tokens: [input, cached, output], reasoning };
}

function codexApp(originator) {
  if (/vscode|ide|jetbrains/i.test(originator)) return "Codex IDE";
  if (/desktop/i.test(originator)) return "Codex Desktop";
  if (/exec/i.test(originator)) return "Codex Exec";
  return /cli/i.test(originator) ? "Codex CLI" : "Codex";
}

async function codexRecords(env, events, status) {
  const roots = logRoots(env).filter((root) => root.source === "codex");
  let files = 0;
  let counted = 0;
  for (const root of roots) {
    for (const file of walk(root.path)) {
      files += 1;
      const state = { session: "", app: "Codex", model: "", total: null, reasoning: 0, external: false };
      const stream = fs.createReadStream(file.path, { encoding: "utf8" });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        if (!line.includes("token_count") && !line.includes("session_meta") && !line.includes("turn_context")) continue;
        let raw;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        const record = isRecord(raw) ? raw : {};
        const payload = isRecord(record.payload) ? record.payload : {};
        const at = Date.parse(record.timestamp);
        if (record.type === "session_meta") {
          const id = text(payload.id);
          if (!state.session) {
            state.session = id;
            state.app = codexApp(text(payload.originator));
            if (/hermes/i.test(text(payload.originator))) state.external = true;
            if (text(payload.model)) state.model = text(payload.model);
          }
          continue;
        }
        if (record.type === "turn_context") {
          if (text(payload.model)) state.model = text(payload.model);
          continue;
        }
        if (record.type !== "event_msg" || payload.type !== "token_count") continue;
        const info = isRecord(payload.info) ? payload.info : {};
        const total = codexTokens(info.total_token_usage);
        if (!total) continue;
        const last = codexTokens(info.last_token_usage);
        const previous = state.total;
        state.total = total.tokens;
        const delta = previous && covers(total.tokens, previous)
          ? total.tokens.map((value, index) => value - previous[index])
          : last && covers(total.tokens, last.tokens)
            ? [...last.tokens]
            : null;
        const reasoningDelta = Math.max(0, total.reasoning - state.reasoning);
        state.reasoning = total.reasoning;
        if (!delta || (state.external && !state.session)) continue;
        if (state.external) continue;
        if (!delta[0] && !delta[2]) continue;
        if (!Number.isFinite(at)) continue;
        counted += 1;
        events.push({
          app: "codex",
          profile: root.profile,
          session: state.session || path.basename(file.path),
          model: state.model || "unknown",
          input: delta[0],
          output: delta[2],
          cached: Math.min(delta[1], delta[0]),
          reasoning: reasoningDelta,
          calls: 1,
          from: at,
          to: at,
          timing: "event",
        });
      }
      stream.close();
    }
  }
  status.codex = files
    ? { state: "ok", detail: `${files} файлов, ${counted} событий` }
    : { state: "missing", detail: "~/.codex/sessions не найден" };
  return events;
}

async function claudeRecords(env, events, status) {
  const roots = logRoots(env).filter((root) => root.source === "claude");
  let files = 0;
  let counted = 0;
  const seen = new Set();
  for (const root of roots) {
    for (const file of walk(root.path)) {
      files += 1;
      const stream = fs.createReadStream(file.path, { encoding: "utf8" });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line || !line.includes('"usage"')) continue;
        let raw;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        const record = isRecord(raw) ? raw : {};
        if (record.type !== "assistant" || record.isApiErrorMessage === true) continue;
        const message = isRecord(record.message) ? record.message : {};
        const usage = isRecord(message.usage) ? message.usage : {};
        const id = text(message.id);
        const at = Date.parse(record.timestamp);
        const model = text(message.model);
        if (!id || !Number.isFinite(at) || !model || model === "<synthetic>") continue;
        const input = asInt(usage.input_tokens);
        const output = asInt(usage.output_tokens);
        const read = usage.cache_read_input_tokens === undefined || usage.cache_read_input_tokens === null ? 0 : asInt(usage.cache_read_input_tokens);
        const write =
          usage.cache_creation_input_tokens === undefined || usage.cache_creation_input_tokens === null
            ? 0
            : asInt(usage.cache_creation_input_tokens);
        if (input === null || output === null || read === null || write === null) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        if (!input && !output && !read && !write) continue;
        counted += 1;
        events.push({
          app: "claude",
          profile: root.profile,
          session: text(record.sessionId) || path.basename(file.path),
          model,
          input: input + read + write,
          output,
          cached: read,
          reasoning: 0,
          calls: 1,
          from: at,
          to: at,
          timing: "event",
        });
      }
      stream.close();
    }
  }
  status.claude = files
    ? { state: "ok", detail: `${files} файлов, ${counted} сообщений` }
    : { state: "missing", detail: "~/.claude/projects не найден" };
  return events;
}

// ---------------------------------------------------------------- report

function emptyTotals() {
  return { input: 0, output: 0, cached: 0, reasoning: 0, calls: 0, sessions: 0, tokens: 0 };
}

function addTotals(target, add) {
  target.input += add.input;
  target.output += add.output;
  target.cached += add.cached;
  target.reasoning += add.reasoning;
  target.calls += add.calls;
  target.tokens += add.input + add.output;
}

function roundTotals(value) {
  const rounded = {};
  for (const key of ["input", "output", "cached", "reasoning", "calls", "sessions", "tokens"]) {
    rounded[key] = Math.round(value[key] ?? 0);
  }
  return rounded;
}

function distribute(record, from, to, emit) {
  const start = Math.max(record.from, from);
  const end = Math.min(record.to, to);
  if (end < start) return false;
  const span = record.to - record.from;
  if (span <= 0) {
    emit(dayKey(record.from), 1);
    return true;
  }
  const dayStart = new Date(start);
  dayStart.setHours(0, 0, 0, 0);
  let cursor = dayStart.getTime();
  while (cursor <= end) {
    const next = new Date(cursor);
    next.setDate(next.getDate() + 1);
    const overlap = Math.min(end, next.getTime() - 1) - Math.max(start, cursor) + 1;
    if (overlap > 0) emit(dayKey(cursor), overlap / span);
    cursor = next.getTime();
  }
  return true;
}

async function buildReport(app, from, to) {
  const env = process.env;
  const events = [];
  const status = {};
  hermesRecords(env, events, status);
  await codexRecords(env, events, status);
  await claudeRecords(env, events, status);
  opencodeRecords(env, events, status);

  const sources = [
    { id: "hermes", label: "Hermes", state: status.hermes?.state ?? "missing", detail: status.hermes?.detail ?? "" },
    { id: "codex", label: "Codex", state: status.codex?.state ?? "missing", detail: status.codex?.detail ?? "" },
    { id: "claude", label: "Claude Code", state: status.claude?.state ?? "missing", detail: status.claude?.detail ?? "" },
    { id: "opencode", label: "OpenCode", state: status.opencode?.state ?? "missing", detail: status.opencode?.detail ?? "" },
  ];

  const apps = new Map();
  for (const source of sources) {
    apps.set(source.id, {
      id: source.id,
      label: source.label,
      available: source.state === "ok",
      state: source.state,
      detail: source.detail,
      models: 0,
      sessions: 0,
      tokens: 0,
      lastActiveAt: 0,
    });
  }

  const models = new Map();
  const days = new Map();
  const sessionsByApp = new Map();
  const modelsByApp = new Map();
  const totals = emptyTotals();
  const scoped = app === "all" ? null : app;

  for (const record of events) {
    const appSummary = apps.get(record.app);
    const inScope = !scoped || record.app === scoped;
    let touched = false;
    distribute(record, from, to, (dayName, fraction) => {
      touched = true;
      const share = fraction;
      const part = {
        input: record.input * share,
        output: record.output * share,
        cached: record.cached * share,
        reasoning: record.reasoning * share,
        calls: record.calls * share,
        tokens: (record.input + record.output) * share,
      };
      appSummary.tokens += part.tokens;
      appSummary.lastActiveAt = Math.max(appSummary.lastActiveAt, record.to);
      let appModels = modelsByApp.get(record.app);
      if (!appModels) {
        appModels = new Set();
        modelsByApp.set(record.app, appModels);
      }
      appModels.add(record.model);
      if (!inScope) return;
      addTotals(totals, part);
      const modelKey = `${record.app}\u0000${record.model}`;
      let model = models.get(modelKey);
      if (!model) {
        model = { model: record.model, app: record.app, ...emptyTotals(), sessionSet: new Set() };
        models.set(modelKey, model);
      }
      addTotals(model, part);
      model.sessionSet.add(record.session);
      let day = days.get(dayName);
      if (!day) {
        day = { day: dayName, ...emptyTotals(), models: new Map(), sessionSet: new Set() };
        days.set(dayName, day);
      }
      addTotals(day, part);
      day.sessionSet.add(record.session);
      let dayModel = day.models.get(record.model);
      if (!dayModel) {
        dayModel = { model: record.model, ...emptyTotals() };
        day.models.set(record.model, dayModel);
      }
      addTotals(dayModel, part);
    });
    if (touched) {
      let set = sessionsByApp.get(record.app);
      if (!set) {
        set = new Set();
        sessionsByApp.set(record.app, set);
      }
      set.add(record.session);
    }
  }

  for (const [appId, set] of sessionsByApp) {
    const summary = apps.get(appId);
    if (summary) summary.sessions = set.size;
  }
  for (const [appId, set] of modelsByApp) {
    const summary = apps.get(appId);
    if (summary) summary.models = set.size;
  }

  const modelList = [...models.values()]
    .filter((model) => !scoped || model.app === scoped)
    .map((model) => ({
      model: model.model,
      app: model.app,
      ...roundTotals(model),
      sessions: model.sessionSet.size,
      share: totals.tokens ? (model.input + model.output) / totals.tokens : 0,
    }))
    .sort((a, b) => b.input + b.output - (a.input + a.output));

  const dayList = [...days.values()]
    .sort((a, b) => (a.day < b.day ? -1 : 1))
    .map((day) => ({
      day: day.day,
      ...roundTotals(day),
      sessions: day.sessionSet.size,
      models: [...day.models.values()]
        .map((model) => ({ model: model.model, ...roundTotals(model) }))
        .sort((a, b) => b.input + b.output - (a.input + a.output))
        .slice(0, 6),
    }));

  const sessionTotal = scoped ? sessionsByApp.get(scoped)?.size ?? 0 : [...sessionsByApp.values()].reduce((sum, set) => sum + set.size, 0);
  totals.sessions = sessionTotal;

  return {
    app,
    from,
    to,
    generatedAt: Date.now(),
    apps: [...apps.values()].map(({ tokens, lastActiveAt, ...rest }) => ({ ...rest, tokens: Math.round(tokens), lastActiveAt })),
    sources,
    totals: roundTotals(totals),
    models: modelList,
    days: dayList,
  };
}
