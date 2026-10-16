// Shared settings helpers, loaded by the content script, popup and background.
// Plain script that attaches to globalThis so it works in every context.
(() => {
  const DEFAULTS = {
    enabled: true, // master switch: badges, cleanup and collection
    showBadges: true, // stats overlay on each pin in the feed
    adsMode: "dim", // "show" | "dim" | "hide"
    aiMode: "show", // "show" | "dim" | "hide"
    retentionDays: 30, // collected pins older than this are pruned
  };

  function load() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, (items) => {
        resolve(chrome.runtime.lastError ? { ...DEFAULTS } : { ...DEFAULTS, ...items });
      });
    });
  }

  function save(patch) {
    return new Promise((resolve) => chrome.storage.sync.set(patch, () => resolve()));
  }

  // Calls fn(fullSettings) whenever any setting changes.
  function watch(fn) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (Object.keys(changes).some((k) => k in DEFAULTS)) load().then(fn);
    });
  }

  globalThis.PinLensSettings = { DEFAULTS, load, save, watch };
})();
