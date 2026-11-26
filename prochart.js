// Ledgerwatch chart engine: candles + volume on TradingView's open-source Lightweight Charts (v5),
// with our own indicators, drawing tools, favourites and keyboard shortcuts.
//   ProChart.mount(el, { sym, name, dark }) -> { setTheme(dark), destroy() }
// Saved in localStorage: favourites, shortcut keys, active indicators, and each coin's drawings.
(() => {
  "use strict";
  const LIBS = [
    "https://unpkg.com/lightweight-charts@5.0/dist/lightweight-charts.standalone.production.js",
    "https://cdn.jsdelivr.net/npm/lightweight-charts@5.0/dist/lightweight-charts.standalone.production.js",
  ];
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  let libP = null;
  const loadLib = () => libP || (libP = (async () => {
    for (const src of LIBS) {
      try {
        await new Promise((ok, no) => {
          const s = document.createElement("script"); s.src = src; s.async = true;
          s.onload = () => window.LightweightCharts ? ok() : no(); s.onerror = () => { s.remove(); no(); };
          document.head.appendChild(s);
        });
        return window.LightweightCharts;
      } catch {}
    }
    libP = null; throw new Error("Couldn't load the chart library");
  })());

  // ---------- Intervals and data ----------
  const IV = {
    "1": { l: "1m", b: "1m", s: 60, c: ["minute", 1] },
    "3": { l: "3m", b: "3m", s: 180, c: ["minute", 3] },
    "5": { l: "5m", b: "5m", s: 300, c: ["minute", 5] },
    "15": { l: "15m", b: "15m", s: 900, c: ["minute", 15] },
    "30": { l: "30m", b: "30m", s: 1800, c: ["minute", 30] },
    "60": { l: "1h", b: "1h", s: 3600, c: ["hour", 1] },
    "120": { l: "2h", b: "2h", s: 7200, c: ["hour", 2] },
    "240": { l: "4h", b: "4h", s: 14400, c: ["hour", 4] },
    "360": { l: "6h", b: "6h", s: 21600, c: ["hour", 6] },
    "480": { l: "8h", b: "8h", s: 28800, c: ["hour", 8] },
    "720": { l: "12h", b: "12h", s: 43200, c: ["hour", 12] },
    "1D": { l: "D", b: "1d", s: 86400, c: ["day", 1] },
    "3D": { l: "3D", b: "3d", s: 259200, c: ["day", 3] },
    "1W": { l: "W", b: "1w", s: 604800, c: ["day", 7] },
    "1M": { l: "M", b: "1M", s: 2592000, c: ["day", 30] },
    // Multi-month frames: neither source offers them, so they're built from calendar-month bars (m = months per bar)
    "3M": { l: "3M", s: 7776000, m: 3 },
    "6M": { l: "6M", s: 15552000, m: 6 },
    "12M": { l: "12M", s: 31536000, m: 12 },
  };
  // Full names for the time-frame dropdown
  const IV_NAMES = { "1": "1 minute", "3": "3 minutes", "5": "5 minutes", "15": "15 minutes", "30": "30 minutes", "60": "1 hour", "120": "2 hours", "240": "4 hours", "360": "6 hours", "480": "8 hours", "720": "12 hours", "1D": "1 day", "3D": "3 days", "1W": "1 week", "1M": "1 month", "3M": "3 months", "6M": "6 months", "12M": "12 months" };
  for (const k in IV) IV[k].n = IV_NAMES[k];
  // Dropdown groups (explicit order — object key order would put numeric keys first)
  const IV_GROUPS = [["Minutes", ["1", "3", "5", "15", "30"]], ["Hours", ["60", "120", "240", "360", "480", "720"]], ["Days", ["1D", "3D", "1W"]], ["Months", ["1M", "3M", "6M", "12M"]]];
  // Quick-access buttons shown beside the dropdown
  const IV_QUICK = ["15", "60", "240", "1D", "1W"];
  // ---------- Exchanges ----------
  // Each adapter: pair(sym) → exchange symbol; iv maps our interval keys to the exchange's native codes;
  // get(pair, code, endRt, limit, stepSec) → bars oldest first, only bars opening before endRt when given.
  // Intervals an exchange lacks are built by merging a smaller native interval (see fetchBars).
  const BIN = "https://data-api.binance.vision/api/v3/klines";
  const bar = (rt, o, h, l, c, v) => ({ rt: +rt, o: +o, h: +h, l: +l, c: +c, v: +v });
  const qs = o => Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
  async function getJson(url, name) {
    const r = await fetch(url); // a network/CORS failure throws TypeError — resolveSrc tells that apart from "not listed"
    if (!r.ok) { const e = new Error(`${name} didn't return prices`); e.transient = r.status === 429 || r.status >= 500; throw e; }
    return r.json();
  }
  const iso = s => new Date(s * 1000).toISOString();
  const EX = {
    binance: { name: "Binance", quote: "USDT", max: 1000, pair: s => s + "USDT",
      iv: { "1": "1m", "3": "3m", "5": "5m", "15": "15m", "30": "30m", "60": "1h", "120": "2h", "240": "4h", "360": "6h", "480": "8h", "720": "12h", "1D": "1d", "3D": "3d", "1W": "1w", "1M": "1M" },
      async get(p, code, endRt, limit) {
        const j = await getJson(`${BIN}?${qs({ symbol: p, interval: code, limit, endTime: endRt ? endRt * 1000 - 1 : null })}`, "Binance");
        return j.map(k => bar(k[0] / 1000, k[1], k[2], k[3], k[4], k[5]));
      } },
    bybit: { name: "Bybit", quote: "USDT", max: 1000, pair: s => s + "USDT",
      iv: { "1": "1", "3": "3", "5": "5", "15": "15", "30": "30", "60": "60", "120": "120", "240": "240", "360": "360", "720": "720", "1D": "D", "1W": "W", "1M": "M" },
      async get(p, code, endRt, limit) {
        const j = await getJson(`https://api.bybit.com/v5/market/kline?${qs({ category: "spot", symbol: p, interval: code, limit, end: endRt ? endRt * 1000 - 1 : null })}`, "Bybit");
        if (j.retCode !== 0 || !j.result || !Array.isArray(j.result.list)) throw new Error(j.retMsg || "Bybit didn't return prices");
        return j.result.list.map(k => bar(k[0] / 1000, k[1], k[2], k[3], k[4], k[5])).reverse();
      } },
    bitget: { name: "Bitget", quote: "USDT", max: 1000, pair: s => s + "USDT",
      // the *utc codes keep daily-and-up candles on UTC midnight (plain "1day" etc. are UTC+8)
      iv: { "1": "1min", "3": "3min", "5": "5min", "15": "15min", "30": "30min", "60": "1h", "240": "4h", "360": "6Hutc", "720": "12Hutc", "1D": "1Dutc", "3D": "3Dutc", "1W": "1Wutc", "1M": "1Mutc" },
      async get(p, code, endRt, limit) {
        const u = endRt
          ? `https://api.bitget.com/api/v2/spot/market/history-candles?${qs({ symbol: p, granularity: code, endTime: endRt * 1000 - 1, limit: Math.min(limit, 200) })}`
          : `https://api.bitget.com/api/v2/spot/market/candles?${qs({ symbol: p, granularity: code, limit })}`;
        const j = await getJson(u, "Bitget");
        if (j.code !== "00000" || !Array.isArray(j.data)) throw new Error(j.msg || "Bitget didn't return prices");
        return j.data.map(k => bar(k[0] / 1000, k[1], k[2], k[3], k[4], k[5])).sort((a, b) => a.rt - b.rt);
      } },
    gate: { name: "Gate.io", quote: "USDT", max: 1000, pair: s => s + "_USDT",
      iv: { "1": "1m", "5": "5m", "15": "15m", "30": "30m", "60": "1h", "240": "4h", "480": "8h", "1D": "1d" },
      async get(p, code, endRt, limit, step) {
        // Gate rejects `limit` together with from/to, so paging back uses a time window instead
        const w = endRt ? { from: endRt - limit * step, to: endRt - 1 } : { limit };
        const j = await getJson(`https://api.gateio.ws/api/v4/spot/candlesticks?${qs({ currency_pair: p, interval: code, ...w })}`, "Gate.io");
        if (!Array.isArray(j)) throw new Error("Gate.io didn't return prices");
        return j.map(k => bar(k[0], k[5], k[3], k[4], k[2], k[6])); // [t, quoteVol, close, high, low, open, baseVol]
      } },
    coinbase: { name: "Coinbase", quote: "USD", max: 300, pair: s => s + "-USD",
      iv: { "1": 60, "5": 300, "15": 900, "60": 3600, "360": 21600, "1D": 86400 },
      async get(p, code, endRt, limit) {
        const w = endRt ? { start: iso(endRt - limit * code), end: iso(endRt - 1) } : {};
        const j = await getJson(`https://api.exchange.coinbase.com/products/${p}/candles?${qs({ granularity: code, ...w })}`, "Coinbase");
        if (!Array.isArray(j)) throw new Error((j && j.message) || "Coinbase didn't return prices");
        return j.map(k => bar(k[0], k[3], k[2], k[1], k[4], k[5])).reverse(); // [t, low, high, open, close, vol], newest first
      } },
    bitstamp: { name: "Bitstamp", quote: "USD", max: 1000, pair: s => s.toLowerCase() + "usd",
      iv: { "1": 60, "3": 180, "5": 300, "15": 900, "30": 1800, "60": 3600, "120": 7200, "240": 14400, "360": 21600, "720": 43200, "1D": 86400, "3D": 259200 },
      async get(p, code, endRt, limit) {
        const j = await getJson(`https://www.bitstamp.net/api/v2/ohlc/${p}/?${qs({ step: code, limit, end: endRt ? endRt - 1 : null })}`, "Bitstamp");
        const o = j && j.data && j.data.ohlc;
        if (!Array.isArray(o)) throw new Error("Bitstamp didn't return prices");
        return o.map(k => bar(k.timestamp, k.open, k.high, k.low, k.close, k.volume));
      } },
  };
  const EX_ORDER = ["binance", "bybit", "bitget", "gate", "coinbase", "bitstamp"];

  // src: { kind: "ex", ex, pair, sym } when the chosen exchange lists the coin,
  // else { kind: "cc", sym, want, why } — CryptoCompare's USD index as a fallback.
  const srcCache = store.get("lw.pc.src2", {});
  async function resolveSrc(sym, exId) {
    const key = exId + ":" + sym;
    if (srcCache[key]) return srcCache[key];
    const ex = EX[exId];
    let out = { kind: "cc", sym, want: exId, why: "not listed" }, sure = true;
    if (sym !== ex.quote) {
      try {
        const R = await ex.get(ex.pair(sym), ex.iv["1D"], null, 2, 86400);
        if (R.length) out = { kind: "ex", ex: exId, pair: ex.pair(sym), sym };
      } catch (e) { if (e instanceof TypeError || e.transient) { sure = false; out.why = "unreachable"; } }
    }
    if (sure) { srcCache[key] = out; store.set("lw.pc.src2", srcCache); }
    return out;
  }
  const srcName = src => !src ? "" : src.kind === "ex" ? EX[src.ex].name : "CryptoCompare";
  const srcQuote = src => src && src.kind === "ex" ? EX[src.ex].quote : "USD";

  // Bars as {rt (real unix sec), o, h, l, c, v}, oldest first. endRt = only bars that open before it.
  // Merge bars into calendar buckets of `m` months (quarters start Jan/Apr/Jul/Oct, halves Jan/Jul, years Jan), UTC.
  function groupMonths(bars, m) {
    const out = [];
    for (const b of bars) {
      const d = new Date(b.rt * 1000), idx = Math.floor((d.getUTCFullYear() * 12 + d.getUTCMonth()) / m) * m;
      const rt = Date.UTC(Math.floor(idx / 12), idx % 12, 1) / 1000, cur = out[out.length - 1];
      if (cur && cur.rt === rt) { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
      else out.push({ rt, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
    return out;
  }
  // Merge bars into fixed buckets of `s` seconds (weeks start Monday 00:00 UTC). n = source bars merged.
  function groupSecs(bars, s, off) {
    const out = [];
    for (const b of bars) {
      const rt = Math.floor((b.rt - off) / s) * s + off, cur = out[out.length - 1];
      if (cur && cur.rt === rt) { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; cur.n++; }
      else out.push({ rt, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, n: 1 });
    }
    return out;
  }
  // Whole daily history from an exchange, paging backwards (capped at 25 requests)
  async function allDaily(src, ex) {
    let out = [], end = null;
    for (let i = 0; i < 25; i++) {
      const R = await ex.get(src.pair, ex.iv["1D"], end, ex.max, 86400);
      const older = end ? R.filter(b => b.rt < end) : R;
      if (!older.length) break;
      out = older.concat(out); end = older[0].rt;
    }
    return out;
  }
  // Monthly-or-finer history used to build month frames; cached 5 minutes since live updates poll often
  const monthCache = {};
  async function monthBase(src) {
    const key = src.kind === "cc" ? "cc:" + src.sym : src.ex + ":" + src.pair, c = monthCache[key];
    if (c && Date.now() - c.t < 300000) return c.bars;
    let bars;
    if (src.kind === "cc") {
      const r = await fetch(`https://min-api.cryptocompare.com/data/v2/histoday?fsym=${encodeURIComponent(src.sym)}&tsym=USD&allData=true`);
      const j = r.ok ? await r.json() : null;
      if (!j || j.Response === "Error" || !j.Data || !j.Data.Data) throw new Error(`No price history found for ${src.sym}`);
      bars = j.Data.Data.filter(d => d.open || d.close).map(d => ({ rt: d.time, o: d.open, h: d.high, l: d.low, c: d.close, v: d.volumefrom }));
    } else {
      const ex = EX[src.ex];
      bars = ex.iv["1M"] ? await ex.get(src.pair, ex.iv["1M"], null, ex.max, 2592000) : await allDaily(src, ex);
    }
    monthCache[key] = { t: Date.now(), bars };
    return bars;
  }
  async function fetchMonthly(src, m, endRt, limit) {
    let out = groupMonths(await monthBase(src), m);
    if (endRt) out = out.filter(b => b.rt < endRt);
    return out.slice(-limit);
  }
  async function fetchBars(src, iv, endRt, limit = 1000) {
    if (IV[iv].m) return fetchMonthly(src, IV[iv].m, endRt, limit);
    if (src.kind === "ex") {
      const ex = EX[src.ex];
      if (ex.iv[iv]) return ex.get(src.pair, ex.iv[iv], endRt, Math.min(limit, ex.max), IV[iv].s);
      if (iv === "1M") return fetchMonthly(src, 1, endRt, limit);
      // Not native here: merge the largest native interval that divides evenly into this one
      const s = IV[iv].s, base = Object.keys(ex.iv).filter(k => k !== "1M" && s % IV[k].s === 0).sort((a, b) => IV[b].s - IV[a].s)[0];
      if (!base) throw new Error(`${ex.name} doesn't offer ${IV[iv].n} candles`);
      const ratio = s / IV[base].s;
      const R = await ex.get(src.pair, ex.iv[base], endRt, Math.min(ex.max, (limit + 1) * ratio), IV[base].s);
      let out = groupSecs(R, s, iv === "1W" ? 345600 : 0);
      if (out.length > 1 && out[0].n < ratio) out = out.slice(1); // oldest bucket was cut off by the request window
      return out.slice(-limit).map(({ n, ...b }) => b);
    }
    const [u, agg] = IV[iv].c;
    const r = await fetch(`https://min-api.cryptocompare.com/data/v2/histo${u}?fsym=${encodeURIComponent(src.sym)}&tsym=USD&limit=${Math.min(limit, 2000)}&aggregate=${agg}${endRt ? `&toTs=${endRt - 1}` : ""}`);
    const j = r.ok ? await r.json() : null;
    if (!j || j.Response === "Error" || !j.Data || !j.Data.Data) throw new Error(`No price history found for ${src.sym}`);
    return j.Data.Data.filter(d => d.open || d.close).map(d => ({ rt: d.time, o: d.open, h: d.high, l: d.low, c: d.close, v: d.volumefrom }));
  }

  // ---------- Indicator math (arrays aligned to bars, null during warm-up) ----------
  const fill = n => new Array(n).fill(null);
  function sma(a, n) { const o = fill(a.length); let s = 0, k = 0; for (let i = 0; i < a.length; i++) { const v = a[i]; if (v == null) { s = 0; k = 0; continue; } s += v; k++; if (k > n) { s -= a[i - n]; k = n; } if (k === n) o[i] = s / n; } return o; }
  function ewm(a, n, al) { const o = fill(a.length); let p = null, s = 0, k = 0; for (let i = 0; i < a.length; i++) { const v = a[i]; if (v == null) continue; if (p == null) { s += v; if (++k === n) o[i] = p = s / n; continue; } o[i] = p = v * al + p * (1 - al); } return o; }
  const ema = (a, n) => ewm(a, n, 2 / (n + 1)), rma = (a, n) => ewm(a, n, 1 / n);
  function wma(a, n) { const o = fill(a.length), d = n * (n + 1) / 2; for (let i = n - 1; i < a.length; i++) { let s = 0, ok = true; for (let j = 0; j < n; j++) { const v = a[i - j]; if (v == null) { ok = false; break; } s += v * (n - j); } if (ok) o[i] = s / d; } return o; }
  function sd(a, n) { const m = sma(a, n); return m.map((mv, i) => { if (mv == null) return null; let s = 0; for (let j = 0; j < n; j++) { const d = a[i - j] - mv; s += d * d; } return Math.sqrt(s / n); }); }
  function hh(a, n) { return a.map((_, i) => { if (i < n - 1) return null; let m = -Infinity; for (let j = 0; j < n; j++) { const v = a[i - j]; if (v == null) return null; if (v > m) m = v; } return m; }); }
  function ll(a, n) { return a.map((_, i) => { if (i < n - 1) return null; let m = Infinity; for (let j = 0; j < n; j++) { const v = a[i - j]; if (v == null) return null; if (v < m) m = v; } return m; }); }
  const trA = B => B.map((b, i) => i ? Math.max(b.h - b.l, Math.abs(b.h - B[i - 1].c), Math.abs(b.l - B[i - 1].c)) : b.h - b.l);
  function rsiA(c, n) {
    const up = fill(c.length), dn = fill(c.length);
    for (let i = 1; i < c.length; i++) { if (c[i] == null || c[i - 1] == null) continue; const d = c[i] - c[i - 1]; up[i] = Math.max(d, 0); dn[i] = Math.max(-d, 0); }
    const u = rma(up, n), d = rma(dn, n);
    return u.map((uv, i) => uv == null || d[i] == null ? null : d[i] === 0 ? 100 : uv === 0 ? 0 : 100 - 100 / (1 + uv / d[i]));
  }
  const stochOf = (src, hi, lo, n) => { const H = hh(hi, n), L = ll(lo, n); return src.map((v, i) => v == null || H[i] == null ? null : H[i] === L[i] ? 50 : 100 * (v - L[i]) / (H[i] - L[i])); };

  const UP = "#089981", DN = "#f23645";
  // pane: false = drawn over the price. out: [{ name, kind: line|hist|dots, color, data, colors? }]
  const IND = {
    vol: { name: "Volume", short: "Vol", pane: false, params: [], calc: B => [{ name: "Vol", kind: "hist", vol: true, data: B.map(b => b.v), colors: B.map(b => (b.c >= b.o ? UP : DN) + "80") }] },
    sma: { name: "Moving average (SMA)", short: "SMA", pane: false, params: [["len", "Length", 20]], color: "#2962ff", calc: (B, p) => [{ name: "SMA", data: sma(B.map(b => b.c), p.len) }] },
    ema: { name: "Exponential moving average (EMA)", short: "EMA", pane: false, params: [["len", "Length", 50]], color: "#ff6d00", calc: (B, p) => [{ name: "EMA", data: ema(B.map(b => b.c), p.len) }] },
    wma: { name: "Weighted moving average (WMA)", short: "WMA", pane: false, params: [["len", "Length", 20]], color: "#ab47bc", calc: (B, p) => [{ name: "WMA", data: wma(B.map(b => b.c), p.len) }] },
    bb: { name: "Bollinger Bands", short: "BB", pane: false, params: [["len", "Length", 20], ["mult", "StdDev", 2]], color: "#2962ff", calc: (B, p) => { const c = B.map(b => b.c), m = sma(c, p.len), s = sd(c, p.len); return [{ name: "Basis", color: "#ff6d00", data: m }, { name: "Upper", data: m.map((v, i) => v == null ? null : v + p.mult * s[i]) }, { name: "Lower", data: m.map((v, i) => v == null ? null : v - p.mult * s[i]) }]; } },
    donchian: { name: "Donchian Channels", short: "DC", pane: false, params: [["len", "Length", 20]], color: "#2962ff", calc: (B, p) => { const H = hh(B.map(b => b.h), p.len), L = ll(B.map(b => b.l), p.len); return [{ name: "Upper", data: H }, { name: "Basis", color: "#ff6d00", data: H.map((v, i) => v == null ? null : (v + L[i]) / 2) }, { name: "Lower", data: L }]; } },
    vwap: { name: "VWAP", short: "VWAP", pane: false, params: [], color: "#2962ff", calc: (B, p, ctx) => {
      const per = ctx.step < 86400 ? 86400 : null; let key = null, pv = 0, vv = 0;
      return [{ name: "VWAP", data: B.map(b => { const d = new Date(b.rt * 1000), k = per ? Math.floor(b.rt / per) : ctx.step < 604800 ? d.getUTCFullYear() * 12 + d.getUTCMonth() : d.getUTCFullYear(); if (k !== key) { key = k; pv = 0; vv = 0; } const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vv += b.v; return vv ? pv / vv : tp; }) }];
    } },
    supertrend: { name: "Supertrend", short: "ST", pane: false, params: [["len", "ATR length", 10], ["mult", "Factor", 3]], calc: (B, p) => {
      const atr = rma(trA(B), p.len), out = fill(B.length), col = fill(B.length); let fu = null, fl = null, dir = 1;
      for (let i = 0; i < B.length; i++) {
        if (atr[i] == null) continue; const m = (B[i].h + B[i].l) / 2, bu = m + p.mult * atr[i], bl = m - p.mult * atr[i], pc = i ? B[i - 1].c : B[i].c;
        fu = fu == null || bu < fu || pc > fu ? bu : fu; fl = fl == null || bl > fl || pc < fl ? bl : fl;
        if (dir === 1 && B[i].c < fl) dir = -1; else if (dir === -1 && B[i].c > fu) dir = 1;
        out[i] = dir === 1 ? fl : fu; col[i] = dir === 1 ? UP : DN;
      }
      return [{ name: "Supertrend", data: out, colors: col }];
    } },
    psar: { name: "Parabolic SAR", short: "SAR", pane: false, params: [["start", "Start", 0.02], ["inc", "Increment", 0.02], ["max", "Max", 0.2]], color: "#2962ff", calc: (B, p) => {
      const o = fill(B.length); if (B.length < 2) return [{ name: "SAR", kind: "dots", data: o }];
      let up = B[1].c >= B[0].c, sar = up ? B[0].l : B[0].h, ep = up ? B[1].h : B[1].l, af = p.start;
      for (let i = 1; i < B.length; i++) {
        sar = sar + af * (ep - sar);
        if (up) { sar = Math.min(sar, B[i - 1].l, i > 1 ? B[i - 2].l : B[i - 1].l); if (B[i].l < sar) { up = false; sar = ep; ep = B[i].l; af = p.start; } else if (B[i].h > ep) { ep = B[i].h; af = Math.min(af + p.inc, p.max); } }
        else { sar = Math.max(sar, B[i - 1].h, i > 1 ? B[i - 2].h : B[i - 1].h); if (B[i].h > sar) { up = true; sar = ep; ep = B[i].h; af = p.start; } else if (B[i].l < ep) { ep = B[i].l; af = Math.min(af + p.inc, p.max); } }
        o[i] = sar;
      }
      return [{ name: "SAR", kind: "dots", data: o }];
    } },
    rsi: { name: "Relative strength index (RSI)", short: "RSI", pane: true, params: [["len", "Length", 14], ["ma", "MA length", 14]], color: "#7e57c2", levels: [70, 30], band: [30, 70], calc: (B, p) => { const r = rsiA(B.map(b => b.c), p.len); return [{ name: "RSI", data: r }, { name: "MA", color: "#fdd835", data: sma(r, p.ma) }]; } },
    macd: { name: "MACD", short: "MACD", pane: true, params: [["fast", "Fast", 12], ["slow", "Slow", 26], ["sig", "Signal", 9]], color: "#2962ff", levels: [0], calc: (B, p) => {
      const c = B.map(b => b.c), f = ema(c, p.fast), s = ema(c, p.slow), m = f.map((v, i) => v == null || s[i] == null ? null : v - s[i]), g = ema(m, p.sig), h = m.map((v, i) => v == null || g[i] == null ? null : v - g[i]);
      return [{ name: "Hist", kind: "hist", data: h, colors: h.map((v, i) => v == null ? null : v >= 0 ? (h[i - 1] != null && h[i - 1] > v ? "#b2dfdb" : "#26a69a") : (h[i - 1] != null && h[i - 1] < v ? "#ffcdd2" : "#ff5252")) }, { name: "MACD", data: m }, { name: "Signal", color: "#ff6d00", data: g }];
    } },
    stoch: { name: "Stochastic", short: "Stoch", pane: true, params: [["len", "%K length", 14], ["k", "%K smoothing", 3], ["d", "%D smoothing", 3]], color: "#2962ff", levels: [80, 20], band: [20, 80], calc: (B, p) => { const k = sma(stochOf(B.map(b => b.c), B.map(b => b.h), B.map(b => b.l), p.len), p.k); return [{ name: "%K", data: k }, { name: "%D", color: "#ff6d00", data: sma(k, p.d) }]; } },
    stochrsi: { name: "Stochastic RSI", short: "Stoch RSI", pane: true, params: [["rsi", "RSI length", 14], ["len", "Stoch length", 14], ["k", "K", 3], ["d", "D", 3]], color: "#2962ff", levels: [80, 20], band: [20, 80], calc: (B, p) => { const r = rsiA(B.map(b => b.c), p.rsi), k = sma(stochOf(r, r, r, p.len), p.k); return [{ name: "K", data: k }, { name: "D", color: "#ff6d00", data: sma(k, p.d) }]; } },
    atr: { name: "Average true range (ATR)", short: "ATR", pane: true, params: [["len", "Length", 14]], color: "#b71c1c", calc: (B, p) => [{ name: "ATR", data: rma(trA(B), p.len) }] },
    adx: { name: "ADX / DMI", short: "ADX", pane: true, params: [["len", "Length", 14]], color: "#ff6d00", calc: (B, p) => {
      const pd = fill(B.length), md = fill(B.length);
      for (let i = 1; i < B.length; i++) { const u = B[i].h - B[i - 1].h, d = B[i - 1].l - B[i].l; pd[i] = u > d && u > 0 ? u : 0; md[i] = d > u && d > 0 ? d : 0; }
      const tr = rma(trA(B).map((v, i) => i ? v : null), p.len), P = rma(pd, p.len), M = rma(md, p.len);
      const pdi = P.map((v, i) => v == null || !tr[i] ? null : 100 * v / tr[i]), mdi = M.map((v, i) => v == null || !tr[i] ? null : 100 * v / tr[i]);
      const dx = pdi.map((v, i) => v == null || mdi[i] == null ? null : v + mdi[i] === 0 ? 0 : 100 * Math.abs(v - mdi[i]) / (v + mdi[i]));
      return [{ name: "ADX", data: rma(dx, p.len) }, { name: "+DI", color: UP, data: pdi }, { name: "−DI", color: DN, data: mdi }];
    } },
    cci: { name: "Commodity channel index (CCI)", short: "CCI", pane: true, params: [["len", "Length", 20]], color: "#2962ff", levels: [100, -100], band: [-100, 100], calc: (B, p) => {
      const tp = B.map(b => (b.h + b.l + b.c) / 3), m = sma(tp, p.len);
      return [{ name: "CCI", data: m.map((mv, i) => { if (mv == null) return null; let s = 0; for (let j = 0; j < p.len; j++) s += Math.abs(tp[i - j] - mv); const md = s / p.len; return md ? (tp[i] - mv) / (0.015 * md) : 0; }) }];
    } },
    mfi: { name: "Money flow index (MFI)", short: "MFI", pane: true, params: [["len", "Length", 14]], color: "#7e57c2", levels: [80, 20], band: [20, 80], calc: (B, p) => {
      const tp = B.map(b => (b.h + b.l + b.c) / 3);
      return [{ name: "MFI", data: B.map((_, i) => { if (i < p.len) return null; let pos = 0, neg = 0; for (let j = i - p.len + 1; j <= i; j++) { const f = tp[j] * B[j].v; if (tp[j] > tp[j - 1]) pos += f; else if (tp[j] < tp[j - 1]) neg += f; } return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg); }) }];
    } },
    obv: { name: "On balance volume (OBV)", short: "OBV", pane: true, params: [], color: "#2962ff", calc: B => { let s = 0; return [{ name: "OBV", data: B.map((b, i) => (s += i ? (b.c > B[i - 1].c ? b.v : b.c < B[i - 1].c ? -b.v : 0) : 0)) }]; } },
    willr: { name: "Williams %R", short: "%R", pane: true, params: [["len", "Length", 14]], color: "#7e57c2", levels: [-20, -80], band: [-80, -20], calc: (B, p) => { const H = hh(B.map(b => b.h), p.len), L = ll(B.map(b => b.l), p.len); return [{ name: "%R", data: B.map((b, i) => H[i] == null ? null : H[i] === L[i] ? -50 : -100 * (H[i] - b.c) / (H[i] - L[i])) }]; } },
  };
  const indParams = (type, given) => { const o = {}; for (const [k, , d] of IND[type].params) o[k] = given && given[k] != null && isFinite(given[k]) ? +given[k] : d; return o; };
  const indLabel = (type, params) => { const d = IND[type], v = d.params.map(([k]) => params[k]); return d.short + (v.length ? " " + v.join(" ") : ""); };
  const indKey = (type, params) => "i:" + type + (IND[type].params.length ? ":" + IND[type].params.map(([k]) => params[k]).join(",") : "");
  function parseKey(fk) {
    if (fk.startsWith("d:")) return TOOLS[fk.slice(2)] ? { kind: "d", id: fk.slice(2) } : null;
    const [, type, vals] = fk.split(":"); if (!IND[type]) return null;
    const p = {}; const vs = (vals || "").split(","); IND[type].params.forEach(([k, , d], i) => p[k] = vs[i] !== undefined && vs[i] !== "" ? +vs[i] : d);
    return { kind: "i", type, params: p };
  }

  // ---------- Drawing tools ----------
  const sv = d => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const dot = (x, y) => `<circle cx="${x}" cy="${y}" r="1.7" fill="currentColor"/>`;
  const IC = {
    cursor: sv('<path d="M10 2v6M10 12v6M2 10h6M12 10h6"/>'),
    trend: sv('<path d="M4 16L16 4"/>' + dot(4, 16) + dot(16, 4)),
    ray: sv('<path d="M4 16L18 2"/>' + dot(4, 16) + dot(11, 9)),
    ext: sv('<path d="M1 19L19 1"/>' + dot(7, 13) + dot(13, 7)),
    arrow: sv('<path d="M4 16L16 4M9 4h7v7"/>'),
    hline: sv('<path d="M1 10h18"/>' + dot(10, 10)),
    hray: sv('<path d="M5 10h14"/>' + dot(5, 10)),
    vline: sv('<path d="M10 1v18"/>' + dot(10, 10)),
    cross: sv('<path d="M10 1v18M1 10h18"/>'),
    channel: sv('<path d="M2 12L12 2M8 18L18 8"/>' + dot(2, 12) + dot(18, 8)),
    fib: sv('<path d="M2 4h16M2 8h16M2 12h16M2 16h16"/>' + dot(2, 4) + dot(18, 16)),
    rect: sv('<rect x="3" y="5" width="14" height="10" rx="1"/>'),
    measure: sv('<path d="M3 14L14 3l3 3L6 17z"/><path d="M6.5 10.5l1.5 1.5M9 8l1.5 1.5M11.5 5.5L13 7"/>'),
    text: sv('<path d="M4 4h12M10 4v13M7.5 17h5"/>'),
    magnet: sv('<path d="M5 3v7a5 5 0 0 0 10 0V3"/><path d="M5 6h3M12 6h3"/>'),
    stay: sv('<rect x="4" y="9" width="12" height="9" rx="1.5"/><path d="M7 9V6a3 3 0 0 1 6 0v3"/>'),
    eye: sv('<path d="M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6-8.5-6-8.5-6z"/><circle cx="10" cy="10" r="2.5"/>'),
    eyeoff: sv('<path d="M3 3l14 14M8 4.3A8 8 0 0 1 10 4c5 0 8.5 6 8.5 6a14 14 0 0 1-2.6 3.2M5.2 6A14 14 0 0 0 1.5 10S5 16 10 16a8 8 0 0 0 3.5-.8"/>'),
    trash: sv('<path d="M3 5h14M8 5V3h4v2M5 5l1 12h8l1-12"/>'),
    star: '<svg viewBox="0 0 20 20"><path d="M10 1.8l2.5 5.2 5.6.7-4.1 3.9 1 5.6L10 14.5l-5 2.7 1-5.6L1.9 7.7l5.6-.7z"/></svg>',
    ind: sv('<path d="M2 17h16"/><path d="M3 13l4-5 4 3 6-7"/>'),
    cam: sv('<path d="M2 6.5h3.5L7 4h6l1.5 2.5H18V16H2z"/><circle cx="10" cy="11" r="3"/>'),
    kbd: sv('<rect x="1.5" y="5" width="17" height="11" rx="2"/><path d="M5 8.5h.01M8 8.5h.01M11 8.5h.01M14 8.5h.01M6 12.5h8"/>'),
    fs: sv('<path d="M3 7.5V3h4.5M17 7.5V3h-4.5M3 12.5V17h4.5M17 12.5V17h-4.5"/>'),
    gear: sv('<circle cx="10" cy="10" r="2.6"/><path d="M10 1.5v2.5M10 16v2.5M1.5 10H4M16 10h2.5M4 4l1.8 1.8M14.2 14.2L16 16M4 16l1.8-1.8M14.2 5.8L16 4"/>'),
    x: sv('<path d="M5 5l10 10M15 5L5 15"/>'),
    undo: sv('<path d="M7 4L3 8l4 4"/><path d="M3 8h9a5 5 0 0 1 0 10H9"/>'),
    grip: sv(dot(7, 5) + dot(13, 5) + dot(7, 10) + dot(13, 10) + dot(7, 15) + dot(13, 15)),
  };
  const TOOLS = {
    trend: { name: "Trend line", n: 2 }, ray: { name: "Ray", n: 2 }, ext: { name: "Extended line", n: 2 }, arrow: { name: "Arrow", n: 2 },
    hline: { name: "Horizontal line", n: 1 }, hray: { name: "Horizontal ray", n: 1 }, vline: { name: "Vertical line", n: 1 }, cross: { name: "Cross line", n: 1 },
    channel: { name: "Parallel channel", n: 3 }, fib: { name: "Fib retracement", n: 2 },
    rect: { name: "Rectangle", n: 2 }, text: { name: "Text", n: 1 }, measure: { name: "Price / date range", n: 2 },
  };
  const GROUPS = [
    { id: "lines", name: "Lines", tools: ["trend", "ray", "ext", "arrow", "hline", "hray", "vline", "cross"] },
    { id: "fibs", name: "Fibonacci & channels", tools: ["fib", "channel"] },
    { id: "shapes", name: "Shapes & text", tools: ["rect", "text"] },
    { id: "measure", name: "Measure", tools: ["measure"] },
  ];
  const FIB = [[0, "#787b86"], [0.236, "#f23645"], [0.382, "#ff9800"], [0.5, "#4caf50"], [0.618, "#089981"], [0.786, "#00bcd4"], [1, "#787b86"], [1.618, "#2962ff"]];
  const COLORS = ["#2962ff", "#f23645", "#089981", "#ff9800", "#ab47bc", "#00bcd4", "#fdd835", "#787b86"];

  // ---------- Shared settings (all charts) ----------
  const DEFAULT_KEYS = { "d:trend": "Alt+T", "d:hline": "Alt+H", "d:hray": "Alt+J", "d:vline": "Alt+V", "d:cross": "Alt+C", "d:fib": "Alt+F", "d:rect": "Alt+Shift+R", "d:measure": "Alt+Shift+M", "d:text": "Alt+Shift+T" };
  const RESERVED = { "/": "Open indicators", "Escape": "Cancel / deselect", "Delete": "Delete selected drawing", "Backspace": "Delete selected drawing", "Ctrl+Z": "Undo drawing change", "Alt+R": "Reset chart view" };
  for (let i = 1; i <= 9; i++) RESERVED["Alt+" + i] = `Favourite #${i}`;
  const S = {
    fav: store.get("lw.pc.fav", []).filter(parseKey),
    keys: store.get("lw.pc.keys", {}),
    ind: store.get("lw.pc.ind", [{ uid: "v1", type: "vol", params: {} }]).filter(x => IND[x && x.type]),
    iv: IV[store.get("lw.pc.iv", "1D")] ? store.get("lw.pc.iv", "1D") : "1D",
    type: store.get("lw.pc.type", "candles"),
    ex: EX[store.get("lw.pc.ex", "binance")] ? store.get("lw.pc.ex", "binance") : "binance",
    magnet: store.get("lw.pc.mag", false), stay: false,
    favPos: store.get("lw.pc.favpos", null),
  };
  const saveS = () => { store.set("lw.pc.favpos", S.favPos); store.set("lw.pc.fav", S.fav); store.set("lw.pc.keys", S.keys); store.set("lw.pc.ind", S.ind); store.set("lw.pc.iv", S.iv); store.set("lw.pc.type", S.type); store.set("lw.pc.ex", S.ex);store.set("lw.pc.mag", S.magnet); };
  const keyOf = fk => fk in S.keys ? S.keys[fk] : (DEFAULT_KEYS[fk] || "");
  const allKeyed = () => { const m = {}; for (const fk of new Set([...Object.keys(DEFAULT_KEYS), ...Object.keys(S.keys)])) { const k = keyOf(fk); if (k) m[k] = fk; } return m; };
  const favNum = fk => { const i = S.fav.indexOf(fk); return i >= 0 && i < 9 ? i + 1 : 0; };
  const shortcutsFor = fk => [favNum(fk) ? "Alt+" + favNum(fk) : "", keyOf(fk)].filter(Boolean);
  const insts = new Set(); let active = null;
  const everyone = fn => insts.forEach(p => { if (p.root.isConnected) fn(p); });
  function toggleFav(fk) {
    const i = S.fav.indexOf(fk); if (i >= 0) S.fav.splice(i, 1); else S.fav.push(fk);
    saveS(); everyone(p => p.refreshUi());
  }
  const favName = fk => { const k = parseKey(fk); return !k ? fk : k.kind === "d" ? TOOLS[k.id].name : indLabel(k.type, k.params); };

  function comboOf(e) {
    let k = e.key;
    if (["Control", "Alt", "Shift", "Meta", "AltGraph", "CapsLock"].includes(k)) return "";
    if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3); else if (/^(Digit|Numpad)[0-9]$/.test(e.code)) k = e.code.slice(-1);
    else if (e.code === "Slash") k = "/"; else if (k === " ") k = "Space"; else if (k.length === 1) k = k.toUpperCase();
    return [(e.ctrlKey || e.metaKey) && "Ctrl", e.altKey && "Alt", e.shiftKey && k !== "/" && "Shift", k].filter(Boolean).join("+");
  }
  const editing = t => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

  let capture = null; // { fk, done(combo|null|"") } while a shortcut is being recorded
  window.addEventListener("keydown", e => {
    if (capture) {
      e.preventDefault(); e.stopPropagation();
      const c = comboOf(e); if (!c) return;
      const cb = capture; capture = null;
      cb.done(c === "Escape" ? null : c === "Backspace" || c === "Delete" ? "" : c);
      return;
    }
    const pc = active && active.root.isConnected && active.root.getClientRects().length ? active : [...insts].find(p => p.root.isConnected && p.root.getClientRects().length);
    if (!pc) return;
    const c = comboOf(e); if (!c) return;
    if (editing(e.target)) { if (c === "Escape" && pc.pop.contains(e.target)) { pc.closePop(); e.preventDefault(); } return; }
    let fs = false; try { fs = !!pc.root.closest(".tvfull") || !!(document.fullscreenElement && document.fullscreenElement.contains(pc.root)); } catch {}
    const near = pc.hover || pc.root.contains(document.activeElement) || fs;
    if (c === "Escape") { if (pc.escape()) e.preventDefault(); return; }
    if (!near && !/Alt|Ctrl/.test(c)) return;               // bare keys only act while the pointer is over the chart
    if (c === "Delete" || c === "Backspace") { if (pc.deleteSel()) e.preventDefault(); return; }
    if (c === "Ctrl+Z") { if (near && pc.undo()) e.preventDefault(); return; }
    if (c === "/") { pc.openInd(); e.preventDefault(); return; }
    if (c === "Alt+R") { pc.fit(); e.preventDefault(); return; }
    const m = c.match(/^Alt\+([1-9])$/);
    if (m) { const fk = S.fav[m[1] - 1]; if (fk) { pc.run(fk); e.preventDefault(); } return; }
    const fk = allKeyed()[c]; if (fk) { pc.run(fk); e.preventDefault(); }
  }, true);

  // ---------- Styles ----------
  const style = document.createElement("style");
  style.textContent = `
.pc{position:relative;display:flex;flex-direction:column;height:100%;background:var(--surface);color:var(--ink);font-size:13px;outline:none;user-select:none;-webkit-user-select:none}
.pc button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.pc svg{width:18px;height:18px;flex:none}
.pc-top{display:flex;align-items:center;gap:2px;padding:4px 6px;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none;min-height:40px}
.pc-top::-webkit-scrollbar{display:none}
.pc-top>button,.pc-ivs button,.pc-top select{height:30px;padding:0 8px;border-radius:6px;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-weight:600}
.pc-top>button:hover,.pc-ivs button:hover,.pc-left button:hover{background:var(--surface-2)}
.pc-sym{font-weight:700;padding:0 8px;white-space:nowrap}.pc-sym span{color:var(--muted);font-weight:500}
.pc-sep{width:1px;height:20px;background:var(--line);margin:0 4px;flex:none}
.pc-ex{min-width:96px;padding:0 6px!important;font-weight:700}.pc-ex.fb{color:var(--muted)!important}
.pc-iv{min-width:104px;margin-left:2px;padding:0 6px!important;border:1px solid var(--line)!important;font-weight:600}
.pc-ivs{display:flex}.pc-ivs button{padding:0 7px;color:var(--muted)}.pc-ivs button.on{color:var(--accent);background:var(--accent-soft)}
.pc-top select{border:0;background:var(--surface);color:var(--ink);cursor:pointer}
.pc-favs{display:flex;gap:3px;align-items:center;margin-left:4px}
.pc-chip{height:28px;display:inline-flex;align-items:center;gap:5px;padding:0 8px;border:1px solid var(--line)!important;border-radius:7px;font-size:12px;font-weight:600;white-space:nowrap}
.pc-chip:hover{border-color:var(--accent)!important}.pc-chip small{font-size:10px;color:var(--faint);font-family:var(--f-mono,monospace)}.pc-chip svg{width:16px;height:16px}
.pc-chip.on{background:var(--accent-soft);color:var(--accent)}
.pc-fbox{position:absolute;z-index:7;top:8px;left:8px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:4px 5px 4px 2px;max-width:calc(100% - 16px);background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:0 6px 20px #0002;cursor:grab;touch-action:none}
.pc-fbox[hidden]{display:none}
.pc-fbox.drag{cursor:grabbing;box-shadow:0 10px 28px #0003}
.pc-fgrip{display:grid;place-items:center;width:16px;height:28px;color:var(--faint)}.pc-fgrip svg{width:14px;height:14px}
.pc-fitem{display:inline-flex;align-items:center;height:28px;border:1px solid var(--line);border-radius:7px;padding-right:2px;cursor:default}
.pc-fitem:hover{border-color:var(--accent)}.pc-fitem.on{background:var(--accent-soft);color:var(--accent)}
.pc-fitem .pc-chip{border:0!important;height:26px;padding:0 3px 0 8px}
.pc .pc-fx{width:18px;height:18px;display:grid;place-items:center;border-radius:50%;color:var(--faint)}
.pc .pc-fx:hover{background:var(--down-soft,#f2364522);color:${DN}}.pc .pc-fx svg{width:11px;height:11px}
.pc-hint{color:var(--faint);font-size:12px;white-space:nowrap;padding:0 6px}
.pc-sp{flex:1}
.pc [data-tvfs] span{display:none}
.pc-mid{flex:1;display:flex;min-height:0}
.pc-left{width:46px;flex:none;border-right:1px solid var(--line);display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 0;overflow-y:auto;scrollbar-width:none}
.pc-left button{width:36px;height:34px;border-radius:7px;display:grid;place-items:center;color:var(--ink)}
.pc-left button.on{background:var(--accent-soft);color:var(--accent)}
.pc-left hr{width:26px;border:0;border-top:1px solid var(--line);margin:4px 0}
.pc-grp{position:relative}.pc-grp .pc-more{position:absolute;right:-6px;top:0;width:12px!important;height:34px!important;font-size:11px;color:var(--faint);opacity:.0}
.pc-grp:hover .pc-more{opacity:1}
.pc-main{position:relative;flex:1;min-width:0}
.pc-chart{position:absolute;inset:0}
.pc-legend{position:absolute;left:8px;top:6px;z-index:3;pointer-events:none;font-size:12px;line-height:1.55;max-width:calc(100% - 90px)}
.pc-legend .r{display:flex;align-items:center;gap:6px;white-space:nowrap;width:max-content;max-width:100%;overflow:hidden;border-radius:5px;padding:0 4px}
.pc-legend .r b{font-weight:600}.pc-legend .m{color:var(--muted)}.pc-legend .u{color:${UP}}.pc-legend .d{color:${DN}}
.pc-legend .ind{pointer-events:auto}.pc-legend .ind:hover{background:var(--surface-2)}
.pc-legend .ops{display:none;gap:1px}.pc-legend .ind:hover .ops{display:inline-flex}
.pc-legend .ops button{width:20px;height:20px;display:grid;place-items:center;border-radius:4px}.pc-legend .ops button:hover{background:var(--line)}
.pc-legend .ops svg{width:14px;height:14px}.pc-legend .ops .fav svg{fill:#f5b301;stroke:none}.pc-legend .ops .nofav svg{fill:none;stroke:currentColor;stroke-width:1.4}
.pc-legend .off{opacity:.45}
.pc-msg{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);z-index:4;pointer-events:none;text-align:center;padding:0 16px}
.pc-sel{position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:5;display:flex;align-items:center;gap:4px;padding:4px 6px;background:var(--surface);border:1px solid var(--line);border-radius:9px;box-shadow:0 6px 20px #0002}
.pc-sel .sw{width:18px;height:18px;border-radius:50%;border:2px solid transparent}.pc-sel .sw.on{border-color:var(--ink)}
.pc-sel .wd{height:22px;min-width:24px;border-radius:5px;font-size:11px;font-weight:700}.pc-sel .wd.on{background:var(--accent-soft);color:var(--accent)}
.pc-sel .del{width:26px;height:24px;display:grid;place-items:center;border-radius:5px}.pc-sel .del:hover{background:var(--down-soft,#f2364522);color:${DN}}
.pc-sel i{width:1px;height:18px;background:var(--line);margin:0 2px}
.pc-pop{position:absolute;z-index:20;background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:0 12px 36px #0003;max-height:calc(100% - 20px);overflow:auto}
.pc-fly{min-width:250px;padding:6px}
.pc-fly h6{margin:4px 8px 6px;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);font-weight:600}
.pc-item{display:flex;align-items:center;gap:10px;padding:0 6px 0 8px;height:36px;border-radius:7px;cursor:pointer;white-space:nowrap}
.pc-item:hover{background:var(--surface-2)}.pc-item.on{color:var(--accent)}
.pc-item .nm{flex:1;overflow:hidden;text-overflow:ellipsis}
.pc-item kbd,.pc-kb{font:11px var(--f-mono,monospace);color:var(--muted);background:var(--surface-2);border:1px solid var(--line);border-radius:5px;padding:1px 5px;white-space:nowrap}
.pc-star{width:26px;height:26px;display:grid;place-items:center;border-radius:6px;flex:none}
.pc-star svg{width:16px;height:16px;fill:none;stroke:var(--faint);stroke-width:1.4}
.pc-item:hover .pc-star svg{stroke:var(--muted)}.pc-star.on svg{fill:#f5b301!important;stroke:#f5b301!important}
.pc-star:hover{background:var(--line)}
.pc-dlg{width:min(520px,calc(100vw - 40px));display:flex;flex-direction:column;max-height:inherit}
.pc-dh{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--line);font-size:16px}
.pc-dh button{width:30px;height:30px;display:grid;place-items:center;border-radius:7px}.pc-dh button:hover{background:var(--surface-2)}
.pc-q{margin:10px 14px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit}
.pc-q:focus{outline:none;border-color:var(--accent)}
.pc-list{overflow:auto;padding:0 8px 10px;min-height:0;flex:1}
.pc-list h6{margin:10px 8px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);font-weight:600}
.pc-note{color:var(--muted);font-size:12px;padding:4px 8px 8px;line-height:1.5}
.pc-kbtn{min-width:86px;height:26px;border:1px dashed var(--line)!important;border-radius:6px;font:11px var(--f-mono,monospace)!important;color:var(--muted)!important}
.pc-kbtn.set{border-style:solid!important;color:var(--ink)!important;background:var(--surface-2)!important}
.pc-kbtn.rec{border-color:var(--accent)!important;color:var(--accent)!important}
.pc-form{padding:12px 14px;display:grid;gap:10px;min-width:240px}
.pc-form label{display:grid;grid-template-columns:1fr 110px;align-items:center;gap:10px;color:var(--muted);font-weight:600}
.pc-form input{padding:6px 8px;border:1px solid var(--line);border-radius:7px;background:var(--surface);color:var(--ink);font:inherit;width:100%}
.pc-form input[type=color]{padding:2px;height:30px}
.pc-form .go{display:flex;justify-content:flex-end;gap:8px}
.pc-form .go button{padding:7px 14px;border-radius:8px;font-weight:600;border:1px solid var(--line)}
.pc-form .go .pri{background:var(--accent);color:var(--accent-ink,#fff);border-color:var(--accent)}
.pc-txt{position:absolute;z-index:6;font:14px Figtree,system-ui,sans-serif;padding:3px 6px;border:1px solid var(--accent);border-radius:5px;background:var(--surface);color:var(--ink);min-width:140px;outline:none}
`;
  document.head.appendChild(style);

  // ---------- One chart ----------
  let uidN = 0;
  const uid = () => Date.now().toString(36) + (uidN++).toString(36);
  const measureCtx = document.createElement("canvas").getContext("2d");
  const FONT = "11px Figtree, system-ui, sans-serif", TFONT = "14px Figtree, system-ui, sans-serif";

  class ProChart {
    constructor(el, opt) {
      this.sym = String(opt.sym || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      this.name = opt.name || this.sym;
      this.dark = !!opt.dark;
      this.iv = S.iv; this.ex = S.ex; this.raw = []; this.T = []; this.tIdx = new Map(); this.prec = 2;
      this.tool = "cursor"; this.lastInGroup = {}; this.sel = null; this.placing = null; this.drag = null;
      this.drawings = store.get("lw.pc.dr." + this.sym, []); this.hideDraw = false; this.undoStack = [];
      this.indSeries = []; this.calc = {}; this.hover = false; this.gen = 0;
      this.root = document.createElement("div"); this.root.className = "pc"; this.root.tabIndex = 0;
      el.appendChild(this.root);
      this.root.innerHTML = `
        <div class="pc-top"></div>
        <div class="pc-mid"><div class="pc-left"></div>
          <div class="pc-main"><div class="pc-chart"></div><div class="pc-legend"></div><div class="pc-sel" hidden></div><div class="pc-fbox" hidden></div><div class="pc-msg">Loading chart…</div></div></div>
        <div class="pc-pop" hidden></div>`;
      this.q = s => this.root.querySelector(s);
      this.chartEl = this.q(".pc-chart"); this.pop = this.q(".pc-pop");
      this.renderTop(); this.renderLeft();
      this.bindUi();
      try { this.ro = new ResizeObserver(() => this.placeFavs()); this.ro.observe(this.q(".pc-main")); } catch {}
      insts.add(this);
      this.init();
    }

    msg(t) { const m = this.q(".pc-msg"); m.textContent = t || ""; m.hidden = !t; }

    async init() {
      try {
        const LC = this.LC = await loadLib();
        if (!this.root.isConnected && this.dead) return;
        this.chart = LC.createChart(this.chartEl, { autoSize: true, ...this.themeOpts(),
          timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 8, borderColor: css("--line") },
          crosshair: { mode: 0 } });
        this.layer = new Layer(this);
        this.chart.subscribeCrosshairMove(p => { this.cross = p; this.renderLegend(); });
        this.chart.timeScale().subscribeVisibleLogicalRangeChange(r => { if (r && r.from < 30) this.loadOlder(); });
        this.makeMain();
        this.bindPointer();
        this.src = await resolveSrc(this.sym, this.ex);
        await this.load();
        this.poll = setInterval(() => this.tick(), 10000);
      } catch (e) { this.msg((e && e.message) || "Chart failed to load"); }
    }

    themeOpts() {
      const bg = css("--surface") || (this.dark ? "#151a24" : "#fff"), ink = css("--muted") || "#666", line = css("--line") || "#e3e6ee";
      const grid = this.dark ? "#ffffff0d" : "#0000000a";
      return { layout: { background: { type: "solid", color: bg }, textColor: ink, fontFamily: "Figtree, system-ui, sans-serif", panes: { separatorColor: line, separatorHoverColor: line, enableResize: true } },
        grid: { vertLines: { color: grid }, horzLines: { color: grid } }, rightPriceScale: { borderColor: line } };
    }
    setTheme(dark) {
      if (this.dark === !!dark || !this.chart) { this.dark = !!dark; return; }
      this.dark = !!dark; this.chart.applyOptions({ ...this.themeOpts(), timeScale: { borderColor: css("--line") } });
    }

    makeMain() {
      if (!this.chart) return;
      const LC = this.LC, t = S.type;
      if (this.main) { try { this.main.detachPrimitive(this.layer); } catch {} this.chart.removeSeries(this.main); }
      const base = { priceLineVisible: true, lastValueVisible: true };
      this.main = t === "line" ? this.chart.addSeries(LC.LineSeries, { ...base, color: "#2962ff", lineWidth: 2 }, 0)
        : t === "area" ? this.chart.addSeries(LC.AreaSeries, { ...base, lineColor: "#2962ff", topColor: "#2962ff55", bottomColor: "#2962ff05", lineWidth: 2 }, 0)
        : t === "bars" ? this.chart.addSeries(LC.BarSeries, { ...base, upColor: UP, downColor: DN, thinBars: false }, 0)
        : this.chart.addSeries(LC.CandlestickSeries, { ...base, upColor: t === "hollow" ? "transparent" : UP, downColor: DN, borderVisible: t === "hollow", borderUpColor: UP, borderDownColor: DN, wickUpColor: UP, wickDownColor: DN }, 0);
      this.main.attachPrimitive(this.layer);
      if (this.raw.length) this.setMainData();
    }
    mainData() {
      const t = S.type, R = this.raw, T = this.T;
      if (t === "line" || t === "area") return R.map((b, i) => ({ time: T[i], value: b.c }));
      if (t === "heikin") { let po, pc; return R.map((b, i) => { const c = (b.o + b.h + b.l + b.c) / 4, o = i ? (po + pc) / 2 : (b.o + b.c) / 2; po = o; pc = c; return { time: T[i], open: o, high: Math.max(b.h, o, c), low: Math.min(b.l, o, c), close: c }; }); }
      return R.map((b, i) => ({ time: T[i], open: b.o, high: b.h, low: b.l, close: b.c }));
    }
    setMainData() {
      this.main.setData(this.mainData());
      this.main.applyOptions({ priceFormat: { type: "price", precision: this.prec, minMove: 1 / 10 ** this.prec } });
      const vol = S.ind.some(x => x.type === "vol" && !x.hidden);
      this.main.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: vol ? 0.22 : 0.08 } });
    }
    // Intraday bars are shown in your local time; daily and longer stay on their UTC date.
    chartTime(rt) { return IV[this.iv].s < 86400 ? rt - new Date(rt * 1000).getTimezoneOffset() * 60 : rt; }
    setRaw(R) {
      this.raw = R; this.T = R.map(b => this.chartTime(b.rt)); this.RT = R.map(b => b.rt);
      this.tIdx = new Map(this.T.map((t, i) => [t, i]));
      const last = R.length ? R[R.length - 1].c : 1;
      this.prec = last >= 1000 ? 2 : last >= 1 ? (last >= 10 ? 2 : 4) : last >= 0.01 ? 6 : 8;
    }

    async load() {
      const g = ++this.gen; this.older = { busy: false, done: false };
      this.msg("Loading chart…");
      const R = await fetchBars(this.src, this.iv);
      if (g !== this.gen) return;
      if (!R.length) throw new Error(`No price history for ${this.sym}`);
      this.setRaw(R); this.setMainData(); this.buildInd(); this.chart.timeScale().applyOptions({ timeVisible: IV[this.iv].s < 86400 });
      this.fitDefault(); this.msg(""); this.renderTop(); this.renderLegend(); this.redraw();
    }
    async switchEx() {
      const g = ++this.gen; this.msg(`Loading ${EX[this.ex].name}…`);
      try {
        const src = await resolveSrc(this.sym, this.ex);
        if (g !== this.gen) return;
        this.src = src; await this.load();
      } catch (e) { if (g === this.gen) { this.msg((e && e.message) || "Chart failed to load"); this.renderTop(); } }
    }
    fitDefault() { const n = this.raw.length; this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 150), to: n + 8 }); }
    fit() { if (this.chart) { this.chart.timeScale().resetTimeScale?.(); this.fitDefault(); this.main.priceScale().applyOptions({ autoScale: true }); } }
    async loadOlder() {
      const o = this.older; if (!o || o.busy || o.done || !this.raw.length) return;
      o.busy = true; const g = this.gen;
      try {
        const R = (await fetchBars(this.src, this.iv, this.raw[0].rt)).filter(b => b.rt < this.raw[0].rt);
        if (g !== this.gen) return;
        if (!R.length) { o.done = true; return; }
        const ts = this.chart.timeScale(), vr = ts.getVisibleLogicalRange();
        this.setRaw(R.concat(this.raw)); this.setMainData(); this.setIndData();
        if (vr) ts.setVisibleLogicalRange({ from: vr.from + R.length, to: vr.to + R.length });
      } catch { o.done = true; } finally { o.busy = false; }
    }
    async tick() {
      if (!this.root.isConnected) return this.destroy();
      if (document.hidden || !this.raw.length || this.older.busy) return;
      const g = this.gen;
      try {
        const R = await fetchBars(this.src, this.iv, null, 3);
        if (g !== this.gen || !R.length) return;
        const last = this.raw[this.raw.length - 1].rt; let changed = false, added = false;
        for (const b of R) {
          if (b.rt < last) continue;
          if (b.rt === last) this.raw[this.raw.length - 1] = b; else { this.raw.push(b); added = true; }
          changed = true;
        }
        if (!changed) return;
        this.setRaw(this.raw);
        if (added) this.setMainData(); else { const md = this.mainData(); this.main.update(md[md.length - 1]); }
        this.setIndData(); this.renderLegend();
      } catch {}
    }

    // ----- indicators -----
    buildInd() {
      if (!this.chart) return;
      for (const s of this.indSeries) try { this.chart.removeSeries(s.series); } catch {}
      this.indSeries = [];
      try { for (let i = this.chart.panes().length - 1; i >= 1; i--) this.chart.removePane(i); } catch {}
      const LC = this.LC; let pane = 1;
      for (const ind of S.ind) {
        const d = IND[ind.type], p = indParams(ind.type, ind.params), at = d.pane ? pane++ : 0;
        const outs = d.calc([], p, { step: IV[this.iv].s });
        outs.forEach((o, j) => {
          const color = (j === 0 && ind.color) || o.color || d.color || "#2962ff", common = { priceLineVisible: false, lastValueVisible: !o.vol, visible: !ind.hidden, title: "" };
          let s;
          if (o.vol) s = this.chart.addSeries(LC.HistogramSeries, { ...common, priceScaleId: "vol", priceFormat: { type: "volume" } }, 0);
          else if (o.kind === "hist") s = this.chart.addSeries(LC.HistogramSeries, { ...common, color }, at);
          else {
            const lo = { ...common, color, lineWidth: d.pane ? 1 : 2, lineVisible: o.kind !== "dots", pointMarkersVisible: o.kind === "dots", pointMarkersRadius: 1.5, crosshairMarkerVisible: o.kind !== "dots" };
            if (d.pane) lo.priceFormat = { type: "price", precision: 2, minMove: 0.01 };
            s = this.chart.addSeries(LC.LineSeries, lo, at);
          }
          if (o.vol) s.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
          if (j === 0 && d.levels) for (const lv of d.levels) s.createPriceLine({ price: lv, color: "#787b8680", lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
          this.indSeries.push({ ind, j, series: s, out: o });
        });
      }
      // Price keeps most of the height; each indicator pane gets an equal smaller share
      try {
        const ps = this.chart.panes(), n = ps.length - 1;
        if (n && ps[0].setStretchFactor) { ps[0].setStretchFactor(Math.max(3, n * 1.3)); for (let i = 1; i <= n; i++) ps[i].setStretchFactor(1); }
        else if (n) { const H = this.chartEl.clientHeight, each = Math.max(60, Math.min(110, H * 0.45 / n)); for (let i = 1; i <= n; i++) ps[i].setHeight?.(each); }
      } catch {}
      this.setIndData();
      if (this.raw.length) this.setMainData();
      this.renderLegend();
    }
    setIndData() {
      const step = IV[this.iv].s;
      const byInd = new Map();
      for (const x of this.indSeries) {
        if (!byInd.has(x.ind)) byInd.set(x.ind, IND[x.ind.type].calc(this.raw, indParams(x.ind.type, x.ind.params), { step }));
        const o = byInd.get(x.ind)[x.j], T = this.T, out = [];
        for (let i = 0; i < o.data.length; i++) { const v = o.data[i]; if (v == null || !isFinite(v)) continue; const pt = { time: T[i], value: v }; if (o.colors && o.colors[i]) pt.color = o.colors[i]; out.push(pt); }
        x.series.setData(out); x.vals = o.data;
      }
    }
    addInd(type, params) {
      S.ind.push({ uid: uid(), type, params: indParams(type, params) }); saveS();
      everyone(p => p.buildInd());
    }
    indOp(id, op) {
      const i = S.ind.findIndex(x => x.uid === id); if (i < 0) return; const ind = S.ind[i];
      if (op === "x") S.ind.splice(i, 1);
      else if (op === "eye") ind.hidden = !ind.hidden;
      else if (op === "star") { toggleFav(indKey(ind.type, indParams(ind.type, ind.params))); return; }
      else if (op === "gear") return this.openIndSettings(ind);
      saveS(); everyone(p => p.buildInd());
    }

    // ----- formatting -----
    fmtP(p) { if (p == null || !isFinite(p)) return "—"; return Math.abs(p) >= 1e15 ? p.toExponential(2) : p.toLocaleString("en-US", { minimumFractionDigits: this.prec, maximumFractionDigits: this.prec }); }
    fmtV(v) { if (v == null || !isFinite(v)) return "—"; const a = Math.abs(v); return a >= 1e9 ? (v / 1e9).toFixed(2) + "B" : a >= 1e6 ? (v / 1e6).toFixed(2) + "M" : a >= 1e3 ? (v / 1e3).toFixed(2) + "K" : v.toFixed(a >= 100 ? 0 : 2); }

    renderLegend() {
      const L = this.q(".pc-legend"); if (!L || !this.raw.length) return;
      let i = this.cross && this.cross.time != null ? this.tIdx.get(this.cross.time) : undefined;
      if (i == null) i = this.raw.length - 1;
      const b = this.raw[i], pc = i ? this.raw[i - 1].c : b.o, ch = b.c - pc, cl = ch >= 0 ? "u" : "d";
      const src = srcName(this.src);
      let h = `<div class="r"><b>${esc(this.name)}</b><span class="m">${esc(this.sym)}/${srcQuote(this.src)} · ${IV[this.iv].l} · ${src}</span></div>
        <div class="r"><span class="m">O</span><span class="${cl}">${this.fmtP(b.o)}</span><span class="m">H</span><span class="${cl}">${this.fmtP(b.h)}</span><span class="m">L</span><span class="${cl}">${this.fmtP(b.l)}</span><span class="m">C</span><span class="${cl}">${this.fmtP(b.c)}</span><span class="${cl}">${ch >= 0 ? "+" : ""}${this.fmtP(ch)} (${pc ? (ch / pc * 100).toFixed(2) : "0.00"}%)</span></div>`;
      const seen = new Set();
      for (const x of this.indSeries) {
        if (seen.has(x.ind)) continue; seen.add(x.ind);
        const ind = x.ind, d = IND[ind.type], p = indParams(ind.type, ind.params), fk = indKey(ind.type, p), fav = S.fav.includes(fk);
        const vals = this.indSeries.filter(y => y.ind === ind).map(y => { const v = y.vals && y.vals[i]; const col = (y.j === 0 && ind.color) || y.out.color || d.color || "var(--ink)"; return `<span style="color:${y.out.vol ? (b.c >= b.o ? UP : DN) : col}">${y.out.vol ? this.fmtV(v) : v == null ? "—" : d.pane ? (Math.abs(v) >= 1e4 ? this.fmtV(v) : v.toFixed(2)) : this.fmtP(v)}</span>`; }).join("");
        const keys = shortcutsFor(fk);
        h += `<div class="r ind${ind.hidden ? " off" : ""}"><span>${esc(indLabel(ind.type, p))}</span>${vals}
          <span class="ops"><button type="button" class="${fav ? "fav" : "nofav"}" data-li="${ind.uid}" data-op="star" title="${fav ? "Remove from favourites" : "Save to favourites (adds a shortcut)"}${keys.length ? " · " + keys.join(", ") : ""}">${IC.star}</button>${d.params.length ? `<button type="button" data-li="${ind.uid}" data-op="gear" title="Settings">${IC.gear}</button>` : ""}<button type="button" data-li="${ind.uid}" data-op="eye" title="${ind.hidden ? "Show" : "Hide"}">${ind.hidden ? IC.eyeoff : IC.eye}</button><button type="button" data-li="${ind.uid}" data-op="x" title="Remove">${IC.x}</button></span></div>`;
      }
      L.innerHTML = h;
    }

    // ----- UI -----
    renderTop() {
      const top = this.q(".pc-top"), types = [["candles", "Candles"], ["hollow", "Hollow candles"], ["bars", "Bars"], ["heikin", "Heikin Ashi"], ["line", "Line"], ["area", "Area"]];
      const fb = this.src && this.src.kind === "cc" ? ` — ${this.src.why === "unreachable" ? `${EX[this.ex].name} couldn't be reached` : `${this.sym} isn't on ${EX[this.ex].name}`}, showing CryptoCompare's USD price` : "";
      top.innerHTML = `<div class="pc-sym">${esc(this.sym)}<span>${srcQuote(this.src)}</span></div>
        <select class="pc-ex${fb ? " fb" : ""}" title="Exchange${esc(fb)}">${EX_ORDER.map(k => `<option value="${k}"${k === this.ex ? " selected" : ""}>${EX[k].name}${k === this.ex && fb ? " (n/a)" : ""}</option>`).join("")}</select><div class="pc-sep"></div>
        <div class="pc-ivs">${IV_QUICK.map(k => `<button type="button" data-iv="${k}" class="${k === this.iv ? "on" : ""}">${IV[k].l}</button>`).join("")}</div>
        <select class="pc-iv" title="Time frame">${IV_GROUPS.map(([g, ks]) => `<optgroup label="${g}">${ks.map(k => `<option value="${k}"${k === this.iv ? " selected" : ""}>${IV[k].n}</option>`).join("")}</optgroup>`).join("")}</select><div class="pc-sep"></div>
        <select class="pc-type" title="Chart type">${types.map(([k, n]) => `<option value="${k}"${k === S.type ? " selected" : ""}>${n}</option>`).join("")}</select><div class="pc-sep"></div>
        <button type="button" data-act="ind" title="Indicators ( / )">${IC.ind}Indicators</button><div class="pc-sep"></div>
        <div class="pc-favs">${S.fav.length ? "" : `<span class="pc-hint" title="Click the ☆ next to any drawing tool or indicator to pin it to a floating bar on the chart. Favourites get Alt+1…Alt+9.">☆ Star tools &amp; indicators to pin them</span>`}</div><div class="pc-sp"></div>
        <button type="button" data-act="keys" title="Keyboard shortcuts">${IC.kbd}</button>
        <button type="button" data-act="shot" title="Download a screenshot">${IC.cam}</button>
        <button type="button" data-tvfs title="Full screen">${IC.fs}<span>Full screen</span></button>`;
      this.renderFavs();
    }
    favChips() {
      return S.fav.map((fk, i) => {
        const k = parseKey(fk); if (!k) return "";
        const keys = shortcutsFor(fk), on = k.kind === "d" && this.tool === k.id;
        return `<span class="pc-fitem${on ? " on" : ""}"><button type="button" class="pc-chip" data-fk="${esc(fk)}" title="${esc(favName(fk))}${keys.length ? " · " + keys.join(" / ") : ""}">${k.kind === "d" ? IC[k.id] : esc(indLabel(k.type, k.params))}${i < 9 ? `<small>${i + 1}</small>` : ""}</button><button type="button" class="pc-fx" data-unfav="${esc(fk)}" title="Remove ${esc(favName(fk))} from favourites">${IC.x}</button></span>`;
      }).join("");
    }
    // Favourites live in a floating box over the chart that can be dragged anywhere
    renderFavs() {
      const box = this.q(".pc-fbox"); if (!box) return;
      box.hidden = !S.fav.length;
      box.innerHTML = S.fav.length ? `<span class="pc-fgrip" title="Drag to move">${IC.grip}</span>${this.favChips()}` : "";
      this.placeFavs();
    }
    placeFavs(x, y) {
      const box = this.q(".pc-fbox"), main = this.q(".pc-main"); if (!box || box.hidden) return;
      const M = main.getBoundingClientRect(); if (!M.width || !M.height) return;
      const bw = box.offsetWidth, bh = box.offsetHeight;
      if (x == null) { const p = S.favPos; x = p ? p.x : M.width - bw - 80; y = p ? p.y : 8; }
      x = Math.max(0, Math.min(x, M.width - bw)); y = Math.max(0, Math.min(y, M.height - bh));
      box.style.left = x + "px"; box.style.top = y + "px";
      return { x, y };
    }
    renderLeft() {
      const L = this.q(".pc-left"), tb = (tool, title) => `<button type="button" data-tool="${tool}" class="${this.tool === tool ? "on" : ""}" title="${esc(title)}">${IC[tool]}</button>`;
      L.innerHTML = tb("cursor", "Cursor (Esc)") + GROUPS.map(g => {
        const cur = g.tools.includes(this.tool) ? this.tool : this.lastInGroup[g.id] || g.tools[0], keys = shortcutsFor("d:" + cur);
        return `<div class="pc-grp">${tb(cur, TOOLS[cur].name + (keys.length ? " · " + keys.join(" / ") : ""))}<button type="button" class="pc-more" data-fly="${g.id}" title="${esc(g.name)}: all tools, favourites and shortcuts">›</button></div>`;
      }).join("") + `<hr>
        <button type="button" data-act="magnet" class="${S.magnet ? "on" : ""}" title="Magnet: snap points to open/high/low/close">${IC.magnet}</button>
        <button type="button" data-act="stay" class="${S.stay ? "on" : ""}" title="Stay in drawing mode">${IC.stay}</button>
        <button type="button" data-act="hide" class="${this.hideDraw ? "on" : ""}" title="${this.hideDraw ? "Show" : "Hide"} all drawings">${this.hideDraw ? IC.eyeoff : IC.eye}</button>
        <button type="button" data-act="undo" title="Undo (Ctrl+Z)">${IC.undo}</button>
        <button type="button" data-act="clear" title="Remove all drawings on ${esc(this.sym)}">${IC.trash}</button>`;
    }
    refreshUi() { this.renderTop(); this.renderLeft(); this.renderLegend(); if (this.popKind === "ind") this.renderIndList(); if (this.popKind === "keys") this.renderKeys(); if (this.popKind && this.popKind.startsWith("fly:")) this.openFly(this.popKind.slice(4)); }

    openPop(kind, html, pos) {
      this.popKind = kind; const p = this.pop; p.innerHTML = html; p.hidden = false;
      p.style.left = p.style.top = p.style.right = p.style.transform = "";
      const R = this.root.getBoundingClientRect();
      if (pos) { p.style.left = pos.x + "px"; p.style.top = pos.y + "px"; const pr = p.getBoundingClientRect(); if (pr.bottom > R.bottom - 6) p.style.top = Math.max(6, pos.y - (pr.bottom - R.bottom) - 6) + "px"; }
      else { p.style.left = "50%"; p.style.top = "48px"; p.style.transform = "translateX(-50%)"; }
    }
    closePop() { this.pop.hidden = true; this.popKind = null; if (capture) { capture = null; } }
    openFly(gid) {
      const g = GROUPS.find(x => x.id === gid), btn = this.q(`[data-fly="${gid}"]`); if (!g || !btn) return;
      const R = this.root.getBoundingClientRect(), b = btn.parentElement.getBoundingClientRect();
      this.openPop("fly:" + gid, `<div class="pc-fly"><h6>${esc(g.name)}</h6>${g.tools.map(t => this.itemHTML("d:" + t, IC[t], TOOLS[t].name, `data-tool="${t}"`, this.tool === t)).join("")}</div>`, { x: b.right - R.left + 6, y: b.top - R.top });
    }
    itemHTML(fk, icon, name, attrs, on) {
      const fav = S.fav.includes(fk), keys = shortcutsFor(fk);
      return `<div class="pc-item${on ? " on" : ""}" ${attrs}>${icon || ""}<span class="nm">${esc(name)}</span>${keys.map(k => `<kbd>${esc(k)}</kbd>`).join("")}<button type="button" class="pc-star${fav ? " on" : ""}" data-star="${esc(fk)}" title="${fav ? "Remove from favourites" : "Add to favourites"}">${IC.star}</button></div>`;
    }
    openInd() {
      this.openPop("ind", `<div class="pc-dlg"><div class="pc-dh"><b>Indicators</b><button type="button" data-act="close">${IC.x}</button></div><input class="pc-q" placeholder="Search" autocomplete="off"><div class="pc-list"></div></div>`);
      this.renderIndList(); const q = this.q(".pc-q"); q.addEventListener("input", () => this.renderIndList()); setTimeout(() => q.focus(), 0);
    }
    renderIndList() {
      const box = this.q(".pc-list"); if (!box) return; const qv = (this.q(".pc-q") || {}).value || "", ql = qv.trim().toLowerCase();
      const match = s => !ql || s.toLowerCase().includes(ql);
      const favs = S.fav.filter(fk => fk.startsWith("i:")).map(fk => [fk, parseKey(fk)]).filter(([, k]) => k && match(IND[k.type].name + " " + indLabel(k.type, k.params)));
      const all = Object.keys(IND).filter(t => match(IND[t].name + " " + IND[t].short)).sort((a, b) => IND[a].name.localeCompare(IND[b].name));
      box.innerHTML = (favs.length ? `<h6>★ Favourites</h6>` + favs.map(([fk, k]) => this.itemHTML(fk, "", `${indLabel(k.type, k.params)} — ${IND[k.type].name}`, `data-fk="${esc(fk)}"`)).join("") : "")
        + `<h6>All indicators</h6>` + (all.length ? all.map(t => this.itemHTML(indKey(t, indParams(t)), "", IND[t].name, `data-addind="${t}"`)).join("") : `<div class="pc-note">No match.</div>`)
        + `<div class="pc-note">Star an indicator to pin it to the top bar and give it a shortcut (Alt+1…9 in favourite order). To save one with your own settings, such as EMA 200, open its ⚙ on the chart, then star it there.</div>`;
    }
    openIndSettings(ind) {
      const d = IND[ind.type], p = indParams(ind.type, ind.params), col = ind.color || d.color || "#2962ff";
      this.editing = ind;
      this.openPop("set", `<div class="pc-dlg" style="width:300px"><div class="pc-dh"><b>${esc(d.name)}</b><button type="button" data-act="close">${IC.x}</button></div>
        <div class="pc-form">${d.params.map(([k, l]) => `<label>${esc(l)}<input type="number" step="any" data-pk="${k}" value="${p[k]}"></label>`).join("")}
        ${d.color ? `<label>Colour<input type="color" data-pk="color" value="${col}"></label>` : ""}
        <div class="go"><button type="button" data-act="close">Cancel</button><button type="button" class="pri" data-act="indapply">Apply</button></div></div></div>`);
    }
    openKeys() { this.openPop("keys", `<div class="pc-dlg"><div class="pc-dh"><b>Keyboard shortcuts</b><button type="button" data-act="close">${IC.x}</button></div><div class="pc-list"></div></div>`); this.renderKeys(); }
    renderKeys() {
      const box = this.q(".pc-list"); if (!box) return;
      const row = (fk, name, icon) => { const k = keyOf(fk), rec = capture && capture.fk === fk; return `<div class="pc-item" style="cursor:default">${icon || ""}<span class="nm">${esc(name)}</span>${favNum(fk) ? `<span class="pc-kb" title="Favourite #${favNum(fk)}">Alt+${favNum(fk)}</span>` : ""}<button type="button" class="pc-kbtn${k ? " set" : ""}${rec ? " rec" : ""}" data-bind="${esc(fk)}" title="Click, then press the keys. Backspace clears, Esc cancels.">${rec ? "Press keys…" : k ? esc(k) : "+ Add"}</button><button type="button" class="pc-star${S.fav.includes(fk) ? " on" : ""}" data-star="${esc(fk)}" title="Favourite">${IC.star}</button></div>`; };
      const favInd = S.fav.filter(fk => fk.startsWith("i:"));
      box.innerHTML = `<div class="pc-note" style="padding-top:12px">Click a key button and press any combination to set your own shortcut. Favourites also get <b>Alt+1…Alt+9</b> in the order you starred them. Shortcuts without Alt or Ctrl only work while the pointer is over the chart.</div>
        <h6>Drawing tools</h6>${Object.keys(TOOLS).map(t => row("d:" + t, TOOLS[t].name, IC[t])).join("")}
        ${favInd.length ? `<h6>Saved indicators</h6>${favInd.map(fk => { const k = parseKey(fk); return row(fk, `${indLabel(k.type, k.params)} — ${IND[k.type].name}`); }).join("")}` : ""}
        <h6>Indicators (default settings)</h6>${Object.keys(IND).filter(t => !favInd.includes(indKey(t, indParams(t)))).map(t => row(indKey(t, indParams(t)), IND[t].name)).join("")}
        <h6>Built in</h6>${Object.entries(RESERVED).filter(([k]) => !/^Alt\+[2-9]$/.test(k) && k !== "Backspace").map(([k, v]) => `<div class="pc-item" style="cursor:default"><span class="nm">${esc(k === "Alt+1" ? "Favourites 1–9" : v)}</span><span class="pc-kb">${esc(k === "Alt+1" ? "Alt+1…9" : k === "Delete" ? "Delete / Backspace" : k)}</span></div>`).join("")}
        <div class="pc-note"><a href="#" data-act="resetkeys" style="color:var(--accent)">Reset shortcuts to defaults</a></div>`;
    }
    recordKey(fk) {
      capture = { fk, done: c => {
        if (c === null) return this.renderKeys();
        if (c && RESERVED[c]) { this.renderKeys(); this.flash(`${c} is already used for “${RESERVED[c]}”`); return; }
        if (c) for (const [k2, f2] of Object.entries(allKeyed())) if (k2 === c && f2 !== fk) S.keys[f2] = "";
        S.keys[fk] = c; saveS(); everyone(p => p.refreshUi());
      } };
      this.renderKeys();
    }
    flash(t) {
      const n = this.q(".pc-note"); if (!n) return; const old = n.innerHTML; n.innerHTML = `<b style="color:${DN}">${esc(t)}</b>`; setTimeout(() => { if (n.isConnected) n.innerHTML = old; }, 2600);
    }

    run(fk) {
      const k = parseKey(fk); if (!k) return;
      if (k.kind === "d") this.setTool(this.tool === k.id ? "cursor" : k.id); else this.addInd(k.type, k.params);
    }
    setTool(t) {
      this.tool = t; this.placing = null;
      const g = GROUPS.find(x => x.tools.includes(t)); if (g) this.lastInGroup[g.id] = t;
      if (t !== "cursor") this.select(null);
      this.renderLeft(); this.renderFavs(); this.redraw();
      this.chartEl.style.cursor = t === "cursor" ? "" : "crosshair";
      active = this;
    }

    bindUi() {
      const r = this.root;
      r.addEventListener("pointerenter", () => { this.hover = true; active = this; });
      r.addEventListener("pointerleave", () => { this.hover = false; });
      r.addEventListener("pointerdown", e => {
        active = this;
        if (!this.pop.hidden && !this.pop.contains(e.target) && !e.target.closest("[data-fly],[data-act=ind],[data-act=keys],[data-li]")) this.closePop();
      }, true);
      // Drag the favourites box by its grip or any empty spot on it
      const fb = this.q(".pc-fbox");
      fb.addEventListener("pointerdown", e => {
        if (e.button !== 0 || e.target.closest("button")) return;
        e.preventDefault(); e.stopPropagation();
        const B = fb.getBoundingClientRect(), ox = e.clientX - B.left, oy = e.clientY - B.top;
        let last = null;
        fb.setPointerCapture(e.pointerId); fb.classList.add("drag");
        const mv = ev => { const M = this.q(".pc-main").getBoundingClientRect(); last = this.placeFavs(ev.clientX - M.left - ox, ev.clientY - M.top - oy) || last; };
        const up = () => {
          fb.removeEventListener("pointermove", mv); fb.removeEventListener("pointerup", up); fb.removeEventListener("pointercancel", up);
          fb.classList.remove("drag");
          if (last) { S.favPos = last; saveS(); everyone(p => p !== this && p.placeFavs()); }
        };
        fb.addEventListener("pointermove", mv); fb.addEventListener("pointerup", up); fb.addEventListener("pointercancel", up);
      });
      r.addEventListener("change", e => {
        if (e.target.classList.contains("pc-ex")) { const v = e.target.value; if (EX[v] && v !== this.ex) { this.ex = S.ex = v; saveS(); this.switchEx(); } return; }
        if (e.target.classList.contains("pc-iv")) { const v = e.target.value; if (IV[v] && v !== this.iv) { this.iv = S.iv = v; saveS(); this.renderTop(); this.load().catch(err => this.msg(err.message)); } return; }
        if (e.target.classList.contains("pc-type")) { S.type = e.target.value; saveS(); everyone(p => { p.makeMain(); p.renderTop(); }); }
      });
      r.addEventListener("click", e => {
        const t = e.target.closest("button,[data-addind],[data-fk],[data-tool],a[data-act]"); if (!t || !r.contains(t)) return;
        if (t.dataset.star) { e.stopPropagation(); return toggleFav(t.dataset.star); }
        if (t.dataset.unfav) { e.stopPropagation(); return toggleFav(t.dataset.unfav); }
        if (t.dataset.bind) return this.recordKey(t.dataset.bind);
        if (t.dataset.li) return this.indOp(t.dataset.li, t.dataset.op);
        if (t.dataset.fly) return this.popKind === "fly:" + t.dataset.fly ? this.closePop() : this.openFly(t.dataset.fly);
        if (t.dataset.tool) { this.setTool(t.dataset.tool === this.tool && t.dataset.tool !== "cursor" ? "cursor" : t.dataset.tool); if (this.popKind && this.popKind.startsWith("fly:")) this.closePop(); return; }
        if (t.dataset.iv) { if (t.dataset.iv !== this.iv) { this.iv = S.iv = t.dataset.iv; saveS(); this.renderTop(); this.load().catch(err => this.msg(err.message)); } return; }
        if (t.dataset.addind) { this.addInd(t.dataset.addind); return this.closePop(); }
        if (t.dataset.fk) { this.run(t.dataset.fk); if (this.popKind === "ind") this.closePop(); return; }
        if (t.dataset.sw) return this.styleSel({ color: t.dataset.sw });
        if (t.dataset.wd) return this.styleSel({ width: +t.dataset.wd });
        const a = t.dataset.act; if (!a) return;
        if (a === "close") this.closePop();
        else if (a === "ind") this.popKind === "ind" ? this.closePop() : this.openInd();
        else if (a === "keys") this.popKind === "keys" ? this.closePop() : this.openKeys();
        else if (a === "shot") this.shot();
        else if (a === "magnet") { S.magnet = !S.magnet; saveS(); everyone(p => p.renderLeft()); }
        else if (a === "stay") { S.stay = !S.stay; everyone(p => p.renderLeft()); }
        else if (a === "hide") { this.hideDraw = !this.hideDraw; this.renderLeft(); this.redraw(); }
        else if (a === "undo") this.undo();
        else if (a === "clear") { if (this.drawings.length && confirm(`Remove all ${this.drawings.length} drawing(s) on ${this.sym}?`)) { this.snap(); this.drawings = []; this.select(null); this.saveDraw(); } }
        else if (a === "delsel") this.deleteSel();
        else if (a === "resetkeys") { e.preventDefault(); S.keys = {}; saveS(); everyone(p => p.refreshUi()); }
        else if (a === "indapply") {
          const ind = this.editing; if (!ind) return; const np = {};
          this.pop.querySelectorAll("[data-pk]").forEach(inp => { if (inp.dataset.pk === "color") ind.color = inp.value; else if (inp.value !== "" && isFinite(inp.value)) np[inp.dataset.pk] = Math.max(+inp.value, 0.0001); });
          ind.params = indParams(ind.type, { ...ind.params, ...np }); saveS(); this.closePop(); everyone(p => p.buildInd());
        }
      });
    }
    shot() {
      if (!this.chart) return;
      const c = this.chart.takeScreenshot(), a = document.createElement("a");
      a.download = `${this.sym}-${IV[this.iv].l}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.png`; a.href = c.toDataURL("image/png"); a.click();
    }

    // ----- drawings: coordinates -----
    tToL(t) {
      const R = this.RT, n = R && R.length, st = IV[this.iv].s; if (!n) return null;
      if (t <= R[0]) return (t - R[0]) / st; if (t >= R[n - 1]) return n - 1 + (t - R[n - 1]) / st;
      let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (R[m] <= t) lo = m; else hi = m; }
      return lo + (t - R[lo]) / (R[hi] - R[lo]);
    }
    lToT(l) {
      const R = this.RT, n = R.length, st = IV[this.iv].s;
      if (l <= 0) return R[0] + l * st; if (l >= n - 1) return R[n - 1] + (l - n + 1) * st;
      const i = Math.floor(l); return R[i] + (R[i + 1] - R[i]) * (l - i);
    }
    lx(l) { const ts = this.chart.timeScale(), i = Math.floor(l), f = l - i, a = ts.logicalToCoordinate(i); if (a == null) return null; if (!f) return a; const b = ts.logicalToCoordinate(i + 1); return b == null ? a : a + (b - a) * f; }
    xl(x) { const ts = this.chart.timeScale(); let l = ts.coordinateToLogical(x); if (l == null) return null; l = Math.round(l); const c = this.lx(l), sp = this.lx(l + 1) - c; if (c != null && sp) l += Math.round((x - c) / sp); return l; }
    px(pt) { const l = this.tToL(pt.t), x = l == null ? null : this.lx(l), y = this.main.priceToCoordinate(pt.p); return x == null || y == null ? null : { x, y }; }
    pointAt(x, y) {
      const l = this.xl(x); if (l == null) return null;
      let p = this.main.coordinateToPrice(y); if (p == null) return null;
      if (S.magnet && l >= 0 && l < this.raw.length) {
        const b = this.raw[l]; let best = p, bd = Infinity;
        for (const v of [b.o, b.h, b.l, b.c]) { const yy = this.main.priceToCoordinate(v); if (yy != null && Math.abs(yy - y) < bd) { bd = Math.abs(yy - y); best = v; } }
        if (bd < 40) p = best;
      }
      return { t: this.lToT(l), p };
    }
    paneH() { try { return this.chart.panes()[0].getHeight(); } catch { return this.chartEl.clientHeight; } }
    paneW() { try { return this.chart.timeScale().width(); } catch { return this.chartEl.clientWidth - 60; } }

    redraw() { if (this.layer && this.layer.req) this.layer.req(); }
    snap() { this.undoStack.push(JSON.stringify(this.drawings)); if (this.undoStack.length > 60) this.undoStack.shift(); }
    undo() { if (!this.undoStack.length) return false; this.drawings = JSON.parse(this.undoStack.pop()); this.select(null); this.saveDraw(); return true; }
    saveDraw() { store.set("lw.pc.dr." + this.sym, this.drawings); this.redraw(); }
    select(d) {
      this.sel = d; const box = this.q(".pc-sel");
      if (!d) { box.hidden = true; this.redraw(); return; }
      box.hidden = false;
      box.innerHTML = COLORS.map(c => `<button type="button" class="sw${d.color === c ? " on" : ""}" data-sw="${c}" style="background:${c}" title="Colour"></button>`).join("") + "<i></i>"
        + [1, 2, 3, 4].map(w => `<button type="button" class="wd${(d.width || 2) === w ? " on" : ""}" data-wd="${w}" title="Line width">${w}px</button>`).join("") + "<i></i>"
        + `<button type="button" class="del" data-act="delsel" title="Delete (Del)">${IC.trash}</button>`;
      this.redraw();
    }
    styleSel(s) { if (!this.sel) return; this.snap(); Object.assign(this.sel, s); this.saveDraw(); this.select(this.sel); }
    deleteSel() { if (!this.sel) return false; this.snap(); this.drawings = this.drawings.filter(d => d !== this.sel); this.select(null); this.saveDraw(); return true; }
    escape() {
      if (capture) return false;
      if (!this.pop.hidden) { this.closePop(); return true; }
      if (this.placing) { this.placing = null; this.redraw(); return true; }
      if (this.tool !== "cursor") { this.setTool("cursor"); return true; }
      if (this.sel) { this.select(null); return true; }
      return false;
    }

    // Geometry used by both painting and hit-testing
    geo(d, P, W, H) {
      const [a, b, c] = P, seg = [], far = (p, q) => { const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy) || 1, k = (W + H) * 4 / L; return { x: q.x + dx * k, y: q.y + dy * k }; };
      let box = null, poly = null;
      switch (d.type) {
        case "trend": case "arrow": if (b) seg.push([a, b]); break;
        case "ray": if (b) seg.push([a, far(a, b)]); break;
        case "ext": if (b) seg.push([far(b, a), far(a, b)]); break;
        case "hline": seg.push([{ x: 0, y: a.y }, { x: W, y: a.y }]); break;
        case "hray": seg.push([a, { x: W, y: a.y }]); break;
        case "vline": seg.push([{ x: a.x, y: 0 }, { x: a.x, y: H }]); break;
        case "cross": seg.push([{ x: 0, y: a.y }, { x: W, y: a.y }], [{ x: a.x, y: 0 }, { x: a.x, y: H }]); break;
        case "rect": case "measure": if (b) { box = { x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x), y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y) }; if (d.type === "rect") seg.push([{ x: box.x1, y: box.y1 }, { x: box.x2, y: box.y1 }], [{ x: box.x2, y: box.y1 }, { x: box.x2, y: box.y2 }], [{ x: box.x2, y: box.y2 }, { x: box.x1, y: box.y2 }], [{ x: box.x1, y: box.y2 }, { x: box.x1, y: box.y1 }]); } break;
        case "fib": if (b) { const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x); for (const [lv] of FIB) { const y = this.main.priceToCoordinate(d.pts[1].p + (d.pts[0].p - d.pts[1].p) * lv); if (y != null) seg.push([{ x: x1, y }, { x: x2, y }]); } box = { x1, x2, y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y) }; } break;
        case "channel": if (b) { seg.push([a, b]); if (c) { const la = this.tToL(d.pts[0].t), lb = this.tToL(d.pts[1].t), lc = this.tToL(d.pts[2].t), on = lb === la ? d.pts[0].p : d.pts[0].p + (d.pts[1].p - d.pts[0].p) * (lc - la) / (lb - la), off = d.pts[2].p - on; const a2y = this.main.priceToCoordinate(d.pts[0].p + off), b2y = this.main.priceToCoordinate(d.pts[1].p + off); if (a2y != null && b2y != null) { const a2 = { x: a.x, y: a2y }, b2 = { x: b.x, y: b2y }; seg.push([a2, b2]); poly = [a, b, b2, a2]; } } } break;
        case "text": { measureCtx.font = TFONT; const w = measureCtx.measureText(d.text || "Text").width; box = { x1: a.x - 2, x2: a.x + w + 2, y1: a.y - 11, y2: a.y + 11 }; break; }
      }
      return { seg, box, poly };
    }
    hitTest(x, y) {
      const W = this.paneW(), H = this.paneH();
      if (this.hideDraw) return null;
      for (let i = this.drawings.length - 1; i >= 0; i--) {
        const d = this.drawings[i], P = d.pts.map(p => this.px(p)); if (P.some(p => !p)) continue;
        for (let h = 0; h < P.length; h++) if (Math.hypot(P[h].x - x, P[h].y - y) < 8) return { d, h };
        const g = this.geo(d, P, W, H);
        if (g.seg.some(([p, q]) => segDist(x, y, p, q) < 6)) return { d, h: -1 };
        if (g.box && x >= g.box.x1 && x <= g.box.x2 && y >= g.box.y1 && y <= g.box.y2) return { d, h: -1 };
        if (g.poly && inPoly(x, y, g.poly)) return { d, h: -1 };
      }
      return null;
    }

    paint(ctx, size) {
      if (!this.raw.length) return;
      const W = size.width, H = size.height, list = this.hideDraw ? [] : this.drawings.slice();
      if (this.placing) { const pl = this.placing, pts = pl.pts.concat(pl.cur ? [pl.cur] : []).slice(0, TOOLS[pl.type].n); list.push({ type: pl.type, pts, color: "#2962ff", width: 2, preview: true }); }
      for (const d of list) {
        const P = d.pts.map(p => this.px(p)); if (!P.length || P.some(p => !p)) continue;
        const col = d.color || "#2962ff", w = d.width || 2, g = this.geo(d, P, W, H);
        ctx.save(); ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = w; ctx.font = FONT; ctx.lineCap = "round";
        const label = (t, x, y, bg, fg, align) => { ctx.font = FONT; const tw = ctx.measureText(t).width + 10; const lx = align === "c" ? x - tw / 2 : align === "r" ? x - tw : x; ctx.fillStyle = bg; roundRect(ctx, lx, y - 10, tw, 20, 4); ctx.fill(); ctx.fillStyle = fg; ctx.textBaseline = "middle"; ctx.fillText(t, lx + 5, y); };
        if (d.type === "fib" && P[1]) {
          const x1 = Math.min(P[0].x, P[1].x), x2 = Math.max(P[0].x, P[1].x); let prevY = null;
          FIB.forEach(([lv, fc]) => {
            const pr = d.pts[1].p + (d.pts[0].p - d.pts[1].p) * lv, y = this.main.priceToCoordinate(pr); if (y == null) return;
            if (prevY != null) { ctx.globalAlpha = 0.08; ctx.fillStyle = fc; ctx.fillRect(x1, Math.min(prevY, y), x2 - x1, Math.abs(y - prevY)); ctx.globalAlpha = 1; }
            ctx.strokeStyle = fc; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
            ctx.fillStyle = fc; ctx.textBaseline = "bottom"; ctx.fillText(`${lv} (${this.fmtP(pr)})`, x1 + 4, y - 2); prevY = y;
          });
          ctx.setLineDash([4, 4]); ctx.strokeStyle = "#787b86"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(P[0].x, P[0].y); ctx.lineTo(P[1].x, P[1].y); ctx.stroke(); ctx.setLineDash([]);
        } else if (d.type === "measure" && g.box) {
          const dp = d.pts[1].p - d.pts[0].p, up = dp >= 0, c2 = up ? "#2962ff" : DN, bars = Math.round(this.tToL(d.pts[1].t) - this.tToL(d.pts[0].t));
          ctx.globalAlpha = 0.15; ctx.fillStyle = c2; ctx.fillRect(g.box.x1, g.box.y1, g.box.x2 - g.box.x1, g.box.y2 - g.box.y1); ctx.globalAlpha = 1;
          ctx.strokeStyle = c2; ctx.lineWidth = 1; arrowLine(ctx, (g.box.x1 + g.box.x2) / 2, P[0].y, (g.box.x1 + g.box.x2) / 2, P[1].y); arrowLine(ctx, P[0].x, (g.box.y1 + g.box.y2) / 2, P[1].x, (g.box.y1 + g.box.y2) / 2);
          const secs = Math.abs(d.pts[1].t - d.pts[0].t), dur = secs >= 86400 ? `${Math.round(secs / 864) / 100}d` : secs >= 3600 ? `${Math.round(secs / 36) / 100}h` : `${Math.round(secs / 60)}m`;
          label(`${up ? "+" : ""}${this.fmtP(dp)} (${(dp / d.pts[0].p * 100).toFixed(2)}%) · ${Math.abs(bars)} bars, ${dur}`, (g.box.x1 + g.box.x2) / 2, up ? g.box.y1 - 14 : g.box.y2 + 14, c2, "#fff", "c");
        } else if (d.type === "text") {
          ctx.font = TFONT; ctx.textBaseline = "middle"; ctx.fillText(d.text || "Text", P[0].x, P[0].y);
        } else {
          if (d.type === "rect" && g.box) { ctx.globalAlpha = 0.12; ctx.fillRect(g.box.x1, g.box.y1, g.box.x2 - g.box.x1, g.box.y2 - g.box.y1); ctx.globalAlpha = 1; }
          if (g.poly) { ctx.globalAlpha = 0.1; ctx.beginPath(); g.poly.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1; }
          ctx.beginPath(); for (const [p, q] of g.seg) { ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); } ctx.stroke();
          if (d.type === "channel" && g.poly) { ctx.setLineDash([5, 5]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo((g.poly[0].x + g.poly[3].x) / 2, (g.poly[0].y + g.poly[3].y) / 2); ctx.lineTo((g.poly[1].x + g.poly[2].x) / 2, (g.poly[1].y + g.poly[2].y) / 2); ctx.stroke(); ctx.setLineDash([]); }
          if (d.type === "arrow" && P[1]) { const an = Math.atan2(P[1].y - P[0].y, P[1].x - P[0].x), L = 10 + w * 2; ctx.beginPath(); ctx.moveTo(P[1].x, P[1].y); ctx.lineTo(P[1].x - L * Math.cos(an - 0.45), P[1].y - L * Math.sin(an - 0.45)); ctx.lineTo(P[1].x - L * Math.cos(an + 0.45), P[1].y - L * Math.sin(an + 0.45)); ctx.closePath(); ctx.fill(); }
        }
        if (d === this.sel || d.preview) {
          for (const p of P) { ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fillStyle = css("--surface") || "#fff"; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = col; ctx.stroke(); }
        }
        ctx.restore();
      }
    }
    axisViews() {
      if (this.hideDraw || !this.raw.length) return [];
      return this.drawings.filter(d => d.type === "hline" || d.type === "hray" || d.type === "cross" || d === this.sel && d.pts.length).map(d => {
        const p = d.pts[0].p, y = this.main.priceToCoordinate(p);
        return { coordinate: () => y == null ? -100 : y, text: () => this.fmtP(p), textColor: () => "#fff", backColor: () => d.color || "#2962ff", visible: () => y != null, tickVisible: () => true };
      });
    }

    bindPointer() {
      const el = this.chartEl, local = e => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      const inPane = q => q.y >= 0 && q.y <= this.paneH() && q.x >= 0 && q.x <= this.paneW();
      let consumed = false;
      const swallow = e => { if (consumed) e.stopPropagation(); };
      el.addEventListener("mousedown", swallow, true); el.addEventListener("touchstart", swallow, { capture: true, passive: true });
      const lockChart = on => this.chart.applyOptions({ handleScroll: !on, handleScale: !on });
      el.addEventListener("pointerdown", e => {
        consumed = false; if (e.button !== 0 || !this.raw.length) return;
        const q = local(e); if (!inPane(q)) return;
        this.root.focus({ preventScroll: true });
        if (this.tool !== "cursor") {
          consumed = true; e.stopPropagation(); lockChart(true);
          const pt = this.pointAt(q.x, q.y); if (!pt) return;
          const need = TOOLS[this.tool].n;
          if (!this.placing) { this.placing = { type: this.tool, pts: [pt], cur: pt, down: q }; if (need === 1) return this.commit(); }
          else { this.placing.pts.push(pt); this.placing.down = q; if (this.placing.pts.length >= need) return this.commit(); }
          this.redraw(); return;
        }
        const hit = this.hitTest(q.x, q.y);
        if (hit) {
          consumed = true; e.stopPropagation(); lockChart(true);
          this.select(hit.d); this.snap();
          this.drag = { d: hit.d, h: hit.h, start: q, orig: hit.d.pts.map(p => ({ l: this.tToL(p.t), p: p.p })), moved: false };
        } else if (this.sel) this.select(null);
      }, true);
      window.addEventListener("pointermove", this._move = e => {
        if (!this.chart) return;
        const q = local(e);
        if (this.placing) { const pt = this.pointAt(q.x, q.y); if (pt) { this.placing.cur = pt; this.redraw(); } return; }
        if (!this.drag) return;
        const D = this.drag; D.moved = true;
        if (D.h >= 0) { const pt = this.pointAt(q.x, q.y); if (pt) D.d.pts[D.h] = pt; }
        else {
          const l0 = this.xl(D.start.x), l1 = this.xl(q.x), p0 = this.main.coordinateToPrice(D.start.y), p1 = this.main.coordinateToPrice(q.y);
          if (l0 == null || l1 == null || p0 == null || p1 == null) return;
          D.d.pts = D.orig.map(o => ({ t: this.lToT(o.l + (l1 - l0)), p: o.p + (p1 - p0) }));
        }
        this.redraw();
      });
      window.addEventListener("pointerup", this._up = e => {
        if (!this.chart) return;
        if (this.placing) {
          const q = local(e), pl = this.placing;
          if (pl.pts.length === 1 && Math.hypot(q.x - pl.down.x, q.y - pl.down.y) > 6) { const pt = this.pointAt(q.x, q.y); if (pt) { pl.pts.push(pt); if (pl.pts.length >= TOOLS[pl.type].n) this.commit(); } }
        }
        if (this.drag) { if (!this.drag.moved) this.undoStack.pop(); this.drag = null; this.saveDraw(); }
        if (consumed) { lockChart(false); consumed = false; }
      });
      el.addEventListener("dblclick", e => {
        const q = local(e), hit = this.tool === "cursor" && this.hitTest(q.x, q.y);
        if (hit && hit.d.type === "text") this.editText(hit.d);
      });
    }
    commit() {
      const pl = this.placing; this.placing = null;
      const d = { id: uid(), type: pl.type, pts: pl.pts.slice(0, TOOLS[pl.type].n), color: pl.type === "measure" ? "#2962ff" : (this.lastColor || "#2962ff"), width: 2 };
      if (d.type === "text") d.text = "";
      this.snap(); this.drawings.push(d); this.saveDraw();
      this.chart.applyOptions({ handleScroll: true, handleScale: true });
      if (!S.stay) this.setTool("cursor");
      this.select(d);
      if (d.type === "text") this.editText(d, true);
    }
    editText(d, isNew) {
      const P = this.px(d.pts[0]); if (!P) return;
      const inp = document.createElement("input"); inp.className = "pc-txt"; inp.value = d.text || ""; inp.placeholder = "Type a note, Enter to save";
      inp.style.left = P.x + "px"; inp.style.top = (P.y - 14) + "px";
      this.q(".pc-main").appendChild(inp); setTimeout(() => inp.focus(), 0);
      let done = false;
      const fin = ok => {
        if (done) return; done = true; inp.remove();
        if (ok && inp.value.trim()) { d.text = inp.value.trim(); }
        else if (isNew || !d.text) { this.drawings = this.drawings.filter(x => x !== d); this.select(null); }
        this.saveDraw();
      };
      inp.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") fin(true); else if (e.key === "Escape") fin(!isNew && !!d.text); });
      inp.addEventListener("blur", () => fin(true));
    }

    destroy() {
      if (this.dead) return; this.dead = true;
      clearInterval(this.poll); insts.delete(this); if (active === this) active = null;
      try { this.ro && this.ro.disconnect(); } catch {}
      window.removeEventListener("pointermove", this._move); window.removeEventListener("pointerup", this._up);
      try { this.chart && this.chart.remove(); } catch {}
    }
  }
  // Remember the last colour picked so new drawings use it
  const _styleSel = ProChart.prototype.styleSel;
  ProChart.prototype.styleSel = function (s) { if (s.color) this.lastColor = s.color; return _styleSel.call(this, s); };

  class Layer {
    constructor(pc) { this.pc = pc; this.req = null; }
    attached(p) { this.req = p.requestUpdate; }
    detached() { this.req = null; }
    updateAllViews() {}
    paneViews() { const pc = this.pc; return [{ zOrder: () => "top", renderer: () => ({ draw: tg => tg.useMediaCoordinateSpace(({ context, mediaSize }) => pc.paint(context, mediaSize)) }) }]; }
    priceAxisViews() { return this.pc.axisViews(); }
  }
  function segDist(x, y, a, b) { const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy; let t = L ? ((x - a.x) * dx + (y - a.y) * dy) / L : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)); }
  function inPoly(x, y, P) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) if ((P[i].y > y) !== (P[j].y > y) && x < (P[j].x - P[i].x) * (y - P[i].y) / (P[j].y - P[i].y) + P[i].x) c = !c; return c; }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function arrowLine(ctx, x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); const an = Math.atan2(y2 - y1, x2 - x1); if (Math.hypot(x2 - x1, y2 - y1) < 12) return; ctx.beginPath(); ctx.moveTo(x2 - 7 * Math.cos(an - 0.5), y2 - 7 * Math.sin(an - 0.5)); ctx.lineTo(x2, y2); ctx.lineTo(x2 - 7 * Math.cos(an + 0.5), y2 - 7 * Math.sin(an + 0.5)); ctx.stroke(); }

  window.ProChart = { mount: (el, opt) => new ProChart(el, opt) };
})();
