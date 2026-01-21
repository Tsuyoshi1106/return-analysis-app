// web/pages/leaps-scenario.js
import { useMemo, useState } from "react";

// --- Math (Black-Scholes) ---
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
  if (T <= 0) {
    const intrinsic = type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return intrinsic;
  }
  if (sigma <= 0) {
    const forward = S * Math.exp((r - q) * T);
    const disc = Math.exp(-r * T);
    return type === "call" ? Math.max(forward - K, 0) * disc : Math.max(K - forward, 0) * disc;
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const discQ = Math.exp(-q * T);
  const discR = Math.exp(-r * T);
  if (type === "call") return S * discQ * normCdf(d1) - K * discR * normCdf(d2);
  return K * discR * normCdf(-d2) - S * discQ * normCdf(-d1);
}

// --- Date helpers (UTC, 365-day basis) ---
function parseISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}
function daysBetweenUTC(a, b) {
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24);
}
function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function round(x, d = 4) {
  if (!Number.isFinite(x)) return "";
  const p = Math.pow(10, d);
  return Math.round(x * p) / p;
}

export default function LeapsScenarioPage() {
  const [ticker, setTicker] = useState("AAPL");
  const [chain, setChain] = useState(null);
  const [loadingChain, setLoadingChain] = useState(false);
  const [err, setErr] = useState("");

  const [selectedExp, setSelectedExp] = useState(null);
  const [side, setSide] = useState("call"); // call / put
  const [contractSymbol, setContractSymbol] = useState("");
  const [scenarioDate, setScenarioDate] = useState(todayISO());
  const [scenarioSpot, setScenarioSpot] = useState("200");

  // assumptions
  const [rate, setRate] = useState("0.05");     // r
  const [divYield, setDivYield] = useState("0.00"); // q
  const [ivShift, setIvShift] = useState("0.00");   // add to current IV (e.g., +0.05)
  const [premiumPaid, setPremiumPaid] = useState(""); // optional, for PnL

  const yearBasis = 365.0;

  async function loadChain(expUnix = null) {
    setErr("");
    setLoadingChain(true);
    setChain(null);
    try {
      const url = expUnix
        ? `/api/options-chain?ticker=${encodeURIComponent(ticker)}&exp=${encodeURIComponent(expUnix)}`
        : `/api/options-chain?ticker=${encodeURIComponent(ticker)}`;

      const r = await fetch(url);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Failed to load options chain");
      setChain(j);
      setSelectedExp(j.selectedExpiration);
      setContractSymbol("");
      setPremiumPaid("");
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setLoadingChain(false);
    }
  }

  async function changeExpiration(expUnix) {
    await loadChain(expUnix);
  }

  const contracts = useMemo(() => {
    if (!chain?.ok) return [];
    return side === "put" ? chain.puts : chain.calls;
  }, [chain, side]);

  const selected = useMemo(() => {
    return contracts.find((c) => c.contractSymbol === contractSymbol) || null;
  }, [contracts, contractSymbol]);

  const scenario = useMemo(() => {
    if (!chain?.ok || !selected) return null;

    const cur = parseISODate(todayISO()); // "現在日付"は今日固定（後で入力化してもOK）
    const scen = parseISODate(scenarioDate);
    if (!cur || !scen) return { error: "Scenario date must be YYYY-MM-DD" };

    const expUnix = Number(selected.expiration);
    const exp = new Date(expUnix * 1000);

    const dToScenario = daysBetweenUTC(cur, scen);
    const dToExpiryFromScenario = daysBetweenUTC(scen, exp);

    if (dToScenario < 0) return { error: "Scenario date must be today or later." };
    if (dToExpiryFromScenario < 0) return { error: "Scenario date must be on/before expiration." };

    const S = Number(scenarioSpot);
    if (!Number.isFinite(S) || S <= 0) return { error: "Scenario spot must be > 0" };

    const K = Number(selected.strike);
    const r = Number(rate);
    const q = Number(divYield);
    const iv0 = Number(selected.impliedVolatility);
    const shift = Number(ivShift);

    if (!Number.isFinite(K) || !Number.isFinite(r) || !Number.isFinite(q) || !Number.isFinite(iv0) || !Number.isFinite(shift)) {
      return { error: "Invalid numeric assumptions." };
    }

    const sigma = Math.max(0, iv0 + shift);
    const T = Math.max(0, dToExpiryFromScenario / yearBasis);

    const theo = bsPrice({ S, K, T, r, q, sigma, type: side === "put" ? "put" : "call" });

    // If user entered premiumPaid, compute PnL per contract
    const paid = Number(premiumPaid);
    const hasPaid = Number.isFinite(paid) && paid >= 0;
    const pnl = hasPaid ? (theo - paid) * 100 : null;

    return {
      S,
      K,
      scenarioDate,
      expiryISO: exp.toISOString().slice(0, 10),
      daysToExpiryFromScenario: round(dToExpiryFromScenario, 2),
      T_years: round(T, 6),
      iv_current: iv0,
      iv_used: sigma,
      theoPrice: theo,
      pnlPerContract: pnl,
    };
  }, [chain, selected, scenarioDate, scenarioSpot, rate, divYield, ivShift, premiumPaid, side]);

  return (
    <div style={{ maxWidth: 1100, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <h1 style={{ fontSize: 34, marginBottom: 6 }}>LEAPS Scenario Pricer</h1>
      <div style={{ color: "#555", marginBottom: 18 }}>
        「<b>もし</b> <b>YYYY-MM-DD</b> に原資産が <b>S</b> だったら、残存期間Tでのオプション理論価格はいくら？」を出します。
        チェーンはYahoo Financeから取得、価格はBlack-Scholes（近似）です。
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Box title="1) Load option chain">
          <Row label="Ticker">
            <div style={{ display: "flex", gap: 8 }}>
              <input value={ticker} onChange={(e) => setTicker(e.target.value)} style={inp} />
              <button onClick={() => loadChain(null)} disabled={loadingChain} style={btn}>
                {loadingChain ? "Loading..." : "Load"}
              </button>
            </div>
          </Row>

          {chain?.ok ? (
            <>
              <Row label="Expiration">
                <select value={selectedExp || ""} onChange={(e) => changeExpiration(e.target.value)} style={inp}>
                  {chain.expirations.map((x) => {
                    const dt = new Date(Number(x) * 1000);
                    const label = dt.toISOString().slice(0, 10);
                    return (
                      <option key={x} value={x}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </Row>

              <div style={{ color: "#666", fontSize: 13, marginTop: 6 }}>
                Underlying: <b>{chain.quote?.symbol}</b> / Spot: <b>{chain.quote?.regularMarketPrice}</b>
              </div>
            </>
          ) : (
            <div style={{ color: "#777", fontSize: 13 }}>Loadを押すとオプションチェーンを取得します。</div>
          )}

          {err ? <div style={{ color: "#b00020", marginTop: 10, fontWeight: 600 }}>{err}</div> : null}
        </Box>

        <Box title="2) Pick a contract">
          <Row label="Side">
            <select value={side} onChange={(e) => setSide(e.target.value)} style={inp}>
              <option value="call">Call</option>
              <option value="put">Put</option>
            </select>
          </Row>

          <Row label="Contract">
            <select value={contractSymbol} onChange={(e) => setContractSymbol(e.target.value)} style={inp}>
              <option value="">-- select --</option>
              {contracts.map((c) => (
                <option key={c.contractSymbol} value={c.contractSymbol}>
                  {c.contractSymbol} | K={c.strike} | IV={round(c.impliedVolatility, 4)} | bid/ask={c.bid}/{c.ask}
                </option>
              ))}
            </select>
          </Row>

          {selected ? (
            <div style={{ marginTop: 10, fontSize: 13, color: "#444", lineHeight: 1.5 }}>
              <div><b>Strike:</b> {selected.strike}</div>
              <div><b>IV (current):</b> {round(selected.impliedVolatility, 6)}</div>
              <div><b>Last:</b> {selected.lastPrice} / <b>Bid:</b> {selected.bid} / <b>Ask:</b> {selected.ask}</div>
              <div><b>OI:</b> {selected.openInterest} / <b>Vol:</b> {selected.volume}</div>
            </div>
          ) : (
            <div style={{ color: "#777", fontSize: 13 }}>契約を選ぶと詳細が出ます。</div>
          )}
        </Box>

        <Box title="3) Scenario inputs">
          <Row label="Scenario date (YYYY-MM-DD)">
            <input value={scenarioDate} onChange={(e) => setScenarioDate(e.target.value)} style={inp} />
          </Row>
          <Row label="Scenario underlying price S">
            <input value={scenarioSpot} onChange={(e) => setScenarioSpot(e.target.value)} style={inp} />
          </Row>

          <Row label="Risk-free rate r">
            <input value={rate} onChange={(e) => setRate(e.target.value)} style={inp} />
          </Row>
          <Row label="Dividend yield q">
            <input value={divYield} onChange={(e) => setDivYield(e.target.value)} style={inp} />
          </Row>
          <Row label="IV shift (add, e.g., +0.05)">
            <input value={ivShift} onChange={(e) => setIvShift(e.target.value)} style={inp} />
          </Row>

          <Row label="Premium paid (optional, per share)">
            <input value={premiumPaid} onChange={(e) => setPremiumPaid(e.target.value)} style={inp} placeholder="e.g., 8.50" />
          </Row>

          <div style={{ color: "#666", fontSize: 13 }}>
            ※ IVは「現在のIV ± シフト」で固定。将来IVを仮定したい場合はここを触ります。
          </div>
        </Box>

        <Box title="4) Result">
          {!selected ? (
            <div style={{ color: "#777" }}>契約を選ぶと結果が出ます。</div>
          ) : scenario?.error ? (
            <div style={{ color: "#b00020", fontWeight: 700 }}>{scenario.error}</div>
          ) : scenario ? (
            <div style={{ lineHeight: 1.6 }}>
              <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>
                Theoretical price: {round(scenario.theoPrice, 4)}
              </div>
              <div><b>Scenario:</b> {scenario.scenarioDate} @ S={scenario.S}</div>
              <div><b>Expiry:</b> {scenario.expiryISO}</div>
              <div><b>Days to expiry (from scenario):</b> {scenario.daysToExpiryFromScenario}</div>
              <div><b>T (years):</b> {scenario.T_years}</div>
              <div><b>IV current / used:</b> {round(scenario.iv_current, 6)} / {round(scenario.iv_used, 6)}</div>
              {Number.isFinite(scenario.pnlPerContract) ? (
                <div style={{ marginTop: 8, fontWeight: 700 }}>
                  PnL per contract (vs paid): {round(scenario.pnlPerContract, 2)}
                </div>
              ) : null}
              <div style={{ marginTop: 10, color: "#666", fontSize: 12 }}>
                注意：米株オプションはAmerican。BSは近似（特にPut/高配当/深ITMではズレやすい）。
              </div>
            </div>
          ) : null}
        </Box>
      </div>
    </div>
  );
}

function Box({ title, children }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
      <div style={{ fontWeight: 800, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 10, alignItems: "center", marginBottom: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

const inp = { width: "100%", padding: 8, borderRadius: 10, border: "1px solid #ccc" };
const btn = { padding: "8px 12px", borderRadius: 10, border: "1px solid #111", background: "#111", color: "white" };

