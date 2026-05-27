export async function resolveCompanyIdByAccessToken(accessToken: string): Promise<string | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  if (!accessToken) return null;
  const normalizedDigits = accessToken.replace(/\D/g, "");
  const candidates = Array.from(new Set([accessToken, normalizedDigits].filter(Boolean)));

  for (const candidate of candidates) {
    const query = new URL(`${url}/rest/v1/tally_companies`);
    query.searchParams.set("select", "Guid");
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

    const rows = (await res.json()) as Array<{ Guid?: string }>;
    const guid = rows?.[0]?.Guid;
    if (guid) return guid;
  }
  return null;
}

export async function resolveSingleCompanyId(): Promise<string | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const query = new URL(`${url}/rest/v1/tally_companies`);
  query.searchParams.set("select", "Guid");
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

  const rows = (await res.json()) as Array<{ Guid?: string }>;
  if (rows.length === 1 && rows[0]?.Guid) return rows[0].Guid;
  return null;
}
