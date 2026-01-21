// web/pages/api/options-chain.js
import YahooFinance from "yahoo-finance2";

// ---- simple memory cache (best-effort on serverless) ----
const CACHE = globalThis.__OPTIONS_CHAIN_CACHE__ || new Map();
globalThis.__OPTIONS_CHAIN_CACHE__ = CACHE;

const TTL_MS = 5 * 60 * 1000; // 5 minutes

function now() {
  return Date.now();
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function normalizeUnderlying(u) {
  if (!u) return null;
  return {
    symbol: u.symbol ?? null,
    shortName: u.shortName ?? u.longName ?? null,
    regularMarketPrice: toNum(u.regularMarketPrice),
    currency: u.currency ?? null,
  };
}

function normalizeOptionRow(r, expiry) {
  return {
    contractSymbol: r.contractSymbol ?? null,
    strike: toNum(r.strike),
    lastPrice: toNum(r.lastPrice),
    bid: toNum(r.bid),
    ask: toNum(r.ask),
    impliedVolatility: toNum(r.impliedVolatility), // yahoo-finance2 returns decimal (e.g. 0.25)
    inTheMoney: !!r.inTheMoney,
    openInterest: toNum(r.openInterest),
    volume: toNum(r.volume),
    expiration: expiry ?? toNum(r.expiration),
    lastTradeDate: toNum(r.lastTradeDate),
  };
}

async function fetchOptions(symbol, date) {
  // yahoo-finance2 options endpoint
  // date: unix seconds or undefined
  const queryOptions = {
    // reduce chance of being blocked
    // yahoo-finance2 supports "headers" via module options in many environments.
    // Some versions accept it per-call. We'll pass in `opts` by creating instance below.
  };

  // v2/v3: instantiate client (prevents "Call `const yahooFinance = new YahooFinance()` first.")
  const yahooFinance = new YahooFinance({
    // add a UA; helps a bit in some environments
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9,ja;q=0.8",
    },
  });

  if (date) {
    return yahooFinance.options(symbol, { date, ...queryOptions });
  }
  return yahooFinance.options(symbol, queryOptions);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, error: "Method Not Allowed" });
      return;
    }

    const tickerRaw = (req.query.ticker || "").toString().trim();
    const dateRaw = (req.query.date || "").toString().trim(); // unix seconds (optional)

    if (!tickerRaw) {
      res.status(400).json({ ok: false, error: "Missing ticker" });
      return;
    }

    const ticker = tickerRaw.toUpperCase();

    let date = null;
    if (dateRaw) {
      const d = Number(dateRaw);
      if (!Number.isFinite(d) || d <= 0) {
        res.status(400).json({ ok: false, error: "Invalid date (unix seconds)" });
        return;
      }
      date = d;
    }

    const cacheKey = `${ticker}:${date ?? "nearest"}`;
    const cached = CACHE.get(cacheKey);
    if (cached && now() - cached.ts < TTL_MS) {
      // Vercel edge cache hint (best-effort)
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
      res.status(200).json(cached.data);
      return;
    }

    const raw = await fetchOptions(ticker, date);

    // raw format:
    // {
    //   underlying: {...},
    //   expirationDates: [unixSeconds...],
    //   options: [{ expirationDate, calls:[], puts:[] }, ...]
    // }
    const underlying = normalizeUnderlying(raw?.underlying);

    const expirationDates = Array.isArray(raw?.expirationDates)
      ? raw.expirationDates.map((x) => toNum(x)).filter((x) => x != null)
      : [];

    // choose first option chain block returned
    const optBlock = Array.isArray(raw?.options) && raw.options.length > 0 ? raw.options[0] : null;
    const expiry = toNum(optBlock?.expirationDate) ?? (expirationDates[0] ?? null);

    const calls = Array.isArray(optBlock?.calls) ? optBlock.calls.map((r) => normalizeOptionRow(r, expiry)) : [];
    const puts = Array.isArray(optBlock?.puts) ? optBlock.puts.map((r) => normalizeOptionRow(r, expiry)) : [];

    const data = {
      ok: true,
      underlying,
      expiry, // unix seconds
      expirationDates, // unix seconds[]
      chain: { calls, puts },
    };

    CACHE.set(cacheKey, { ts: now(), data });

    // Vercel edge cache hint (best-effort)
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json(data);
  } catch (e) {
    // Always return JSON to avoid "<!DOCTYPE... is not valid JSON"
    const msg = e?.message ? String(e.message) : String(e);
    res.status(500).json({
      ok: false,
      error: msg,
      hint:
        "Yahooのレート制限/一時ブロックの可能性があります。連打を避け、少し待って再実行。Vercelでは特に出やすいのでキャッシュが重要です。",
    });
  }
}

