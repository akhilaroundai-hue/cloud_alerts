import { resolveCompanyIdByAccessToken, resolveSingleCompanyId } from "../../lib/tenant";

type ProductRow = {
  company_id: string | null;
  company_name: string | null;
  ItemName: string | null;
  ItemQuantity: string | number | null;
  reorder_level: string | number | null;
  reorder_quantity: string | number | null;
};

function n(v: string | number | null | undefined): number {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
}

function norm(v: string | null | undefined): string {
  return String(v ?? "").trim().toLowerCase();
}

async function getCompanyName(companyId: string): Promise<string | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  const query = new URL(`${url}/rest/v1/tally_companies`);
  query.searchParams.set("select", "company_name");
  query.searchParams.set("Guid", `eq.${companyId}`);
  query.searchParams.set("limit", "1");
  const res = await fetch(query.toString(), { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" });
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ company_name?: string }>;
  return rows[0]?.company_name || null;
}

async function getReorderRows(companyId: string): Promise<ProductRow[]> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  const headersObj = { apikey: key, Authorization: `Bearer ${key}` };

  const byId = new URL(`${url}/rest/v1/products`);
  byId.searchParams.set("select", "company_id,company_name,ItemName,ItemQuantity,reorder_level,reorder_quantity");
  byId.searchParams.set("company_id", `eq.${companyId}`);
  byId.searchParams.set("is_active", "eq.true");
  byId.searchParams.set("limit", "20000");
  const idRes = await fetch(byId.toString(), { headers: headersObj, cache: "no-store" });
  let rows: ProductRow[] = [];
  if (idRes.ok) rows = (await idRes.json()) as ProductRow[];

  if (!rows.length) {
    const companyName = await getCompanyName(companyId);
    if (companyName) {
      const all = new URL(`${url}/rest/v1/products`);
      all.searchParams.set("select", "company_id,company_name,ItemName,ItemQuantity,reorder_level,reorder_quantity");
      all.searchParams.set("is_active", "eq.true");
      all.searchParams.set("limit", "20000");
      const allRes = await fetch(all.toString(), { headers: headersObj, cache: "no-store" });
      if (allRes.ok) {
        const allRows = (await allRes.json()) as ProductRow[];
        rows = allRows.filter((r) => norm(r.company_name) === norm(companyName));
      }
    }
  }

  return rows.filter((r) => {
    const level = n(r.reorder_level);
    const qty = n(r.ItemQuantity);
    return level > 0 && qty === level;
  });
}

export default async function ReorderPage({ searchParams }: { searchParams: { access?: string; token?: string } }) {
  try {
    const accessToken = searchParams.access || searchParams.token || "";
    const companyId = (await resolveCompanyIdByAccessToken(accessToken)) || (accessToken ? null : await resolveSingleCompanyId());
    if (!companyId) {
      return <main><header><h1>Unauthorized</h1><p>Invalid or missing access token.</p></header></main>;
    }
    const rows = await getReorderRows(companyId);
    return (
      <main>
        <header>
          <h1>Reorder Alert</h1>
          <p>Showing {rows.length} items where stock reached reorder level</p>
        </header>
        <div className="card">
          {rows.length === 0 ? (
            <p>No reorder items found.</p>
          ) : (
            <>
              <table className="desktop-table reorder-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Current Qty</th>
                    <th>Reorder Level</th>
                    <th>Suggested Reorder Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.ItemName || "item"}-${i}`}>
                      <td>{r.ItemName || "-"}</td>
                      <td>{n(r.ItemQuantity)}</td>
                      <td>{n(r.reorder_level)}</td>
                      <td>{n(r.reorder_quantity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mobile-list">
                {rows.map((r, i) => (
                  <div className="mobile-item" key={`${r.ItemName || "item-mobile"}-${i}`}>
                    <div className="mobile-item-top">
                      <strong>{r.ItemName || "-"}</strong>
                      <span className="badge">Reorder</span>
                    </div>
                    <div className="mobile-grid">
                      <span>Current Qty</span><span>{n(r.ItemQuantity)}</span>
                      <span>Reorder Level</span><span>{n(r.reorder_level)}</span>
                      <span>Suggested Qty</span><span>{n(r.reorder_quantity)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </main>
    );
  } catch (e) {
    return (
      <main>
        <header>
          <h1>Reorder Alert</h1>
          <p>Failed to load reorder items.</p>
          <p>{e instanceof Error ? e.message : "Unknown server error"}</p>
        </header>
      </main>
    );
  }
}
