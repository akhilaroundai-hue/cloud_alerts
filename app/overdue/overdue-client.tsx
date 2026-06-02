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
  opening_balance: string;
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

function parseDateString(dateStr: string | null): Date | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function getDateOnly(date: Date): string {
  return date.toISOString().split('T')[0];
}

function getDaysFromToday(dateStr: string | null): number | null {
  const date = parseDateString(dateStr);
  if (!date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return Math.floor((date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
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
  const [sortBy, setSortBy] = useState<"duedate" | "amount" | "customer" | "overdue">("duedate");

  const grouped = useMemo(() => {
    const map = new Map<string, { key: string; customer: string; phone: string | number | null; indexes: number[]; total: number }>();
    rows.forEach((row, index) => {
      const key = (row.customer_name || "unknown").trim().toLowerCase();
      const existing = map.get(key);
      const amount = Number(row.opening_balance || 0);
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

  const filteredAndSortedGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    let filtered = grouped;
    
    if (q) {
      filtered = grouped.filter((g) => {
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
    }

    // Filter for overdue only if selected
    if (sortBy === "overdue") {
      filtered = filtered.filter((g) => {
        return g.indexes.some((idx) => {
          const daysFromToday = getDaysFromToday(rows[idx].duedate || rows[idx].date);
          return daysFromToday !== null && daysFromToday < 0;
        });
      });
    }

    // Sort groups based on selected sort option
    const sorted = [...filtered].sort((a, b) => {
      if (sortBy === "duedate" || sortBy === "overdue") {
        // Get earliest due date for each group
        const getEarliestDueDate = (group: typeof a) => {
          let earliest: Date | null = null;
          group.indexes.forEach((idx) => {
            const dueDate = parseDateString(rows[idx].duedate || rows[idx].date);
            if (dueDate && (!earliest || dueDate < earliest)) {
              earliest = dueDate;
            }
          });
          return earliest;
        };
        
        const aDate = getEarliestDueDate(a);
        const bDate = getEarliestDueDate(b);
        
        if (!aDate && !bDate) return 0;
        if (!aDate) return 1;
        if (!bDate) return -1;
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const aDays = Math.floor(((aDate as Date).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        const bDays = Math.floor(((bDate as Date).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        
        // Priority order: today (0), tomorrow (1), upcoming (>1), overdue (<0)
        const getPriority = (days: number) => {
          if (days === 0) return 0; // Today - highest priority
          if (days === 1) return 1; // Tomorrow
          if (days > 1) return 2;   // Upcoming
          return 3;                 // Overdue - lowest priority
        };
        
        const aPriority = getPriority(aDays);
        const bPriority = getPriority(bDays);
        
        if (aPriority !== bPriority) {
          return aPriority - bPriority;
        }
        
        // Within same priority, sort by actual date
        return (aDate as Date).getTime() - (bDate as Date).getTime();
      } else if (sortBy === "amount") {
        return b.total - a.total;
      } else {
        return a.customer.localeCompare(b.customer);
      }
    });

    return sorted;
  }, [grouped, rows, search, sortBy]);

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
    filteredAndSortedGroups.forEach((group) => {
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
      <div className="card" style={{ marginBottom: 8, padding: "10px" }}>
        <p style={{ fontSize: 13, marginBottom: 6 }}>
          Rows with customer number: {rowsWithPhoneCount} | Selected bills: {selectedIndexes.length}
        </p>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customer / ref no / phone / voucher type"
          disabled={sending}
          style={{ width: "100%", padding: "6px 10px", borderRadius: 8, border: "1px solid #cfd8cf", fontSize: 13, marginBottom: 6 }}
        />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <select 
            value={sortBy} 
            onChange={(e) => setSortBy(e.target.value as "duedate" | "amount" | "customer" | "overdue")}
            style={{ fontSize: 12, padding: "5px 8px", minHeight: 32, borderRadius: 6, border: "1px solid #cfd8cf" }}
          >
            <option value="duedate">Sort: Due Date</option>
            <option value="overdue">Overdue Only</option>
            <option value="amount">Sort: Amount</option>
            <option value="customer">Sort: Customer</option>
          </select>
          <button onClick={() => toggleAll(true)} disabled={sending} style={{ fontSize: 12, padding: "5px 10px", minHeight: 32 }}>Select all</button>
          <button onClick={() => toggleAll(false)} disabled={sending} style={{ fontSize: 12, padding: "5px 10px", minHeight: 32 }}>Clear</button>
          <button onClick={sendSelected} disabled={sending || selectedIndexes.length === 0} style={{ fontSize: 12, padding: "5px 10px", minHeight: 32 }}>
            {sending ? "Sending..." : "Send Selected"}
          </button>
        </div>
      </div>

      <div>
        {filteredAndSortedGroups.map((group) => {
          // Calculate earliest due date for badge display
          let earliestDueDate: Date | null = null;
          let daysFromToday: number | null = null;
          group.indexes.forEach((idx) => {
            const dueDate = parseDateString(rows[idx].duedate || rows[idx].date);
            if (dueDate && (!earliestDueDate || dueDate < earliestDueDate)) {
              earliestDueDate = dueDate;
            }
          });
          if (earliestDueDate) {
            daysFromToday = getDaysFromToday((earliestDueDate as Date).toISOString());
          }
          const open = !!expanded[group.key];
          const pendingIndexes = group.indexes.filter((i) => !sentRows[i]);
          const selectedInGroup = group.indexes.filter((i) => !!selected[i]).length;
          const isOverdueGroup = daysFromToday !== null && daysFromToday < 0;
          return (
            <div className="card" key={group.key} style={{ marginBottom: 8, padding: "10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3
                    style={{
                      margin: 0,
                      fontSize: 15,
                      fontWeight: 600,
                      marginBottom: 3,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      flexWrap: "wrap",
                      color: isOverdueGroup ? "#ca8a04" : undefined,
                    }}
                  >
                    {group.customer}
                    {daysFromToday !== null && (
                      <span style={{
                        fontSize: 10,
                        fontWeight: 600,
                        padding: "2px 6px",
                        borderRadius: 999,
                        background: daysFromToday < 0 ? "#fee2e2" : daysFromToday === 0 ? "#fee" : daysFromToday === 1 ? "#fef3c7" : "#e0e7ff",
                        color: daysFromToday < 0 ? "#991b1b" : daysFromToday === 0 ? "#991b1b" : daysFromToday === 1 ? "#92400e" : "#3730a3"
                      }}>
                        {daysFromToday < 0 ? "OVERDUE" : daysFromToday === 0 ? "DUE TODAY" : daysFromToday === 1 ? "DUE TOMORROW" : `${daysFromToday}d`}
                      </span>
                    )}
                  </h3>
                  <p style={{ fontSize: 12, lineHeight: 1.4, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", margin: 0 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
                      </svg>
                      {group.phone || "-"}
                    </span>
                    <span>• Bills: {group.indexes.length}</span>
                    <span
                      style={{
                        color: selectedInGroup > 0 ? "#0f8a5f" : "#6f7a70",
                        fontWeight: 600,
                        background: selectedInGroup > 0 ? "#e7f8ef" : "#edf0ed",
                        borderRadius: 999,
                        padding: "1px 6px",
                        fontSize: 11,
                      }}
                    >
                      Sel: {selectedInGroup}
                    </span>
                    <span>• Rs {formatNum(group.total)}</span>
                  </p>
                </div>
                <button 
                  onClick={() => setExpanded((prev) => ({ ...prev, [group.key]: !open }))} 
                  style={{ 
                    minHeight: 32, 
                    width: 32, 
                    padding: 0, 
                    display: "flex", 
                    alignItems: "center", 
                    justifyContent: "center",
                    flexShrink: 0
                  }}
                  title={open ? "Hide Bills" : "View Bills"}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {open ? (
                      <polyline points="18 15 12 9 6 15"></polyline>
                    ) : (
                      <polyline points="6 9 12 15 18 9"></polyline>
                    )}
                  </svg>
                </button>
              </div>

              {open ? (
                <div style={{ marginTop: 8 }}>
                  {group.indexes.map((idx) => {
                    const r = rows[idx];
                    const isSent = !!sentRows[idx];
                    const hasPhone = getPhoneDigits(r.mobile_number || fallbackPhoneByIndex[idx]).length > 0;
                    return (
                      <div
                        key={`${r.invoicenumber}-${idx}`}
                        style={{
                          border: "1px solid #d8dfd8",
                          borderRadius: 8,
                          padding: 8,
                          marginBottom: 6,
                          background: isSent ? "#edf2ed" : "#fff",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                          <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 13 }}>
                            <input
                              type="checkbox"
                              checked={!!selected[idx]}
                              disabled={sending || isSent}
                              onChange={(e) => setSelected((prev) => ({ ...prev, [idx]: e.target.checked }))}
                            />
                            Ref: {r.invoicenumber || "-"}
                          </label>
                          <button disabled={sending || isSent || !hasPhone} onClick={() => sendRows([idx])} style={{ fontSize: 11, padding: "4px 8px", minHeight: 28 }}>
                            {isSent ? "Sent" : hasPhone ? "Send" : "No Phone"}
                          </button>
                        </div>
                        <div className="mobile-grid" style={{ marginTop: 6, fontSize: 12 }}>
                          <span>Voucher</span><span>{r.voucher_type || "-"}</span>
                          <span>Bill Date</span><span>{r.date || "-"}</span>
                          <span>Due Date</span><span>{r.duedate || "-"}</span>
                          {(() => {
                            const dueDate = parseDateString(r.duedate || r.date);
                            if (!dueDate) return null;
                            const today = new Date();
                            today.setHours(0, 0, 0, 0);
                            dueDate.setHours(0, 0, 0, 0);
                            const days = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
                            if (days <= 0) return null;
                            return <><span>Overdue Days</span><span>{days}</span></>;
                          })()}
                          <span>Pending</span><span>Rs {formatNum(r.opening_balance)}</span>
                          <span>Opening</span><span>Rs {formatNum(r.closing_balance)}</span>
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
