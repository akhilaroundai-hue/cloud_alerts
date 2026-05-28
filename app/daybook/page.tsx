import { headers } from "next/headers";
import { businessDate, formatAmount, getCompanyScope, getDaybookRows, numberValue } from "../../lib/daybook";
import { resolveCompanyIdByAccessToken } from "../../lib/tenant";

function displayDate(value: string): string {
  if (!value) return "-";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export default async function DaybookPage({ searchParams }: { searchParams: { access?: string; token?: string; date?: string } }) {
  try {
    const accessToken = searchParams.access || searchParams.token || "";
    const companyId = await resolveCompanyIdByAccessToken(accessToken);
    if (!companyId) {
      return <main><header><h1>Unauthorized</h1><p>Invalid or missing access token.</p></header></main>;
    }

    const scope = await getCompanyScope(companyId);
    if (!scope) {
      return <main><header><h1>Unauthorized</h1><p>Company was not found for this access token.</p></header></main>;
    }

    const date = searchParams.date || businessDate();
    const rows = await getDaybookRows(scope, date);
    const total = rows.reduce((acc, row) => acc + numberValue(row.net_amount ?? row.amount), 0);
    const host = headers().get("host") || "localhost:3000";

    return (
      <main>
        <header>
          <h1>Today&apos;s Daybook</h1>
          <p>
            {scope.company_name || "Company"} | {displayDate(date)} | {rows.length} transactions | Total Rs {formatAmount(total)} | Host: {host}
          </p>
        </header>
        <div className="card">
          {rows.length === 0 ? (
            <p>No daybook transactions found for this date.</p>
          ) : (
            <>
              <table className="desktop-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Transaction Type</th>
                    <th>Customer / Ledger</th>
                    <th>Voucher No</th>
                    <th>Reference</th>
                    <th>Amount</th>
                    <th>Narration</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={`${row.id || row.voucher_number || "daybook"}-${index}`}>
                      <td>{displayDate(row.transaction_date)}</td>
                      <td><span className="badge">{row.transaction_type || row.voucher_type || "Transaction"}</span></td>
                      <td>{row.customer_name || row.ledger_name || "-"}</td>
                      <td>{row.voucher_number || "-"}</td>
                      <td>{row.reference_number || "-"}</td>
                      <td>Rs {formatAmount(row.net_amount ?? row.amount)}</td>
                      <td>{row.narration || row.remarks || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mobile-list">
                {rows.map((row, index) => (
                  <div className="mobile-item" key={`${row.id || row.voucher_number || "daybook-mobile"}-${index}`}>
                    <div className="mobile-item-top">
                      <strong>{row.customer_name || row.ledger_name || "Transaction"}</strong>
                      <span className="badge">{row.transaction_type || row.voucher_type || "Transaction"}</span>
                    </div>
                    <div className="mobile-grid">
                      <span>Date</span><span>{displayDate(row.transaction_date)}</span>
                      <span>Voucher</span><span>{row.voucher_number || "-"}</span>
                      <span>Reference</span><span>{row.reference_number || "-"}</span>
                      <span>Amount</span><span>Rs {formatAmount(row.net_amount ?? row.amount)}</span>
                      <span>Narration</span><span>{row.narration || row.remarks || "-"}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </main>
    );
  } catch (e) {
    return (
      <main>
        <header>
          <h1>Today&apos;s Daybook</h1>
          <p>Failed to load daybook data.</p>
          <p>{e instanceof Error ? e.message : "Unknown server error"}</p>
        </header>
      </main>
    );
  }
}
