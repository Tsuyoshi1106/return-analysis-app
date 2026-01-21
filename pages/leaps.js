// web/pages/leaps.js
import { useEffect, useMemo, useState } from "react";

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function fmt(n, digits = 4) {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  if (!Number.isFinite(n)) return String(n);
  return Number(n).toFixed(digits);
}

function fmt2(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  if (!Number.isFinite(n)) return String(n);
  return Number(n).toFixed(2);
}

function parseYYYYMMDD(s) {
  // expects YYYY-MM-DD
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo, d, 0, 0, 0));
  // validate (e.g., 2026-02-31)
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return null;
  return dt;
}

function daysBetweenUTC(a, b) {
  // a,b: Date in UTC midnight
  const ms = b.getTime() - a.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

function normCdf(x) {
  // Abramowitz-Stegun approximation via erf
  // N(x)=0.5*(1+erf(x/sqrt(2)))
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  const cdf = 0.5 * (1 + sign * erf);
  return cdf;
}

function bsPrice({ S, K, T, r, q, sigma, isCall }) {
  // Black-Scholes with dividend yield q
  // If T<=0, return intrinsic.
  if (!(S > 0) || !(K > 0)) return null;
  if (!(sigma >= 0)) return null;

  if (T <= 0) {
    const intrinsic = isCall ? Math.max(0, S - K) : Math.max(0, K - S);
    return intrinsic;
  }
  if (sigma === 0) {
    // deterministic forward
    const fwd = S * Math.exp((r - q) * T);
    const disc = Math.exp(-r * T);
    const payoff = isCall ? Math.max(0, fwd - K) : Math.max(0, K - fwd);
    return disc * payoff;
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const Nd1 = normCdf(isCall ? d1 : -d1);
  const Nd2 = normCdf(isCall ? d2 : -d2);

  const discQ = Math.exp(-q * T);
  const discR = Math.exp(-r * T);

  if (isCall) {
    return S * discQ * normCdf(d1) - K * discR * normCdf(d2);
  } else {
    return K * discR * normCdf(-d2) - S * discQ * normCdf(-d1);
  }
}

async function safeFetchJson(url) {
  const r = await fetch(url);
  const text = await r.text();

  if (!r.ok) {
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
  }
}

function contractLabel(c) {
  // e.g. 2027-01-19 200C IV=0.23 bid/ask
  const exp = c?.expiration ? new Date(c.expiration * 1000) : null;
  const expStr = exp ? exp.toISOString().slice(0, 10) : "????-??-??";
  const k = c?.strike ?? "-";
  const iv = c?.impliedVolatility ?? null;
  const bid = c?.bid ?? null;
  const ask = c?.ask ?? null;
  return `${expStr}  K=${k}  IV=${iv !== null ? fmt(iv, 4) : "-"}  bid=${bid !== null ? fmt2(bid) : "-"} ask=${ask !== null ? fmt2(ask) : "-"}`;
}

export default function LeapsPage() {
  const [ticker, setTicker] = useState("AAPL");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const [chain, setChain] = useState(null); // {ticker, quote, expirations, selectedExpiration, calls, puts}
  const [side, setSide] = useState("call"); // call|put
  const [selectedSymbol, setSelectedSymbol] = useState("");

  // scenario inputs
  const [scenarioDateStr, setScenarioDateStr] = useState(() => {
    // default: tomorrow in local time -> formatted YYYY-MM-DD
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  });
  const [scenarioS, setScenarioS] = useState("200");
  const [r, setR] = useState("0.05");
  const [q, setQ] = useState("0.00");
  const [ivShift, setIvShift] = useState("0.00");
  const [premiumPaid, setPremiumPaid] = useState("");

  const contracts = useMemo(() => {
    if (!chain) return [];
    return side === "call" ? chain.calls || [] : chain.puts || [];
  }, [chain, side]);

  const selectedContract = useMemo(() => {
    if (!contracts?.length || !selectedSymbol) return null;
    return contracts.find((c) => c.contractSymbol === selectedSymbol) || null;
  }, [contracts, selectedSymbol]);

  const quotePrice = chain?.quote?.regularMarketPrice ?? null;

  const computed = useMemo(() => {
    if (!selectedContract) return { ok: false, reason: "契約を選択してください。" };

    const K = Number(selectedContract.strike);
    const iv0 = Number(selectedContract.impliedVolatility);
    if (!(K > 0)) return { ok: false, reason: "Strikeが不正です。" };
    if (!(iv0 >= 0)) return { ok: false, reason: "IVが不正です。" };

    const scenDt = parseYYYYMMDD(scenarioDateStr);
    if (!scenDt) return { ok: false, reason: "Scenario date は YYYY-MM-DD で入力してください。" };

    const exp = selectedContract.expiration ? new Date(selectedContract.expiration * 1000) : null;
    if (!exp) return { ok: false, reason: "Expirationが不正です。" };

    // Convert exp to UTC midnight (roughly)
    const expUTC = new Date(Date.UTC(exp.getUTCFullYear(), exp.getUTCMonth(), exp.getUTCDate(), 0, 0, 0));
    const tDays = daysBetweenUTC(scenDt, expUTC);
    const T = tDays / 365.0;

    const S = Number(scenarioS);
    const rr = Number(r);
    const qq = Number(q);
    const shift = Number(ivShift);

    if (!(S > 0)) return { ok: false, reason: "Scenario underlying price S が不正です。" };
    if (!Number.isFinite(rr) || !Number.isFinite(qq) || !Number.isFinite(shift))
      return { ok: false, reason: "r/q/IV shift が不正です。" };

    const sigma = Math.max(0, iv0 + shift);

    const isCall = side === "call";
    const theo = bsPrice({ S, K, T, r: rr, q: qq, sigma, isCall });

    if (theo === null) return { ok: false, reason: "計算に失敗しました。" };

    const paid = premiumPaid === "" ? null : Number(premiumPaid);
    const pnl = paid !== null && Number.isFinite(paid) ? theo - paid : null;

    return {
      ok: true,
      K,
      iv0,
      sigma,
      expStr: expUTC.toISOString().slice(0, 10),
      tDays,
      T,
      theo,
      paid,
      pnl,
    };
  }, [selectedContract, scenarioDateStr, scenarioS, r, q, ivShift, premiumPaid, side]);

  async function onLoadChain() {
    setErr("");
    setLoading(true);
    setChain(null);
    setSelectedSymbol("");

    try {
      const t = String(ticker || "").trim().toUpperCase();
      if (!t) throw new Error("Tickerを入力してください。");

      const data = await safeFetchJson(`/api/options-chain?ticker=${encodeURIComponent(t)}`);
      if (!data.ok) throw new Error(data.error || "API returned ok:false");

      setChain(data);

      // set default scenario S from quote
      if (data?.quote?.regularMarketPrice) {
        setScenarioS(String(data.quote.regularMarketPrice));
      }

      // default select a near-the-money contract
      const list = (data.calls || []);
      if (list.length && data?.quote?.regularMarketPrice) {
        const s0 = data.quote.regularMarketPrice;
        const sorted = [...list].sort((a, b) => Math.abs(a.strike - s0) - Math.abs(b.strike - s0));
        setSide("call");
        setSelectedSymbol(sorted[0]?.contractSymbol || "");
      }
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  // when side changes, clear selection (or keep if exists)
  useEffect(() => {
    if (!chain) return;
    const list = side === "call" ? chain.calls : chain.puts;
    if (!list?.length) {
      setSelectedSymbol("");
      return;
    }
    // if current symbol not in list, choose first
    if (!selectedSymbol || !list.some((c) => c.contractSymbol === selectedSymbol)) {
      setSelectedSymbol(list[0].contractSymbol);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, chain]);

  return (
    <div style={{ maxWidth: 1100, margin: "40px auto", padding: "0 16px", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial" }}>
      <h1 style={{ fontSize: 42, margin: 0 }}>LEAPS Scenario Pricer</h1>
      <p style={{ marginTop: 8, color: "#444", lineHeight: 1.6 }}>
        「もし <b>YYYY-MM-DD</b> に原資産が <b>S</b> だったら、残存期間でのオプション理論価格はいくら？」を出します。
        チェーンはYahoo Financeから取得、価格はBlack-Scholes（近似）です。
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginTop: 22 }}>
        {/* 1) Load */}
        <div style={{ border: "1px solid #ddd", borderRadius: 14, padding: 18 }}>
          <h2 style={{ marginTop: 0 }}>1) Load option chain</h2>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div style={{ width: 90, color: "#333" }}>Ticker</div>
            <input
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid #bbb", fontSize: 16 }}
              placeholder="AAPL"
            />
            <button
              onClick={onLoadChain}
              disabled={loading}
              style={{
                padding: "10px 16px",
                borderRadius: 12,
                border: "1px solid #111",
                background: loading ? "#333" : "#111",
                color: "white",
                fontSize: 16,
                cursor: loading ? "not-allowed" : "pointer",
              }}
            >
              {loading ? "Loading..." : "Load"}
            </button>
          </div>

          <div style={{ marginTop: 14, fontSize: 14, color: "#555" }}>
            Loadを押すとオプションチェーンを取得します。
          </div>

          {err ? (
            <div style={{ marginTop: 14, color: "#b00020", fontWeight: 600, whiteSpace: "pre-wrap" }}>
              {err}
            </div>
          ) : null}

          {chain ? (
            <div style={{ marginTop: 14, fontSize: 14, color: "#333" }}>
              <div><b>{chain.ticker}</b>  spot={quotePrice !== null ? fmt2(quotePrice) : "-"} {chain?.quote?.currency ? `(${chain.quote.currency})` : ""}</div>
              <div style={{ marginTop: 6, color: "#666" }}>expirations: {chain.expirations?.length || 0}</div>
            </div>
          ) : null}
        </div>

        {/* 2) Pick */}
        <div style={{ border: "1px solid #ddd", borderRadius: 14, padding: 18 }}>
          <h2 style={{ marginTop: 0 }}>2) Pick a contract</h2>

          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 10, alignItems: "center" }}>
            <div style={{ color: "#333" }}>Side</div>
            <select
              value={side}
              onChange={(e) => setSide(e.target.value)}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #bbb", fontSize: 16 }}
              disabled={!chain}
            >
              <option value="call">Call</option>
              <option value="put">Put</option>
            </select>

            <div style={{ color: "#333" }}>Contract</div>
            <select
              value={selectedSymbol}
              onChange={(e) => setSelectedSymbol(e.target.value)}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #bbb", fontSize: 16 }}
              disabled={!chain || !contracts.length}
            >
              {!chain ? <option value="">-- load first --</option> : null}
              {chain && !contracts.length ? <option value="">(no contracts)</option> : null}
              {contracts.map((c) => (
                <option key={c.contractSymbol} value={c.contractSymbol}>
                  {contractLabel(c)}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginTop: 14, fontSize: 14, color: "#555" }}>
            契約を選ぶと詳細が出ます。
          </div>

          {selectedContract ? (
            <div style={{ marginTop: 12, fontSize: 14, color: "#333", lineHeight: 1.7 }}>
              <div><b>{selectedContract.contractSymbol}</b></div>
              <div>Strike: {fmt2(selectedContract.strike)} / IV: {fmt(selectedContract.impliedVolatility, 4)}</div>
              <div>Bid/Ask: {fmt2(selectedContract.bid)} / {fmt2(selectedContract.ask)} / Last: {fmt2(selectedContract.lastPrice)}</div>
              <div>OI: {selectedContract.openInterest ?? "-"} / Vol: {selectedContract.volume ?? "-"}</div>
            </div>
          ) : null}
        </div>

        {/* 3) Inputs */}
        <div style={{ border: "1px solid #ddd", borderRadius: 14, padding: 18 }}>
          <h2 style={{ marginTop: 0 }}>3) Scenario inputs</h2>

          <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 10, alignItems: "center" }}>
            <div>Scenario date (YYYY-MM-DD)</div>
            <input
              value={scenarioDateStr}
              onChange={(e) => setScenarioDateStr(e.target.value)}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #bbb", fontSize: 16 }}
              placeholder="2026-01-20"
            />

            <div>Scenario underlying price S</div>
            <input
              value={scenarioS}
              onChange={(e) => setScenarioS(e.target.value)}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #bbb", fontSize: 16 }}
              placeholder="200"
            />

            <div>Risk-free rate r</div>
            <input
              value={r}
              onChange={(e) => setR(e.target.value)}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #bbb", fontSize: 16 }}
              placeholder="0.05"
            />

            <div>Dividend yield q</div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #bbb", fontSize: 16 }}
              placeholder="0.00"
            />

            <div>IV shift (add, e.g., +0.05)</div>
            <input
              value={ivShift}
              onChange={(e) => setIvShift(e.target.value)}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #bbb", fontSize: 16 }}
              placeholder="0.00"
            />

            <div>Premium paid (optional, per share)</div>
            <input
              value={premiumPaid}
              onChange={(e) => setPremiumPaid(e.target.value)}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #bbb", fontSize: 16 }}
              placeholder="e.g., 8.50"
            />
          </div>

          <div style={{ marginTop: 12, fontSize: 13, color: "#666" }}>
            ※ IVは「現在のIV + シフト」で固定。将来IVを仮定したい場合はここを触ります。
          </div>
        </div>

        {/* 4) Result */}
        <div style={{ border: "1px solid #ddd", borderRadius: 14, padding: 18 }}>
          <h2 style={{ marginTop: 0 }}>4) Result</h2>

          {!computed.ok ? (
            <div style={{ marginTop: 8, color: "#555" }}>{computed.reason}</div>
          ) : (
            <div style={{ marginTop: 8, lineHeight: 1.8 }}>
              <div><b>Theoretical price (per share):</b> {fmt2(computed.theo)}</div>
              <div>Strike K: {fmt2(computed.K)}</div>
              <div>Expiration: {computed.expStr}</div>
              <div>Days to exp (from scenario date): {fmt2(computed.tDays)}</div>
              <div>T (years, 365d): {fmt(computed.T, 6)}</div>
              <div>IV now: {fmt(computed.iv0, 4)} → IV used: {fmt(computed.sigma, 4)}</div>
              {computed.paid !== null ? (
                <div><b>PnL vs paid:</b> {fmt2(computed.pnl)}</div>
              ) : (
                <div style={{ color: "#666" }}>（Premium paid を入れるとPnLも出します）</div>
              )}
            </div>
          )}

          <div style={{ marginTop: 14, fontSize: 12, color: "#777" }}>
            注意：これは教育・分析目的であり、投資助言ではありません。Black-Scholesは近似であり、配当・金利・ボラ・早期行使等を完全には反映しません。
          </div>
        </div>
      </div>
    </div>
  );
}

