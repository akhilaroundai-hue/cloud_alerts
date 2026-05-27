type CompanyRow = {
  Guid: string;
  company_name: string | null;
  owner_number: string | number | null;
  owner_phone_number: string | number | null;
  access_token: string | null;
  is_active: boolean | null;
};

type OutstandingRow = {
  company_id: string | null;
  company_name: string | null;
  customer_name: string | null;
  opening_balance: string | number | null;
  closing_balance: string | number | null;
  amount: string | number | null;
  duedate: string | null;
  overdue_days: number | string | null;
  bill_type: string | null;
};

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function digits(v: string | number | null | undefined): string {
  return String(v ?? "").replace(/\D/g, "");
}

function n(v: string | number | null | undefined): number {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
}

function norm(v: string | null | undefined): string {
  return String(v ?? "").trim().toLowerCase();
}

async function sbSelect<T>(table: string, params: Record<string, string>): Promise<T[]> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const q = new URL(`${url}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(params)) q.searchParams.set(k, v);
  const res = await fetch(q.toString(), { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Supabase select ${table} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T[];
}

async function sbUpsert(table: string, rows: Record<string, unknown>[], onConflict: string): Promise<void> {
  if (!rows.length) return;
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const q = new URL(`${url}/rest/v1/${table}`);
  q.searchParams.set("on_conflict", onConflict);
  const res = await fetch(q.toString(), {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Supabase upsert ${table} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function sbInsert(table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (!rows.length) return;
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(rows),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Supabase insert ${table} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function sendInteraktTemplate(phone: string, templateName: string, bodyValues: string[], link?: string): Promise<unknown> {
  const interaktKey = env("INTERAKT_API_KEY");
  const interaktBase = process.env.INTERAKT_BASE_URL || "https://api.interakt.ai";
  const countryCode = process.env.INTERAKT_COUNTRY_CODE || "+91";

  const payload: Record<string, unknown> = {
    countryCode,
    phoneNumber: phone,
    type: "Template",
    template: { name: templateName, languageCode: "en", bodyValues },
  };
  if (link) {
    payload.buttonValues = { "0": [link] };
    (payload.template as Record<string, unknown>).buttonValues = { "0": [link] };
  }

  const res = await fetch(`${interaktBase.replace(/\/$/, "")}/v1/public/message/`, {
    method: "POST",
    headers: { Authorization: `Basic ${interaktKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const body = await res.json().catch(async () => ({ raw: await res.text() }));
  if (!res.ok) throw new Error(`Interakt failed: ${res.status} ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

function buildOverdueLink(accessToken: string): string | undefined {
  const base = process.env.INTERAKT_PORTAL_BASE_URL?.trim();
  if (!base) return undefined;
  const b = base.replace(/\/$/, "");
  return b.endsWith("/overdue") ? `${b}?access=${accessToken}` : `${b}/overdue?access=${accessToken}`;
}

function buildCreditLink(accessToken: string): string | undefined {
  const base = (process.env.INTERAKT_CREDIT_PORTAL_BASE_URL || process.env.INTERAKT_PORTAL_BASE_URL)?.trim();
  if (!base) return undefined;
  const b = base.replace(/\/$/, "");
  return b.endsWith("/credit-settings") ? `${b}?access=${accessToken}` : `${b}/credit-settings?access=${accessToken}`;
}

export async function runAlertsJob(): Promise<{ companies: number; overdueSent: number; creditSent: number }> {
  const overdueThreshold = Number(process.env.OVERDUE_CUSTOMERS_THRESHOLD || "1");
  const overdueDaysThreshold = Number(process.env.OVERDUE_DAYS_THRESHOLD || "1");
  const creditThresholdPercent = Number(process.env.DEFAULT_CREDIT_THRESHOLD_PERCENT || "90");
  const overdueTemplate = process.env.INTERAKT_TEMPLATE_NAME || "";
  const creditTemplate = process.env.INTERAKT_CREDIT_ALERT_TEMPLATE_NAME || "";
  const interaktEnabled = String(process.env.INTERAKT_ENABLED || "false").toLowerCase() === "true";
  const today = new Date().toISOString().slice(0, 10);

  const companies = await sbSelect<CompanyRow>("tally_companies", {
    select: "Guid,company_name,owner_number,owner_phone_number,access_token,is_active",
    limit: "10000",
  });

  let overdueSent = 0;
  let creditSent = 0;

  for (const company of companies) {
    if (company.is_active === false) continue;
    const companyGuid = String(company.Guid || "").trim();
    const companyName = String(company.company_name || "").trim();
    if (!companyGuid && !companyName) continue;

    let outstanding = await sbSelect<OutstandingRow>("outstanding", {
      select: "company_id,company_name,customer_name,opening_balance,closing_balance,amount,duedate,overdue_days,bill_type",
      company_id: `eq.${companyGuid}`,
      limit: "20000",
    });
    if (!outstanding.length && companyName) {
      const allRows = await sbSelect<OutstandingRow>("outstanding", {
        select: "company_id,company_name,customer_name,opening_balance,closing_balance,amount,duedate,overdue_days,bill_type",
        limit: "20000",
      });
      outstanding = allRows.filter((r) => norm(r.company_name) === norm(companyName));
    }

    const overdueRows = outstanding.filter((r) => {
      const billType = norm(r.bill_type);
      if (billType === "payable" || billType === "purchase") return false;
      const od = Math.max(n(r.overdue_days), 0);
      return od >= overdueDaysThreshold && n(r.closing_balance) > 0;
    });
    const overdueCustomers = new Set(overdueRows.map((r) => norm(r.customer_name)).filter(Boolean));
    const totalOverdue = overdueRows.reduce((acc, r) => acc + n(r.closing_balance), 0);
    const maxOverdue = overdueRows.reduce((acc, r) => Math.max(acc, n(r.overdue_days)), 0);
    const triggered = overdueCustomers.size >= overdueThreshold;

    await sbUpsert(
      "overdue_anomaly_snapshots",
      [
        {
          snapshot_date: today,
          overdue_customer_count: overdueCustomers.size,
          overdue_bill_count: overdueRows.length,
          total_overdue_amount: String(totalOverdue),
          max_overdue_days: maxOverdue,
          triggered,
        },
      ],
      "snapshot_date",
    );

    const customers = await sbSelect<{ customer_name: string; credit_limit: string | number | null; company_name: string | null }>("customers", {
      select: "customer_name,credit_limit,company_name",
      is_active: "eq.true",
      limit: "20000",
    });
    const scopedCustomers = customers.filter((c) => norm(c.company_name) === norm(companyName));

    const usedByCustomer = new Map<string, number>();
    for (const row of outstanding) {
      const k = norm(row.customer_name);
      if (!k) continue;
      const used = Math.max(Math.abs(n(row.opening_balance)), Math.abs(n(row.closing_balance)), Math.abs(n(row.amount)));
      usedByCustomer.set(k, (usedByCustomer.get(k) || 0) + used);
    }

    const creditLogs: Record<string, unknown>[] = [];
    const pendingCreditAlerts: Array<{ customerName: string; used: number; limit: number; thresholdPercent: number }> = [];
    for (const c of scopedCustomers) {
      const k = norm(c.customer_name);
      const limit = Math.abs(n(c.credit_limit));
      if (limit <= 0) continue;
      const used = usedByCustomer.get(k) || 0;
      const thresholdAmount = (limit * creditThresholdPercent) / 100;
      let anomalyType: string | null = null;
      let status = "ok";
      if (used > limit) {
        status = "exceeded";
        anomalyType = "limit_exceeded";
      } else if (used >= thresholdAmount) {
        status = "warning";
        anomalyType = "credit_threshold";
      }
      creditLogs.push({
        snapshot_date: today,
        company_id: companyGuid,
        customer_name: c.customer_name,
        credit_limit: String(limit),
        credit_used: String(used),
        threshold_percent: String(creditThresholdPercent),
        threshold_amount: String(thresholdAmount),
        status,
        anomaly_type: anomalyType,
      });
      if (anomalyType) pendingCreditAlerts.push({ customerName: c.customer_name, used, limit, thresholdPercent: creditThresholdPercent });
    }
    if (creditLogs.length) await sbUpsert("credit_anomaly_logs", creditLogs, "snapshot_date,company_id,customer_name,anomaly_type");

    const ownerPhone = digits(company.owner_number) || digits(company.owner_phone_number) || digits(process.env.INTERAKT_OWNER_PHONE || "");
    const accessToken = digits(company.access_token) || ownerPhone;
    if (!interaktEnabled || !ownerPhone) continue;

    if (triggered && overdueTemplate) {
      try {
        const resp = await sendInteraktTemplate(ownerPhone, overdueTemplate, [], buildOverdueLink(accessToken));
        overdueSent += 1;
        await sbInsert("overdue_alert_logs", [{ snapshot_date: today, status: "sent", owner_phone_number: ownerPhone, overdue_customer_count: overdueCustomers.size, overdue_bill_count: overdueRows.length, response_json: resp }]);
      } catch (e) {
        await sbInsert("overdue_alert_logs", [{ snapshot_date: today, status: "failed", owner_phone_number: ownerPhone, overdue_customer_count: overdueCustomers.size, overdue_bill_count: overdueRows.length, response_json: { error: e instanceof Error ? e.message : "Unknown error" } }]);
      }
    } else {
      await sbInsert("overdue_alert_logs", [{ snapshot_date: today, status: "skipped", owner_phone_number: ownerPhone, overdue_customer_count: overdueCustomers.size, overdue_bill_count: overdueRows.length, response_json: { reason: "threshold_not_met_or_template_missing" } }]);
    }

    if (creditTemplate) {
      for (const item of pendingCreditAlerts) {
        try {
          const resp = await sendInteraktTemplate(
            ownerPhone,
            creditTemplate,
            [item.customerName, String(item.used), String(item.limit)],
            buildCreditLink(accessToken),
          );
          creditSent += 1;
          await sbInsert("credit_alert_logs", [{ snapshot_date: today, company_id: companyGuid, customer_name: item.customerName, alert_key: `${item.used}|${item.limit}|${item.thresholdPercent}`, status: "sent", owner_phone_number: ownerPhone, response_json: resp }]);
        } catch (e) {
          await sbInsert("credit_alert_logs", [{ snapshot_date: today, company_id: companyGuid, customer_name: item.customerName, alert_key: `${item.used}|${item.limit}|${item.thresholdPercent}`, status: "failed", owner_phone_number: ownerPhone, response_json: { error: e instanceof Error ? e.message : "Unknown error" } }]);
        }
      }
    }
  }

  return { companies: companies.length, overdueSent, creditSent };
}
