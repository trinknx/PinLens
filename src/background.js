// PinLens background service worker: stores collected pins in IndexedDB,
// answers the content script and popup, runs downloads and sets the toolbar badge.
import "./settings.js";

const { DEFAULTS, load: loadSettings } = globalThis.PinLensSettings;
const DB_NAME = "pinlens";
const STORE = "pins";
const DAY = 86400000;

// ---- IndexedDB ----

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("seenAt", "seenAt");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

// Runs fn(store) in one transaction and resolves with whatever fn returns
// (read request results are unwrapped) once the transaction completes.
async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function isEmpty(v) {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
}

// New data wins field by field, but a partial record never blanks out a
// field we already know.
function merge(old, incoming, now) {
  if (!old) return { ...incoming, firstSeenAt: now, seenAt: now, seenCount: 1 };
  const out = { ...old };
  for (const [k, v] of Object.entries(incoming)) if (!isEmpty(v)) out[k] = v;
  out.isPromoted = !!(old.isPromoted || incoming.isPromoted);
  out.isAI = !!(old.isAI || incoming.isAI);
  out.seenAt = now;
  out.seenCount = (old.seenCount || 1) + 1;
  return out;
}

function savePins(list) {
  const now = Date.now();
  return withStore("readwrite", (store) => {
    for (const pin of list) {
      if (!pin || typeof pin.id !== "string") continue;
      const req = store.get(pin.id);
      req.onsuccess = () => store.put(merge(req.result, pin, now));
    }
    return list.length;
  });
}

function getPins(ids) {
  return withStore("readonly", (store) => {
    const found = [];
    for (const id of ids) {
      const req = store.get(String(id));
      req.onsuccess = () => req.result && found.push(req.result);
    }
    return found;
  });
}

const getAllPins = () => withStore("readonly", (store) => store.getAll());
const countPins = () => withStore("readonly", (store) => store.count());
const clearPins = () => withStore("readwrite", (store) => store.clear());

async function prune() {
  const { retentionDays } = await loadSettings();
  const cutoff = Date.now() - Math.max(1, Number(retentionDays) || DEFAULTS.retentionDays) * DAY;
  return withStore("readwrite", (store) => {
    const req = store.index("seenAt").openCursor(IDBKeyRange.upperBound(cutoff));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  });
}

// ---- downloads ----

function extensionOf(url, kind) {
  const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : kind === "video" ? "mp4" : "jpg";
}

async function downloadPin(id) {
  const [pin] = await getPins([id]);
  if (!pin || !pin.media || !pin.media.length) return { ok: false, error: "No media stored for this pin" };
  const many = pin.media.length > 1;
  for (const [i, m] of pin.media.entries()) {
    const name = many ? `${pin.id}_${String(i + 1).padStart(2, "0")}` : pin.id;
    await chrome.downloads.download({
      url: m.url,
      filename: `PinLens/${name}.${extensionOf(m.url, m.kind)}`,
      conflictAction: "uniquify",
    });
  }
  return { ok: true, files: pin.media.length };
}

// ---- messages ----

let savesSincePrune = 0;

const handlers = {
  async "pins:save"({ pins }) {
    if (!Array.isArray(pins) || !pins.length) return 0;
    const saved = await savePins(pins.slice(0, 2000));
    if ((savesSincePrune += 1) >= 50) {
      savesSincePrune = 0;
      prune().catch(() => {});
    }
    return saved;
  },
  "pins:get": ({ ids }) => getPins(Array.isArray(ids) ? ids.slice(0, 1000) : []),
  "pins:all": () => getAllPins(),
  "pins:count": () => countPins(),
  "pins:clear": () => clearPins().then(() => true),
  "pin:download": ({ id }) => downloadPin(String(id)),
  "tab:cleaned"({ count }, sender) {
    const tabId = sender.tab && sender.tab.id;
    if (tabId === undefined) return false;
    chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" }).catch(() => {});
    return true;
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message && handlers[message.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message, sender))
    .then(sendResponse, (err) => {
      console.warn("PinLens:", message.type, err);
      sendResponse(null);
    });
  return true; // keep the channel open for the async response
});

chrome.runtime.onInstalled.addListener(async () => {
  // Write defaults for any setting the user hasn't set yet.
  const current = await loadSettings();
  chrome.storage.sync.set(current);
  chrome.action.setBadgeBackgroundColor({ color: "#e60023" });
  prune().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: "#e60023" });
  prune().catch(() => {});
});
