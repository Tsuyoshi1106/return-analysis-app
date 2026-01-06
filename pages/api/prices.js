// ===== In-memory cache (per server process) =====
// key: "SYMBOL|PERIOD"
// value: { ts: number(ms), points: Array<{date, close}>, symbol, period }
// TTL: 10 minutes
const CACHE_TTL_MS = 10 * 60 * 1000;

// 失敗時の短期クールダウン（同じキーで連打されるとYahooに負荷がかかるため）
const FAIL_COOLDOWN_MS = 30 * 1000;

// Next dev はホットリロードでモジュールが読み直されることがあるので
// globalThis に載せておくと安定します
const globalCache = (globalThis.__SIGMORA_PRICE_CACHE__ ||= new Map());
const globalFail = (globalThis.__SIGMORA_PRICE_FAIL__ ||= new Map());

function now() {
  return Date.now();
}

function cacheKey(symbol, period) {
  return `${symbol}|${period}`;
}

function normalizeSymbol(raw) {
  return String(raw || "").trim().toUpperCase();
}

function normalizePeriod(raw) {
  return String(raw || "5Y").trim().toUpperCase();
}

function periodToRange(period) {
  if (period === "1Y") return "1y";
  if (period === "3Y") return "3y";
  if (period === "5Y") return "5y";
  return "max";
}

export default async function handler(req, res) {
  try {
    const symbol = normalizeSymbol(req.query.symbol);
    const period = normalizePeriod(req.query.period);

    if (!symbol) return res.status(400).json({ error: "symbol is required" });

    const key = cacheKey(symbol, period);

    // 1) Fail cooldown（直近で失敗してたら即返す）
    const lastFailTs = globalFail.get(key);
    if (lastFailTs && now() - lastFailTs < FAIL_COOLDOWN_MS) {
      return res.status(429).json({
        error: "Provider temporarily unavailable (cooldown). Try again shortly.",
        detail: `cooldown_ms=${FAIL_COOLDOWN_MS}`,
      });
    }

    // 2) Cache hit
    const cached = globalCache.get(key);
    if (cached && now() - cached.ts < CACHE_TTL_MS) {
      return res.status(200).json({
        symbol,
        period,
        points: cached.points,
        meta: { source: "cache", cached_at: new Date(cached.ts).toISOString() },
      });
    }

    // 3) Fetch from Yahoo Finance
    const range = periodToRange(period);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?range=${encodeURIComponent(range)}&interval=1d&events=div%2Csplits`;

    const r = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        Accept: "application/json,text/plain,*/*",
      },
    });

    const text = await r.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      globalFail.set(key, now());
      return res.status(502).json({
        error: "Non-JSON response from Yahoo Finance",
        preview: text.slice(0, 200),
      });
    }

    const err0 = json?.chart?.error;
    const result0 = json?.chart?.result?.[0];

    if (err0) {
      globalFail.set(key, now());
      return res.status(400).json({
        error: "Yahoo Finance returned an error",
        detail: err0,
      });
    }

    if (!result0) {
      globalFail.set(key, now());
      return res.status(502).json({
        error: "Unexpected Yahoo Finance format (missing chart.result[0])",
        rawKeys: Object.keys(json?.chart || {}),
      });
    }

    const timestamps = result0.timestamp;
    const closes = result0.indicators?.quote?.[0]?.close;

    if (!Array.isArray(timestamps) || !Array.isArray(closes)) {
      globalFail.set(key, now());
      return res.status(502).json({
        error: "Unexpected Yahoo Finance format (missing timestamp/close arrays)",
      });
    }

    const points = [];
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const c = closes[i];
      if (!Number.isFinite(ts)) continue;
      if (!Number.isFinite(c)) continue;

      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      points.push({ date, close: Number(c) });
    }

    if (points.length < 2) {
      globalFail.set(key, now());
      return res.status(400).json({
        error: "Not enough data points",
        symbol,
        period,
        range,
        count: points.length,
      });
    }

    points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    // 4) Save cache and respond
    const ts = now();
    globalCache.set(key, { ts, points });

    return res.status(200).json({
      symbol,
      period,
      points,
      meta: { source: "yahoo", cached_until: new Date(ts + CACHE_TTL_MS).toISOString() },
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}


