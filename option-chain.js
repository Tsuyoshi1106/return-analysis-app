// web/pages/api/options-chain.js
// Fetch option chain from Yahoo Finance (no API key).
// Endpoint: https://query2.finance.yahoo.com/v7/finance/options/{ticker}?date={unix}
//
// Returns: expirations list + calls/puts for selected expiration.

function toInt(x, defVal) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.floor(n) : defVal;
}

async function fetchYahoo(url) {
  const r = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept": "application/json,text/plain,*/*",
    },
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Yahoo fetch failed ${r.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Yahoo returned non-JSON: ${text.slice(0, 200)}`);
  }
}

function normalizeContract(c) {
  // Keep only what we need
  return {
    contractSymbol: c.contractSymbol,
    strike: c.strike,
    currency: c.currency,
    lastPrice: c.lastPrice,
    bid: c.bid,
    ask: c.ask,
    change: c.change,
    percentChange: c.percentChange,
    volume: c.volume,
    openInterest: c.openInterest,
    impliedVolatility: c.impliedVolatility, // decimal (e.g., 0.45)
    inTheMoney: c.inTheMoney,
    expiration: c.expiration, // unix seconds
    contractSize: c.contractSize,
    lastTradeDate: c.lastTradeDate,
  };
}

export default async function handler(req, res) {
  try {
    const tickerRaw = String(req.query.ticker || "").trim();
    if (!tickerRaw) return res.status(400).json({ ok: false, error: "ticker is required" });

    // Yahoo tickers sometimes need URL encoding (e.g., BRK-B => BRK-B works; sometimes BRK-B or BRK.B)
    const ticker = tickerRaw.toUpperCase();

    // First call to get expiration list
    const url0 = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}`;
    const j0 = await fetchYahoo(url0);

    const result0 = j0?.optionChain?.result?.[0];
    if (!result0) {
      return res.status(404).json({ ok: false, error: "No option chain result. Ticker may be invalid or options unavailable." });
    }

    const expirations = result0.expirationDates || [];
    if (expirations.length === 0) {
      return res.status(404).json({ ok: false, error: "No expirations returned for this ticker." });
    }

    // Pick expiration: query param "exp" as unix seconds; otherwise first (nearest)
    const expParam = toInt(req.query.exp, null);
    const exp = expParam && expirations.includes(expParam) ? expParam : expirations[0];

    const url1 = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}?date=${exp}`;
    const j1 = await fetchYahoo(url1);

    const result1 = j1?.optionChain?.result?.[0];
    const quote = result1?.quote || null;
    const opt = result1?.options?.[0] || null;
    if (!opt) {
      return res.status(404).json({ ok: false, error: "No option contracts for selected expiration." });
    }

    const calls = (opt.calls || []).map(normalizeContract);
    const puts = (opt.puts || []).map(normalizeContract);

    res.status(200).json({
      ok: true,
      ticker,
      quote: quote
        ? {
            symbol: quote.symbol,
            regularMarketPrice: quote.regularMarketPrice,
            regularMarketTime: quote.regularMarketTime,
            currency: quote.currency,
            shortName: quote.shortName,
          }
        : null,
      expirations,
      selectedExpiration: exp,
      calls,
      puts,
      note:
        "Options via Yahoo Finance. Scenario pricing should use a model (e.g., Black-Scholes). For American options/dividends, model price is an approximation.",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

