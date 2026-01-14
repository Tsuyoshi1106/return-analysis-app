// web/pages/api/silver-premium.js
// Silver Premium Monitor (US vs SGE SHAG)
// Data sources:
// - SGE: https://en.sge.com.cn/h5_data_SilverBenchmarkPrice (table page)  (more scrape-friendly)
// - Yahoo Finance (no key): SI=F (COMEX silver futures), USD/CNY
//
// Premium% = (SGE_SHAG_CNY/kg * scale) / (SI=F_USD/oz * USD/CNY * 32.1507466) - 1
//
// Notes:
// - This is an educational/analytics tool; not investment advice.
// - If SGE page structure changes, regex may need an update.

const OZ_TO_KG = 32.1507466;

function periodToDays(period) {
  switch ((period || "1Y").toUpperCase()) {
    case "1M":
      return 35;
    case "3M":
      return 110;
    case "6M":
      return 220;
    case "1Y":
      return 400;
    case "5Y":
      return 2000;
    default:
      return 400;
  }
}

function yRange(period) {
  switch ((period || "1Y").toUpperCase()) {
    case "1M":
      return { range: "2mo", interval: "1d" };
    case "3M":
      return { range: "6mo", interval: "1d" };
    case "6M":
      return { range: "1y", interval: "1d" };
    case "1Y":
      return { range: "2y", interval: "1d" };
    case "5Y":
      return { range: "5y", interval: "1wk" };
    default:
      return { range: "2y", interval: "1d" };
  }
}

async function fetchYahooChart(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(
    interval
  )}&includePrePost=false&events=div%7Csplit%7CcapitalGains`;

  const res = await fetch(url, {
    headers: {
      // Some hosts behave better with a UA
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "application/json,text/plain,*/*",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Yahoo fetch failed: ${symbol} ${res.status} ${text.slice(0, 120)}`);
  }

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo response missing chart.result for ${symbol}`);

  const ts = result.timestamp || [];
  const quotes = result.indicators?.quote?.[0] || {};
  const close = quotes.close || [];

  // Build [ {date, value} ] using close
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    const v = close[i];
    if (v == null || Number.isNaN(v)) continue;
    const d = new Date(ts[i] * 1000);
    const iso = d.toISOString().slice(0, 10);
    points.push({ date: iso, value: Number(v) });
  }
  return points;
}

function parseSgeH5Table(html) {
  // Target rows like:
  // <tr> <td>20260112</td> <td>SHAG</td> <td>20421</td> <td>20927</td> </tr>
  //
  // We'll accept extra attributes/whitespace.
  const rows = [];

  const rowRe =
    /<tr[^>]*>\s*<td[^>]*>\s*(\d{8})\s*<\/td>\s*<td[^>]*>\s*SHAG\s*<\/td>\s*<td[^>]*>\s*([\d.]+)\s*<\/td>\s*<td[^>]*>\s*([\d.]+)\s*<\/td>/gi;

  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const yyyymmdd = m[1];
    const am = Number(m[2]);
    const pm = Number(m[3]);
    const iso = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

    // Prefer PM if present, else AM
    const price = Number.isFinite(pm) && pm > 0 ? pm : am;

    if (Number.isFinite(price) && price > 0) {
      rows.push({ date: iso, shag_cny_kg: price, am, pm });
    }
  }

  // If the table is rendered in a less-HTML-ish way (rare), try a fallback:
  // "20260112, SHAG, 20421, 20927" style
  if (rows.length === 0) {
    const altRe = /(\d{8})\s*,?\s*SHAG\s*,?\s*([\d.]+)\s*,?\s*([\d.]+)/g;
    while ((m = altRe.exec(html)) !== null) {
      const yyyymmdd = m[1];
      const am = Number(m[2]);
      const pm = Number(m[3]);
      const iso = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
      const price = Number.isFinite(pm) && pm > 0 ? pm : am;
      if (Number.isFinite(price) && price > 0) {
        rows.push({ date: iso, shag_cny_kg: price, am, pm });
      }
    }
  }

  // sort asc
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

function filterRecent(points, days) {
  if (!points.length) return points;
  const last = new Date(points[points.length - 1].date);
  const cutoff = new Date(last.getTime() - days * 24 * 3600 * 1000);
  return points.filter((p) => new Date(p.date) >= cutoff);
}

function buildMap(points) {
  const m = new Map();
  for (const p of points) m.set(p.date, p.value);
  return m;
}

export default async function handler(req, res) {
  try {
    const period = (req.query.period || "1Y").toString();
    const scale = Number(req.query.scale ?? "1");
    const scaleSafe = Number.isFinite(scale) && scale > 0 ? scale : 1;

    const { range, interval } = yRange(period);
    const days = periodToDays(period);

    // 1) SGE SHAG (CNY/kg)
    // Use the H5 table page (more scrape-friendly).
    const sgeUrl = "https://en.sge.com.cn/h5_data_SilverBenchmarkPrice";
    const sgeRes = await fetch(sgeUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!sgeRes.ok) {
      const text = await sgeRes.text().catch(() => "");
      throw new Error(`SGE fetch failed: ${sgeRes.status} ${text.slice(0, 120)}`);
    }

    const sgeHtml = await sgeRes.text();
    let shag = parseSgeH5Table(sgeHtml);
    shag = filterRecent(shag, days);

    if (!shag.length) {
      throw new Error(
        "Could not parse SHAG data from SGE h5 page. The page structure may have changed or blocked."
      );
    }

    // 2) Yahoo: SI=F (USD/oz), USD/CNY
    const [si, usdcny] = await Promise.all([
      fetchYahooChart("SI=F", range, interval),
      fetchYahooChart("USDCNY=X", range, interval),
    ]);

    const siMap = buildMap(si);
    const fxMap = buildMap(usdcny);

    // 3) Join on dates present in SGE, require SI and FX
    const points = [];
    for (const p of shag) {
      const siUsdOz = siMap.get(p.date);
      const fx = fxMap.get(p.date);
      if (siUsdOz == null || fx == null) continue;

      const us_cny_kg = Number(siUsdOz) * Number(fx) * OZ_TO_KG;
      if (!Number.isFinite(us_cny_kg) || us_cny_kg <= 0) continue;

      const sge_cny_kg = p.shag_cny_kg * scaleSafe;
      const premium = sge_cny_kg / us_cny_kg - 1;

      points.push({
        date: p.date,
        sge_cny_kg: Number(sge_cny_kg),
        us_cny_kg: Number(us_cny_kg),
        premium: Number(premium),
        si_usd_oz: Number(siUsdOz),
        usdcny: Number(fx),
      });
    }

    if (!points.length) {
      throw new Error("No joined data points (dates did not overlap).");
    }

    // cache a bit (helps avoid rate limiting)
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({
      ok: true,
      period,
      scale: scaleSafe,
      n: points.length,
      source: {
        sge: sgeUrl,
        yahoo: ["SI=F", "USDCNY=X"],
      },
      points,
    });
  } catch (e) {
    const msg = e?.message || String(e);

    res.status(502).json({
      ok: false,
      error: msg,
      hint:
        "Common causes: SGE page changed/blocked, rate limits, or no overlap in dates. Try again later or reduce period.",
    });
  }
}

