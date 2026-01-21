// web/pages/api/leaps-sim.js
// LEAPS simulator: GBM paths + Black-Scholes valuation at checkpoints
// No external API required.

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function isFiniteNumber(x) {
  return typeof x === "number" && Number.isFinite(x);
}

// Standard normal CDF approximation (Abramowitz-Stegun)
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let prob =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) prob = 1 - prob;
  return prob;
}

function bsPrice({ S, K, T, r, q, sigma, type }) {
  // T in years
  if (T <= 0) {
    // At expiry intrinsic
    const intrinsic = type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return intrinsic;
  }
  if (sigma <= 0) {
    // Deterministic forward-ish
    const forward = S * Math.exp((r - q) * T);
    const disc = Math.exp(-r * T);
    if (type === "call") return Math.max(forward - K, 0) * disc;
    return Math.max(K - forward, 0) * disc;
  }

  const sqrtT = Math.sqrt(T);
  const d1 =
    (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const Nd1 = normCdf(type === "call" ? d1 : -d1);
  const Nd2 = normCdf(type === "call" ? d2 : -d2);

  const discQ = Math.exp(-q * T);
  const discR = Math.exp(-r * T);

  if (type === "call") {
    return S * discQ * normCdf(d1) - K * discR * normCdf(d2);
  } else {
    return K * discR * normCdf(-d2) - S * discQ * normCdf(-d1);
  }
}

// Box-Muller for standard normal
function randn() {
  let u = 0,
    v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function parseISODate(s) {
  // Expect "YYYY-MM-DD"
  if (typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Validate round-trip
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  )
    return null;
  return dt;
}

function daysBetweenUTC(a, b) {
  const ms = b.getTime() - a.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

function uniqueSortedPositiveInts(arr) {
  const set = new Set();
  for (const x of arr) {
    const n = Math.floor(Number(x));
    if (Number.isFinite(n) && n > 0) set.add(n);
  }
  return Array.from(set).sort((x, y) => x - y);
}

export default async function handler(req, res) {
  try {
    const body = req.method === "POST" ? req.body : req.query;

    const {
      spot,
      strike,
      iv,
      rate,
      dividend,
      type,
      premiumPaid,
      contracts,
      currentDate,
      expiryDate,
      checkpointDates, // optional: ["YYYY-MM-DD", ...]
      checkpointDays, // optional: [30, 90, ...] from current
      nSims,
      seed, // not used (Math.random)
    } = body;

    const S0 = Number(spot);
    const K = Number(strike);
    const sigma = Number(iv);
    const r = Number(rate);
    const q = Number(dividend);
    const optType = (type || "call").toLowerCase() === "put" ? "put" : "call";
    const paid = Number(premiumPaid);
    const qty = Math.max(1, Math.floor(Number(contracts) || 1));
    const sims = clamp(Math.floor(Number(nSims) || 20000), 500, 200000);

    if (![S0, K, sigma, r, q, paid].every(isFiniteNumber) || S0 <= 0 || K <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid numeric inputs." });
    }
    if (sigma < 0 || sigma > 5) {
      return res.status(400).json({ ok: false, error: "IV must be between 0 and 5 (i.e., 0% to 500%)." });
    }

    const cur = parseISODate(currentDate);
    const exp = parseISODate(expiryDate);
    if (!cur || !exp) {
      return res.status(400).json({ ok: false, error: "currentDate / expiryDate must be YYYY-MM-DD." });
    }

    const totalDays = daysBetweenUTC(cur, exp);
    if (!Number.isFinite(totalDays) || totalDays <= 0.5) {
      return res.status(400).json({ ok: false, error: "expiryDate must be after currentDate." });
    }

    // Build checkpoints (in days from current), always include expiry
    let cpDays = [];

    if (Array.isArray(checkpointDays)) {
      cpDays = cpDays.concat(uniqueSortedPositiveInts(checkpointDays));
    } else if (typeof checkpointDays === "string" && checkpointDays.trim()) {
      // allow "30,90,180"
      cpDays = cpDays.concat(
        uniqueSortedPositiveInts(
          checkpointDays
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        )
      );
    }

    if (Array.isArray(checkpointDates) && checkpointDates.length > 0) {
      for (const ds of checkpointDates) {
        const dt = parseISODate(ds);
        if (!dt) continue;
        const d = daysBetweenUTC(cur, dt);
        if (d > 0.5) cpDays.push(Math.round(d));
      }
    } else if (typeof checkpointDates === "string" && checkpointDates.trim()) {
      // allow "2026-03-01,2026-06-01"
      for (const ds of checkpointDates.split(",")) {
        const dt = parseISODate(ds.trim());
        if (!dt) continue;
        const d = daysBetweenUTC(cur, dt);
        if (d > 0.5) cpDays.push(Math.round(d));
      }
    }

    // Clean: keep within (0, totalDays], unique, sorted
    const maxD = Math.floor(totalDays);
    cpDays = uniqueSortedPositiveInts(cpDays)
      .map((d) => clamp(d, 1, maxD))
      .filter((d) => d <= maxD);

    if (cpDays.length === 0) {
      // default checkpoints if none specified
      const defaults = [30, 90, 180, 365].map((d) => clamp(d, 1, maxD));
      cpDays = uniqueSortedPositiveInts(defaults);
    }

    // ensure expiry included (as maxD)
    if (!cpDays.includes(maxD)) cpDays.push(maxD);
    cpDays = uniqueSortedPositiveInts(cpDays);

    // Convert checkpoint days to year fractions
    const yearBasis = 365.0; // calendar-based (you like 365)
    const cpT = cpDays.map((d) => d / yearBasis);

    // Precompute per-step dt between checkpoints
    const dtYears = [];
    for (let i = 0; i < cpT.length; i++) {
      const prev = i === 0 ? 0 : cpT[i - 1];
      dtYears.push(cpT[i] - prev);
    }

    // Simulate GBM under risk-neutral drift (r - q)
    const drift = (r - q);
    const S_at = new Array(cpT.length).fill(0).map(() => new Array(sims));
    const V_at = new Array(cpT.length).fill(0).map(() => new Array(sims));
    const PnL_at = new Array(cpT.length).fill(0).map(() => new Array(sims));

    for (let path = 0; path < sims; path++) {
      let S = S0;
      for (let i = 0; i < cpT.length; i++) {
        const dt = dtYears[i];
        const z = randn();
        const step = Math.exp((drift - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * z);
        S = S * step;

        const T_remain = Math.max(cpT[cpT.length - 1] - cpT[i], 0);
        const V = bsPrice({ S, K, T: T_remain, r, q, sigma, type: optType });
        const pnl = (V - paid) * 100 * qty; // 1 contract = 100 shares

        S_at[i][path] = S;
        V_at[i][path] = V;
        PnL_at[i][path] = pnl;
      }
    }

    // Helpers for summary stats
    function quantile(sortedArr, p) {
      const n = sortedArr.length;
      if (n === 0) return NaN;
      const idx = (n - 1) * p;
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      if (lo === hi) return sortedArr[lo];
      const w = idx - lo;
      return sortedArr[lo] * (1 - w) + sortedArr[hi] * w;
    }

    function summarize(arr) {
      const sorted = [...arr].sort((a, b) => a - b);
      const n = sorted.length;
      const mean = sorted.reduce((s, x) => s + x, 0) / n;
      const pProfit = sorted.filter((x) => x > 0).length / n;
      return {
        mean,
        pProfit,
        p05: quantile(sorted, 0.05),
        p50: quantile(sorted, 0.5),
        p95: quantile(sorted, 0.95),
      };
    }

    const checkpoints = cpDays.map((d, i) => {
      const dt = new Date(cur.getTime() + d * 24 * 60 * 60 * 1000);
      const iso = dt.toISOString().slice(0, 10);
      const Sarr = S_at[i];
      const Varr = V_at[i];
      const Parr = PnL_at[i];
      const sS = summarize(Sarr);
      const sV = summarize(Varr);
      const sP = summarize(Parr);

      return {
        dayFromNow: d,
        date: iso,
        underlying: sS,
        optionValue: sV,
        pnl: sP,
      };
    });

    // Provide a small sample of paths for charting
    const samplePaths = Math.min(20, sims);
    const sampleIdx = Array.from({ length: samplePaths }, (_, i) => i);
    const sampled = cpDays.map((d, i) => ({
      dayFromNow: d,
      date: checkpoints[i].date,
      S: sampleIdx.map((j) => S_at[i][j]),
      V: sampleIdx.map((j) => V_at[i][j]),
      PnL: sampleIdx.map((j) => PnL_at[i][j]),
    }));

    return res.status(200).json({
      ok: true,
      inputs: {
        spot: S0,
        strike: K,
        iv: sigma,
        rate: r,
        dividend: q,
        type: optType,
        premiumPaid: paid,
        contracts: qty,
        currentDate,
        expiryDate,
        nSims: sims,
        checkpointDays: cpDays,
      },
      checkpoints,
      sampled, // for plotting some sample paths
      notes: {
        model: "GBM risk-neutral drift (r-q), constant IV; option valued by Black-Scholes at each checkpoint.",
        yearBasis: 365,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      detail: String(e && e.message ? e.message : e),
    });
  }
}

