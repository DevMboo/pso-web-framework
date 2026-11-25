"use strict";
(function () {
  var script = document.currentScript;
  var ROOT = new URL("../", script.src).href;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  };
  function announce(msg) { var s = $("#sr-status"); if (s) { s.textContent = ""; setTimeout(function () { s.textContent = msg; }, 30); } }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === "text") n.textContent = attrs[k]; else if (k === "class") n.className = attrs[k]; else n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { n.append(c); });
    return n;
  }
  function icon(name) {
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("class", "icon"); s.setAttribute("aria-hidden", "true"); s.setAttribute("focusable", "false");
    var u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "#i-" + name); s.appendChild(u);
    return s;
  }

  /* ---------- theme ---------- */
  var themeBtn = $("#theme-toggle");
  function syncTheme() { if (themeBtn) themeBtn.setAttribute("aria-pressed", String(document.documentElement.getAttribute("data-theme") === "light")); }
  if (themeBtn) themeBtn.addEventListener("click", function () {
    var next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next); store.set("pso-theme", next); syncTheme(); announce("Theme: " + next);
  });
  syncTheme();

  /* ---------- navigation ---------- */
  var sidebar = $("#sidebar"), menuBtn = $(".menu-btn");
  function setNav(open) { if (!sidebar || !menuBtn) return; sidebar.classList.toggle("is-open", open); menuBtn.setAttribute("aria-expanded", String(open)); menuBtn.setAttribute("aria-label", open ? "Close navigation" : "Open navigation"); }
  if (menuBtn && sidebar) {
    menuBtn.addEventListener("click", function () { setNav(!sidebar.classList.contains("is-open")); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && sidebar.classList.contains("is-open")) { setNav(false); menuBtn.focus(); } });
    if (sidebar) sidebar.addEventListener("click", function (e) { if (e.target.closest && e.target.closest("a")) setNav(false); });
  }
  var openSections = {};
  try { openSections = JSON.parse(store.get("pso-nav") || "{}"); } catch (e) { openSections = {}; }
  $$(".nav-section").forEach(function (d) {
    var id = d.getAttribute("data-section");
    if (!d.open && openSections[id]) d.open = true;
    d.addEventListener("toggle", function () { openSections[id] = d.open; store.set("pso-nav", JSON.stringify(openSections)); });
  });
  var current = $('.sidebar a[aria-current="page"]');
  if (current && current.scrollIntoView) current.scrollIntoView({ block: "center" });

  var ver = $("[data-version-select]");
  if (ver) ver.addEventListener("change", function () { var o = ver.options[ver.selectedIndex]; var h = o.getAttribute("data-href"); if (h) location.href = h; });
  var docsVersion = (($('meta[name="pso-docs-version"]') || {}).content) || "";
  // only a page served by `pso docs` can be compared with an installed CLI: static hosting has nothing to ask (and nothing to fail)
  if (/^https?:$/.test(location.protocol) && docsVersion && $('meta[name="pso-docs-server"]')) {
    fetch(new URL("__pso/version", new URL("/", location.href)).href, { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (j && j.version && j.version !== docsVersion) {
        var box = el("aside", { class: "callout callout-warning", role: "status" }, [el("div", { class: "callout-title" }, [icon("triangle-alert"), el("span", { text: "Documentation version mismatch" })]), el("div", { class: "callout-body" }, [el("p", { text: "You are reading PSO Web " + docsVersion + " documentation, but the installed pso CLI is " + j.version + ". Commands and behavior may differ." })])]);
        var host = $("article") || $("main"); if (host) host.insertBefore(box, host.firstChild);
      }
    }).catch(function () { /* static hosting: no CLI to compare with */ });
  }

  /* ---------- code copy ---------- */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var t = el("textarea", { "aria-hidden": "true" }); t.value = text; t.style.position = "fixed"; t.style.opacity = "0"; document.body.appendChild(t); t.select();
      try { document.execCommand("copy") ? resolve() : reject(new Error("copy failed")); } catch (e) { reject(e); } finally { t.remove(); }
    });
  }
  function flash(btn, ok) {
    var label = $(".copy-label", btn); var old = btn.getAttribute("data-label") || (label && label.textContent) || "Copy";
    btn.setAttribute("data-label", old);
    if (label) label.textContent = ok ? "Copied" : "Copy failed"; btn.classList.toggle("is-copied", ok); announce(ok ? "Copied to clipboard" : "Copy failed");
    setTimeout(function () { if (label) label.textContent = old; btn.classList.remove("is-copied"); }, 1600);
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("button.copy");
    if (!b) return;
    copyText(b.getAttribute("data-code") || "").then(function () { flash(b, true); }, function () { flash(b, false); });
  });

  /* ---------- tabs ---------- */
  $$("[data-tabs]").forEach(function (t) {
    var tabs = $$('[role="tab"]', t), panels = $$('[role="tabpanel"]', t);
    function select(i, focus) { tabs.forEach(function (x, k) { x.setAttribute("aria-selected", String(k === i)); x.tabIndex = k === i ? 0 : -1; panels[k].hidden = k !== i; }); if (focus) tabs[i].focus(); }
    tabs.forEach(function (x, i) {
      x.addEventListener("click", function () { select(i, false); });
      x.addEventListener("keydown", function (e) {
        var k = e.key, n = tabs.length;
        if (k === "ArrowRight") { select((i + 1) % n, true); e.preventDefault(); } else if (k === "ArrowLeft") { select((i + n - 1) % n, true); e.preventDefault(); }
        else if (k === "Home") { select(0, true); e.preventDefault(); } else if (k === "End") { select(n - 1, true); e.preventDefault(); }
      });
    });
  });

  /* ---------- table of contents tracking ---------- */
  var tocLinks = $$(".toc a[href^='#']");
  if (tocLinks.length && "IntersectionObserver" in window) {
    var map = {}; tocLinks.forEach(function (a) { map[a.getAttribute("href").slice(1)] = a; });
    var heads = Object.keys(map).map(function (id) { return document.getElementById(id); }).filter(Boolean);
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { tocLinks.forEach(function (a) { a.classList.remove("is-active"); a.removeAttribute("aria-current"); }); var a = map[en.target.id]; if (a) { a.classList.add("is-active"); a.setAttribute("aria-current", "location"); } } });
    }, { rootMargin: "-70px 0px -70% 0px" });
    heads.forEach(function (h) { io.observe(h); });
  }

  /* ---------- diagrams ---------- */
  $$("[data-diagram]").forEach(function (fig) {
    var nodes = $$("[data-node]", fig), steps = $$("[data-step]", fig);
    function activate(i) { nodes.forEach(function (n) { var on = n.getAttribute("data-node") === String(i); n.classList.toggle("is-active", on); n.setAttribute("aria-pressed", String(on)); }); steps.forEach(function (s) { var on = s.getAttribute("data-step") === String(i); s.classList.toggle("is-active", on); if (on && s.scrollIntoView && fig.getBoundingClientRect().width < 760) s.scrollIntoView({ block: "nearest" }); }); }
    nodes.forEach(function (n) {
      n.setAttribute("aria-pressed", "false");
      n.addEventListener("click", function () { activate(n.getAttribute("data-node")); });
      n.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(n.getAttribute("data-node")); } });
    });
  });

  /* ---------- local search ---------- */
  var INDEX = window.PSO_SEARCH || [];
  var dlg = null, input = null, list = null, opener = null, results = [], sel = 0;
  function terms(q) { return q.toLowerCase().split(/[^a-z0-9:_.\-\/@]+/).filter(function (t) { return t.length > 0; }); }
  function score(e, ts, raw) {
    var title = e.t.toLowerCase(), kw = (e.w || "").toLowerCase(), desc = (e.d || "").toLowerCase(), text = (e.x || "").toLowerCase(), total = 0, headHit = null;
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i], s = 0;
      if (title === t || title === "pso " + t) s += 30; else if (title.indexOf(t) === 0 || title.indexOf("pso " + t) === 0) s += 16; else if (title.indexOf(t) >= 0) s += 10;
      if (kw.split(" ").indexOf(t) >= 0) s += 8; else if (kw.indexOf(t) >= 0) s += 5;
      var hs = e.h || [];
      for (var k = 0; k < hs.length; k++) if (hs[k][0].toLowerCase().indexOf(t) >= 0) { s += 6; headHit = headHit || hs[k]; break; }
      if (desc.indexOf(t) >= 0) s += 3;
      if (text.indexOf(t) >= 0) s += 1;
      if (!s) return null;
      total += s;
    }
    if (e.k === "Command" && /^pso\b|:/.test(raw)) total += 4;
    return { total: total, head: headHit };
  }
  function highlight(node, text, ts) {
    var lower = text.toLowerCase(), marks = [];
    ts.forEach(function (t) { var i = lower.indexOf(t); if (i >= 0) marks.push([i, i + t.length]); });
    marks.sort(function (a, b) { return a[0] - b[0]; });
    var pos = 0;
    marks.forEach(function (m) { if (m[0] < pos) return; node.append(document.createTextNode(text.slice(pos, m[0]))); node.append(el("mark", { text: text.slice(m[0], m[1]) })); pos = m[1]; });
    node.append(document.createTextNode(text.slice(pos)));
  }
  function snippet(e, ts) {
    var src = e.d || ""; if (e.x) { var low = e.x.toLowerCase(); for (var i = 0; i < ts.length; i++) { var p = low.indexOf(ts[i]); if (p >= 0 && !(e.d || "").toLowerCase().includes(ts[i])) { src = (p > 70 ? "…" : "") + e.x.slice(Math.max(0, p - 70), p + 110) + "…"; break; } } }
    return src.length > 190 ? src.slice(0, 187) + "…" : src;
  }
  function run(q) {
    var ts = terms(q); list.textContent = ""; results = []; sel = 0;
    if (!ts.length) { list.append(el("li", { class: "search-empty", role: "presentation", text: "Type to search guides, commands, decorators, error codes and configuration." })); input.setAttribute("aria-expanded", "false"); return; }
    INDEX.forEach(function (e) { var s = score(e, ts, q.toLowerCase()); if (s) results.push({ e: e, s: s.total, h: s.head }); });
    results.sort(function (a, b) { return b.s - a.s || (a.e.t < b.e.t ? -1 : 1); });
    results = results.slice(0, 14);
    if (!results.length) { list.append(el("li", { class: "search-empty", role: "presentation", text: 'No results for "' + q + '".' })); input.setAttribute("aria-expanded", "false"); return; }
    results.forEach(function (r, i) {
      var target = ROOT + r.e.u.split("#")[0] + (r.h ? "#" + r.h[1] : (r.e.u.indexOf("#") >= 0 ? "#" + r.e.u.split("#")[1] : ""));
      var a = el("div", { class: "sr-link" });
      var title = el("span", { class: "sr-head" }); var t = el("span"); highlight(t, r.e.t, ts); title.append(t, el("span", { class: "sr-kind", text: r.e.k }), el("span", { class: "sr-path", text: r.e.s + (r.h ? " › " + r.h[0] : "") }));
      var d = el("div", { class: "sr-desc" }); highlight(d, snippet(r.e, ts), ts);
      a.append(title, d);
      var li = el("li", { class: "search-result", role: "option", id: "sr-" + i, "aria-selected": String(i === 0), "data-href": target }); li.append(a); li.addEventListener("click", function () { location.href = target; }); list.append(li);
    });
    input.setAttribute("aria-expanded", "true"); input.setAttribute("aria-activedescendant", "sr-0");
    announce(results.length + " results");
  }
  function select(i) { var items = $$(".search-result", list); if (!items.length) return; sel = (i + items.length) % items.length; items.forEach(function (x, k) { x.setAttribute("aria-selected", String(k === sel)); }); input.setAttribute("aria-activedescendant", "sr-" + sel); items[sel].scrollIntoView({ block: "nearest" }); }
  function openSearch(from) {
    if (!dlg) {
      input = el("input", { class: "search-input", type: "text", role: "combobox", "aria-expanded": "false", "aria-controls": "search-results", "aria-autocomplete": "list", "aria-label": "Search documentation", placeholder: "Search guides, commands, decorators, error codes...", autocomplete: "off", spellcheck: "false" });
      list = el("ul", { class: "search-results", id: "search-results", role: "listbox", "aria-label": "Search results" });
      var row = el("div", { class: "search-input-row" }, [icon("search"), input]);
      var foot = el("div", { class: "search-foot" }, [el("span", { text: "Up/Down to move" }), el("span", { text: "Enter to open" }), el("span", { text: "Esc to close" }), el("span", { text: "Searches locally, no network" })]);
      var panel = el("div", { class: "search-panel" }, [row, list, foot]);
      dlg = el("div", { class: "search-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Search" }, [panel]);
      document.body.appendChild(dlg);
      dlg.addEventListener("mousedown", function (e) { if (e.target === dlg) closeSearch(); });
      input.addEventListener("input", function () { run(input.value); });
      input.addEventListener("keydown", function (e) {
        if (e.key === "ArrowDown") { select(sel + 1); e.preventDefault(); } else if (e.key === "ArrowUp") { select(sel - 1); e.preventDefault(); }
        else if (e.key === "Enter") { var cur = $(".search-result[aria-selected='true']", list); if (cur) { location.href = cur.getAttribute("data-href"); } e.preventDefault(); }
        else if (e.key === "Escape") { closeSearch(); e.preventDefault(); }
        else if (e.key === "Tab") { e.preventDefault(); }
      });
    }
    opener = from || document.activeElement; dlg.classList.add("is-open"); document.body.style.overflow = "hidden"; input.value = ""; run(""); input.focus();
  }
  function closeSearch() { if (!dlg) return; dlg.classList.remove("is-open"); document.body.style.overflow = ""; if (opener && opener.focus) opener.focus(); }
  $$("[data-search-open]").forEach(function (b) { b.addEventListener("click", function () { openSearch(b); }); });
  document.addEventListener("keydown", function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || "")) || e.target.isContentEditable;
    if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); dlg && dlg.classList.contains("is-open") ? closeSearch() : openSearch(); }
    else if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); openSearch(); }
  });

  /* ---------- AI context builder ---------- */
  var AI = window.PSO_AI;
  function resolveSel(ids) {
    var by = {}; AI.scopes.forEach(function (s) { by[s.id] = s; });
    var out = { core: true };
    (function add(id) { if (!by[id]) return; by[id].requires.forEach(add); out[id] = true; });
    var addAll = function (id) { if (!by[id]) return; by[id].requires.forEach(addAll); out[id] = true; };
    ids.forEach(addAll);
    return AI.order.filter(function (id) { return out[id]; }).map(function (id) { return by[id]; });
  }
  function compose(ids) {
    var sel = resolveSel(ids);
    var head = ["# PSO Web — AI Development Context", "", "> Framework version " + AI.version + ". Generated from the PSO documentation sources by `pso ai:context`. Scopes: " + sel.map(function (s) { return s.id; }).join(", ") + ".", ""];
    var parts = sel.map(function (s) { return s.id === "core" ? s.body : "## " + s.title + "\n\n" + s.body.replace(/^#\s+.*\n+/, ""); });
    return [].concat(head, [parts.join("\n\n"), ""]).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
  }
  function wrap(format, body) {
    if (format === "markdown") return body;
    var block = "<!-- pso:ai-context:start version=" + AI.version + " -->\n" + body.replace(/\s+$/, "") + "\n" + AI.blockEnd + "\n";
    return AI.headers[format] + "\n" + block;
  }
  var FILES = { markdown: "PSO_CONTEXT.md", agents: "AGENTS.md", claude: "CLAUDE.md", copilot: "copilot-instructions.md" };
  function download(name, text) {
    var a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/markdown" })), download: name }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000); announce("Downloaded " + name);
  }
  if (AI) {
    $$("[data-copy-scope]").forEach(function (b) { b.addEventListener("click", function () { copyText(compose([b.getAttribute("data-copy-scope")])).then(function () { flash(b, true); }, function () { flash(b, false); }); }); });
    var host = $("[data-ai-builder]");
    if (host) {
      var chosen = {}; var saved = null;
      try { saved = JSON.parse(store.get("pso-ai-selection") || "null"); } catch (e) { saved = null; }
      var base = AI.scopes.filter(function (s) { return s.base && s.id !== "core"; }), tasks = AI.scopes.filter(function (s) { return !s.base; });
      (saved || base.map(function (s) { return s.id; })).forEach(function (id) { chosen[id] = true; });
      var out = el("textarea", { class: "ai-text", readonly: "readonly", "aria-label": "Generated AI context", spellcheck: "false" });
      var stats = el("div", { class: "ai-stats", role: "status", "aria-live": "polite" });
      var fmt = el("select", { class: "version", "aria-label": "Export format" }, [el("option", { value: "markdown", text: "Markdown" }), el("option", { value: "agents", text: "AGENTS.md" }), el("option", { value: "claude", text: "CLAUDE.md" }), el("option", { value: "copilot", text: "Copilot instructions" })]);
      var boxes = {};
      function ids() { return AI.order.filter(function (id) { return chosen[id] && id !== "core"; }); }
      function text() { return wrap(fmt.value, compose(ids())); }
      function refresh() {
        var t = text(); out.value = t; var tok = Math.ceil(t.length / 4);
        stats.textContent = t.length.toLocaleString("en-US") + " characters, about " + tok.toLocaleString("en-US") + " tokens (estimate: characters / 4, not a tokenizer count). Scopes: core + " + (ids().join(", ") || "none") + ".";
        store.set("pso-ai-selection", JSON.stringify(ids()));
        Object.keys(boxes).forEach(function (id) { boxes[id].checked = !!chosen[id]; });
      }
      function group(title, items) {
        var wrapEl = el("div", {}, [el("h3", { class: "ai-group-title", text: title })]);
        var grid = el("div", { class: "ai-grid" });
        items.forEach(function (s) {
          var cb = el("input", { type: "checkbox", id: "ai-" + s.id }); boxes[s.id] = cb;
          cb.addEventListener("change", function () { if (cb.checked) chosen[s.id] = true; else delete chosen[s.id]; refresh(); });
          var copyBtn = el("button", { class: "btn btn-ghost", type: "button", "aria-label": "Copy only the " + s.title + " context" }, [icon("copy"), el("span", { class: "copy-label", text: "Copy" })]);
          copyBtn.addEventListener("click", function () { copyText(compose([s.id])).then(function () { flash(copyBtn, true); }, function () { flash(copyBtn, false); }); });
          grid.append(el("div", { class: "ai-card" }, [el("label", { for: "ai-" + s.id }, [cb, el("span", { text: s.title })]), el("p", { text: s.description }), el("div", { class: "ai-card-foot" }, [el("span", { text: "~" + Math.ceil(s.tokens).toLocaleString("en-US") + " tokens" }), copyBtn])]));
        });
        wrapEl.append(grid); return wrapEl;
      }
      var copyAll = el("button", { class: "btn btn-primary", type: "button" }, [icon("copy"), el("span", { class: "copy-label", text: "Copy context" })]);
      var dl = el("button", { class: "btn", type: "button" }, [icon("download"), el("span", { text: "Download" })]);
      var all = el("button", { class: "btn btn-ghost", type: "button", text: "Select all" }), none = el("button", { class: "btn btn-ghost", type: "button", text: "Clear" });
      all.addEventListener("click", function () { AI.scopes.forEach(function (s) { if (s.id !== "core") chosen[s.id] = true; }); refresh(); });
      none.addEventListener("click", function () { Object.keys(chosen).forEach(function (k) { delete chosen[k]; }); refresh(); });
      copyAll.addEventListener("click", function () { copyText(text()).then(function () { flash(copyAll, true); }, function () { flash(copyAll, false); }); });
      dl.addEventListener("click", function () { download(FILES[fmt.value], text()); });
      fmt.addEventListener("change", refresh);
      host.textContent = "";
      host.append(
        el("p", { class: "ai-note", text: "The core rules (identity, invariants, security and generation rules) are always included. Pick what else your task needs." }),
        group("Framework contexts", base), group("Task contexts", tasks),
        el("div", { class: "ai-output" }, [el("div", { class: "ai-output-bar" }, [stats, el("div", { class: "ai-actions" }, [all, none, fmt, copyAll, dl])]), out]),
        el("p", { class: "ai-note", text: "Nothing leaves your browser: the text is assembled locally from the documentation shipped with PSO Web " + AI.version + "." })
      );
      refresh();
    }
  }
})();
