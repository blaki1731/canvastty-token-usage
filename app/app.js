"use strict";

const sdk = window.CanvasTTYPlugin;
const state = {
  locale: "ru",
  app: "all",
  preset: "7d",
  from: null,
  to: null,
  data: null,
  apps: [],
  theme: null,
  bgMode: "mono",
  loading: false,
  error: null,
};

const BG_MODES = [
  { id: "mono", label: "Монохром" },
  { id: "canvas", label: "Как в Canvas" },
  { id: "glass", label: "Полупрозрачный" },
];

const THEME_VARS = ["surface", "surfaceSoft", "surfaceElevated", "primary", "text", "muted", "border", "canvas"];

function camelToKebab(value) {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement;
  for (const key of THEME_VARS) {
    if (theme[key]) root.style.setProperty(`--${camelToKebab(key)}`, theme[key]);
  }
  if (theme.shadow) root.style.setProperty("--shadow-lg", theme.shadow);
}

function applyBgMode() {
  document.body.classList.toggle("standalone", window.parent === window);
  for (const mode of BG_MODES) {
    document.body.classList.toggle(`bg-${mode.id}`, state.bgMode === mode.id);
  }
  for (const button of document.querySelectorAll("#bg-switch button")) {
    button.classList.toggle("active", button.dataset.bg === state.bgMode);
  }
}

async function loadTheme() {
  if (!sdk) return;
  try {
    const theme = await call("theme.get", {});
    state.theme = theme;
    applyTheme(theme);
  } catch {}
}

const PRESETS = [
  { id: "24h", label: "24 ч", hours: 24 },
  { id: "7d", label: "7 дней", hours: 24 * 7 },
  { id: "30d", label: "30 дней", hours: 24 * 30 },
  { id: "all", label: "Всё время", hours: null },
];

const T = {
  ru: {
    title: "Расход токенов",
    subtitle: "по моделям CLI-агентов",
    allApps: "Все приложения",
    models: "Модели",
    days: "По дням",
    input: "Вход",
    output: "Выход",
    cached: "Кэш (чтение)",
    reasoning: "Рассуждения",
    calls: "Вызовы API",
    sessions: "Сессии",
    share: "Доля",
    model: "Модель",
    refresh: "Обновить",
    apply: "Применить",
    empty: "Нет данных за выбранный период",
    loading: "Читаю журналы агентов…",
    needService: "Сервис сбора данных не запущен. Включите плагин и его native code в «Настройки → Плагины», затем перезапустите окно.",
    noSdk: "Это окно должно открываться внутри CanvasTTY.",
    tokensShort: "токенов",
    rangeLabel: (from, to) =>
      `${fmtDate(from)} — ${fmtDate(to)}`,
    note: "Hermes и OpenCode: токены сессии распределяются равномерно между первым и последним наблюдением. Codex и Claude Code — по событиям журнала.",
    sourceNote: "Источники",
    modelsCount: (n) => `${n} мод.`,
    appReady: "готов",
    appMissing: "нет данных",
    appError: "ошибка",
  },
  en: {
    title: "Token usage",
    subtitle: "per model for CLI agents",
    allApps: "All applications",
    models: "Models",
    days: "By day",
    input: "Input",
    output: "Output",
    cached: "Cache (read)",
    reasoning: "Reasoning",
    calls: "API calls",
    sessions: "Sessions",
    share: "Share",
    model: "Model",
    refresh: "Refresh",
    apply: "Apply",
    empty: "No data for the selected period",
    loading: "Reading agent logs…",
    needService: "The collection service is not running. Enable the plugin and its native code in Settings → Plugins, then reopen this window.",
    noSdk: "This window must be opened inside CanvasTTY.",
    tokensShort: "tokens",
    rangeLabel: (from, to) => `${fmtDate(from)} — ${fmtDate(to)}`,
    note: "Hermes and OpenCode: session tokens are spread evenly between the first and last observation. Codex and Claude Code: log events.",
    sourceNote: "Sources",
    modelsCount: (n) => `${n} models`,
    appReady: "ready",
    appMissing: "no data",
    appError: "error",
  },
};

