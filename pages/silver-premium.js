// web/pages/silver-premium.js
import { useMemo, useState } from "react";

function round(x, d = 3) {
  if (x == null || !Number.isFinite(x)) return x;
  const p = Math.pow(10, d);
  return Math.round(x * p) / p;
}

export default function SilverPremium() {
  const [period, setPeriod] = useState("1Y");
  const [scale, setScale] = useState("1");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [data, setData] = useState(null);

  const points = data?.points || [];

  const summary = useMemo(() => {
    if (!points.length) return null;
    const last = points[points.length - 1];
    return {
      date: last.date,
      premiumPct: last.premium * 100,
      usUsd: last.us_usd_oz,
      cnUsd: last.cn_proxy_usd_oz,
      fx: last.usd_cny,
      usCnyKg: last.us_cny_kg,
      cnCnyKg: last.cn_proxy_cny_kg,
    };
  }, [points]);

  async function load() {
    setLoading(true);
    setErr("");
    setData(null);
    try {
      const url = `/api/silver-premium?period=${encodeURIComponent(
        period
      )}&scale=${encodeURIComponent(scale)}`;
      const res = await fetch(url);
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        maxWidth: 980,
        margin: "40px auto",
        padding: "0 18px",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto",
      }}
    >
      <h1 style={{ marginBottom: 6 }}>Silver Premium Monitor (Proxy version)</h1>
      <p style={{ marginTop: 0, color: "#444" }}>
        中国側の現物データはサーバ側で取得が不安定なため、最短版では Yahoo のプロキシ（AG=F）を使って
        「差（Premium%）」を可視化します。予測・推奨はしません。
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 18 }}>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ padding: "10px 12px" }}>
          <option value="1M">1M</option>
          <option value="3M">3M</option>
          <option value="6M">6M</option>
          <option value="1Y">1Y</option>
          <option value="5Y">5Y</option>
        </select>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 12, color: "#555" }}>scale（互換用 / 基本1）</div>
          <input
            value={scale}
            onChange={(e) => setScale(e.target.value)}
            placeholder="1"
            style={{ padding: "10px 12px", width: 240 }}
          />
        </div>

        <button
          onClick={load}
          disabled={loading}
          style={{
            padding: "12px 18px",
            border: "1px solid #111",
            background: "#111",
            color: "white",
            borderRadius: 8,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Loading..." : "Load"}
        </button>
      </div>

      <p style={{ marginTop: 14, color: "#666", fontSize: 13, lineHeight: 1.6 }}>
        Premium% = (CN proxy / US) − 1（※内部的にはCNY/kg換算も表示）
        <br />
        Symbols: US=SI=F, CN proxy=AG=F, FX=USDCNY=X（Yahoo）
      </p>

      {err ? (
        <div style={{ marginTop: 18 }}>
          <div style={{ color: "crimson", fontWeight: 600 }}>Error: {err}</div>
          <div style={{ marginTop: 6, color: "#666", fontSize: 13 }}>
            よくある原因：Yahoo側の一時レート制限・ネットワーク・シンボル取得失敗
          </div>
        </div>
      ) : null}

      {summary ? (
        <div style={{ marginTop: 18, padding: 14, border: "1px solid #ddd", borderRadius: 10 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Latest</div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", color: "#222" }}>
            <div>Date: {summary.date}</div>
            <div>Premium: {round(summary.premiumPct, 2)}%</div>
            <div>US (SI=F): {round(summary.usUsd, 2)} USD/oz</div>
            <div>CN proxy (AG=F): {round(summary.cnUsd, 2)} USD/oz</div>
            <div>USD/CNY: {round(summary.fx, 4)}</div>
            <div>US: {round(summary.usCnyKg, 0)} CNY/kg</div>
            <div>CN proxy: {round(summary.cnCnyKg, 0)} CNY/kg</div>
          </div>
        </div>
      ) : null}

      {points.length ? (
        <div style={{ marginTop: 18 }}>
          <h3 style={{ marginBottom: 8 }}>Data (last 120 rows, rounded)</h3>
          <div style={{ overflowX: "auto", border: "1px solid #eee", borderRadius: 10 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#fafafa" }}>
                  <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Date</th>
                  <th style={{ textAlign: "right", padding: 10, borderBottom: "1px solid #eee" }}>Premium%</th>
                  <th style={{ textAlign: "right", padding: 10, borderBottom: "1px solid #eee" }}>US (USD/oz)</th>
                  <th style={{ textAlign: "right", padding: 10, borderBottom: "1px solid #eee" }}>CN proxy (USD/oz)</th>
                  <th style={{ textAlign: "right", padding: 10, borderBottom: "1px solid #eee" }}>USD/CNY</th>
                </tr>
              </thead>
              <tbody>
                {points.slice(-120).map((p) => (
                  <tr key={p.date}>
                    <td style={{ padding: 10, borderBottom: "1px solid #f0f0f0" }}>{p.date}</td>
                    <td style={{ padding: 10, borderBottom: "1px solid #f0f0f0", textAlign: "right" }}>
                      {round(p.premium * 100, 2)}%
                    </td>
                    <td style={{ padding: 10, borderBottom: "1px solid #f0f0f0", textAlign: "right" }}>
                      {round(p.us_usd_oz, 2)}
                    </td>
                    <td style={{ padding: 10, borderBottom: "1px solid #f0f0f0", textAlign: "right" }}>
                      {round(p.cn_proxy_usd_oz, 2)}
                    </td>
                    <td style={{ padding: 10, borderBottom: "1px solid #f0f0f0", textAlign: "right" }}>
                      {round(p.usd_cny, 4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p style={{ marginTop: 10, color: "#777", fontSize: 12 }}>
            注意：このツールは教育・分析目的であり、投資助言ではありません。将来の成果を保証しません。
          </p>
        </div>
      ) : null}
    </div>
  );
}

