import { businessDate/*, getDaybookRows, numberValue*/ } from "./daybook";

type CompanyRow = {
  id: string;
  Guid: string;
  company_name: string | null;
  owner_number: string | number | null;
  owner_phone_number: string | number | null;
  owner_numbers: Array<string | number> | null;
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
  date: string | null;
  duedate: string | null;
  overdue_days: number | string | null;
  bill_type: string | null;
};

type ScheduleRow = {
  alert_type: string;
  alert_time: string;
  repeat_pattern: "daily" | "weekly" | "monthly";
  day_of_week: number[] | null;
};

/* DISABLED: ProductRow type used by reorder alert (disabled)
type ProductRow = {
  company_id: string | null;
  company_name: string | null;
  ItemName: string | null;
  ItemQuantity: string | number | null;
  reorder_level: string | number | null;
  reorder_quantity: string | number | null;
};
*/

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function digits(v: string | number | null | undefined): string {
  return String(v ?? "").replace(/\D/g, "");
}

function ownerPhones(company: CompanyRow): string[] {
  const phones = new Set<string>();
  const add = (v: string | number | null | undefined) => {
    const phone = digits(v);
    if (phone) phones.add(phone);
  };

  for (const phone of company.owner_numbers || []) add(phone);
  add(company.owner_number);
  add(company.owner_phone_number);
  add(process.env.INTERAKT_OWNER_PHONE || "");

  return [...phones];
}

function n(v: string | number | null | undefined): number {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
}

function norm(v: string | null | undefined): string {
  return String(v ?? "").trim().toLowerCase();
}

function isUuidLike(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
}

function dateValue(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = new Date(`${v.slice(0, 10)}T00:00:00Z`).getTime();
  return Number.isFinite(t) ? t : null;
}

