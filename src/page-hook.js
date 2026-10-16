// PinLens page hook. Runs in Pinterest's own JavaScript world (manifest
// "world": "MAIN") at document_start, so it can see the JSON Pinterest fetches.
// It only reads responses — it never changes a request or a response — and
// forwards normalized pin records to the content script via postMessage.
// No chrome.* APIs are available here.
(() => {
  if (window.__pinlensHooked) return;
  window.__pinlensHooked = true;

  const TAG = "PINLENS_PINS";
  const API_RE = /\/resource\/[A-Za-z]+Resource\/get\/|\/_graphql\//;
  // digital_media_source_type values Pinterest uses for AI-generated/modified media.
  const AI_SOURCE_TYPES = [11, 12, 16];
  const MAX_NODES = 60000;
  const IMAGE_SIZES_LARGEST_FIRST = ["orig", "originals", "1200x", "736x", "474x", "236x"];
  const IMAGE_SIZES_THUMB_FIRST = ["236x", "474x", "736x", "orig", "originals"];

  const paused = () => !!document.documentElement.dataset.pinlensPaused;
  const numOrNull = (v) => (v === undefined || v === null || v === "" ? null : Number(v) || 0);

  function pickImage(images, order) {
    if (!images || typeof images !== "object") return null;
    for (const key of order) {
      if (images[key] && typeof images[key].url === "string") return images[key].url;
    }
    return null;
  }

  function bestMp4(videoList) {
    if (!videoList || typeof videoList !== "object") return null;
    let best = null;
    for (const v of Object.values(videoList)) {
      if (v && typeof v.url === "string" && /\.mp4(\?|$)/.test(v.url)) {
        if (!best || (Number(v.width) || 0) > (Number(best.width) || 0)) best = v;
      }
    }
    return best ? best.url : null;
  }

  function collectMedia(p) {
    const media = [];
    const pushImage = (images) => {
      const url = pickImage(images, IMAGE_SIZES_LARGEST_FIRST);
      if (url) media.push({ kind: "image", url });
    };

    const video = bestMp4(p.videos && p.videos.video_list);
    if (video) media.push({ kind: "video", url: video });

    const slots = p.carousel_data && p.carousel_data.carousel_slots;
    if (Array.isArray(slots)) slots.forEach((s) => pushImage(s && s.images));

    const pages = p.story_pin_data && p.story_pin_data.pages;
    if (Array.isArray(pages)) {
      for (const page of pages) {
        for (const block of (page && page.blocks) || []) {
          const v = bestMp4(block && block.video && block.video.video_list);
          if (v) media.push({ kind: "video", url: v });
          else pushImage(block && block.image && block.image.images);
        }
      }
    }

    if (!media.length) pushImage(p.images);
    // Dedupe while keeping order.
    const seen = new Set();
    return media.filter((m) => !seen.has(m.url) && seen.add(m.url));
  }

  function pinType(p, media) {
    if (p.story_pin_data) return "idea";
    const slots = p.carousel_data && p.carousel_data.carousel_slots;
    if (Array.isArray(slots) && slots.length > 1) return "carousel";
    if (p.videos || p.is_video || media.some((m) => m.kind === "video")) return "video";
    return "image";
  }

  function normalize(p, id) {
    const media = collectMedia(p);
    const stats = (p.aggregated_pin_data && p.aggregated_pin_data.aggregated_stats) || {};
    let reactions = null;
    if (p.reaction_counts && typeof p.reaction_counts === "object") {
      reactions = Object.values(p.reaction_counts).reduce((a, b) => a + (Number(b) || 0), 0);
    }
    const pinner = p.native_creator || p.pinner || p.origin_pinner || null;
    const created = Date.parse(p.created_at);
    return {
      id,
      title: (p.grid_title || p.title || "").trim() || null,
      description: (p.description || p.closeup_unified_description || "").trim() || null,
      link: p.link || null,
      domain: p.domain || null,
      createdAt: Number.isFinite(created) ? created : null,
      saves: numOrNull(stats.saves),
      repins: numOrNull(p.repin_count),
      comments: numOrNull(p.comment_count ?? (p.aggregated_pin_data && p.aggregated_pin_data.comment_count)),
      reactions,
      type: pinType(p, media),
      isPromoted: p.is_promoted === true || !!p.promoter || !!p.sponsorship,
      isAI: AI_SOURCE_TYPES.includes(Number(p.digital_media_source_type)),
      thumb: pickImage(p.images, IMAGE_SIZES_THUMB_FIRST),
      media,
      pinner: pinner && pinner.username
        ? {
            username: pinner.username,
            name: pinner.full_name || pinner.username,
            followers: numOrNull(pinner.follower_count),
          }
        : null,
      board: p.board && p.board.name ? { name: p.board.name, url: p.board.url || null } : null,
      dominantColor: p.dominant_color || null,
    };
  }

  function pinIdOf(node) {
    const isPinType = node.type === "pin" || node.__typename === "Pin";
    const looksLikePin =
      node.images !== undefined &&
      (node.aggregated_pin_data !== undefined || node.repin_count !== undefined);
    if (!isPinType && !looksLikePin) return null;
    const id = String(node.entityId || node.id || "");
    return /^\d+$/.test(id) ? id : null;
  }

  // Iterative walk over any JSON payload, collecting every pin-shaped object.
  function extractPins(root) {
    const out = [];
    const stack = [root];
    let visited = 0;
    while (stack.length && visited < MAX_NODES) {
      const node = stack.pop();
      visited++;
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
        continue;
      }
      const id = pinIdOf(node);
      if (id) {
        try {
          out.push(normalize(node, id));
        } catch (e) {
          /* skip malformed pin */
        }
      }
      for (const key in node) {
        const v = node[key];
        if (v && typeof v === "object") stack.push(v);
      }
    }
    return out;
  }

  function report(json) {
    if (paused()) return;
    try {
      const pins = extractPins(json);
      if (pins.length) window.postMessage({ source: TAG, pins }, location.origin);
    } catch (e) {
      /* never break the page */
    }
  }

  const urlOf = (input) =>
    typeof input === "string" ? input : (input && (input.url || String(input))) || "";

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = origFetch.apply(this, args);
    try {
      if (API_RE.test(urlOf(args[0]))) {
        promise
          .then((res) => {
            if (!paused()) res.clone().json().then(report, () => {});
          })
          .catch(() => {});
      }
    } catch (e) {
      /* never break the page's fetch */
    }
    return promise;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (API_RE.test(String(url))) {
        this.addEventListener("load", function () {
          if (paused()) return;
          try {
            report(this.responseType === "json" ? this.response : JSON.parse(this.responseText));
          } catch (e) {
            /* not JSON */
          }
        });
      }
    } catch (e) {
      /* never break the page's XHR */
    }
    return origOpen.call(this, method, url, ...rest);
  };

  // The first page load is server-rendered: its pins live in an embedded JSON blob.
  function readEmbeddedData() {
    for (const id of ["__PWS_DATA__", "__PWS_INITIAL_PROPS__"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      try {
        report(JSON.parse(el.textContent || "{}"));
      } catch (e) {
        /* ignore */
      }
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", readEmbeddedData, { once: true });
  } else {
    readEmbeddedData();
  }
})();
