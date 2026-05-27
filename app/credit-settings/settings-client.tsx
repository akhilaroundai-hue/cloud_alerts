"use client";

import { useMemo, useState } from "react";

type Customer = { customer_name: string; credit_limit: string; outstanding_total: string };
type Setting = { ledger_name: string; credit_limit: string; threshold_percent: string };

type Props = {
  companyId: string;
  accessToken: string;
  customers: Customer[];
  settings: Setting[];
  initialSearch?: string;
};

export default function CreditSettingsClient({ companyId, accessToken, customers, settings, initialSearch = "" }: Props) {
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [rows, setRows] = useState(() => {
    const map = new Map(settings.map((s) => [s.ledger_name.toLowerCase(), s]));
    return customers.map((c) => {
      const s = map.get(c.customer_name.toLowerCase());
      return {
        ledger_name: c.customer_name,
        credit_limit: s?.credit_limit || c.credit_limit || "0",
        outstanding_total: c.outstanding_total || "0",
        threshold_percent: s?.threshold_percent || "90",
      };
    });
  });
  const [search, setSearch] = useState(initialSearch);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.ledger_name.toLowerCase().includes(q));
  }, [rows, search]);

  async function save() {
    setSaving(true);
    setNotice("");
    try {
      const res = await fetch("/api/credit-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, accessToken, rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Save failed");
      setNotice(`Saved ${data.updated_count || 0} customers.`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function formatNum(v: string | number | null | undefined): string {
    const n = Number(v || 0);
    return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  const summary = useMemo(() => {
    return rows.reduce(
      (acc, row) => {
        const limit = Number(row.credit_limit || 0);
        const used = Number(row.outstanding_total || 0);
        const threshold = Number(row.threshold_percent || 90);
        acc.limit += limit;
        acc.used += used;
        if (limit > 0 && used >= (limit * threshold) / 100) acc.breached += 1;
        return acc;
      },
      { limit: 0, used: 0, breached: 0 },
    );
  }, [rows]);

  return (
    <>
      <div className="credit-summary-grid">
        <div className="card">
          <strong>{rows.length}</strong>
          <p>Customers</p>
        </div>
        <div className="card">
          <strong>Rs {formatNum(summary.used)}</strong>
          <p>Total Outstanding</p>
        </div>
        <div className="card">
          <strong>Rs {formatNum(summary.limit)}</strong>
          <p>Total Credit Limit</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Search customer"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={saving}
          style={{ width: "100%", maxWidth: 460, padding: "8px 10px", borderRadius: 8, border: "1px solid #cfd8cf" }}
        />
      </div>

      <div className="card" style={{ marginBottom: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={save} disabled={saving}>{saving ? "Saving..." : "Save Settings"}</button>
        {notice ? <span style={{ marginLeft: 10 }}>{notice}</span> : null}
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {filtered.map((row) => {
          const limit = Number(row.credit_limit || 0);
          const used = Number(row.outstanding_total || 0);
          const threshold = Number(row.threshold_percent || 90);
          const pct = limit > 0 ? Math.min((used / limit) * 100, 999) : 0;
          const thresholdAmount = limit > 0 ? (limit * threshold) / 100 : 0;
          const breached = limit > 0 && used >= thresholdAmount;
          return (
            <div className="card" key={row.ledger_name} style={{ overflow: "visible" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16 }}>{row.ledger_name}</h3>
                  <p style={{ marginTop: 4 }}>{breached ? "Breached" : "Within limit"} | {pct.toFixed(1)}% used</p>
                </div>
                <label style={{ display: "grid", gap: 4, minWidth: 130 }}>
                  <span style={{ color: "var(--muted)", fontSize: 12 }}>Threshold %</span>
                  <input
                    type="text"
                    value={row.threshold_percent}
                    onChange={(e) => setRows((prev) => prev.map((p) => (p.ledger_name === row.ledger_name ? { ...p, threshold_percent: e.target.value } : p)))}
                    disabled={saving}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #cfd8cf" }}
                  />
                </label>
              </div>
              <div className="mobile-grid" style={{ marginTop: 12 }}>
                <span>Outstanding</span><span>Rs {formatNum(used)}</span>
                <span>Credit Limit</span><span>Rs {formatNum(limit)}</span>
                <span>Alert At</span><span>Rs {formatNum(thresholdAmount)}</span>
              </div>
              <div style={{ marginTop: 12, height: 7, borderRadius: 999, background: "#e7ece8", overflow: "hidden" }}>
                <div
                  style={{
                    width: `${Math.min(pct, 100)}%`,
                    height: "100%",
                    background: breached ? "#ef4444" : "#0f8a5f",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
