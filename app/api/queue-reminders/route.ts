import { NextRequest, NextResponse } from "next/server";
import { resolveCompanyIdByAccessToken, resolveSingleCompanyId } from "../../../lib/tenant";

type QueueInputRow = {
  company_id: string | null;
  company_name?: string | null;
  customer_name: string;
  mobile_number: string | number | null;
  invoicenumber: string;
  closing_balance: string;
};

function digits(v: string | number | null | undefined): string {
  return String(v ?? "").replace(/\D/g, "");
}

async function resolveCompany(supabaseUrl: string, supabaseKey: string, companyId: string) {
  const q = new URL(`${supabaseUrl}/rest/v1/tally_companies`);
  q.searchParams.set("select", "id,Guid,company_name");
  q.searchParams.set("id", `eq.${companyId}`);
  q.searchParams.set("limit", "1");
  const res = await fetch(q.toString(), {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    cache: "no-store",
  });
  const rows = res.ok ? ((await res.json()) as Array<{ Guid?: string; company_name?: string }>) : [];
  return {
    companyGuid: String(rows[0]?.Guid || "").trim(),
    companyName: String(rows[0]?.company_name || "").trim(),
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const accessToken = String(body?.accessToken || "");
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
    }

    const companyId =
      (await resolveCompanyIdByAccessToken(accessToken)) ||
      (accessToken ? null : await resolveSingleCompanyId());
    if (!companyId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { companyGuid, companyName } = await resolveCompany(supabaseUrl, supabaseKey, companyId);

    const inputRows = (body?.rows || []) as QueueInputRow[];
    const filteredRows = inputRows.filter((row) => {
      if (row.company_id && row.company_id === companyId) return true;
      if (row.company_id && companyGuid && row.company_id === companyGuid) return true;
      if (
        row.company_name &&
        companyName &&
        String(row.company_name).trim().toLowerCase() === companyName.toLowerCase()
      )
        return true;
      return false;
    });

    if (filteredRows.length === 0) {
      return NextResponse.json({ error: "No valid rows for this company" }, { status: 400 });
    }

    const batchId = crypto.randomUUID();
    const now = new Date().toISOString();
    const tz = process.env.BUSINESS_TIMEZONE || "UTC";
    const sendDate = new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD

    const insertRows = filteredRows.map((row) => ({
      batch_id: batchId,
      company_id: companyGuid || companyId,
      company_name: companyName || row.company_name || null,
      customer_name: row.customer_name || null,
      mobile_number: digits(row.mobile_number) || null,
      invoice_number: row.invoicenumber || null,
      amount: row.closing_balance || "0",
      send_date: sendDate,
      status: "pending",
      queued_at: now,
    }));

    const insertRes = await fetch(`${supabaseUrl}/rest/v1/tally_reminder_queue`, {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(insertRows),
      cache: "no-store",
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      return NextResponse.json(
        { error: `Failed to queue reminders: ${errText.slice(0, 300)}` },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, batch_id: batchId, queued_count: insertRows.length });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const accessToken = String(body?.accessToken || "");
    const batchId = String(body?.batch_id || "");
    const newStatus = String(body?.status || "sent");

    if (!batchId) return NextResponse.json({ error: "batch_id required" }, { status: 400 });
    if (!["sent", "failed"].includes(newStatus)) {
      return NextResponse.json({ error: "Invalid status. Use: sent or failed" }, { status: 400 });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
    }

    const companyId =
      (await resolveCompanyIdByAccessToken(accessToken)) ||
      (accessToken ? null : await resolveSingleCompanyId());
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { companyGuid } = await resolveCompany(supabaseUrl, supabaseKey, companyId);
    const lookupId = companyGuid || companyId;

    const q = new URL(`${supabaseUrl}/rest/v1/tally_reminder_queue`);
    q.searchParams.set("batch_id", `eq.${batchId}`);
    q.searchParams.set("company_id", `eq.${lookupId}`);

    const res = await fetch(q.toString(), {
      method: "PATCH",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ status: newStatus, processed_at: new Date().toISOString() }),
      cache: "no-store",
    });

    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json({ error: `Update failed: ${errText.slice(0, 300)}` }, { status: 500 });
    }

    return NextResponse.json({ ok: true, batch_id: batchId, status: newStatus });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const accessToken = searchParams.get("access") || searchParams.get("token") || "";
    const limit = Math.min(Number(searchParams.get("limit") || "500"), 1000);

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
    }

    const companyId =
      (await resolveCompanyIdByAccessToken(accessToken)) ||
      (accessToken ? null : await resolveSingleCompanyId());
    if (!companyId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { companyGuid } = await resolveCompany(supabaseUrl, supabaseKey, companyId);
    const lookupId = companyGuid || companyId;

    const q = new URL(`${supabaseUrl}/rest/v1/tally_reminder_queue`);
    q.searchParams.set(
      "select",
      "id,batch_id,customer_name,mobile_number,invoice_number,amount,send_date,status,queued_at,processed_at,tally_response"
    );
    q.searchParams.set("company_id", `eq.${lookupId}`);
    q.searchParams.set("order", "queued_at.desc");
    q.searchParams.set("limit", String(limit));

    const res = await fetch(q.toString(), {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      cache: "no-store",
    });

    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json({ error: `History fetch failed: ${errText.slice(0, 300)}` }, { status: 500 });
    }

    const rows = await res.json();
    return NextResponse.json({ ok: true, rows });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