const fmtFull = new Intl.NumberFormat("ru-RU");
const fmtCompact = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });
const fmtDate = (ms) => {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date);
};
const fmtTime = (ms) =>
  new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
const compact = (n) => fmtCompact.format(n);
const full = (n) => fmtFull.format(n);

function pluralRu(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// Window resize hotkeys, mirroring the canvas-tty-plugins "resize" plugin:
// Ctrl + "+" / "-" scales by 1.15 (420x260 .. 1600x1100), and a Ctrl + arrow
// pressed shortly before grows the window/card towards that side.
const RESIZE_FACTOR = 1.15;
const RESIZE_MIN_W = 420, RESIZE_MIN_H = 260, RESIZE_MAX_W = 1600, RESIZE_MAX_H = 1100;
const RESIZE_ARROW_MS = 1200;
let resizeDirection = null;
let resizeDirectionAt = 0;

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function resizeKeyDirection(event) {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
    return event.key;
  }
  return String(event.code || "").startsWith("Arrow") ? event.code : null;
}

// Standalone Electron window: resize the OS window itself.
function resizeOwnWindow(factor, direction) {
  const x = window.screenX, y = window.screenY, width = window.outerWidth, height = window.outerHeight;
  const right = x + width, bottom = y + height;
  let nextWidth = width, nextHeight = height, nextX = x, nextY = y;
  if (direction === "ArrowLeft" || direction === "ArrowRight") {
    nextWidth = clamp(Math.round(width * factor), RESIZE_MIN_W, RESIZE_MAX_W);
    if (direction === "ArrowLeft") nextX = right - nextWidth;
  } else if (direction === "ArrowUp" || direction === "ArrowDown") {
    nextHeight = clamp(Math.round(height * factor), RESIZE_MIN_H, RESIZE_MAX_H);
    if (direction === "ArrowUp") nextY = bottom - nextHeight;
  } else {
    nextWidth = clamp(Math.round(width * factor), RESIZE_MIN_W, RESIZE_MAX_W);
    nextHeight = clamp(Math.round(height * factor), RESIZE_MIN_H, RESIZE_MAX_H);
  }
  if (nextWidth === width && nextHeight === height) return;
  window.resizeTo(nextWidth, nextHeight);
  if (nextX !== x || nextY !== y) window.moveTo(nextX, nextY);
}

function forwardResizeToCanvas(factor, direction) {
  // Canvas card: the resize plugin's hook (in the main window) resizes the
  // card that owns this iframe.
  window.parent.postMessage({ source: "canvastty-plugin-hotkey", type: "resize", factor, direction }, "*");
}

function wireResizeHotkeys() {
  // A click inside this iframe never reaches the canvas document (cross-origin
  // iframe), so the card would never look selected and the canvas-wide
  // Ctrl+/Ctrl- handler would have no target. Tell the host we were clicked.
  if (window.parent !== window) {
    window.addEventListener("pointerdown", () => {
      window.parent.postMessage({ source: "canvastty-plugin-hotkey", type: "activate" }, "*");
    }, true);
  }
  window.addEventListener("keydown", (event) => {
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target;
    if (target && target.closest && target.closest("input, textarea, select, [contenteditable='true']")) return;
    const direction = resizeKeyDirection(event);
    if (direction) {
      resizeDirection = direction;
      resizeDirectionAt = Date.now();
      return;
    }
    const plus = event.key === "+" || event.key === "=" || event.code === "NumpadAdd";
    const minus = event.key === "-" || event.key === "_" || event.code === "NumpadSubtract";
    if (!plus && !minus) return;
    event.preventDefault();
    const armed = Date.now() - resizeDirectionAt <= RESIZE_ARROW_MS ? resizeDirection : null;
    const factor = plus ? RESIZE_FACTOR : 1 / RESIZE_FACTOR;
    if (window.parent === window) resizeOwnWindow(factor, armed);
    else forwardResizeToCanvas(factor, armed);
  }, true);
}

