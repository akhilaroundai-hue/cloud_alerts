import CreditSettingsClient from "./settings-client";
import { resolveCompanyIdByAccessToken, resolveSingleCompanyId } from "../../lib/tenant";

type Customer = {
  customer_name: string;
  credit_limit: string;
  outstanding_total: string;
};

type Setting = {
  ledger_name: string;
  credit_limit: string;
  threshold_percent: string;
};

type OutstandingRow = {
  customer_name: string;
  closing_balance: string;
};

function keyOf(value: string): string {
  return value.trim().toLowerCase();
}

async function getCustomers(companyId: string): Promise<Customer[]> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  const customersQuery = new URL(`${url}/rest/v1/customers`);
  customersQuery.searchParams.set("select", "customer_name,credit_limit");
  customersQuery.searchParams.set("company_id", `eq.${companyId}`);
  customersQuery.searchParams.set("is_active", "eq.true");
  customersQuery.searchParams.set("order", "customer_name.asc");

  const outstandingQuery = new URL(`${url}/rest/v1/outstanding`);
  outstandingQuery.searchParams.set("select", "customer_name,closing_balance");
  outstandingQuery.searchParams.set("company_id", `eq.${companyId}`);
  outstandingQuery.searchParams.set("limit", "20000");

  const [customersRes, outstandingRes] = await Promise.all([
    fetch(customersQuery.toString(), { headers, cache: "no-store" }),
    fetch(outstandingQuery.toString(), { headers, cache: "no-store" }),
  ]);
  if (!customersRes.ok) throw new Error(`Customer fetch failed: ${customersRes.status}`);
  if (!outstandingRes.ok) throw new Error(`Outstanding fetch failed: ${outstandingRes.status}`);

  const customers = (await customersRes.json()) as Array<Omit<Customer, "outstanding_total">>;
  const outstanding = (await outstandingRes.json()) as OutstandingRow[];
  const totals = new Map<string, number>();
  outstanding.forEach((row) => {
    const k = keyOf(row.customer_name || "");
    totals.set(k, (totals.get(k) || 0) + Math.abs(Number(row.closing_balance || 0)));
  });

  return customers.map((customer) => ({
    ...customer,
    credit_limit: String(Math.abs(Number(customer.credit_limit || 0))),
    outstanding_total: String(totals.get(keyOf(customer.customer_name)) || 0),
  }));
}

async function getSettings(companyId: string): Promise<Setting[]> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  const query = new URL(`${url}/rest/v1/customer_credit_settings`);
  query.searchParams.set("select", "ledger_name,credit_limit,threshold_percent");
  query.searchParams.set("company_id", `eq.${companyId}`);
  query.searchParams.set("is_active", "eq.true");
  const res = await fetch(query.toString(), { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" });
  if (!res.ok) {
    if (res.status === 404) {
      return [];
    }
    throw new Error(`Settings fetch failed: ${res.status}`);
  }
  return (await res.json()) as Setting[];
}

export default async function CreditSettingsPage({ searchParams }: { searchParams: { access?: string; token?: string; customer?: string } }) {
  const accessToken = searchParams.access || searchParams.token || "";
  const companyId = (await resolveCompanyIdByAccessToken(accessToken)) || (accessToken ? null : await resolveSingleCompanyId());
  if (!companyId) {
    return <main><header><h1>Unauthorized</h1><p>Invalid or missing access token.</p></header></main>;
  }
  const [customers, settings] = await Promise.all([getCustomers(companyId), getSettings(companyId)]);
  const settingByLedger = new Map(settings.map((s) => [keyOf(s.ledger_name), s]));
  const filteredCustomers = customers.filter((c) => {
    const setting = settingByLedger.get(keyOf(c.customer_name));
    const settingLimit = Number(setting?.credit_limit || 0);
    const customerLimit = Number(c.credit_limit || 0);
    return settingLimit > 0 || customerLimit > 0;
  });
  return (
    <main>
      <header>
        <h1>Credit Limits</h1>
        <p>Set customer alert threshold percentages.</p>
      </header>
      <CreditSettingsClient
        companyId={companyId}
        accessToken={accessToken}
        customers={filteredCustomers}
        settings={settings}
        initialSearch={searchParams.customer || ""}
      />
    </main>
  );
}
