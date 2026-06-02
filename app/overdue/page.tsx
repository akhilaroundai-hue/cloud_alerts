import OverdueClient from "./overdue-client";
import { resolveCompanyIdByAccessToken, resolveSingleCompanyId } from "../../lib/tenant";

type Outstanding = {
  company_id: string | null;
  customer_name: string;
  mobile_number: string | number | null;
  invoicenumber: string;
  date: string;
  duedate: string | null;
  overdue_days: number | null;
  amount: string;
  closing_balance: string;
  opening_amount: string;
  voucher_type: string | null;
};

function num(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "0.00";
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function getOverdueRows(limit: number, companyId: string): Promise<Outstanding[]> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const headers: Record<string, string> = { apikey: key, Authorization: `Bearer ${key}`, Range: `0-${limit - 1}`, Prefer: "count=exact" };
  const baseFields = "company_id,customer_name,invoicenumber,date,duedate,overdue_days,amount,closing_balance,opening_amount";
  const attempts = [
    `${baseFields},mobile_number`,
    `${baseFields},customer_number`,
  ];

  let rowsById: Outstanding[] = [];
  for (const selectFields of attempts) {
    const query = new URL(`${url}/rest/v1/outstanding`);
    query.searchParams.set("select", selectFields);
    query.searchParams.set("company_id", `eq.${companyId}`);
    query.searchParams.set("bill_type", "eq.receivable");
    query.searchParams.set("order", "customer_name.asc,duedate.asc");
    query.searchParams.set("limit", String(limit));

    const res = await fetch(query.toString(), { headers, cache: "no-store" });
    if (!res.ok) {
      continue;
    }
    const rawRows = (await res.json()) as Array<Record<string, string | number | null>>;
    rowsById = rawRows.map((r) => ({
      company_id: (r.company_id as string | null) ?? null,
      customer_name: String(r.customer_name || ""),
      mobile_number: (r.mobile_number ?? r.customer_number ?? null) as string | number | null,
      invoicenumber: String(r.invoicenumber || ""),
      date: String(r.date || ""),
      duedate: ((r.duedate || r.date) as string | null) ?? null,
      overdue_days: (r.overdue_days as number | null) ?? null,
      amount: String(r.amount ?? "0"),
      closing_balance: String(r.closing_balance ?? "0"),
      opening_amount: String(r.opening_amount ?? "0"),
      voucher_type: null,
    }));
    if (rowsById.length > 0) return rowsById;
  }

  // Fallback by company_name when company_id mapping differs between systems.
  const companyQuery = new URL(`${url}/rest/v1/tally_companies`);
  companyQuery.searchParams.set("select", "company_name");
  companyQuery.searchParams.set("id", `eq.${companyId}`);
  companyQuery.searchParams.set("limit", "1");
  const companyRes = await fetch(companyQuery.toString(), { headers, cache: "no-store" });
  if (!companyRes.ok) return rowsById;
  const companyRows = (await companyRes.json()) as Array<{ company_name?: string }>;
  const companyName = String(companyRows?.[0]?.company_name || "").trim().toLowerCase();
  if (!companyName) return rowsById;

  for (const selectFields of attempts) {
    const query = new URL(`${url}/rest/v1/outstanding`);
    query.searchParams.set("select", selectFields + ",company_name");
    query.searchParams.set("bill_type", "eq.receivable");
    query.searchParams.set("order", "customer_name.asc,duedate.asc");
    query.searchParams.set("limit", "20000");
    const res = await fetch(query.toString(), { headers: { ...headers, Range: "0-19999" }, cache: "no-store" });
    if (!res.ok) continue;
    const rawRows = (await res.json()) as Array<Record<string, string | number | null>>;
    const filtered = rawRows.filter((r) => String(r.company_name || "").trim().toLowerCase() === companyName);
    return filtered.map((r) => ({
      company_id: (r.company_id as string | null) ?? null,
      customer_name: String(r.customer_name || ""),
      mobile_number: (r.mobile_number ?? r.customer_number ?? null) as string | number | null,
      invoicenumber: String(r.invoicenumber || ""),
      date: String(r.date || ""),
      duedate: ((r.duedate || r.date) as string | null) ?? null,
      overdue_days: (r.overdue_days as number | null) ?? null,
      amount: String(r.amount ?? "0"),
      closing_balance: String(r.closing_balance ?? "0"),
      opening_amount: String(r.opening_amount ?? "0"),
      voucher_type: null,
    }));
  }

  return rowsById;
}

export default async function OverduePage({ searchParams }: { searchParams: { limit?: string; access?: string; token?: string } }) {
  try {
    const accessToken = searchParams.access || searchParams.token || "";
    const companyId = (await resolveCompanyIdByAccessToken(accessToken)) || (accessToken ? null : await resolveSingleCompanyId());
    if (!companyId) {
      return (
        <main>
          <header>
            <h1>Unauthorized</h1>
            <p>Invalid or missing access token.</p>
          </header>
        </main>
      );
    }

    const limit = Math.min(Math.max(Number(searchParams.limit || 5000), 1), 20000);
    const rows = await getOverdueRows(limit, companyId);
    const total = rows.reduce((acc, r) => acc + Number(r.opening_amount || 0), 0);

    return (
      <main>
        <header>
          <h1>RoundALERTS</h1>
          <p>
            Showing {rows.length} overdue rows | Total due: Rs {num(total)}
          </p>
        </header>
        <OverdueClient rows={rows} accessToken={accessToken} />
      </main>
    );
  } catch (e) {
    return (
      <main>
        <header>
          <h1>RoundALERTS</h1>
          <p>Failed to load overdue data.</p>
          <p>{e instanceof Error ? e.message : "Unknown server error"}</p>
        </header>
      </main>
    );
  }
}