function el(id) {
  return document.getElementById(id);
}

function rangeFromPreset(preset, now = Date.now()) {
  const found = PRESETS.find((item) => item.id === preset);
  if (!found) return null;
  if (found.hours === null) return { from: 0, to: now };
  return { from: now - found.hours * 3600000, to: now };
}

function toLocalInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function call(method, params) {
  return sdk.service.request("usage", method, params);
}

async function load() {
  if (!sdk) {
    state.error = T.ru.noSdk;
    render();
    return;
  }
  state.loading = true;
  state.error = null;
  render();
  try {
    const now = Date.now();
    let range = rangeFromPreset(state.preset, now);
    if (state.preset === "custom" && state.from && state.to) range = { from: state.from, to: state.to };
    if (!range) range = rangeFromPreset("7d", now);
    const data = await call("usage.query", { app: state.app, from: range.from, to: range.to });
    state.data = data;
    state.apps = data.apps ?? [];
    state.from = data.from;
    state.to = data.to;
  } catch (error) {
    state.error = String(error?.message ?? error);
    state.data = null;
  } finally {
    state.loading = false;
    render();
  }
}

function render() {
  renderBanner();
  renderAppList();
  renderHeader();
  renderSummary();
  renderModels();
  renderChart();
  renderSources();
}

function renderBanner() {
  const banner = el("banner");
  if (state.error) {
    banner.hidden = false;
    banner.className = "banner";
    banner.textContent = /native code|не запущен|not running/i.test(state.error)
      ? `${T[state.locale].needService} (${state.error})`
      : state.error;
    return;
  }
  if (!state.loading && state.data && state.data.totals.tokens === 0) {
    banner.hidden = false;
    banner.className = "banner info";
    banner.textContent = T[state.locale].empty;
    return;
  }
  banner.hidden = true;
}

function renderAppList() {
  const nav = el("app-list");
  nav.textContent = "";
  const apps = [{ id: "all", label: T[state.locale].allApps, available: true, tokens: 0, sessions: 0, models: 0, state: "ok", detail: "" }];
  const totals = state.data?.totals ?? {};
  apps[0].tokens = totals.tokens ?? 0;
  apps[0].sessions = totals.sessions ?? 0;
  for (const app of state.apps) apps.push(app);

  for (const app of apps) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `app-item${app.id === state.app ? " active" : ""}`;
    const dot = document.createElement("span");
    dot.className = `dot ${app.state === "ok" || app.id === "all" ? "ok" : app.state === "error" ? "error" : "missing"}`;
    const body = document.createElement("span");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = app.label;
    const meta = document.createElement("div");
    meta.className = "meta";
    const metaText =
      app.id === "all"
        ? `${full(app.sessions)} ${pluralRu(app.sessions, "сессия", "сессии", "сессий")}`
        : `${app.models} ${pluralRu(app.models, "модель", "модели", "моделей")} · ${app.sessions} ${pluralRu(app.sessions, "сессия", "сессии", "сессий")}`;
    meta.textContent = app.state === "ok" ? metaText : T[state.locale][app.state === "error" ? "appError" : "appMissing"];
    body.append(name, meta);
    const tokens = document.createElement("span");
    tokens.className = "tokens";
    tokens.textContent = compact(app.tokens);
    button.append(dot, body, tokens);
    button.addEventListener("click", () => {
      state.app = app.id;
      saveUiState();
      load();
    });
    nav.append(button);
  }
}

