"use client";

import { useMemo, useState } from "react";

type Row = {
  company_id: string | null;
  customer_name: string;
  mobile_number: string | number | null;
  invoicenumber: string;
  date: string;
  duedate: string | null;
  overdue_days: number | null;
  amount: string;
  closing_balance: string;
  voucher_type: string | null;
};

function formatNum(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "0.00";
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getPhoneDigits(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\D/g, "");
}

export default function OverdueClient({ rows, accessToken }: { rows: Row[]; accessToken: string }) {
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [sending, setSending] = useState(false);
  const [sentRows, setSentRows] = useState<Record<number, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [snackbar, setSnackbar] = useState<{ text: string; type: "success" | "error"; visible: boolean }>({
    text: "",
    type: "success",
    visible: false,
  });
  const [search, setSearch] = useState("");

  const grouped = useMemo(() => {
    const map = new Map<string, { key: string; customer: string; phone: string | number | null; indexes: number[]; total: number }>();
    rows.forEach((row, index) => {
      const key = (row.customer_name || "unknown").trim().toLowerCase();
      const existing = map.get(key);
      const amount = Number(row.closing_balance || 0);
      if (!existing) {
        map.set(key, {
          key,
          customer: row.customer_name || "Unknown Customer",
          phone: row.mobile_number,
          indexes: [index],
          total: Number.isNaN(amount) ? 0 : amount,
        });
      } else {
        existing.indexes.push(index);
        existing.total += Number.isNaN(amount) ? 0 : amount;
        if (!getPhoneDigits(existing.phone) && getPhoneDigits(row.mobile_number)) {
          existing.phone = row.mobile_number;
        }
      }
    });
    return Array.from(map.values());
  }, [rows]);

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return grouped;
    return grouped.filter((g) => {
      const customerMatch = g.customer.toLowerCase().includes(q);
      const phoneMatch = String(g.phone || "").toLowerCase().includes(q);
      const rowMatch = g.indexes.some((i) => {
        const row = rows[i];
        return (
          (row.invoicenumber || "").toLowerCase().includes(q) ||
          String(row.mobile_number || "").toLowerCase().includes(q) ||
          (row.voucher_type || "").toLowerCase().includes(q)
        );
      });
      return customerMatch || phoneMatch || rowMatch;
    });
  }, [grouped, rows, search]);

  const rowsWithPhoneCount = useMemo(() => rows.filter((r) => getPhoneDigits(r.mobile_number).length > 0).length, [rows]);
  const selectedIndexes = useMemo(() => Object.entries(selected).filter(([, v]) => v).map(([k]) => Number(k)), [selected]);
  const fallbackPhoneByIndex = useMemo(() => {
    const m: Record<number, string | number | null> = {};
    grouped.forEach((g) => {
      g.indexes.forEach((i) => {
        m[i] = g.phone;
      });
    });
    return m;
  }, [grouped]);

  function showSnackbar(text: string, type: "success" | "error") {
    setSnackbar({ text, type, visible: true });
    setTimeout(() => {
      setSnackbar((prev) => ({ ...prev, visible: false }));
    }, 2500);
  }

  function toggleAll(checked: boolean) {
    const next: Record<number, boolean> = {};
    filteredGroups.forEach((group) => {
      group.indexes.forEach((i) => {
        if (!sentRows[i]) next[i] = checked;
      });
    });
    setSelected((prev) => ({ ...prev, ...next }));
  }

  async function sendRows(indexes: number[]) {
    const targetIndexes = indexes.filter((i) => !sentRows[i]);
    if (targetIndexes.length === 0) {
      showSnackbar("Nothing pending to send for selected item(s).", "error");
      return;
    }

    setSending(true);
    try {
      const payload = targetIndexes.map((i) => {
        const row = rows[i];
        const effectivePhone = getPhoneDigits(row.mobile_number) ? row.mobile_number : fallbackPhoneByIndex[i] || null;
        return { ...row, mobile_number: effectivePhone };
      });
      const res = await fetch("/api/send-reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken, rows: payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to send reminders");

      const results = Array.isArray(data.results) ? data.results : [];
      const sentIndexMap: Record<number, boolean> = {};
      targetIndexes.forEach((rowIndex, idx) => {
        const r = results[idx];
        if (r?.ok) sentIndexMap[rowIndex] = true;
      });

      setSentRows((prev) => ({ ...prev, ...sentIndexMap }));
      setSelected((prev) => {
        const next = { ...prev };
        Object.keys(sentIndexMap).forEach((k) => {
          next[Number(k)] = false;
        });
        return next;
      });

      if ((data.failed_count || 0) === 0 && (data.sent_count || 0) > 0) {
        showSnackbar(`Success: ${data.sent_count} reminder${data.sent_count > 1 ? "s" : ""} sent.`, "success");
      } else if ((data.sent_count || 0) > 0) {
        showSnackbar(`Partially sent: ${data.sent_count} sent, ${data.failed_count} failed.`, "success");
      } else {
        showSnackbar(`No reminders sent. Failed: ${data.failed_count || 0}.`, "error");
      }
    } catch (err) {
      showSnackbar(err instanceof Error ? err.message : "Failed to send reminders", "error");
    } finally {
      setSending(false);
    }
  }

  async function sendSelected() {
    if (selectedIndexes.length === 0) {
      showSnackbar("Select at least one outstanding bill.", "error");
      return;
    }
    await sendRows(selectedIndexes);
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <p>
          Rows with customer number: {rowsWithPhoneCount} | Selected bills: {selectedIndexes.length}
        </p>
        <p style={{ marginTop: 8, marginBottom: 8 }}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customer / ref no / phone / voucher type"
            disabled={sending}
            style={{ width: "100%", maxWidth: 460, padding: "8px 10px", borderRadius: 8, border: "1px solid #cfd8cf" }}
          />
        </p>
        <p style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => toggleAll(true)} disabled={sending}>Select all shown bills</button>
          <button onClick={() => toggleAll(false)} disabled={sending}>Clear</button>
          <button onClick={sendSelected} disabled={sending || selectedIndexes.length === 0}>
            {sending ? "Sending..." : "Send Selected Bills"}
          </button>
        </p>
      </div>

      <div>
        {filteredGroups.map((group) => {
          const open = !!expanded[group.key];
          const pendingIndexes = group.indexes.filter((i) => !sentRows[i]);
          const selectedInGroup = group.indexes.filter((i) => !!selected[i]).length;
          return (
            <div className="card" key={group.key} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 18 }}>{group.customer}</h3>
                  <p style={{ marginTop: 4 }}>
                    Phone: {group.phone || "-"} | Bills: {group.indexes.length} |{" "}
                    <span
                      style={{
                        color: selectedInGroup > 0 ? "#0f8a5f" : "#6f7a70",
                        fontWeight: 700,
                        background: selectedInGroup > 0 ? "#e7f8ef" : "#edf0ed",
                        borderRadius: 999,
                        padding: "2px 8px",
                      }}
                    >
                      Selected: {selectedInGroup}
                    </span>{" "}
                    | Total: Rs {formatNum(group.total)}
                  </p>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={() => setExpanded((prev) => ({ ...prev, [group.key]: !open }))}>
                    {open ? "Hide Bills" : "View Bills"}
                  </button>
                </div>
              </div>

              {open ? (
                <div style={{ marginTop: 10 }}>
                  {group.indexes.map((idx) => {
                    const r = rows[idx];
                    const isSent = !!sentRows[idx];
                    const hasPhone = getPhoneDigits(r.mobile_number || fallbackPhoneByIndex[idx]).length > 0;
                    return (
                      <div
                        key={`${r.invoicenumber}-${idx}`}
                        style={{
                          border: "1px solid #d8dfd8",
                          borderRadius: 10,
                          padding: 10,
                          marginBottom: 8,
                          background: isSent ? "#edf2ed" : "#fff",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
                            <input
                              type="checkbox"
                              checked={!!selected[idx]}
                              disabled={sending || isSent}
                              onChange={(e) => setSelected((prev) => ({ ...prev, [idx]: e.target.checked }))}
                            />
                            Ref: {r.invoicenumber || "-"}
                          </label>
                          <button disabled={sending || isSent || !hasPhone} onClick={() => sendRows([idx])}>
                            {isSent ? "Already Sent" : hasPhone ? "Send This Bill" : "No Phone"}
                          </button>
                        </div>
                        <div className="mobile-grid" style={{ marginTop: 8 }}>
                          <span>Voucher</span><span>{r.voucher_type || "-"}</span>
                          <span>Bill Date</span><span>{r.date || "-"}</span>
                          <span>Due Date</span><span>{r.duedate || "-"}</span>
                          <span>Overdue Days</span><span>{r.overdue_days ?? 0}</span>
                          <span>Amount</span><span>Rs {formatNum(r.amount)}</span>
                          <span>Closing</span><span>Rs {formatNum(r.closing_balance)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {snackbar.visible ? (
        <div
          style={{
            position: "fixed",
            left: "50%",
            bottom: 20,
            transform: "translateX(-50%)",
            background: snackbar.type === "success" ? "#0f8a5f" : "#b42318",
            color: "#fff",
            padding: "10px 14px",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            zIndex: 2000,
            fontWeight: 600,
            maxWidth: "90vw",
          }}
        >
          {snackbar.text}
        </div>
      ) : null}
    </>
  );
}
