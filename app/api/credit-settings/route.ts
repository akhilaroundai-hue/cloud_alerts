import { NextRequest, NextResponse } from "next/server";
import { resolveCompanyIdByAccessToken, resolveSingleCompanyId } from "../../../lib/tenant";

function toNum(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

type CreditSettingInput = {
  ledger_name?: string;
  credit_limit?: string | number;
  threshold_percent?: string | number;
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const accessToken = String(body?.accessToken || "");
    const companyId = (await resolveCompanyIdByAccessToken(accessToken)) || (accessToken ? null : await resolveSingleCompanyId());
    if (!companyId || companyId !== String(body?.companyId || "")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rows: CreditSettingInput[] = Array.isArray(body?.rows) ? body.rows : [];
    const payload = rows
      .map((r) => ({
        company_id: companyId,
        ledger_name: String(r.ledger_name || "").trim(),
        credit_limit: String(toNum(r.credit_limit, 0)),
        threshold_percent: String(toNum(r.threshold_percent, 90)),
        overdue_days_threshold: 1,
        is_active: true,
      }))
      .filter((r) => r.ledger_name.length > 0);

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    const upsertUrl = `${url}/rest/v1/customer_credit_settings?on_conflict=company_id,ledger_name`;
    const res = await fetch(upsertUrl, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Save failed: ${res.status} ${txt.slice(0, 300)}`);
    }
    return NextResponse.json({ updated_count: payload.length });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