function renderHeader() {
  const labels = { all: T[state.locale].allApps };
  for (const app of state.apps) labels[app.id] = app.label;
  el("current-app").textContent = labels[state.app] ?? T[state.locale].allApps;
  const rangeText = state.from !== null ? T[state.locale].rangeLabel(state.from, state.to) : "";
  const collected = state.data?.sources?.find((source) => source.state === "ok");
  el("current-range").textContent = state.loading
    ? T[state.locale].loading
    : `${rangeText}${collected ? "" : state.apps.some((a) => a.state === "missing") ? " · нет источников" : ""}`;

  const presets = el("range-presets");
  if (presets.childElementCount !== PRESETS.length) {
    presets.textContent = "";
    for (const preset of PRESETS) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.preset = preset.id;
      button.textContent = preset.label;
      button.addEventListener("click", () => {
        state.preset = preset.id;
        saveUiState();
        load();
      });
      presets.append(button);
    }
  }
  for (const button of presets.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.preset === state.preset);
  }
  el("custom-range").style.display = "inline-flex";
  if (state.preset === "custom") {
    el("from-input").value = toLocalInput(state.from ?? Date.now() - 7 * 86400000);
    el("to-input").value = toLocalInput(state.to ?? Date.now());
  }
  el("refresh").disabled = state.loading;
}

function renderSummary() {
  const box = el("summary");
  const totals = state.data?.totals;
  if (!totals) {
    box.textContent = "";
    return;
  }
  const cards = [
    { label: T[state.locale].input, value: totals.input, sub: `${compact(totals.cached)} ${T[state.locale].cached.toLowerCase()}` },
    { label: T[state.locale].output, value: totals.output, sub: "" },
    { label: T[state.locale].cached, value: totals.cached, sub: "" },
    { label: T[state.locale].reasoning, value: totals.reasoning, sub: "" },
    { label: T[state.locale].calls, value: totals.calls, sub: "" },
    { label: T[state.locale].sessions, value: totals.sessions, sub: "" },
  ];
  box.textContent = "";
  for (const card of cards) {
    const div = document.createElement("div");
    div.className = "card";
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = card.label;
    const value = document.createElement("div");
    value.className = "value";
    value.textContent = compact(card.value);
    value.title = full(card.value);
    div.append(label, value);
    if (card.sub) {
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = card.sub;
      div.append(sub);
    }
    box.append(div);
  }
}

function renderModels() {
  const table = el("models-table");
  const models = state.data?.models ?? [];
  if (!models.length) {
    table.textContent = "";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = state.loading ? T[state.locale].loading : T[state.locale].empty;
    table.append(empty);
    return;
  }
  table.textContent = "";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const key of ["model", "input", "output", "cached", "reasoning", "calls", "sessions", "share"]) {
    const th = document.createElement("th");
    th.textContent = T[state.locale][key];
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  for (const model of models) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.className = "model";
    name.textContent = model.model;
    name.title = model.model;
    tr.append(name);
    for (const key of ["input", "output", "cached", "reasoning", "calls", "sessions"]) {
      const td = document.createElement("td");
      td.className = "num";
      td.textContent = full(model[key]);
      td.title = full(model[key]);
      tr.append(td);
    }
    const share = document.createElement("td");
    const bar = document.createElement("div");
    bar.className = "share-bar";
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(1, Math.round((model.share ?? 0) * 100))}%`;
    bar.append(fill);
    share.append(bar);
    share.title = `${((model.share ?? 0) * 100).toFixed(1)}%`;
    tr.append(share);
    tbody.append(tr);
  }
  table.append(thead, tbody);
}

function renderChart() {
  const box = el("chart");
  const days = state.data?.days ?? [];
  box.textContent = "";
  if (!days.length) return;
  const width = 900;
  const height = 170;
  const padTop = 12;
  const padBottom = 22;
  const padX = 4;
  const max = Math.max(...days.map((day) => day.input + day.output), 1);
  const innerHeight = height - padTop - padBottom;
  const slot = (width - padX * 2) / days.length;
  const barWidth = Math.max(2, Math.min(34, slot * 0.62));
  const parts = [];
  parts.push(`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${T[state.locale].days}">`);
  days.forEach((day, index) => {
    const x = padX + index * slot + (slot - barWidth) / 2;
    const inputH = (day.input / max) * innerHeight;
    const outputH = (day.output / max) * innerHeight;
    const yInput = padTop + innerHeight - inputH;
    const yOutput = yInput - outputH;
    const total = day.input + day.output;
    const top = (day.models ?? [])[0];
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${yInput.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0, inputH).toFixed(1)}" fill="#8fb6d8" rx="1"><title>${day.day}: ${full(day.input)} ${T[state.locale].input.toLowerCase()} · ${full(day.output)} ${T[state.locale].output.toLowerCase()} · ${full(total)} ${T[state.locale].tokensShort}${top ? ` · ${top.model}` : ""}</title></rect>`,
    );
    if (outputH > 0) {
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${yOutput.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(0, outputH).toFixed(1)}" fill="#c9a2d8" rx="1"><title>${day.day}: ${full(day.output)} ${T[state.locale].output.toLowerCase()}</title></rect>`,
      );
    }
    if (days.length <= 12 || index % Math.ceil(days.length / 12) === 0) {
      const short = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" }).format(new Date(`${day.day}T12:00:00`));
      parts.push(`<text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 6}" fill="#a9a6b8" font-size="9" text-anchor="middle">${short}</text>`);
    }
  });
  parts.push("</svg>");
  box.innerHTML = parts.join("");
  const legend = document.createElement("div");
  legend.className = "chart-legend";
  legend.innerHTML = `<span><i style="background:#8fb6d8"></i>${T[state.locale].input}</span><span><i style="background:#c9a2d8"></i>${T[state.locale].output}</span>`;
  box.append(legend);
}

