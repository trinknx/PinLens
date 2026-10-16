// PinLens content script (isolated world). Receives pin data from page-hook.js,
// sends it to the background for storage, draws a stats badge on each pin in
// the grid and dims/hides ads and AI pins according to the user's settings.
(() => {
  const TAG = "PINLENS_PINS";
  const GRID_ITEM = '[data-grid-item="true"]';
  const PIN_ID_ATTR = "data-test-pin-id";
  const { compact, age } = globalThis.PinLensFormat;

  let settings = { ...globalThis.PinLensSettings.DEFAULTS };
  const pins = new Map(); // id -> pin record, for this tab
  const unsent = new Map(); // id -> pin record waiting to go to the background
  const lookedUp = new Set(); // ids we already asked the background about
  let pageIds = []; // pin ids seen in the grid on the current URL, in order
  let pageIdSet = new Set();
  let lastHref = location.href;
  const cleaned = { ads: new Set(), ai: new Set() };

  // ---- receiving data from the page hook ----

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== TAG) return;
    if (!Array.isArray(event.data.pins)) return;
    for (const pin of event.data.pins) {
      if (!pin || typeof pin.id !== "string") continue;
      pins.set(pin.id, mergeLocal(pins.get(pin.id), pin));
      unsent.set(pin.id, pins.get(pin.id));
    }
    scheduleFlush();
    scheduleRefresh();
  });

  function mergeLocal(a, b) {
    if (!a) return b;
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (v !== null && v !== undefined && !(Array.isArray(v) && !v.length)) out[k] = v;
    }
    out.isPromoted = !!(a.isPromoted || b.isPromoted);
    out.isAI = !!(a.isAI || b.isAI);
    return out;
  }

  let flushTimer = null;
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (!settings.enabled || !unsent.size) return;
      const batch = [...unsent.values()];
      unsent.clear();
      send({ type: "pins:save", pins: batch });
    }, 1500);
  }

  function send(message) {
    return chrome.runtime.sendMessage(message).catch(() => null);
  }

  // Pins rendered from cache (back/forward, SPA navigation) may never pass
  // through the hook again; fill them in from what the background has stored.
  let lookupTimer = null;
  const lookupQueue = new Set();
  function lookup(id) {
    if (lookedUp.has(id)) return;
    lookedUp.add(id);
    lookupQueue.add(id);
    if (lookupTimer) return;
    lookupTimer = setTimeout(async () => {
      lookupTimer = null;
      const ids = [...lookupQueue];
      lookupQueue.clear();
      const found = await send({ type: "pins:get", ids });
      if (Array.isArray(found) && found.length) {
        found.forEach((p) => pins.set(p.id, mergeLocal(p, pins.get(p.id) || {})));
        scheduleRefresh();
      }
    }, 400);
  }

  // ---- decorating the grid ----

  function pinIdOf(item) {
    const tagged = item.querySelector(`[${PIN_ID_ATTR}]`);
    if (tagged) return tagged.getAttribute(PIN_ID_ATTR);
    const link = item.querySelector('a[href*="/pin/"]');
    const m = link && link.getAttribute("href").match(/\/pin\/(\d+)/);
    return m ? m[1] : null;
  }

  function modeFor(pin) {
    if (!pin) return "show";
    if (pin.isPromoted) return settings.adsMode;
    if (pin.isAI) return settings.aiMode;
    return "show";
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function buildBadge(pin) {
    const badge = el("div", "pinlens-badge");
    const stat = (icon, text, title) => {
      const s = el("span", "pinlens-stat");
      s.title = title;
      s.append(el("b", null, icon), document.createTextNode(" " + text));
      return s;
    };
    badge.append(
      stat("♥", compact(pin.saves), "Saves"),
      stat("↻", compact(pin.repins), "Repins"),
      stat("✦", compact(pin.reactions), "Reactions"),
      stat("◷", age(pin.createdAt), "Age")
    );

    const tags = el("span", "pinlens-tags");
    if (pin.isPromoted) tags.append(el("i", "pinlens-tag pinlens-tag-ad", "AD"));
    if (pin.isAI) tags.append(el("i", "pinlens-tag pinlens-tag-ai", "AI"));
    if (pin.type !== "image") tags.append(el("i", "pinlens-tag", pin.type.toUpperCase()));
    badge.append(tags);

    if (pin.media && pin.media.length) {
      const dl = el("button", "pinlens-dl", "⤓");
      dl.type = "button";
      dl.title = pin.media.length > 1 ? `Download ${pin.media.length} files` : "Download";
      dl.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        send({ type: "pin:download", id: pin.id });
        dl.textContent = "✓";
      });
      badge.append(dl);
    }
    // Clicks on the badge shouldn't open the pin underneath.
    badge.addEventListener("click", (e) => e.stopPropagation());
    return badge;
  }

  function signature(pin) {
    return [pin.saves, pin.repins, pin.reactions, pin.createdAt, pin.isPromoted, pin.isAI, pin.type,
      pin.media && pin.media.length].join("|");
  }

  function clearItem(item) {
    item.classList.remove("pinlens-dim", "pinlens-hide");
    const badge = item.querySelector(":scope > .pinlens-badge");
    if (badge) badge.remove();
    delete item.dataset.pinlensId;
    delete item.dataset.pinlensSig;
  }

  function decorate(item, id, pin) {
    // Grid cells get recycled by Pinterest's virtualized list; reset if reused.
    if (item.dataset.pinlensId && item.dataset.pinlensId !== id) clearItem(item);
    item.dataset.pinlensId = id;

    const mode = modeFor(pin);
    item.classList.toggle("pinlens-dim", mode === "dim");
    item.classList.toggle("pinlens-hide", mode === "hide");
    if (mode !== "show" && pin) (pin.isPromoted ? cleaned.ads : cleaned.ai).add(id);
    if (mode === "hide") item.querySelectorAll("video").forEach((v) => v.pause());

    const existing = item.querySelector(":scope > .pinlens-badge");
    if (!settings.showBadges || !pin) {
      if (existing) existing.remove();
      return;
    }
    const sig = signature(pin);
    if (existing && item.dataset.pinlensSig === sig) return;
    if (existing) existing.remove();
    if (getComputedStyle(item).position === "static") item.style.position = "relative";
    item.append(buildBadge(pin));
    item.dataset.pinlensSig = sig;
  }

  function refresh() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      pageIds = [];
      pageIdSet = new Set();
    }
    const items = document.querySelectorAll(GRID_ITEM);
    if (!settings.enabled) {
      items.forEach(clearItem);
      updateBadgeCount();
      return;
    }
    items.forEach((item) => {
      const id = pinIdOf(item);
      if (!id) return;
      if (!pageIdSet.has(id)) {
        pageIdSet.add(id);
        pageIds.push(id);
      }
      const pin = pins.get(id);
      if (!pin) lookup(id);
      decorate(item, id, pin);
    });
    updateBadgeCount();
  }

  let lastCount = -1;
  function updateBadgeCount() {
    const count = settings.enabled ? cleaned.ads.size + cleaned.ai.size : 0;
    if (count === lastCount) return;
    lastCount = count;
    send({ type: "tab:cleaned", count });
  }

  let refreshTimer = null;
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, 250);
  }

  // ---- popup requests ----

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "page:pins") {
      sendResponse({ url: location.href, ids: pageIds.slice() });
    }
  });

  // ---- startup ----

  function applySettings(next) {
    settings = next;
    if (settings.enabled) delete document.documentElement.dataset.pinlensPaused;
    else document.documentElement.dataset.pinlensPaused = "1";
    cleaned.ads.clear();
    cleaned.ai.clear();
    document.querySelectorAll(GRID_ITEM).forEach((item) => delete item.dataset.pinlensSig);
    refresh();
  }

  globalThis.PinLensSettings.watch(applySettings);

  function start() {
    new MutationObserver(scheduleRefresh).observe(document.body, { childList: true, subtree: true });
    globalThis.PinLensSettings.load().then(applySettings);
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
