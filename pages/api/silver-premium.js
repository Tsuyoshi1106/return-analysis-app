// web/pages/api/silver-premium.js
//
// SATAN (shortest) working version: NO SGE scraping.
// We use Yahoo Finance only (stable on Vercel):
// - US silver proxy: SI=F (USD/oz)
// - "China proxy": AG=F (USD/oz)  ※not actual China spot; proxy series
// - FX: USDCNY=X (USD/CNY)
//
// Premium% = (ChinaProxy_USD/oz * USD/CNY * 32.1507) / (US_USD/oz * USD/CNY * 32.1507) - 1
//         = ChinaProxy_USD/oz / US_USD/oz - 1
//
// (We still include FX + kg conversion in output for transparency.)

const OZ_PER_KG = 32.1507466;

function mapPeriod(period) {
  const p = String(period || "1Y").toUpperCase();
  // choose ranges that are robust
  if (p === "1M") return { range: "3mo", interval: "1d", days: 40 };
  if (p === "3M") return { range: "6mo", interval: "1d", days: 120 };
  if (p === "6M") return { range: "1y", interval: "1d", days: 250 };
  if (p === "5Y") return { range: "5y", interval: "1wk", days: 2000 };
  return { range: "2y", interval: "1d", days: 450 }; // 1Y default
}

async function fetchYahooDailyCloses(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;

  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "application/json,text/plain,*/*",
    },
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Yahoo fetch failed: ${symbol} ${r.status} ${t.slice(0, 120)}`);
  }

  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`Yahoo response missing chart.result for ${symbol}`);

  const ts = res.timestamp || [];
  const close = res.indicators?.quote?.[0]?.close || [];

  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    if (c == null || Number.isNaN(c)) continue;
    const d = new Date(ts[i] * 1000);
    const iso = d.toISOString().slice(0, 10);
    out.push({ date: iso, close: Number(c) });
  }
  return out;
}

function buildMap(series) {
  const m = new Map();
  for (const x of series) m.set(x.date, x.close);
  return m;
}

function filterRecent(points, days) {
  if (!points.length) return points;
  const last = new Date(points[points.length - 1].date);
  const cutoff = new Date(last.getTime() - days * 24 * 3600 * 1000);
  return points.filter((p) => new Date(p.date) >= cutoff);
}

export default async function handler(req, res) {
  try {
    const period = String(req.query.period || "1Y");
    const scale = Number(req.query.scale ?? 1); // keep for UI compatibility (unused effectively)
    const scaleSafe = Number.isFinite(scale) && scale > 0 ? scale : 1;

    const { range, interval, days } = mapPeriod(period);

    // Yahoo only
    // US proxy: SI=F
    // "China proxy": AG=F
    // FX: USDCNY=X
    const [us, cnProxy, fx] = await Promise.all([
      fetchYahooDailyCloses("SI=F", range, interval),
      fetchYahooDailyCloses("AG=F", range, interval),
      fetchYahooDailyCloses("USDCNY=X", range, interval),
    ]);

    const usMap = buildMap(us);
    const cnMap = buildMap(cnProxy);
    const fxMap = buildMap(fx);

    // join on intersection
    const dates = [...usMap.keys()].filter((d) => cnMap.has(d) && fxMap.has(d)).sort();

    let points = [];
    for (const d of dates) {
      const usUsdOz = usMap.get(d);
      const cnUsdOz = cnMap.get(d);
      const usdCny = fxMap.get(d);
      if (![usUsdOz, cnUsdOz, usdCny].every((v) => Number.isFinite(v) && v > 0)) continue;

      // Convert to CNY/kg for display (not required for premium calc)
      const usCnyKg = usUsdOz * usdCny * OZ_PER_KG;
      const cnCnyKg = cnUsdOz * usdCny * OZ_PER_KG * scaleSafe;

      const premium = cnCnyKg / usCnyKg - 1; // == cnUsdOz/usUsdOz - 1 (scale cancels if same units)
      points.push({
        date: d,
        us_usd_oz: usUsdOz,
        cn_proxy_usd_oz: cnUsdOz,
        usd_cny: usdCny,
        us_cny_kg: usCnyKg,
        cn_proxy_cny_kg: cnCnyKg,
        premium: premium, // decimal
      });
    }

    points = filterRecent(points, days);

    if (!points.length) throw new Error("No joined data points (symbols/overlap).");

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=86400");
    return res.status(200).json({
      ok: true,
      period,
      scale: scaleSafe,
      source: {
        yahoo_symbols: { us: "SI=F", cn_proxy: "AG=F", fx: "USDCNY=X" },
        note:
          "This SATAN version uses Yahoo-only proxies (no SGE scraping). CN proxy is AG=F on Yahoo (not guaranteed to be SGE spot).",
      },
      points,
    });
  } catch (e) {
    return res.status(502).json({
      ok: false,
      error: String(e?.message || e),
      hint: "Try again later (rate limits) or shorten period.",
    });
  }
}