function renderSources() {
  const box = el("sources");
  const sources = state.data?.sources ?? [];
  box.textContent = "";
  const note = document.createElement("div");
  note.className = "row";
  note.textContent = T[state.locale].note;
  box.append(note);
  for (const source of sources) {
    const row = document.createElement("div");
    row.className = "row";
    const tag = document.createElement("span");
    tag.className = `tag ${source.state}`;
    tag.textContent = source.state === "ok" ? T[state.locale].appReady : source.state === "error" ? T[state.locale].appError : T[state.locale].appMissing;
    const label = document.createElement("span");
    label.textContent = `${source.label}: ${source.detail || "—"}`;
    row.append(tag, label);
    box.append(row);
  }
}

function saveUiState() {
  if (!sdk?.storage) return;
  sdk.storage
    .set("ui-state", { app: state.app, preset: state.preset, from: state.from, to: state.to, bgMode: state.bgMode })
    .catch(() => {});
}

async function restoreUiState() {
  if (!sdk?.storage) return;
  try {
    const saved = await sdk.storage.get("ui-state");
    if (saved && typeof saved === "object") {
      if (typeof saved.app === "string") state.app = saved.app;
      if (typeof saved.preset === "string") state.preset = saved.preset;
      if (Number.isFinite(saved.from)) state.from = saved.from;
      if (Number.isFinite(saved.to)) state.to = saved.to;
      if (BG_MODES.some((mode) => mode.id === saved.bgMode)) state.bgMode = saved.bgMode;
    }
  } catch {}
}

function wireControls() {
  el("refresh").addEventListener("click", load);
  for (const button of el("bg-switch").querySelectorAll("button")) {
    button.addEventListener("click", () => {
      state.bgMode = button.dataset.bg;
      saveUiState();
      applyBgMode();
    });
  }
  el("apply-range").addEventListener("click", () => {
    const from = new Date(el("from-input").value).getTime();
    const to = new Date(el("to-input").value).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return;
    state.preset = "custom";
    state.from = from;
    state.to = to;
    saveUiState();
    load();
  });
}

async function main() {
  if (!sdk) {
    render();
    return;
  }
  sdk.ready();
  sdk.onContext((context) => {
    state.locale = context?.appearance?.locale === "en" ? "en" : "ru";
    document.documentElement.lang = state.locale;
    render();
  });
  sdk.onVisibilityChange((visibility) => {
    if (visibility === "visible") load();
  });
  wireControls();
  wireResizeHotkeys();
  await restoreUiState();
  applyBgMode();
  await loadTheme();
  await load();
  setInterval(() => {
    if (document.visibilityState === "visible") load();
  }, 60000);
}

main();
