import { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

/* ====== 数値計算ロジック ====== */

function round(x, digits = 2) {
  if (x === undefined || !Number.isFinite(x)) return x;
  const m = 10 ** digits;
  return Math.round(x * m) / m;
}

function stddev(arr) {
  const n = arr.length;
  if (n < 2) return undefined;
  const mean = arr.reduce((s, x) => s + x, 0) / n;
  const varSum = arr.reduce((s, x) => s + (x - mean) ** 2, 0);
  return Math.sqrt(varSum / (n - 1));
}

function worstNAvg(returns, n) {
  if (returns.length < n) return undefined;
  const a = [...returns].sort((x, y) => x - y);
  const worst = a.slice(0, n);
  return worst.reduce((s, x) => s + x, 0) / n;
}

function quantile(arr, q) {
  if (!arr.length) return undefined;
  const a = [...arr].sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return a[base + 1] === undefined
    ? a[base]
    : a[base] + rest * (a[base + 1] - a[base]);
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function analyze(points) {
  if (!points || points.length < 2) throw new Error("Not enough points");

  const closes = points.map((p) => p.close);

  // returns[i] corresponds to points[i] date (i>=1)
  const returns = [];
  const retSeries = []; // {date, r}
  for (let i = 1; i < closes.length; i++) {
    const r = closes[i] / closes[i - 1] - 1;
    returns.push(r);
    retSeries.push({ date: points[i].date, r });
  }

  // equity (starts at 1)
  const equity = [1];
  for (let i = 0; i < returns.length; i++) {
    equity.push(equity[i] * (1 + returns[i]));
  }

  // drawdown + durations
  let peak = equity[0];
  let maxDD = 0; // <=0
  let ddDuration = 0;
  let maxDdDuration = 0;

  const drawdown = equity.map((e) => {
    if (e >= peak) {
      peak = e;
      ddDuration = 0;
    } else {
      ddDuration += 1;
      maxDdDuration = Math.max(maxDdDuration, ddDuration);
    }
    const dd = e / peak - 1;
    maxDD = Math.min(maxDD, dd);
    return dd;
  });

  // max losing streak
  let curLose = 0;
  let maxLose = 0;
  for (const r of returns) {
    if (r < 0) {
      curLose += 1;
      maxLose = Math.max(maxLose, curLose);
    } else {
      curLose = 0;
    }
  }

  // vol + tail proxies
  const dailyVol = stddev(returns);
  const worst10Avg = worstNAvg(returns, 10);
  const worstYear = returns.length >= 252 ? quantile(returns, 1 / 252) : undefined;

  // charts (丸めて格納：見た目もtooltipも安定)
  const chart = points.map((p, i) => ({
    date: p.date,
    equity: round(equity[i], 4),            // 例: 1.2345
    drawdown: round(drawdown[i] * 100, 2),  // 例: -12.34 (%)
  }));

  // worst days list (top 10 worst daily returns)
  const worstDays = [...retSeries]
    .sort((a, b) => a.r - b.r) // worst first
    .slice(0, Math.min(10, retSeries.length))
    .map((x, idx) => ({
      rank: idx + 1,
      date: x.date,
      retPct: round(x.r * 100, 2),
    }));

  // === Pain Score (Sigmora-style heuristic, 0-100) ===
  // 深さ(MaxDD)・長さ(DD期間)・揺れ(日次ボラ)を、基準値で0-1に正規化して合成
  // - depth : |MaxDD| / 0.60（60%DDを最大級の基準）
  // - length: MaxDDDuration / 252（約1年を長い痛みの基準）
  // - jitter: DailyVol / 0.03（3%日次ボラを激しい揺れの基準）
  const depth = clamp(Math.abs(maxDD) / 0.60, 0, 1);
  const length = clamp(maxDdDuration / 252, 0, 1);
  const jitter = dailyVol === undefined ? 0 : clamp(dailyVol / 0.03, 0, 1);

  // weights: depth 55%, length 30%, jitter 15%
  const painScore = Math.round(100 * (0.55 * depth + 0.30 * length + 0.15 * jitter));

  // 画面に説明を出すための内訳も返す（丸め）
  const painBreakdown = {
    depth: round(depth, 3),
    length: round(length, 3),
    jitter: round(jitter, 3),
  };

  return {
    maxDD,
    maxDdDuration,
    maxLose,
    dailyVol,
    worst10Avg,
    worstYear,
    chart,
    worstDays,
    painScore,
    painBreakdown,
  };
}

/* ====== UI helpers ====== */

function fmtPct(x) {
  if (x === undefined || !Number.isFinite(x)) return "N/A";
  return (x * 100).toFixed(2) + "%";
}

function fmtNum(x, digits = 2) {
  if (x === undefined || !Number.isFinite(x)) return "N/A";
  return Number(x).toFixed(digits);
}

function Card({ title, value, subtitle }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
      <div style={{ color: "#666", fontSize: 13, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 22, fontWeight: 650, wordBreak: "break-word" }}>
        {value}
      </div>
      {subtitle ? (
        <div style={{ color: "#888", fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}

function Badge({ text }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 8px",
        borderRadius: 999,
        border: "1px solid #ddd",
        fontSize: 12,
        color: "#555",
      }}
    >
      {text}
    </span>
  );
}

/* ====== URL helpers ====== */

function getParamsFromURL() {
  if (typeof window === "undefined") return null;
  const sp = new URLSearchParams(window.location.search);
  const t = sp.get("ticker");
  const p = sp.get("period");
  const ticker = t ? String(t).toUpperCase().trim() : null;
  const period = p ? String(p).toUpperCase().trim() : null;
  return { ticker, period };
}

function setParamsToURL(ticker, period) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("ticker", ticker);
  url.searchParams.set("period", period);
  window.history.replaceState({}, "", url.toString());
}

export default function Home() {
  const [ticker, setTicker] = useState("GLD");
  const [period, setPeriod] = useState("5Y");
  const [points, setPoints] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [showWorst, setShowWorst] = useState(true);
  const [autoRan, setAutoRan] = useState(false);

  // SSRで window を触らないように share URL を state に持つ
  const [shareUrl, setShareUrl] = useState("");

  const result = useMemo(() => {
    if (!points.length) return null;
    return analyze(points);
  }, [points]);

  async function onAnalyze(nextTicker, nextPeriod, { updateURL = true } = {}) {
    const t = (nextTicker ?? ticker).toUpperCase().trim();
    const p = (nextPeriod ?? period).toUpperCase().trim();

    setErr("");
    setLoading(true);
    try {
      if (updateURL) setParamsToURL(t, p);

      const r = await fetch(
        `/api/prices?symbol=${encodeURIComponent(t)}&period=${encodeURIComponent(p)}`
      );
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "API error");
      setPoints(j.points);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  // 初回：URLパラメータがあればそれで自動分析
  useEffect(() => {
    if (autoRan) return;
    const params = getParamsFromURL();
    if (!params) return;

    const nextT = params.ticker || "GLD";
    const nextP = params.period || "5Y";

    setTicker(nextT);
    setPeriod(nextP);
    setAutoRan(true);

    onAnalyze(nextT, nextP, { updateURL: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRan]);

  // share URL を更新（クライアントでのみ）
  useEffect(() => {
    if (typeof window === "undefined") return;
    const origin = window.location.origin;
    const path = `/?ticker=${encodeURIComponent(
      ticker.toUpperCase().trim()
    )}&period=${encodeURIComponent(period.toUpperCase().trim())}`;
    setShareUrl(origin + path);
  }, [ticker, period]);

  return (
    <div
      style={{
        maxWidth: 1000,
        margin: "40px auto",
        padding: 16,
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto",
      }}
    >
      <h1 style={{ marginBottom: 6 }}>Return Risk Analyzer (MVP)</h1>
      <div style={{ color: "#666", marginBottom: 18 }}>
        予測なし・推奨なし。過去データから「痛み」と「揺れ」を可視化。
      </div>

      <div
        style={{
          display: "flex",
          gap: 12,
          marginBottom: 14,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value)}
          placeholder="Ticker (e.g., GLD)"
          style={{
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid #ddd",
            width: 180,
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onAnalyze();
          }}
        />

        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd" }}
        >
          <option value="1Y">1Y</option>
          <option value="3Y">3Y</option>
          <option value="5Y">5Y</option>
          <option value="MAX">MAX</option>
        </select>

        <button
          onClick={() => onAnalyze()}
          disabled={loading}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #111",
            background: "#111",
            color: "white",
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? "Loading..." : "Analyze"}
        </button>

        <div style={{ marginLeft: 8, display: "flex", gap: 8, alignItems: "center" }}>
          <Badge text="Yahoo Finance" />
          <Badge text="Cached API" />
          <Badge text="Sharable URL" />
        </div>
      </div>

      <div style={{ color: "#888", fontSize: 12, marginBottom: 14, lineHeight: 1.6 }}>
        共有：URL に <code>?ticker=GLD&amp;period=5Y</code> を付けると、その条件で自動分析します。
        <br />
        ※グラフの数値は「見やすさ優先」で四捨五入しています（Equity: 小数4桁、DD%: 小数2桁）。
      </div>

      {err ? <div style={{ color: "crimson", marginBottom: 10 }}>{err}</div> : null}

      {result && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 12,
              marginBottom: 18,
            }}
          >
            <Card
              title="Pain Score"
              value={`${result.painScore}/100`}
              subtitle={
                "過去の「痛み」の要約（将来予測ではない）。\n" +
                "深さ=|MaxDD|/0.60、長さ=DD期間/252、揺れ=日次ボラ/0.03 を 0-1 に正規化して合成。\n" +
                `内訳: depth=${fmtNum(result.painBreakdown.depth, 3)}, length=${fmtNum(
                  result.painBreakdown.length,
                  3
                )}, jitter=${fmtNum(result.painBreakdown.jitter, 3)}`
              }
            />
            <Card title="Max Drawdown" value={fmtPct(result.maxDD)} />
            <Card title="Max DD Duration" value={`${result.maxDdDuration} days`} />
            <Card title="Max Losing Streak" value={`${result.maxLose} days`} />
            <Card title="Daily Volatility" value={fmtPct(result.dailyVol)} />
            <Card title="Worst 10 Days Avg" value={fmtPct(result.worst10Avg)} />
            <Card title="Year-level Worst Loss" value={fmtPct(result.worstYear)} subtitle="データが少ないとN/A" />
            <Card title="Share this URL" value={shareUrl || "Loading..."} subtitle="同じ分析条件を再現" />
            <Card title="Worst days list" value={showWorst ? "ON" : "OFF"} subtitle="トグルで表示切替" />
          </div>

          <h3 style={{ marginTop: 6 }}>Equity Curve</h3>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={result.chart}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" hide />
              <YAxis tickFormatter={(v) => Number(v).toFixed(4)} />
              <Tooltip formatter={(v) => Number(v).toFixed(4)} />
              <Line type="monotone" dataKey="equity" dot={false} />
            </LineChart>
          </ResponsiveContainer>

          <h3 style={{ marginTop: 26 }}>Drawdown (%)</h3>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={result.chart}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" hide />
              <YAxis tickFormatter={(v) => Number(v).toFixed(2)} />
              <Tooltip formatter={(v) => `${Number(v).toFixed(2)}%`} />
              <Line type="monotone" dataKey="drawdown" dot={false} />
            </LineChart>
          </ResponsiveContainer>

          <div style={{ marginTop: 26, display: "flex", alignItems: "center", gap: 10 }}>
            <h3 style={{ margin: 0 }}>Worst Days (Top 10)</h3>
            <button
              onClick={() => setShowWorst((v) => !v)}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid #ddd",
                cursor: "pointer",
                background: "white",
              }}
            >
              {showWorst ? "Hide" : "Show"}
            </button>
          </div>

          {showWorst && (
            <div style={{ overflowX: "auto", marginTop: 10 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                    <th style={{ padding: "8px 6px" }}>Rank</th>
                    <th style={{ padding: "8px 6px" }}>Date</th>
                    <th style={{ padding: "8px 6px" }}>Return</th>
                  </tr>
                </thead>
                <tbody>
                  {result.worstDays.map((w) => (
                    <tr key={w.rank} style={{ borderBottom: "1px solid #f0f0f0" }}>
                      <td style={{ padding: "8px 6px" }}>{w.rank}</td>
                      <td style={{ padding: "8px 6px" }}>{w.date}</td>
                      <td style={{ padding: "8px 6px", fontWeight: 650 }}>
                        {w.retPct.toFixed(2)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ color: "#888", fontSize: 12, marginTop: 8, lineHeight: 1.6 }}>
                Worst days は「その日（終値ベース）のリターン」が最も悪い日付を並べています（四捨五入表示）。
              </div>
            </div>
          )}

          <div style={{ marginTop: 28, fontSize: 12, color: "#888", lineHeight: 1.6 }}>
            注意：本ツールは教育・分析目的であり、投資助言ではありません。将来の成果を保証しません。
          </div>
        </>
      )}
    </div>
  );
}



