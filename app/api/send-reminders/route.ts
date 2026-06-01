import { NextRequest, NextResponse } from "next/server";
import { resolveCompanyIdByAccessToken, resolveSingleCompanyId } from "../../../lib/tenant";

type ReminderRow = {
  company_id: string | null;
  company_name?: string | null;
  customer_name: string;
  mobile_number: string | number | null;
  invoicenumber: string;
  closing_balance: string;
};

function digits(v: string): string {
  return v.replace(/\D/g, "");
}

function ownerPhones(company: { owner_numbers?: Array<string | number> | null; owner_number?: string | number | null; owner_phone_number?: string | number | null }, fallback: string): string[] {
  const phones = new Set<string>();
  const add = (v: string | number | null | undefined) => {
    const phone = digits(String(v ?? ""));
    if (phone) phones.add(phone);
  };

  for (const phone of company.owner_numbers || []) add(phone);
  add(company.owner_number);
  add(company.owner_phone_number);
  add(fallback);

  return [...phones];
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const accessToken = String(body?.accessToken || "");
    const companyId = (await resolveCompanyIdByAccessToken(accessToken)) || (accessToken ? null : await resolveSingleCompanyId());
    if (!companyId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const inputRows = (body?.rows || []) as ReminderRow[];

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
    }

    // Resolve company owner from DB so multi-company owner confirmation goes to correct number.
    const companyQuery = new URL(`${supabaseUrl}/rest/v1/tally_companies`);
    companyQuery.searchParams.set("select", "id,Guid,company_name,owner_number,owner_phone_number,owner_numbers");
    companyQuery.searchParams.set("id", `eq.${companyId}`);
    companyQuery.searchParams.set("limit", "1");
    const companyRes = await fetch(companyQuery.toString(), {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      cache: "no-store",
    });
    const companyRows = companyRes.ok ? ((await companyRes.json()) as Array<{ Guid?: string; company_name?: string; owner_number?: string | number | null; owner_phone_number?: string | number | null; owner_numbers?: Array<string | number> | null }>) : [];
    const company = companyRows[0];
    const companyGuid = String(company?.Guid || "");
    const companyName = String(company?.company_name || "").trim().toLowerCase();

    // Keep strict tenant safety, but allow either id-guid/company-name style row mapping.
    const rows = inputRows.filter((row) => {
      if (row.company_id && row.company_id === companyId) return true; // id-based
      if (row.company_id && companyGuid && row.company_id === companyGuid) return true; // guid-based
      if (!row.company_id && row.company_name && companyName && String(row.company_name).trim().toLowerCase() === companyName) return true;
      return false;
    });

    const interaktKey = process.env.INTERAKT_API_KEY;
    const interaktBase = process.env.INTERAKT_BASE_URL || "https://api.interakt.ai";
    const countryCode = process.env.INTERAKT_COUNTRY_CODE || "+91";
    const templateName = process.env.INTERAKT_CUSTOMER_TEMPLATE_NAME || "customer_payment_remind";
    const senderName = process.env.INTERAKT_SENDER_NAME || "RoundTally";
    const ownerPhoneList = ownerPhones(company || {}, accessToken);
    const ownerTemplateName = process.env.INTERAKT_OWNER_CONFIRMATION_TEMPLATE_NAME || "reminder_confirmation";

    if (!interaktKey) {
      return NextResponse.json({ error: "Missing INTERAKT_API_KEY" }, { status: 500 });
    }

    let sent = 0;
    let failed = 0;
    const results: Array<{ phone: string; ok: boolean; response: unknown }> = [];
    const reminderLogs: Array<Record<string, unknown>> = [];

    for (const row of rows) {
      const phone = digits(String(row.mobile_number || ""));
      if (!phone) {
        failed += 1;
        results.push({ phone: "", ok: false, response: "Missing mobile_number" });
        reminderLogs.push({
          company_id: companyGuid || companyId,
          customer_name: row.customer_name || null,
          phone_number: null,
          invoice_number: row.invoicenumber || null,
          amount: row.closing_balance || "0",
          status: "failed",
          error_reason: "Missing mobile_number",
          response_json: null,
          sent_at: new Date().toISOString(),
        });
        continue;
      }

      const sendPayload = async (bodyValues: string[]) => {
        const payload = {
          countryCode,
          phoneNumber: phone,
          type: "Template",
          template: {
            name: templateName,
            languageCode: "en",
            bodyValues,
          },
        };
        const res = await fetch(`${interaktBase.replace(/\/$/, "")}/v1/public/message/`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${interaktKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        let j: unknown = null;
        try {
          j = await res.json();
        } catch {
          j = await res.text();
        }
        return { res, j };
      };

      // Template variants supported:
      // 4 vars: customer, sender/company, amount, invoice
      // 3 vars: customer, amount, invoice
      const primaryValues = [
        row.customer_name || "Customer",
        String(row.company_name || senderName),
        String(row.closing_balance || "0"),
        row.invoicenumber || "-",
      ];
      const fallbackValues = [
        row.customer_name || "Customer",
        String(row.closing_balance || "0"),
        row.invoicenumber || "-",
      ];

      let { res, j } = await sendPayload(primaryValues);
      if (!res.ok) {
        const txt = typeof j === "string" ? j : JSON.stringify(j);
        if (txt.includes("expected number of params") || txt.includes("bodyValues")) {
          const retry = await sendPayload(fallbackValues);
          res = retry.res;
          j = retry.j;
        }
      }

      if (res.ok) {
        sent += 1;
        results.push({ phone, ok: true, response: j });
        reminderLogs.push({
          company_id: companyGuid || companyId,
          customer_name: row.customer_name || null,
          phone_number: phone,
          invoice_number: row.invoicenumber || null,
          amount: row.closing_balance || "0",
          status: "sent",
          error_reason: null,
          response_json: j,
          sent_at: new Date().toISOString(),
        });
      } else {
        failed += 1;
        results.push({ phone, ok: false, response: j });
        reminderLogs.push({
          company_id: companyGuid || companyId,
          customer_name: row.customer_name || null,
          phone_number: phone,
          invoice_number: row.invoicenumber || null,
          amount: row.closing_balance || "0",
          status: "failed",
          error_reason: typeof j === "string" ? j : JSON.stringify(j),
          response_json: j,
          sent_at: new Date().toISOString(),
        });
      }
    }

    let owner_confirmation_sent = false;
    let owner_confirmation_response: unknown = null;

    if (sent > 0 && ownerPhoneList.length > 0) {
      const ownerResponses: Array<{ phone: string; ok: boolean; response: unknown }> = [];
      const sendOwner = async (ownerPhone: string, bodyValues?: string[]) => {
        const ownerPayload = {
          countryCode,
          phoneNumber: ownerPhone,
          type: "Template",
          template: {
            name: ownerTemplateName,
            languageCode: "en",
            ...(bodyValues ? { bodyValues } : {}),
          },
        };
        const ownerRes = await fetch(`${interaktBase.replace(/\/$/, "")}/v1/public/message/`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${interaktKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(ownerPayload),
        });
        let ownerBody: unknown = null;
        try {
          ownerBody = await ownerRes.json();
        } catch {
          ownerBody = await ownerRes.text();
        }
        return { ownerRes, ownerBody };
      };

      for (const ownerPhone of ownerPhoneList) {
        let { ownerRes, ownerBody } = await sendOwner(ownerPhone, [String(sent)]);
        if (!ownerRes.ok) {
          const txt = typeof ownerBody === "string" ? ownerBody : JSON.stringify(ownerBody);
          if (txt.includes("expected number of params") || txt.includes("bodyValues")) {
            const retry = await sendOwner(ownerPhone);
            ownerRes = retry.ownerRes;
            ownerBody = retry.ownerBody;
          }
        }
        ownerResponses.push({ phone: ownerPhone, ok: ownerRes.ok, response: ownerBody });
      }

      owner_confirmation_response = ownerResponses;
      owner_confirmation_sent = ownerResponses.some((r) => r.ok);
    }

    // Save reminder logs to Supabase
    if (reminderLogs.length > 0) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/reminder_logs`, {
          method: "POST",
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify(reminderLogs),
          cache: "no-store",
        });
      } catch {
        // Don't fail the response if logging fails
      }
    }

    return NextResponse.json({
      sent_count: sent,
      failed_count: failed,
      results,
      owner_confirmation_sent,
      owner_confirmation_response,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
