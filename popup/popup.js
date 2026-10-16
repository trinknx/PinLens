(() => {
  const { compact, age } = globalThis.PinLensFormat;
  const Settings = globalThis.PinLensSettings;
  const PAGE_SIZE = 50;
  const PREFS_KEY = "pinlens:popup";

  const $ = (sel) => document.querySelector(sel);
  const send = (message) => chrome.runtime.sendMessage(message).catch(() => null);

  let allPins = [];
  let pageIds = null; // null when the active tab isn't a Pinterest page
  let shown = PAGE_SIZE;
  let currentList = [];

  // ---- prefs (per-viewer convenience only) ----

  function loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    } catch {
      return {};
    }
  }
  function savePrefs() {
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ scope: $("#scope").value, filter: $("#filter").value, sort: $("#sort").value })
      );
    } catch {
      /* storage unavailable */
    }
  }

  // ---- data ----

  async function loadPageIds() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !/^https?:\/\/([^/]+\.)?pinterest\./.test(tab.url || "")) return null;
      const res = await chrome.tabs.sendMessage(tab.id, { type: "page:pins" });
      return res && Array.isArray(res.ids) ? res.ids : null;
    } catch {
      return null; // content script not injected (tab opened before install)
    }
  }

  const SORTS = {
    saves: (p) => p.saves,
    repins: (p) => p.repins,
    reactions: (p) => p.reactions,
    comments: (p) => p.comments,
    newest: (p) => p.createdAt,
    oldest: (p) => (p.createdAt ? -p.createdAt : null),
    seen: (p) => p.seenAt,
    followers: (p) => p.pinner && p.pinner.followers,
  };

  const FILTERS = {
    all: () => true,
    image: (p) => p.type === "image",
    video: (p) => p.type === "video",
    carousel: (p) => p.type === "carousel",
    idea: (p) => p.type === "idea",
    promoted: (p) => p.isPromoted,
    ai: (p) => p.isAI,
    organic: (p) => !p.isPromoted && !p.isAI,
  };

  function haystack(p) {
    return [p.title, p.description, p.domain, p.pinner && p.pinner.username, p.pinner && p.pinner.name,
      p.board && p.board.name].filter(Boolean).join(" ").toLowerCase();
  }

  function computeList() {
    const scope = $("#scope").value;
    let list = allPins;
    if (scope === "page" && pageIds) {
      const byId = new Map(allPins.map((p) => [p.id, p]));
      list = pageIds.map((id) => byId.get(id)).filter(Boolean);
    }
    const filter = FILTERS[$("#filter").value] || FILTERS.all;
    const q = $("#search").value.trim().toLowerCase();
    list = list.filter((p) => filter(p) && (!q || haystack(p).includes(q)));

    const key = SORTS[$("#sort").value] || SORTS.saves;
    // Unknown values always sink to the bottom, whatever the direction.
    return list
      .map((p) => ({ p, v: key(p) }))
      .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity))
      .map((x) => x.p);
  }

  // ---- rendering ----

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function pinUrl(id) {
    return `https://www.pinterest.com/pin/${id}/`;
  }

  function renderCard(p) {
    const li = el("li", "card");

    const img = el("img", "thumb");
    img.loading = "lazy";
    img.alt = "";
    if (p.thumb) img.src = p.thumb;
    if (p.dominantColor) img.style.background = p.dominantColor;

    const info = el("div", "info");
    const title = el("p", "title");
    if (p.isPromoted) title.append(el("span", "tag ad", "ad"));
    if (p.isAI) title.append(el("span", "tag ai", "ai"));
    if (p.type !== "image") title.append(el("span", "tag", p.type));
    title.append(document.createTextNode(p.title || p.description || "Untitled pin"));
    title.title = p.title || p.description || "";

    const metaBits = [];
    if (p.pinner) metaBits.push("@" + p.pinner.username + (p.pinner.followers ? ` (${compact(p.pinner.followers)})` : ""));
    if (p.board) metaBits.push(p.board.name);
    if (p.domain) metaBits.push(p.domain);
    const meta = el("p", "meta", metaBits.join(" · ") || " ");

    const stats = el("p", "stats");
    const stat = (label, value) => {
      const s = el("span");
      s.append(el("b", null, value), document.createTextNode(" " + label));
      stats.append(s);
    };
    stat("saves", compact(p.saves));
    stat("repins", compact(p.repins));
    stat("reactions", compact(p.reactions));
    stat("comments", compact(p.comments));
    stat("old", age(p.createdAt));

    info.append(title, meta, stats);

    const actions = el("div", "card-actions");
    const open = el("button", "icon-btn", "Open");
    open.addEventListener("click", () => chrome.tabs.create({ url: pinUrl(p.id) }));
    actions.append(open);
    if (p.media && p.media.length) {
      const dl = el("button", "icon-btn", p.media.length > 1 ? `⤓ ${p.media.length}` : "⤓");
      dl.title = "Download";
      dl.addEventListener("click", async () => {
        dl.disabled = true;
        const res = await send({ type: "pin:download", id: p.id });
        dl.textContent = res && res.ok ? "✓" : "!";
        if (!res || !res.ok) dl.title = (res && res.error) || "Download failed";
      });
      actions.append(dl);
    }

    li.append(img, info, actions);
    return li;
  }

  function render() {
    currentList = computeList();
    const list = $("#list");
    list.replaceChildren();

    const scopeLabel = $("#scope").value === "page" && pageIds ? "on this page" : "collected";
    $("#summary").textContent = `${currentList.length} of ${allPins.length} pins ${scopeLabel}`;

    if (!currentList.length) {
      const empty = el("li", "empty");
      empty.textContent = allPins.length
        ? "No pins match these filters."
        : "No pins yet. Browse Pinterest and PinLens will collect pins as they load.";
      list.append(empty);
    }
    currentList.slice(0, shown).forEach((p) => list.append(renderCard(p)));
    $("#more").hidden = currentList.length <= shown;
    $("#download-all").disabled = !currentList.length;
    $("#export").disabled = !currentList.length;
  }

  // ---- export ----

  function csvCell(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function exportCsv() {
    const header = ["id", "url", "title", "type", "saves", "repins", "reactions", "comments", "created",
      "promoted", "ai", "pinner", "pinner_followers", "board", "domain", "link", "media_urls"];
    const rows = currentList.map((p) => [
      p.id, pinUrl(p.id), p.title || p.description, p.type, p.saves, p.repins, p.reactions, p.comments,
      p.createdAt ? new Date(p.createdAt).toISOString() : "", p.isPromoted, p.isAI,
      p.pinner && p.pinner.username, p.pinner && p.pinner.followers, p.board && p.board.name, p.domain, p.link,
      (p.media || []).map((m) => m.url).join(" "),
    ]);
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pinlens-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function downloadList() {
    const targets = currentList.filter((p) => p.media && p.media.length).slice(0, 50);
    if (!targets.length) return;
    if (!confirm(`Download media for ${targets.length} pins into Downloads/PinLens?`)) return;
    const btn = $("#download-all");
    btn.disabled = true;
    for (const [i, p] of targets.entries()) {
      btn.textContent = `Downloading ${i + 1}/${targets.length}…`;
      await send({ type: "pin:download", id: p.id });
    }
    btn.textContent = "Download list";
    btn.disabled = false;
  }

  // ---- settings view ----

  async function renderSettings() {
    const s = await Settings.load();
    const form = $("#settings");
    form.showBadges.checked = s.showBadges;
    form.adsMode.value = s.adsMode;
    form.aiMode.value = s.aiMode;
    form.retentionDays.value = s.retentionDays;
    $("#enabled").checked = s.enabled;
    const count = await send({ type: "pins:count" });
    $("#stored").textContent = `${count || 0} pins stored in this browser.`;
  }

  function wireSettings() {
    const form = $("#settings");
    form.addEventListener("change", (e) => {
      const t = e.target;
      if (t.name === "showBadges") Settings.save({ showBadges: t.checked });
      else if (t.name === "retentionDays") {
        const days = Math.min(365, Math.max(1, Math.round(Number(t.value) || Settings.DEFAULTS.retentionDays)));
        t.value = days;
        Settings.save({ retentionDays: days });
      } else if (t.name) Settings.save({ [t.name]: t.value });
    });
    $("#enabled").addEventListener("change", (e) => Settings.save({ enabled: e.target.checked }));
    $("#clear").addEventListener("click", async () => {
      if (!confirm("Delete every pin PinLens has collected? This can't be undone.")) return;
      await send({ type: "pins:clear" });
      allPins = [];
      renderSettings();
      render();
    });
  }

  // ---- startup ----

  function wireTabs() {
    document.querySelectorAll(".tab").forEach((tab) =>
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
        $("#view-pins").hidden = tab.dataset.view !== "pins";
        $("#view-settings").hidden = tab.dataset.view !== "settings";
        if (tab.dataset.view === "settings") renderSettings();
      })
    );
  }

  async function init() {
    wireTabs();
    wireSettings();

    const prefs = loadPrefs();
    for (const id of ["filter", "sort"]) if (prefs[id]) $("#" + id).value = prefs[id];

    const [pins, ids, s] = await Promise.all([send({ type: "pins:all" }), loadPageIds(), Settings.load()]);
    allPins = Array.isArray(pins) ? pins : [];
    pageIds = ids;
    $("#enabled").checked = s.enabled;

    const pageOption = $("#scope").querySelector('[value="page"]');
    if (!pageIds) {
      pageOption.disabled = true;
      pageOption.textContent = "This page (open Pinterest)";
      $("#scope").value = "all";
    } else {
      $("#scope").value = prefs.scope || "page";
    }

    for (const id of ["scope", "filter", "sort"]) {
      $("#" + id).addEventListener("change", () => {
        shown = PAGE_SIZE;
        savePrefs();
        render();
      });
    }
    let searchTimer;
    $("#search").addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        shown = PAGE_SIZE;
        render();
      }, 150);
    });
    $("#more").addEventListener("click", () => {
      shown += PAGE_SIZE;
      render();
    });
    $("#export").addEventListener("click", exportCsv);
    $("#download-all").addEventListener("click", downloadList);

    render();
  }

  init();
})();
