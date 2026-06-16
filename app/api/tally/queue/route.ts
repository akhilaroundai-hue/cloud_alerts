import { NextRequest, NextResponse } from "next/server";
import { resolveCompanyIdByAccessToken, resolveSingleCompanyId } from "../../../../lib/tenant";

export const dynamic = "force-dynamic";

// Tally calls this endpoint to get today's reminder queue.
// Filtered by send_date = today so yesterday's already-sent rows are never returned again.
// Tally only needs to READ this response — no write-back required.
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const accessToken = searchParams.get("access") || searchParams.get("token") || "";

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

    const companyQuery = new URL(`${supabaseUrl}/rest/v1/tally_companies`);
    companyQuery.searchParams.set("select", "Guid");
    companyQuery.searchParams.set("id", `eq.${companyId}`);
    companyQuery.searchParams.set("limit", "1");
    const companyRes = await fetch(companyQuery.toString(), {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      cache: "no-store",
    });
    const companyRows = companyRes.ok
      ? ((await companyRes.json()) as Array<{ Guid?: string }>)
      : [];
    const lookupId = String(companyRows[0]?.Guid || companyId).trim();

    const tz = process.env.BUSINESS_TIMEZONE || "UTC";
    const today = new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD

    const q = new URL(`${supabaseUrl}/rest/v1/tally_reminder_queue`);
    q.searchParams.set(
      "select",
      "id,batch_id,customer_name,mobile_number,invoice_number,amount,send_date,queued_at"
    );
    q.searchParams.set("company_id", `eq.${lookupId}`);
    q.searchParams.set("send_date", `eq.${today}`);
    q.searchParams.set("order", "queued_at.asc");
    q.searchParams.set("limit", "1000");

    const res = await fetch(q.toString(), {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      cache: "no-store",
    });

    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json({ error: `Failed to fetch queue: ${errText.slice(0, 300)}` }, { status: 500 });
    }

    const rows = await res.json();
    return NextResponse.json({ ok: true, count: rows.length, today, rows });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
