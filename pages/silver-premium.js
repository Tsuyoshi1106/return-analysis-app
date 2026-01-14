// web/pages/silver-premium.js
import { useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

function round(x, digits = 2) {
  if (x === undefined || x === null || !Number.isFinite(x)) return x;
  const m = 10 ** digits;
  return Math.round(x * m) / m;
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

export default function SilverPremium() {
  const [range, setRange] = useState("1y");
  const [sgeScale, setSgeScale] = useState("1");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [data, setData] = useState(null);

  const chartPremium = useMemo(() => {
    if (!data?.points?.length) return [];
    return data.points.map((p) => ({
      date: p.date,
      premium_pct: round(p.premium_pct, 2),
    }));
  }, [data]);

  const chartLevels = useMemo(() => {
    if (!data?.points?.length) return [];
    return data.points.map((p) => ({
      date: p.date,
      shag_cny_per_kg: round(p.shag_cny_per_kg, 2),
      implied_cny_per_kg: round(p.implied_cny_per_kg, 2),
    }));
  }, [data]);

  async function onLoad() {
    setErr("");
    setLoading(true);
    try {
      const url = `/api/silver-premium?range=${encodeURIComponent(
        range
      )}&sgeScale=${encodeURIComponent(sgeScale)}`;
      const r = await fetch(url);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "API error");
      setData(j);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  const latest = data?.stats?.latest;

  return (
    <div
      style={{
        maxWidth: 1050,
        margin: "40px auto",
        padding: 16,
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto",
      }}
    >
      <h1 style={{ marginBottom: 6 }}>Silver Premium Monitor (US vs SGE SHAG)</h1>
      <div style={{ color: "#666", marginBottom: 18 }}>
        SGE（上海銀ベンチ SHAG）と、米国（SI=F）×USD/CNY から計算した「US暗黙CNY/kg」との
        差（Premium%）を可視化します。予測・推奨はしません。
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <select
          value={range}
          onChange={(e) => setRange(e.target.value)}
          style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd" }}
        >
          <option value="1y">1Y</option>
          <option value="2y">2Y</option>
          <option value="5y">5Y</option>
          <option value="max">MAX</option>
        </select>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 12, color: "#666" }}>
            SGE scale（単位ズレ調整）
          </label>
          <input
            value={sgeScale}
            onChange={(e) => setSgeScale(e.target.value)}
            placeholder="1"
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #ddd",
              width: 180,
            }}
          />
        </div>

        <button
          onClick={onLoad}
          disabled={loading}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #111",
            background: "#111",
            color: "white",
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.7 : 1,
            height: 42,
            marginTop: 18,
          }}
        >
          {loading ? "Loading..." : "Load"}
        </button>
      </div>

      <div style={{ color: "#888", fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
        Premium% = (SGE_SHAG_CNY/kg * scale) / (SI=F_USD/oz × USD/CNY × 32.1507) − 1<br />
        ※ SGE側の公表単位がページ側の都合で解釈しづらい場合があるため、MVPでは scale を設けています。
        レベル感が明らかにズレる場合は 0.1 / 0.01 などを試してください。
      </div>

      {err ? <div style={{ color: "crimson", marginTop: 12 }}>{err}</div> : null}

      {data && latest && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 12,
              marginTop: 18,
              marginBottom: 18,
            }}
          >
            <Card
              title="Latest Premium"
              value={`${round(latest.premium_pct, 2)}%`}
              subtitle={`Date: ${latest.date}`}
            />
            <Card
              title="Z-score (vs history)"
              value={
                latest.zscore === null || latest.zscore === undefined
                  ? "N/A"
                  : round(latest.zscore, 2)
              }
              subtitle={`Mean=${round(data.stats.mean_premium_pct, 2)}%, Std=${round(
                data.stats.std_premium_pct,
                2
              )}%`}
            />
            <Card
              title="Levels (CNY/kg)"
              value={`${round(latest.shag_cny_per_kg, 2)} vs ${round(
                latest.implied_cny_per_kg,
                2
              )}`}
              subtitle="SGE_SHAG (scaled) vs US implied"
            />
          </div>

          <h3 style={{ marginTop: 6 }}>Premium (%)</h3>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartPremium}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" hide />
              <YAxis tickFormatter={(v) => Number(v).toFixed(2)} />
              <Tooltip formatter={(v) => `${Number(v).toFixed(2)}%`} />
              <Line type="monotone" dataKey="premium_pct" dot={false} />
            </LineChart>
          </ResponsiveContainer>

          <h3 style={{ marginTop: 26 }}>Level comparison (CNY/kg)</h3>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartLevels}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" hide />
              <YAxis tickFormatter={(v) => Number(v).toFixed(0)} />
              <Tooltip formatter={(v) => Number(v).toFixed(2)} />
              <Line type="monotone" dataKey="shag_cny_per_kg" dot={false} />
              <Line type="monotone" dataKey="implied_cny_per_kg" dot={false} />
            </LineChart>
          </ResponsiveContainer>

          <div style={{ marginTop: 22, fontSize: 12, color: "#888", lineHeight: 1.6 }}>
            注意：このツールは分析目的であり、投資助言ではありません。将来の裁定機会や収束を保証しません。
          </div>
        </>
      )}
    </div>
  );
}


