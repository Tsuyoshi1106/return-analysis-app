export default async function handler(req, res) {
  try {
    const ticker = String(req.query.ticker || "").trim().toUpperCase();
    if (!ticker) return res.status(400).json({ ok: false, error: "ticker is required (?ticker=AAPL)" });

    async function fetchJson(url) {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
      }
      return await r.json();
    }

    const base = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}`;
    const j1 = await fetchJson(base);
    const r1 = j1?.optionChain?.result?.[0];
    if (!r1) throw new Error("Yahoo options: no result");

    const expirations = r1.expirationDates || [];
    if (!expirations.length) throw new Error("Yahoo options: no expirationDates");

    const exp = expirations[expirations.length - 1];

    const j2 = await fetchJson(`${base}?date=${exp}`);
    const r2 = j2?.optionChain?.result?.[0];
    if (!r2) throw new Error("Yahoo options(date): no result");

    const q = r2.quote || {};
    const chain = r2.options?.[0] || {};

    return res.status(200).json({
      ok: true,
      source: "yahoo",
      ticker,
      quote: q,
      expiration: exp,
      expirations,
      calls: chain.calls || [],
      puts: chain.puts || [],
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}


