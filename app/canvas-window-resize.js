/*!
 * canvas-window-resize — addon for the CanvasTTY window-resize plugin.
 *
 * One file, three contexts, one hotkey scheme:
 *   Ctrl + '+' / '-'            resize the selected window
 *   Ctrl + Arrow, then '+'/'-'  resize towards that side
 *
 *   - CanvasTTY main window      -> resizes the selected layer. Plugin cards
 *                                  are selected by a click even though the app
 *                                  only marks them selected for groups; plugin
 *                                  iframes report their clicks back so the card
 *                                  lights up like a terminal.
 *   - Plugin canvas card (iframe)-> forwards the hotkey to the host, which
 *                                  resizes the card.
 *   - Standalone Electron window -> resizes the OS window itself
 *                                  (window.resizeTo / moveTo).
 *
 * Integration (newer resize plugin):
 *   1. drop this file next to the plugin (addons/canvas-window-resize.js);
 *   2. include it in the injected hook after the plugin code, or load it in a
 *      plugin page with <script src="..."> — it auto-installs;
 *   3. it exposes window.CanvasWindowResize = { install, plan, selectedLayers,
 *      resizeSelected, resizeElectronWindow, context };
 *   4. it sets window.__canvasWindowResizeActive, and an older resize hook can
 *      yield by checking that flag before handling Ctrl + '+' / '-'.
 *
 * Options (install(options)): factor, minWidth, minHeight, maxWidth, maxHeight,
 * arrowWindowMs, messageSource, extraSources, onEmptySelection, onGrowClamped.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CanvasWindowResize = api;
  if (root && root.document && root.__canvasWindowResizeAutostart !== false) api.install();
}(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  var DEFAULTS = {
    factor: 1.15,
    minWidth: 420,
    minHeight: 260,
    maxWidth: 1600,
    maxHeight: 1100,
    arrowWindowMs: 1200,
    messageSource: "canvas-window-resize",
    // Older hooks posted their hotkeys with this source; keep accepting it.
    extraSources: ["canvastty-plugin-hotkey"],
    onEmptySelection: null,
    onGrowClamped: null
  };

  var state = {
    options: null,
    context: null,      // "host" | "frame" | "window"
    direction: null,
    directionAt: 0,
    hostInstalled: false,
    clientInstalled: false
  };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function arrowOf(e) {
    var k = e.key || "";
    if (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") return k;
    var c = e.code || "";
    return c.indexOf("Arrow") === 0 ? c : null;
  }

  function dirName(arrow) {
    if (arrow === "ArrowLeft") return "left";
    if (arrow === "ArrowRight") return "right";
    if (arrow === "ArrowUp") return "up";
    if (arrow === "ArrowDown") return "down";
    return null;
  }

  function currentDirection() {
    if (!state.direction) return null;
    if (Date.now() - state.directionAt > state.options.arrowWindowMs) return null;
    return dirName(state.direction);
  }

  function clearDirection() { state.direction = null; state.directionAt = 0; }

  // Pure math, shared by every context. bounds: {position:{x,y}, size:{width,height}}
  // dir: "left" | "right" | "up" | "down" | null (proportional).
  function plan(bounds, factor, dir) {
    var o = state.options;
    var p = { x: bounds.position.x, y: bounds.position.y };
    var w = bounds.size.width, h = bounds.size.height;
    if (dir === "left" || dir === "right") {
      var right = p.x + w;
      w = Math.round(clamp(w * factor, o.minWidth, o.maxWidth));
      if (dir === "left") p.x = right - w;
    } else if (dir === "up" || dir === "down") {
      var bottom = p.y + h;
      h = Math.round(clamp(h * factor, o.minHeight, o.maxHeight));
      if (dir === "up") p.y = bottom - h;
    } else {
      w = Math.round(clamp(w * factor, o.minWidth, o.maxWidth));
      h = Math.round(clamp(h * factor, o.minHeight, o.maxHeight));
    }
    return { position: p, size: { width: w, height: h } };
  }

  function changed(before, next) {
    return before.size.width !== next.size.width || before.size.height !== next.size.height;
  }

  // ------------------------------------------------------------- selection

  function isSelected(el) {
    var c = el.classList;
    return c.contains("terminal-card--selected") ||
           c.contains("plugin-canvas-card--selected") ||
           c.contains("sticky-note-card--selected") ||
           c.contains("material-card--selected") ||
           c.contains("file-browser-card--selected") ||
           c.contains("browser-card--selected");
  }

  function selectedLayers() {
    var doc = root.document, out = [], seen = {};
    if (!doc) return out;
    var nodes = doc.querySelectorAll("[data-canvas-layer-id], [data-material-id]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isSelected(el)) continue;
      var layer = el.getAttribute("data-canvas-layer-id"), kind = null, id = null;
      if (layer) {
        var ci = layer.indexOf(":");
        kind = ci < 0 ? layer : layer.slice(0, ci);
        id = ci < 0 ? null : layer.slice(ci + 1);
      } else {
        kind = "material";
        id = el.getAttribute("data-material-id");
      }
      if (!id || seen[kind + ":" + id]) continue;
      seen[kind + ":" + id] = true;
      out.push({ kind: kind, id: id });
    }
    return out;
  }

  function selectPluginCard(card) {
    var cards = root.document.querySelectorAll(".plugin-canvas-card");
    for (var i = 0; i < cards.length; i++) {
      if (cards[i] !== card) cards[i].classList.remove("plugin-canvas-card--selected");
    }
    if (card) card.classList.add("plugin-canvas-card--selected");
  }

  function clearPluginSelection() {
    var cards = root.document.querySelectorAll(".plugin-canvas-card--selected");
    for (var i = 0; i < cards.length; i++) cards[i].classList.remove("plugin-canvas-card--selected");
  }

  function frameCard(source) {
    var frames = root.document.querySelectorAll("iframe.plugin-frame");
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow !== source) continue;
      return frames[i].closest(".plugin-canvas-card");
    }
    return null;
  }

  function frameLayer(source) {
    var card = frameCard(source);
    var layer = card && card.getAttribute("data-canvas-layer-id");
    if (!layer || layer.indexOf(":") < 0) return null;
    return { kind: layer.slice(0, layer.indexOf(":")), id: layer.slice(layer.indexOf(":") + 1) };
  }

  // ------------------------------------------------------------- host resize

  function hostResizeLayer(layer, factor, dir) {
    var api = root.canvasTTY;
    if (!api) return Promise.resolve(false);

    if (layer.kind === "terminal" && api.terminal && api.terminal.list) {
      return api.terminal.list().catch(function () { return []; }).then(function (sessions) {
        for (var i = 0; i < sessions.length; i++) {
          var s = sessions[i];
          if (s.id === layer.id && s.position && s.size) {
            api.terminal.setBounds(layer.id, plan(s, factor, dir));
            return true;
          }
        }
        return false;
      });
    }

    if (layer.kind === "material" && api.materials && api.materials.snapshot) {
      return api.materials.snapshot().catch(function () { return null; }).then(function (snap) {
        var materials = (snap && snap.materials) || [];
        for (var i = 0; i < materials.length; i++) {
          if (materials[i].id === layer.id && materials[i].position && materials[i].size) {
            api.materials.setBounds(layer.id, plan(materials[i], factor, dir));
            return true;
          }
        }
        return false;
      });
    }

    if (!api.settings || !api.settings.get) return Promise.resolve(false);
    return api.settings.get().catch(function () { return null; }).then(function (settings) {
      if (!settings) return false;
      var list = null, key = null;
      if (layer.kind === "plugin") { list = settings.pluginCanvas || []; key = "pluginCanvas"; }
      else if (layer.kind === "note") { list = settings.stickyNotes || []; key = "stickyNotes"; }
      else if (layer.kind === "files") { list = settings.fileCards || []; key = "fileCards"; }
      else if (layer.kind === "browser") {
        var browser = settings.browserCanvas;
        if (!browser || !browser.position || !browser.size) return false;
        return api.settings.update({ browserCanvas: plan(browser, factor, dir) })
          .then(function () { return true; }, function () { return false; });
      } else {
        return false;
      }
      for (var i = 0; i < list.length; i++) {
        if (list[i].id !== layer.id || !list[i].position || !list[i].size) continue;
        var next = plan(list[i], factor, dir);
        if (!changed(list[i], next)) return false;
        var patch = {};
        patch[key] = list.map(function (x) { return x.id === layer.id ? Object.assign({}, x, next) : x; });
        return api.settings.update(patch).then(function () { return true; }, function () { return false; });
      }
      return false;
    });
  }

  function hostResizeSelected(factor, dir) {
    var layers = selectedLayers();
    if (!layers.length) {
      if (typeof state.options.onEmptySelection === "function") state.options.onEmptySelection(factor > 1);
      return 0;
    }
    var growing = factor > 1;
    Promise.all(layers.map(function (layer) { return hostResizeLayer(layer, factor, dir); }))
      .then(function (results) {
        if (growing && results.indexOf(true) < 0 && typeof state.options.onGrowClamped === "function") {
          state.options.onGrowClamped(layers);
        }
      })
      .catch(function () {});
    return layers.length;
  }

  // ---------------------------------------------------------- electron window

  // Electron plugin windows report stale outerWidth/outerHeight (the renderer
  // keeps the size the window was created with), so the addon tracks the size
  // it asked for instead of trusting the window metrics.
  var LOGICAL_KEY = "canvas-window-resize.size";

  function loadLogicalSize() {
    try {
      var raw = root.localStorage ? root.localStorage.getItem(LOGICAL_KEY) : null;
      if (raw) {
        var v = JSON.parse(raw);
        if (v && v.width > 0 && v.height > 0) return { width: v.width, height: v.height };
      }
    } catch (e) {}
    var w = root.outerWidth, h = root.outerHeight;
    return {
      width: w && w > 0 ? w : state.options.minWidth,
      height: h && h > 0 ? h : state.options.minHeight
    };
  }

  function saveLogicalSize(size) {
    try {
      if (root.localStorage) root.localStorage.setItem(LOGICAL_KEY, JSON.stringify(size));
    } catch (e) {}
  }

  // Standalone Electron window: resize the OS window itself.
  function resizeOwnWindow(factor, dir) {
    var cur = loadLogicalSize();
    var next = plan({ position: { x: 0, y: 0 }, size: cur }, factor, dir);
    var nw = next.size.width, nh = next.size.height;
    if (nw === cur.width && nh === cur.height) return false;
    var x = root.screenX, y = root.screenY;
    var nx = x, ny = y;
    if (dir === "left") nx = x + cur.width - nw;
    else if (dir === "up") ny = y + cur.height - nh;
    root.resizeTo(nw, nh);
    if (nx !== x || ny !== y) root.moveTo(nx, ny);
    saveLogicalSize({ width: nw, height: nh });
    return true;
  }

  // ---------------------------------------------------------------- client

  function postToHost(type, extra) {
    var data = { source: state.options.messageSource, type: type };
    if (extra) for (var k in extra) data[k] = extra[k];
    root.parent.postMessage(data, "*");
  }

  function onMessage(e) {
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.source !== state.options.messageSource &&
        state.options.extraSources.indexOf(d.source) < 0) return;
    if (d.type === "activate") {
      var card = frameCard(e.source);
      if (card) selectPluginCard(card);
      return;
    }
    if (d.type !== "resize") return;
    if (typeof d.factor !== "number" || !(d.factor > 0)) return;
    var layer = frameLayer(e.source);
    if (layer) hostResizeLayer(layer, d.factor, d.direction || null);
  }

  // ------------------------------------------------------------------- keys

  function applyResize(factor, dir) {
    if (state.context === "host") hostResizeSelected(factor, dir);
    else if (state.context === "frame") postToHost("resize", { factor: factor, direction: dir });
    else resizeOwnWindow(factor, dir);
  }

  function onKeydown(e) {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    var t = e.target;
    if (t && t.closest && t.closest("input, textarea, select, [contenteditable='true']")) return;
    var arrow = arrowOf(e);
    if (arrow) {
      state.direction = arrow;
      state.directionAt = Date.now();
      return;
    }
    var plus = e.key === "+" || e.key === "=" || e.code === "NumpadAdd";
    var minus = e.key === "-" || e.key === "_" || e.code === "NumpadSubtract";
    if (!plus && !minus) return;
    e.preventDefault();
    applyResize(plus ? state.options.factor : 1 / state.options.factor, currentDirection());
  }

  function onKeyup(e) {
    if (e.key === "Control" || e.code === "ControlLeft" || e.code === "ControlRight" || arrowOf(e)) {
      clearDirection();
    }
  }

  // -------------------------------------------------------------- contexts

  // The main renderer gets `window.canvasTTY` from its preload before any page
  // script runs; standalone Electron plugin windows never have it. That makes
  // the context detectable immediately, without waiting for the app to boot.
  function detectContext() {
    if (root.parent && root.parent !== root) return "frame";
    if (root.canvasTTY) return "host";
    // The main renderer is a file: document; plugin windows are served from
    // canvastty-plugin:. This covers the moment before the preload bridge is up.
    if (root.location && root.location.protocol === "file:") return "host";
    return "window";
  }

  function boot() {
    if (state.context) return;
    start(detectContext());
  }

  function start(context) {
    if (state.context) return;
    state.context = context;
    if (context === "host") installHost();
    else installClient();
    root.__canvasWindowResizeActive = true;
  }

  function installHost() {
    if (state.hostInstalled) return;
    state.hostInstalled = true;
    root.addEventListener("pointerdown", function (e) {
      var t = e.target;
      var card = t && t.closest && t.closest(".plugin-canvas-card");
      if (card) selectPluginCard(card);
      else clearPluginSelection();
    }, true);
    root.addEventListener("keydown", onKeydown, true);
    root.addEventListener("keyup", onKeyup, true);
    root.addEventListener("blur", clearDirection, true);
    root.addEventListener("message", onMessage);
  }

  function installClient() {
    if (state.clientInstalled) return;
    state.clientInstalled = true;
    root.addEventListener("keydown", onKeydown, true);
    root.addEventListener("keyup", onKeyup, true);
    root.addEventListener("blur", clearDirection, true);
    if (state.context === "frame") {
      // A click inside a cross-origin iframe never reaches the canvas document,
      // so the plugin reports it and the host selects the card.
      root.addEventListener("pointerdown", function () { postToHost("activate"); }, true);
    }
  }

  // The canvas-tty-plugins resize plugin can be switched off in localStorage;
  // honour that so the addon never fights the user's settings.
  function resizePluginOn() {
    try {
      var saved = root.localStorage ? root.localStorage.getItem("cttyPlugins") : null;
      if (saved === null || saved === "" || saved === "all") return true;
      var on = {};
      saved.split(",").forEach(function (k) { on[String(k).trim()] = true; });
      return !!on.resize;
    } catch (e) { return true; }
  }

  function install(options) {
    if (state.options) return state;
    state.options = Object.assign({}, DEFAULTS, options || {});
    if (!resizePluginOn()) return state;
    boot();
    return state;
  }

  function configure(options) {
    if (!state.options) install();
    if (options) state.options = Object.assign({}, state.options, options);
    return state.options;
  }

  return {
    install: install,
    configure: configure,
    plan: plan,
    context: function () { return state.context; },
    selectedLayers: function () { return state.context === "host" ? selectedLayers() : []; },
    resizeSelected: function (factor, dir) { return hostResizeSelected(factor, dir); },
    resizeElectronWindow: resizeOwnWindow,
    version: "1.0.0"
  };
}));
