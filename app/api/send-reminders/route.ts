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
    companyQuery.searchParams.set("select", "id,Guid,company_name,owner_number,owner_phone_number");
    companyQuery.searchParams.set("id", `eq.${companyId}`);
    companyQuery.searchParams.set("limit", "1");
    const companyRes = await fetch(companyQuery.toString(), {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      cache: "no-store",
    });
    const companyRows = companyRes.ok ? ((await companyRes.json()) as Array<{ Guid?: string; company_name?: string; owner_number?: string | number | null; owner_phone_number?: string | number | null }>) : [];
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
    const ownerPhoneRaw =
      String(company?.owner_number || "") ||
      String(company?.owner_phone_number || "") ||
      process.env.INTERAKT_OWNER_PHONE ||
      "";
    const ownerTemplateName = process.env.INTERAKT_OWNER_CONFIRMATION_TEMPLATE_NAME || "reminder_confirmation";

    if (!interaktKey) {
      return NextResponse.json({ error: "Missing INTERAKT_API_KEY" }, { status: 500 });
    }

    let sent = 0;
    let failed = 0;
    const results: Array<{ phone: string; ok: boolean; response: unknown }> = [];

    for (const row of rows) {
      const phone = digits(String(row.mobile_number || ""));
      if (!phone) {
        failed += 1;
        results.push({ phone: "", ok: false, response: "Missing mobile_number" });
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
      } else {
        failed += 1;
        results.push({ phone, ok: false, response: j });
      }
    }

    let owner_confirmation_sent = false;
    let owner_confirmation_response: unknown = null;
    const ownerPhone = digits(ownerPhoneRaw);

    if (sent > 0 && ownerPhone) {
      const ownerPayload = {
        countryCode,
        phoneNumber: ownerPhone,
        type: "Template",
        template: {
          name: ownerTemplateName,
          languageCode: "en",
          bodyValues: [String(sent)],
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

      try {
        owner_confirmation_response = await ownerRes.json();
      } catch {
        owner_confirmation_response = await ownerRes.text();
      }
      owner_confirmation_sent = ownerRes.ok;
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
