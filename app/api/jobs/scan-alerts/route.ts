import { NextRequest, NextResponse } from "next/server";
import { runAlertsJob } from "../../../../lib/alerts-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return false;
  const auth = req.headers.get("authorization") || "";
  if (auth === `Bearer ${secret}`) return true;
  const header = req.headers.get("x-cron-secret") || "";
  return header === secret;
}

export async function POST(req: NextRequest) {
  try {
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    
    const result = await runAlertsJob();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("Alerts job error:", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
