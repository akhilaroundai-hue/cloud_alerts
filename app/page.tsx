import Link from "next/link";

export default function Home() {
  return (
    <main>
      <header>
        <h1>Outstanding Alerts (New Portal)</h1>
        <p>Portal for new Supabase schema with company-token isolation.</p>
      </header>
      <div className="card">
        <p>
          <Link href="/overdue">Open Overdue Page</Link>
        </p>
        <p>
          <Link href="/credit-settings">Open Credit Settings</Link>
        </p>
        <p>
          <Link href="/reorder">Open Reorder Alerts</Link>
        </p>
        <p>
          Open using a company link: <code>/overdue?access=COMPANY_TOKEN</code>
        </p>
        <p>
          Credit settings link: <code>/credit-settings?access=COMPANY_TOKEN</code>
        </p>
        <p>
          Reorder link: <code>/reorder?access=COMPANY_TOKEN</code>
        </p>
      </div>
    </main>
  );
}
