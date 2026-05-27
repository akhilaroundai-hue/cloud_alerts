function digitsOnly(v: string): string {
  return v.replace(/\D/g, "");
}

function extractTokenCandidates(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: string) => {
    const t = v.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  if (!raw) return [];
  push(raw);

  // Direct digit-only candidate
  const d = digitsOnly(raw);
  if (d) push(d);

  // If access is itself a URL/query string, recursively extract `access=` value.
  const accessMatch = raw.match(/[?&]access=([^&]+)/i);
  if (accessMatch?.[1]) {
    try {
      const decoded = decodeURIComponent(accessMatch[1]);
      push(decoded);
      const dd = digitsOnly(decoded);
      if (dd) push(dd);
    } catch {
      push(accessMatch[1]);
      const dd = digitsOnly(accessMatch[1]);
      if (dd) push(dd);
    }
  }

  // Try all phone-like fragments and prioritize the last one (nested URLs often end with true token).
  const phoneish = raw.match(/\d{7,20}/g) || [];
  for (const p of phoneish) push(p);

  return out;
}

export async function resolveCompanyIdByAccessToken(accessToken: string): Promise<string | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  if (!accessToken) return null;
  const candidates = extractTokenCandidates(accessToken);

  for (const candidate of candidates) {
    const query = new URL(`${url}/rest/v1/tally_companies`);
    query.searchParams.set("select", "id");
    query.searchParams.set("access_token", `eq.${candidate}`);
    query.searchParams.set("limit", "1");

    const res = await fetch(query.toString(), {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Company token lookup failed: ${res.status} ${txt.slice(0, 300)}`);
    }

    const rows = (await res.json()) as Array<{ id?: string }>;
    const id = rows?.[0]?.id;
    if (id) return id;
  }

  // Automatic fallback: if access_token wasn't populated for a new company yet,
  // allow owner_number-based resolution (digits match).
  for (const candidate of candidates) {
    const digits = digitsOnly(candidate);
    if (!digits) continue;
    const query = new URL(`${url}/rest/v1/tally_companies`);
    query.searchParams.set("select", "id");
    query.searchParams.set("owner_number", `eq.${digits}`);
    query.searchParams.set("limit", "1");

    const res = await fetch(query.toString(), {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Company owner lookup failed: ${res.status} ${txt.slice(0, 300)}`);
    }

    const rows = (await res.json()) as Array<{ id?: string }>;
    const id = rows?.[0]?.id;
    if (id) return id;
  }
  return null;
}

export async function resolveSingleCompanyId(): Promise<string | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const query = new URL(`${url}/rest/v1/tally_companies`);
  query.searchParams.set("select", "id");
  query.searchParams.set("order", "updated_at.desc");
  query.searchParams.set("limit", "2");

  const res = await fetch(query.toString(), {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Company fallback lookup failed: ${res.status} ${txt.slice(0, 300)}`);
  }

  const rows = (await res.json()) as Array<{ id?: string }>;
  if (rows.length === 1 && rows[0]?.id) return rows[0].id;
  return null;
}
