# PinLens

A Chrome/Edge (Manifest V3) extension for Pinterest. It works like SortPin:

- **Stats badge on every pin** in the feed: saves, repins, reactions, age, AD / AI / VIDEO tags, and a download button.
- **Feed cleanup**: dim or hide promoted pins and AI-generated pins. The toolbar badge counts what was cleaned in the tab.
- **Popup**: every pin you've browsed, with search, filters (images, videos, carousels, idea pins, ads, AI) and sorting (saves, repins, reactions, comments, newest, oldest, pinner followers). You can scope it to the current page, export to CSV, or download media.
- **Downloads**: the original image, the best MP4 for videos, and every slide of a carousel or idea pin. Files go to `Downloads/PinLens/`.

No build step, no dependencies, no network calls of its own.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this `PinLens` folder.
4. Open Pinterest **while signed in** and scroll your home feed or a search.

Logged-out Pinterest only shows "gated" placeholder pins that have no IDs or stats, so there's nothing for PinLens to read.

## How it works

```
page-hook.js  (MAIN world, document_start)
  wraps fetch/XHR, reads Pinterest's /resource/*/get/ and /_graphql/ JSON
  and the embedded __PWS_DATA__ blob, normalizes pin objects
        │ window.postMessage
        ▼
content.js    (isolated world)
  MutationObserver over [data-grid-item] cells → badge, dim/hide
        │ chrome.runtime.sendMessage
        ▼
background.js (service worker)
  IndexedDB store, merge, prune after N days, downloads, toolbar badge
        ▲
popup/        list, filter, sort, CSV, settings (chrome.storage.sync)
```

| File | Role |
| --- | --- |
| `src/page-hook.js` | Runs in the page's own JS context so it can see Pinterest's API responses. Read-only: it never changes requests or responses. |
| `src/content.js` / `content.css` | Matches grid cells to pin IDs (`data-test-pin-id` or `/pin/<id>/` links), draws badges, applies dim/hide. |
| `src/background.js` | IndexedDB `pinlens.pins` (key `id`, index `seenAt`), message handlers, downloads. |
| `src/settings.js` | Defaults and `chrome.storage.sync` helpers shared by every context. |
| `src/format.js` | Number/age formatting shared by content script and popup. |
| `popup/` | The toolbar popup UI. |

### Messages

| type | from → to | purpose |
| --- | --- | --- |
| `pins:save` | content → bg | store/merge a batch of pins |
| `pins:get` | content → bg | look up pins rendered from cache |
| `pins:all`, `pins:count`, `pins:clear` | popup → bg | list / count / wipe |
| `pin:download` | content/popup → bg | download all media of a pin |
| `tab:cleaned` | content → bg | toolbar badge count |
| `page:pins` | popup → content | pin IDs on the current page, in order |

## Things that may need updating

Pinterest changes its markup and API often. If badges stop appearing, check these first:

- `GRID_ITEM` / `PIN_ID_ATTR` in `src/content.js`, the DOM selectors.
- `API_RE` and `pinIdOf()` in `src/page-hook.js`, which decide which responses are read and which objects count as pins.
- `AI_SOURCE_TYPES` (`digital_media_source_type` values 11, 12, 16), which flags AI pins.
