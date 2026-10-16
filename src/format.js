// Display helpers shared by the content script and popup.
(() => {
  function compact(n) {
    if (n === null || n === undefined) return "–";
    const v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k";
    return String(v);
  }

  function age(ts) {
    if (!ts) return "–";
    const days = Math.max(0, (Date.now() - ts) / 86400000);
    if (days < 1) return "today";
    if (days < 30) return Math.floor(days) + "d";
    if (days < 365) return Math.floor(days / 30) + "mo";
    return (days / 365).toFixed(days < 3650 ? 1 : 0).replace(/\.0$/, "") + "y";
  }

  globalThis.PinLensFormat = { compact, age };
})();
