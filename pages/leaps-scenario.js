// web/pages/leaps-scenario.js

import React, { useEffect, useMemo, useRef, useState } from "react";

function toMs(epochLike) {
  const n = Number(epochLike);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function formatYMD(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseYMDToMs(ymd) {
  if (!ymd) return null;
  const [y, m, d] = String(ymd).split("-").map((x) => Number(x));
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  const t = dt.getTime();
  return Number.isNaN(t) ? null : t;
}

function clampNumber(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

// --- Normal CDF (approx) ---
function normCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const absX = Math.abs(x) / Math.sqrt(2.0);
  const t = 1.0 / (1.0 + p * absX);
  const y =
    1.0 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-absX * absX);

  return 0.5 * (1.0 + sign * y);
}

function bsPrice({ S, K, r, q, sigma, T, isCall }) {
  if (!(S > 0) || !(K > 0) || !(sigma > 0) || !(T > 0)) return null;

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const dfR = Math.exp(-r * T);
  const dfQ = Math.exp(-q * T);

  if (isCall) return S * dfQ * normCdf(d1) - K * dfR * normCdf(d2);
  return K * dfR * normCdf(-d2) - S * dfQ * normCdf(-d1);
}

function friendlyError(msg) {
  const s = String(msg || "");
  if (/Invalid Crumb|Unauthorized|crumb/i.test(s)) {
    return "Yahoo側で一時ブロック/レート制限（401/crumb）が発生しました。少し待って再試行してください。";
  }
  if (/Too Many Requests|429/i.test(s)) {
    return "Yahoo側でレート制限（429）が発生しました。少し待って再試行してください。";
  }
  if (/Call `const yahooFinance = new YahooFinance\(\)` first/i.test(s)) {
    return "サーバ側のyahoo-finance2初期化が必要です（APIファイルを更新してください）。";
  }
  return s || "fetch failed";
}

export default function LeapsScenario() {
  const [ticker, setTicker] = useState("AAPL");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const [data, setData] = useState(null);
  const [expiryMs, setExpiryMs] = useState(null);

  const [side, setSide] = useState("call");
  const [contractSymbol, setContractSymbol] = useState("");

  const [scenarioDate, setScenarioDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return formatYMD(d.getTime());
  });
  const [scenarioS, setScenarioS] = useState("200");
  const [r, setR] = useState("0.05");
  const [q, setQ] = useState("0");
  const [ivShift, setIvShift] = useState("0");
  const [premiumPaid, setPremiumPaid] = useState("");

  // 競合防止：最後に投げたリクエスト以外は捨てる
  const lastReqIdRef = useRef(0);

  // Expiry変更デバウンス（連打で401にならないため）
  const expiryDebounceRef = useRef(null);

  async function fetchChain({ tkr, expiry }) {
    const reqId = ++lastReqIdRef.current;
    setErr("");
    setLoading(true);

    try {
      const t = String(tkr || "").trim().toUpperCase();
      if (!t) throw new Error("Ticker is required");

      const params = new URLSearchParams({ ticker: t });
      if (expiry) params.set("expiry", formatYMD(toMs(expiry)));

      const res = await fetch(`/api/options-chain?${params.toString()}`);
      const j = await res.json();

      if (reqId !== lastReqIdRef.current) return; // 古いレスは捨てる
      if (!j?.ok) throw new Error(j?.error || "options-chain failed");

      const expirations = Array.isArray(j.expirations) ? j.expirations.map(toMs).filter(Boolean) : [];
      const picked = toMs(j.expiry);

      const normalized = {
        ...j,
        expirations,
        expiry: picked,
        chain: {
          calls: Array.isArray(j?.chain?.calls) ? j.chain.calls : [],
          puts: Array.isArray(j?.chain?.puts) ? j.chain.puts : [],
        },
      };

      setData(normalized);
      setExpiryMs(picked || (expirations.length ? expirations[0] : null));
      setContractSymbol(""); // 満期が変わるたびに選択はリセット（安全）
    } catch (e) {
      setData(null);
      setExpiryMs(null);
      setContractSymbol("");
      setErr(friendlyError(e?.message || e));
    } finally {
      if (reqId === lastReqIdRef.current) setLoading(false);
    }
  }

  async function loadChain() {
    // Load ボタンだけが「初回の入口」になるよう統一
    return fetchChain({ tkr: ticker, expiry: null });
  }

  // Expiry変更時：即fetchせず、デバウンスしてから取りに行く
  useEffect(() => {
    if (!data) return;
    const ex = toMs(expiryMs);
    if (!ex) return;

    // 初回ロード直後の setExpiryMs で余計に2回目のfetchを撃たない
    if (toMs(data?.expiry) === ex) return;

    if (expiryDebounceRef.current) clearTimeout(expiryDebounceRef.current);
    expiryDebounceRef.current = setTimeout(() => {
      fetchChain({ tkr: ticker, expiry: ex });
    }, 350); // 350ms debounce

    return () => {
      if (expiryDebounceRef.current) clearTimeout(expiryDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiryMs]);

  const underlying = data?.underlying || null;

  const contracts = useMemo(() => {
    const arr = side === "put" ? data?.chain?.puts : data?.chain?.calls;
    return Array.isArray(arr) ? arr : [];
  }, [data, side]);

  const selected = useMemo(() => {
    if (!contractSymbol) return null;
    if (!Array.isArray(contracts) || contracts.length === 0) return null;
    return contracts.find((c) => c?.contractSymbol === contractSymbol) || null;
  }, [contracts, contractSymbol]);

  const scenarioMs = useMemo(() => parseYMDToMs(scenarioDate), [scenarioDate]);

  const daysToExpiry = useMemo(() => {
    const ex = toMs(expiryMs);
    const sc = scenarioMs;
    if (!ex || !sc) return null;
    const diffDays = (ex - sc) / (24 * 3600 * 1000);
    return Number.isFinite(diffDays) ? diffDays : null;
  }, [expiryMs, scenarioMs]);

  const T = useMemo(() => {
    if (daysToExpiry == null) return null;
    return daysToExpiry / 365.0;
  }, [daysToExpiry]);

  const theo = useMemo(() => {
    if (!selected) return null;

    const S = clampNumber(scenarioS, NaN);
    const K = clampNumber(selected.strike, NaN);
    const rr = clampNumber(r, NaN);
    const qq = clampNumber(q, 0);
    const shift = clampNumber(ivShift, 0);

    const baseIv = clampNumber(selected.impliedVolatility, NaN);
    const sigmaRaw = baseIv + shift;

    // 極小IVはYahoo側の欠損/丸めが多いので、ここでは “価格計算しない” 方が公開用として安全
    const sigma = sigmaRaw > 0.0005 ? sigmaRaw : NaN;

    const t = T;
    if (!(t > 0)) return null;

    const price = bsPrice({
      S,
      K,
      r: rr,
      q: qq,
      sigma,
      T: t,
      isCall: side !== "put",
    });

    return Number.isFinite(price) ? price : null;
  }, [selected, scenarioS, r, q, ivShift, T, side]);

  // ---- styles ----
  const container = {
    maxWidth: 1200,
    margin: "30px auto",
    padding: "0 16px",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
  };
  const h1 = { fontSize: 56, margin: "0 0 8px 0", letterSpacing: "-0.02em" };
  const desc = { color: "#333", lineHeight: 1.7, marginBottom: 22 };
  const grid = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 };
  const card = { background: "#fff", border: "1px solid #e6e6e6", borderRadius: 18, padding: 18 };
  const title = { fontWeight: 800, fontSize: 18, marginBottom: 12 };
  const row3 = { display: "grid", gridTemplateColumns: "160px 1fr auto", gap: 12, alignItems: "center", marginBottom: 12 };
  const row2 = { display: "grid", gridTemplateColumns: "160px 1fr", gap: 12, alignItems: "center", marginBottom: 12 };
  const label = { color: "#111", fontWeight: 700 };
  const input = { width: "100%", padding: "10px 12px", borderRadius: 12, border: "1px solid #d8d8d8", fontSize: 16 };
  const btn = { padding: "10px 16px", borderRadius: 12, border: "0", background: "#111", color: "#fff", fontWeight: 800, cursor: "pointer" };
  const small = { color: "#666", fontSize: 13, lineHeight: 1.5 };
  const pillErr = { background: "#ffe9e9", border: "1px solid #ffb2b2", color: "#b10000", padding: "8px 12px", borderRadius: 999, fontSize: 13, fontWeight: 700, maxWidth: 560, textAlign: "right" };
  const box = { background: "#f7f7f7", border: "1px solid #ececec", borderRadius: 14, padding: 14, marginTop: 10 };

  return (
    <div style={container}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <h1 style={h1}>LEAPS Scenario Pricer</h1>
          <div style={desc}>
            「もし <b>YYYY-MM-DD</b> に原資産が <b>S</b> だったら、残存期間Tでのオプション理論価格はいくら？」を計算します。<br />
            チェーンは <b>Yahoo Finance</b>、価格は <b>Black-Scholes（近似）</b> です。
          </div>
        </div>
        {err ? <div style={pillErr}>{err}</div> : null}
      </div>

      <div style={grid}>
        <div style={card}>
          <div style={title}>1) Load option chain</div>

          <div style={row3}>
            <div style={label}>Ticker</div>
            <input style={input} value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="e.g. AAPL" />
            <button style={btn} onClick={loadChain} disabled={loading}>
              {loading ? "Loading..." : "Load"}
            </button>
          </div>

          <div style={row2}>
            <div style={label}>Expiry</div>
            <select
              style={input}
              value={expiryMs || ""}
              onChange={(e) => setExpiryMs(toMs(e.target.value))}
              disabled={!data || loading}
            >
              {!data?.expirations?.length ? (
                <option value="">(Load first)</option>
              ) : (
                data.expirations.map((ms) => (
                  <option key={ms} value={ms}>
                    {formatYMD(ms)}
                  </option>
                ))
              )}
            </select>
          </div>

          <div style={small}>
            ※ Expiryを変えると、その満期のチェーンをAPIに取りに行って差し替えます（デバウンス＋APIキャッシュで401を抑制）。
          </div>

          {underlying ? (
            <div style={box}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>
                {underlying.symbol} — {underlying.shortName}
              </div>
              <div style={{ color: "#333" }}>
                Spot: <b>{underlying.regularMarketPrice}</b> {underlying.currency}{" "}
                <span style={{ color: "#777" }}>（as of Yahoo quote）</span>
              </div>
              <div style={{ color: "#777", marginTop: 6 }}>
                Selected expiry: <b>{expiryMs ? formatYMD(expiryMs) : "-"}</b>
              </div>
            </div>
          ) : null}
        </div>

        <div style={card}>
          <div style={title}>2) Pick a contract</div>

          <div style={row2}>
            <div style={label}>Side</div>
            <select
              style={input}
              value={side}
              onChange={(e) => {
                setSide(e.target.value);
                setContractSymbol("");
              }}
              disabled={!data || loading}
            >
              <option value="call">Call</option>
              <option value="put">Put</option>
            </select>
          </div>

          <div style={row2}>
            <div style={label}>Contract</div>
            <select
              style={input}
              value={contractSymbol}
              onChange={(e) => setContractSymbol(e.target.value)}
              disabled={!data || loading || contracts.length === 0}
            >
              <option value="">{data ? "-- select --" : "(Load first)"}</option>
              {contracts.map((c) => (
                <option key={c.contractSymbol} value={c.contractSymbol}>
                  {c.contractSymbol} | K={c.strike} | IV={Number(c.impliedVolatility || 0).toFixed(4)}
                </option>
              ))}
            </select>
          </div>

          {selected ? (
            <div style={box}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>{selected.contractSymbol}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <div>Strike: <b>{selected.strike}</b></div>
                <div>IV: <b>{selected.impliedVolatility}</b></div>
                <div>Last: <b>{selected.lastPrice}</b></div>
                <div>Bid: <b>{selected.bid}</b></div>
                <div>Ask: <b>{selected.ask}</b></div>
                <div>OI: <b>{selected.openInterest}</b></div>
              </div>
            </div>
          ) : (
            <div style={small}>チェーン取得後に Contract を選んでください。</div>
          )}
        </div>

        <div style={card}>
          <div style={title}>3) Scenario inputs</div>

          <div style={{ ...row2, gridTemplateColumns: "220px 1fr" }}>
            <div style={label}>Scenario date</div>
            <input type="date" style={input} value={scenarioDate} onChange={(e) => setScenarioDate(e.target.value)} />
          </div>

          <div style={{ ...row2, gridTemplateColumns: "220px 1fr" }}>
            <div style={label}>Underlying price (S)</div>
            <input style={input} value={scenarioS} onChange={(e) => setScenarioS(e.target.value)} />
          </div>

          <div style={{ ...row2, gridTemplateColumns: "220px 1fr" }}>
            <div style={label}>Risk-free rate (r)</div>
            <input style={input} value={r} onChange={(e) => setR(e.target.value)} />
          </div>

          <div style={{ ...row2, gridTemplateColumns: "220px 1fr" }}>
            <div style={label}>Dividend yield (q)</div>
            <input style={input} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>

          <div style={{ ...row2, gridTemplateColumns: "220px 1fr" }}>
            <div style={label}>IV shift</div>
            <input style={input} value={ivShift} onChange={(e) => setIvShift(e.target.value)} />
          </div>

          <div style={{ ...row2, gridTemplateColumns: "220px 1fr" }}>
            <div style={label}>Premium paid (opt)</div>
            <input style={input} value={premiumPaid} onChange={(e) => setPremiumPaid(e.target.value)} placeholder="e.g. 8.50" />
          </div>

          <div style={small}>※ 残存期間は「満期 - Scenario date」を 365日ベースで年換算します。</div>
        </div>

        <div style={card}>
          <div style={title}>4) Result</div>

          {!selected ? (
            <div style={small}>Contract を選ぶと結果が表示されます。</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div style={box}>
                <div style={{ fontWeight: 900, color: "#777", marginBottom: 8 }}>SCENARIO</div>
                <div>Date: <b>{scenarioDate || "-"}</b></div>
                <div>S: <b>{scenarioS}</b></div>
                <div>Days to expiry (from scenario): <b>{daysToExpiry == null ? "-" : daysToExpiry.toFixed(2)}</b></div>
                <div>T (years): <b>{T == null ? "-" : T.toFixed(6)}</b></div>
                <div style={{ marginTop: 8, color: "#777" }}>
                  Expiry: <b>{expiryMs ? formatYMD(expiryMs) : "-"}</b>
                </div>
              </div>

              <div style={box}>
                <div style={{ fontWeight: 900, color: "#777", marginBottom: 8 }}>PRICED BY BLACK-SCHOLES</div>
                <div>Theo price: <b>{theo == null ? "-" : theo.toFixed(4)}</b></div>
                <div>Strike K: <b>{selected.strike}</b></div>
                <div>
                  IV used:{" "}
                  <b>
                    {(() => {
                      const base = clampNumber(selected.impliedVolatility, NaN);
                      const shift = clampNumber(ivShift, 0);
                      const s = base + shift;
                      return Number.isFinite(s) ? s : "-";
                    })()}
                  </b>
                </div>
                <div>r / q: <b>{r} / {q}</b></div>

                {premiumPaid ? (
                  <div style={{ marginTop: 10 }}>
                    P/L (per share): <b>{theo == null ? "-" : (theo - clampNumber(premiumPaid, 0)).toFixed(4)}</b>
                  </div>
                ) : null}

                <div style={{ marginTop: 10, color: "#777" }}>
                  ※ IVが極小（ほぼ0）の場合は理論値が出ないことがあります（Yahoo側の欠損/丸めが多いため）。
                </div>
              </div>

              <div style={{ ...box, gridColumn: "1 / -1" }}>
                <div style={{ fontWeight: 900, color: "#777", marginBottom: 8 }}>CONTRACT</div>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
                  <div>Symbol: <b>{selected.contractSymbol}</b></div>
                  <div>ITM: <b>{String(!!selected.inTheMoney)}</b></div>
                  <div>Last / Bid / Ask: <b>{selected.lastPrice} / {selected.bid} / {selected.ask}</b></div>
                  <div>OI: <b>{selected.openInterest}</b></div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

