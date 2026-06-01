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
    
    // Start the job in the background without waiting
    runAlertsJob().catch((e) => {
      console.error("Alerts job failed:", e instanceof Error ? e.message : "Unknown error");
    });
    
    // Return immediately to prevent timeout
    return NextResponse.json({ ok: true, status: "started", message: "Alerts job started in background" });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