function overdueDays(row: OutstandingRow, today: string): number {
  const effectiveDueDate = row.duedate || row.date;
  const due = dateValue(effectiveDueDate);
  const now = dateValue(today);
  if (due !== null && now !== null) {
    return Math.max(Math.floor((now - due) / 86_400_000), 0);
  }
  return Math.max(n(row.overdue_days), 0);
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

async function getCompanySchedules(companyId: string): Promise<ScheduleRow[]> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const q = new URL(`${url}/rest/v1/alert_schedules`);
  q.searchParams.set("select", "alert_type,alert_time,repeat_pattern,day_of_week");
  q.searchParams.set("company_id", `eq.${companyId}`);
  // FIX 1: Removed is_active filter - column doesn't exist in admin_portal schema
  const res = await fetch(q.toString(), { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" });
  if (!res.ok) {
    console.error(`[getCompanySchedules] Failed for ${companyId}:`, res.status);
    return [];
  }
  const data = await res.json();
  console.log(`[getCompanySchedules] ${companyId}:`, data);
  return data as ScheduleRow[];
}

function shouldSendAlert(
  schedules: ScheduleRow[],
  now: Date
): boolean {
  const timeZone = process.env.BUSINESS_TIME_ZONE || "Asia/Kolkata";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    day: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const currentHH = parts.find((p) => p.type === "hour")?.value?.padStart(2, "0") ?? "00";
  const currentMM = parts.find((p) => p.type === "minute")?.value?.padStart(2, "0") ?? "00";
  const currentTime = `${currentHH}:${currentMM}`;
  const currentDate = Number(parts.find((p) => p.type === "day")?.value ?? "0");
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const currentDay = weekdayMap[parts.find((p) => p.type === "weekday")?.value ?? ""] ?? now.getDay();

  console.log(`[shouldSendAlert] Current time: ${currentTime}, day: ${currentDay}, date: ${currentDate}`);
  console.log(`[shouldSendAlert] Checking schedules:`, schedules);

  return schedules.some((s) => {
    console.log(`[shouldSendAlert] Comparing schedule ${s.alert_time} vs current ${currentTime}`);
    if (s.alert_time !== currentTime) return false;
    switch (s.repeat_pattern) {
      case "daily":
        return true;
      case "weekly":
        return Array.isArray(s.day_of_week) ? s.day_of_week.includes(currentDay) : false;
      case "monthly":
        return currentDate === 1;
      default:
        return false;
    }
  });
}

function buildOverdueLink(accessToken: string): string | undefined {
  const base = process.env.INTERAKT_PORTAL_BASE_URL?.trim();
  if (!base) return undefined;
  const b = base.replace(/\/$/, "");
  return b.endsWith("/overdue") ? `${b}?access=${accessToken}` : `${b}/overdue?access=${accessToken}`;
}

/* DISABLED: buildCreditLink used by credit alert (disabled)
function buildCreditLink(accessToken: string): string | undefined {
  const base = (process.env.INTERAKT_CREDIT_PORTAL_BASE_URL || process.env.INTERAKT_PORTAL_BASE_URL)?.trim();
  if (!base) return undefined;
  const b = base.replace(/\/$/, "");
  return b.endsWith("/credit-settings") ? `${b}?access=${accessToken}` : `${b}/credit-settings?access=${accessToken}`;
}
*/

/* DISABLED: buildReorderLink used by reorder alert (disabled)
function buildReorderLink(accessToken: string): string | undefined {
  const base = (process.env.INTERAKT_REORDER_PORTAL_BASE_URL || process.env.INTERAKT_PORTAL_BASE_URL)?.trim();
  if (!base) return undefined;
  const b = base.replace(/\/$/, "");
  return b.endsWith("/reorder") ? `${b}?access=${accessToken}` : `${b}/reorder?access=${accessToken}`;
}
*/

/* DISABLED: buildDaybookLink used by daybook alert (disabled)
function buildDaybookLink(accessToken: string): string | undefined {
  const base = (process.env.INTERAKT_DAYBOOK_PORTAL_BASE_URL || process.env.INTERAKT_PORTAL_BASE_URL)?.trim();
  if (!base) return undefined;
  const b = base.replace(/\/$/, "");
  return b.endsWith("/daybook") ? `${b}?access=${accessToken}` : `${b}/daybook?access=${accessToken}`;
}
*/

export async function runAlertsJob(): Promise<{
  companies: number;
  overdueSent: number;
}> {
  const overdueThreshold = Number(process.env.OVERDUE_CUSTOMERS_THRESHOLD || "1");
  const overdueDaysThreshold = Number(process.env.OVERDUE_DAYS_THRESHOLD || "1");
  const overdueTemplate = process.env.INTERAKT_TEMPLATE_NAME || "";
  const interaktEnabled = String(process.env.INTERAKT_ENABLED || "false").toLowerCase() === "true";
  const today = businessDate();

  console.log(`[runAlertsJob] Starting job. interaktEnabled=${interaktEnabled}, template=${overdueTemplate}, today=${today}`);

  const companies = await sbSelect<CompanyRow>("tally_companies", {
    select: "id,Guid,company_name,owner_number,owner_phone_number,owner_numbers,access_token,is_active",
    limit: "10000",
  });

  console.log(`[runAlertsJob] Found ${companies.length} companies`);

  let overdueSent = 0;
  // let creditSent = 0;       // DISABLED
  // let reorderSent = 0;      // DISABLED
  // let daybookSent = 0;      // DISABLED
  // let daybookSkipped = 0;   // DISABLED
  // let daybookFailed = 0;    // DISABLED
  // let daybookRowsTotal = 0; // DISABLED

  const now = new Date();

  for (const company of companies) {
    if (company.is_active === false) continue;
    const companyGuid = String(company.Guid || "").trim();
    const companyName = String(company.company_name || "").trim();
    if (!companyGuid && !companyName) continue;

    // FIX 2: Added debug logging to track schedule fetching
    console.log(`[runAlertsJob] Processing company: ${companyName} (id=${company.id})`);
    
    const schedules = await getCompanySchedules(String(company.id || ""));
    console.log(`[runAlertsJob] Found ${schedules.length} schedules for ${companyName}`);
    
    if (schedules.length === 0) {
      console.log(`[runAlertsJob] No schedules for ${companyName}, skipping`);
      continue;
    }

    const overdueSchedules = schedules.filter((s) => s.alert_type === "overdue");
    console.log(`[runAlertsJob] Found ${overdueSchedules.length} overdue schedules for ${companyName}`);
    
    if (overdueSchedules.length === 0) {
      console.log(`[runAlertsJob] No overdue schedules for ${companyName}, skipping`);
      continue;
    }

    const shouldSend = shouldSendAlert(overdueSchedules, now);
    console.log(`[runAlertsJob] shouldSendAlert for ${companyName}: ${shouldSend}`);
    
    if (!shouldSend) {
      console.log(`[runAlertsJob] Time/day mismatch for ${companyName}, skipping`);
      continue;
    }

    let outstanding = await sbSelect<OutstandingRow>("outstanding", {
      select: "company_id,company_name,customer_name,opening_balance,closing_balance,amount,date,duedate,overdue_days,bill_type",
      company_id: `eq.${companyGuid}`,
      limit: "20000",
    });
    if (!outstanding.length && companyName) {
      const allRows = await sbSelect<OutstandingRow>("outstanding", {
        select: "company_id,company_name,customer_name,opening_balance,closing_balance,amount,date,duedate,overdue_days,bill_type",
        limit: "20000",
      });
      outstanding = allRows.filter((r) => norm(r.company_name) === norm(companyName));
    }

    const overdueRows = outstanding.filter((r) => {
      const billType = norm(r.bill_type);
      if (billType === "payable" || billType === "purchase") return false;
      const od = overdueDays(r, today);
      return od >= overdueDaysThreshold && n(r.closing_balance) > 0;
    });
    const overdueCustomers = new Set(overdueRows.map((r) => norm(r.customer_name)).filter(Boolean));
    const totalOverdue = overdueRows.reduce((acc, r) => acc + n(r.closing_balance), 0);
    const maxOverdue = overdueRows.reduce((acc, r) => Math.max(acc, overdueDays(r, today)), 0);
    const triggered = overdueCustomers.size >= overdueThreshold;

    console.log(`[runAlertsJob] ${companyName}: ${overdueCustomers.size} customers, ${overdueRows.length} bills, triggered=${triggered}`);

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

    /* DISABLED: Credit alert data fetch and log (disabled)
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
    */

    const phones = ownerPhones(company);
    const primaryOwnerPhone = phones[0] || "";
    const accessToken = String(company.access_token || "").trim() || primaryOwnerPhone;
    
    console.log(`[runAlertsJob] ${companyName}: phones=${phones.join(',')}, interaktEnabled=${interaktEnabled}`);
    
    if (!interaktEnabled || phones.length === 0) {
      console.log(`[runAlertsJob] ${companyName}: Skipping - interaktEnabled=${interaktEnabled}, phones=${phones.length}`);
      continue;
    }

    /* DISABLED: Daybook alert (disabled)
    if (daybookTemplate) {
      try {
        const daybookRows = await getDaybookRows(
          { id: String(company.id || companyGuid), Guid: companyGuid || null, company_name: companyName || null },
          today,
        );
        daybookRowsTotal += daybookRows.length;
        const daybookAmount = daybookRows.reduce((acc, row) => acc + numberValue(row.net_amount ?? row.amount), 0);
        const logCompanyId = companyGuid || String(company.id || "");
        const existingLogs = await sbSelect<{ id?: string }>("daybook_alert_logs", {
          select: "id",
          snapshot_date: `eq.${today}`,
          company_id: `eq.${logCompanyId}`,
          status: "eq.sent",
          limit: "1",
        }).catch(() => []);

        if (daybookRows.length > 0 && existingLogs.length === 0) {
          const responses: Array<{ phone: string; ok: boolean; response: unknown }> = [];
          for (const ownerPhone of phones) {
            try {
              const resp = await sendInteraktTemplate(ownerPhone, daybookTemplate, [], buildDaybookLink(accessToken));
              daybookSent += 1;
              responses.push({ phone: ownerPhone, ok: true, response: resp });
            } catch (e) {
              daybookFailed += 1;
              responses.push({ phone: ownerPhone, ok: false, response: { error: e instanceof Error ? e.message : "Unknown error" } });
            }
          }
          await sbInsert("daybook_alert_logs", [
            {
              snapshot_date: today,
              company_id: logCompanyId,
              owner_phone_number: phones.join(","),
              transaction_count: daybookRows.length,
              total_amount: String(daybookAmount),
              status: responses.some((r) => r.ok) ? "sent" : "failed",
              response_json: responses,
            },
          ]).catch(() => Promise.resolve());
        } else if (daybookRows.length > 0) {
          daybookSkipped += 1;
          await sbInsert("daybook_alert_logs", [
            {
              snapshot_date: today,
              company_id: logCompanyId,
              owner_phone_number: phones.join(","),
              transaction_count: daybookRows.length,
              total_amount: String(daybookAmount),
              status: "skipped",
              response_json: { reason: "already_sent" },
            },
          ]).catch(() => Promise.resolve());
        } else {
          daybookSkipped += 1;
        }
      } catch (e) {
        daybookFailed += 1;
        await sbInsert("daybook_alert_logs", [
          {
            snapshot_date: today,
            company_id: companyGuid || String(company.id || ""),
            owner_phone_number: phones.join(","),
            transaction_count: 0,
            total_amount: "0",
            status: "failed",
            response_json: { error: e instanceof Error ? e.message : "Unknown error" },
          },
        ]).catch(() => Promise.resolve());
      }
    } else {
      daybookSkipped += 1;
    }
    */

    const logCompanyId = companyGuid || String(company.id || "");
    const existingOverdueLogs = await sbSelect<{ id?: string }>("overdue_alert_logs", {
      select: "id",
      snapshot_date: `eq.${today}`,
      company_id: `eq.${logCompanyId}`,
      status: "eq.sent",
      limit: "1",
    }).catch(() => []);

    console.log(`[runAlertsJob] ${companyName}: existing logs=${existingOverdueLogs.length}`);

    if (existingOverdueLogs.length > 0) {
      console.log(`[runAlertsJob] ${companyName}: Already sent today, skipping`);
      continue;
    }

    if (triggered && overdueTemplate) {
      console.log(`[runAlertsJob] ${companyName}: SENDING ALERTS to ${phones.length} phones`);
      for (const ownerPhone of phones) {
        try {
          const resp = await sendInteraktTemplate(ownerPhone, overdueTemplate, [], buildOverdueLink(accessToken));
          overdueSent += 1;
          console.log(`[runAlertsJob] ${companyName}: Sent to ${ownerPhone}`);
          await sbInsert("overdue_alert_logs", [{ snapshot_date: today, company_id: logCompanyId, status: "sent", owner_phone_number: ownerPhone, overdue_customer_count: overdueCustomers.size, overdue_bill_count: overdueRows.length, response_json: resp }]);
        } catch (e) {
          console.error(`[runAlertsJob] ${companyName}: Failed to send to ${ownerPhone}:`, e);
          await sbInsert("overdue_alert_logs", [{ snapshot_date: today, company_id: logCompanyId, status: "failed", owner_phone_number: ownerPhone, overdue_customer_count: overdueCustomers.size, overdue_bill_count: overdueRows.length, response_json: { error: e instanceof Error ? e.message : "Unknown error" } }]);
        }
      }
    } else {
      console.log(`[runAlertsJob] ${companyName}: Not triggered or no template, skipping`);
      await sbInsert("overdue_alert_logs", [{ snapshot_date: today, company_id: logCompanyId, status: "skipped", owner_phone_number: phones.join(","), overdue_customer_count: overdueCustomers.size, overdue_bill_count: overdueRows.length, response_json: { reason: "threshold_not_met_or_template_missing" } }]);
    }

    /* DISABLED: Credit alert sending (disabled)
    if (creditTemplate) {
      for (const item of pendingCreditAlerts) {
        for (const ownerPhone of phones) {
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
    */

    /* DISABLED: Reorder alert (disabled)
    try {
      let products: ProductRow[] = [];
      const productCompanyIds = [String(company.id || "").trim(), companyGuid].filter((v, i, arr) => v && arr.indexOf(v) === i);
      for (const productCompanyId of productCompanyIds) {
        if (!isUuidLike(productCompanyId)) continue;
        products = await sbSelect<ProductRow>("products", {
          select: "company_id,company_name,ItemName,ItemQuantity,reorder_level,reorder_quantity",
          company_id: `eq.${productCompanyId}`,
          is_active: "eq.true",
          limit: "20000",
        });
        if (products.length) break;
      }
      if (!products.length && companyName) {
        const allProducts = await sbSelect<ProductRow>("products", {
          select: "company_id,company_name,ItemName,ItemQuantity,reorder_level,reorder_quantity,is_active",
          is_active: "eq.true",
          limit: "20000",
        });
        products = allProducts.filter((p) => norm(p.company_name) === norm(companyName));
      }
      const reorderItems = products.filter((p) => {
        const level = n(p.reorder_level);
        const qty = n(p.ItemQuantity);
        return level > 0 && qty === level;
      });

      if (reorderTemplate && reorderItems.length > 0) {
        for (const ownerPhone of phones) {
          try {
            const resp = await sendInteraktTemplate(
              ownerPhone,
              reorderTemplate,
              [String(reorderItems.length)],
              buildReorderLink(accessToken),
            );
            reorderSent += 1;
            await sbInsert("reorder_alert_logs", [
              {
                snapshot_date: today,
                company_id: companyGuid,
                owner_phone_number: ownerPhone,
                item_count: reorderItems.length,
                status: "sent",
                response_json: resp,
              },
            ]).catch(() => Promise.resolve());
          } catch (e) {
            await sbInsert("reorder_alert_logs", [
              {
                snapshot_date: today,
                company_id: companyGuid,
                owner_phone_number: ownerPhone,
                item_count: reorderItems.length,
                status: "failed",
                response_json: { error: e instanceof Error ? e.message : "Unknown error" },
              },
            ]).catch(() => Promise.resolve());
          }
        }
      }
    } catch {
      // Keep overdue/credit pipeline alive even when products schema/table differs.
    }
    */
  }

  console.log(`[runAlertsJob] Finished. Companies: ${companies.length}, Sent: ${overdueSent}`);
  return { companies: companies.length, overdueSent };
}
