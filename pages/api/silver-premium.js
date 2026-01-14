// web/pages/api/silver-premium.js
//
// Returns a time series of "SGE silver benchmark premium vs US implied CNY/kg"
// Premium% = (SGE_CNY_per_kg_scaled / (US_USD_per_oz * FX_USDCNY * OZ_PER_KG)) - 1
//
// Sources:
// - SGE SHAG daily chart page (HTML scrape) https://en.sge.com.cn/data_SilverBenchmarkPrice
// - Yahoo Finance chart endpoint (unofficial but widely used): https://query1.finance.yahoo.com/v8/finance/chart/{symbol}

const OZ_PER_KG = 32.1507466;

// simple in-memory cache (serverless friendly enough; may reset between invocations)
const CACHE = global.__SILVER_PREMIUM_CACHE__ || (global.__SILVER_PREMIUM_CACHE__ = new Map());

function cacheGet(key) {
  const v = CACHE.get(key);
  if (!v) return null;
  if (Date.now() > v.expiresAt) {
    CACHE.delete(key);
    return null;
  }
  return v.data;
}
function cacheSet(key, data, ttlMs) {
  CACHE.set(key, { data, expiresAt: Date.now() + ttlMs });
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: {
      // helps some hosts return full HTML
      "user-agent": "Mozilla/5.0 (compatible; SigmoraBot/1.0)",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!r.ok) throw new Error(`Fetch failed: ${url} (${r.status})`);
  return await r.text();
}

async function fetchYahooDailyCloses(symbol, range = "1y") {
  // Using Yahoo Finance v8 chart endpoint (unofficial)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=1d&range=${encodeURIComponent(range)}`;

  const r = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; SigmoraBot/1.0)",
      "accept": "application/json,text/plain,*/*",
    },
  });

  if (!r.ok) throw new Error(`Yahoo chart fetch failed (${symbol}) status=${r.status}`);

  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`Yahoo chart missing result for ${symbol}`);

  const ts = res.timestamp || [];
  const closes = res.indicators?.quote?.[0]?.close || [];

  // build series of { date: YYYY-MM-DD, close }
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c === null || c === undefined) continue;
    const d = new Date(ts[i] * 1000);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    out.push({ date: `${yyyy}-${mm}-${dd}`, close: Number(c) });
  }
  return out;
}

function parseSgeShagFromHtml(html) {
  // The SGE page may embed data lines like:
  // 20260109, SHAG, 18378, 18683
  // We'll extract (date, v1, v2) and use v2 as "benchmark" by default.
  const rows = [];
  const re = /(\d{8})\s*,\s*SHAG\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+(?:\.[0-9]+)?)/g;

  let m;
  while ((m = re.exec(html)) !== null) {
    const ymd = m[1];
    const v1 = Number(m[2]);
    const v2 = Number(m[3]);
    const yyyy = ymd.slice(0, 4);
    const mm = ymd.slice(4, 6);
    const dd = ymd.slice(6, 8);
    rows.push({
      date: `${yyyy}-${mm}-${dd}`,
      v1,
      v2,
    });
  }

  // If nothing matched, surface an actionable error (SGE page structure changed)
  if (!rows.length) {
    throw new Error(
      "Could not parse SHAG data from SGE page. The page structure may have changed."
    );
  }

  // sort ascending by date
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

function buildMapByDate(series) {
  const m = new Map();
  for (const x of series) m.set(x.date, x);
  return m;
}

function mean(arr) {
  if (!arr.length) return undefined;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}
function std(arr) {
  if (arr.length < 2) return undefined;
  const mu = mean(arr);
  const v = arr.reduce((s, x) => s + (x - mu) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

export default async function handler(req, res) {
  try {
    const range = String(req.query.range || "1y").toLowerCase(); // 1y / 2y / 5y / max (yahoo supports)
    const sgeScale = Number(req.query.sgeScale || 1); // because SGE units can be tricky; allow scaling
    if (!Number.isFinite(sgeScale) || sgeScale <= 0) {
      return res.status(400).json({ error: "Invalid sgeScale" });
    }

    const cacheKey = `silver-premium:${range}:${sgeScale}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
      return res.status(200).json(cached);
    }

    // 1) Fetch SGE SHAG
    const sgeHtml = await fetchText("https://en.sge.com.cn/data_SilverBenchmarkPrice");
    const shagRows = parseSgeShagFromHtml(sgeHtml);
    // Use v2 as "benchmark" (empirically often the second column)
    // Apply scale factor for unit ambiguity.
    const shagSeries = shagRows.map((r) => ({
      date: r.date,
      shag_cny_per_kg: r.v2 * sgeScale,
    }));

    // 2) Fetch US silver price (USD/oz) and FX (USD/CNY)
    // Using SI=F as COMEX silver futures proxy (close); you can swap to XAGUSD=X later if you prefer.
    const us = await fetchYahooDailyCloses("SI=F", range);
    const fx = await fetchYahooDailyCloses("CNY=X", range); // USD/CNY

    const usMap = buildMapByDate(us);
    const fxMap = buildMapByDate(fx);
    const sgeMap = buildMapByDate(shagSeries);

    // 3) Join by date (intersection)
    const dates = [...sgeMap.keys()].filter((d) => usMap.has(d) && fxMap.has(d));
    dates.sort();

    const points = [];
    for (const d of dates) {
      const usUsdPerOz = usMap.get(d).close;
      const usdCny = fxMap.get(d).close;
      const shagCnyPerKg = sgeMap.get(d).shag_cny_per_kg;

      const impliedCnyPerKg = usUsdPerOz * usdCny * OZ_PER_KG;
      const premium = shagCnyPerKg / impliedCnyPerKg - 1; // decimal
      points.push({
        date: d,
        us_usd_per_oz: usUsdPerOz,
        usd_cny: usdCny,
        shag_cny_per_kg: shagCnyPerKg,
        implied_cny_per_kg: impliedCnyPerKg,
        premium_pct: premium * 100,
      });
    }

    if (points.length < 20) {
      throw new Error(
        "Not enough joined data points. Try a shorter range or check data sources."
      );
    }

    // 4) Compute rolling-ish stats on entire sample for MVP
    const prem = points.map((p) => p.premium_pct);
    const mu = mean(prem);
    const sd = std(prem);

    const last = points[points.length - 1];
    const z = sd ? (last.premium_pct - mu) / sd : null;

    const payload = {
      meta: {
        range,
        sgeScale,
        note:
          "Premium% compares SGE SHAG (scaled) vs US implied CNY/kg from SI=F and USD/CNY. sgeScale exists because SGE units can vary by publication; adjust if levels look off.",
        sources: {
          sge: "https://en.sge.com.cn/data_SilverBenchmarkPrice",
          yahoo_chart_endpoint: "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}",
          symbols: { us: "SI=F", fx: "CNY=X" },
        },
      },
      stats: {
        mean_premium_pct: mu,
        std_premium_pct: sd,
        latest: {
          ...last,
          zscore: z,
        },
      },
      points,
    };

    // Cache 10 minutes (SGE updates daily; this is enough)
    cacheSet(cacheKey, payload, 10 * 60 * 1000);

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

