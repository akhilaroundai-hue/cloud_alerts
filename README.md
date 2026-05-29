# Web Portal (Next.js, new schema)

## 1) Setup
- copy `.env.example` to `.env.local`
- set your values
- set `INTERAKT_OWNER_PHONE` in each company system `.env`

## 2) DB change (one time)
Add required columns/index:
```sql
alter table public.tally_companies add column if not exists access_token text;
alter table public.tally_companies add column if not exists owner_phone_number text;
alter table public.tally_companies add column if not exists owner_numbers text[] default '{}';
create unique index if not exists tally_companies_access_token_key on public.tally_companies(access_token);
```

## 3) Install and run portal
```bash
npm install
npm run dev
```

Owner link format:
- `http://localhost:3000/overdue?access=OWNER_PHONE_DIGITS`
- Example: `http://localhost:3000/overdue?access=9526830843`

For multiple owners, store all WhatsApp numbers in `owner_numbers`:
```sql
update public.tally_companies
set owner_numbers = array['9876543210', '9123456789']
where id = '<company-id>';
```

## 4) Notes for new schema
- Overdue page reads `outstanding.mobile_number` (not `customer_number`)
- Credit settings page reads customer base from `customers` table
- Company isolation is enforced by `tally_companies.access_token -> tally_companies.Guid -> outstanding.company_id`

## 5) Python-free background alerts
This portal includes backend job endpoint:
- `GET/POST /api/jobs/scan-alerts`

It does:
- scan Supabase outstanding + customers
- scan low-stock products for reorder alerts
- compute overdue snapshots
- compute credit-limit anomalies
- detect reorder items where `ItemQuantity = reorder_level`
- send owner WhatsApp alerts (Interakt)
- store logs in alert log tables

### Required env vars (on deployed web portal)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `INTERAKT_ENABLED=true`
- `INTERAKT_API_KEY`
- `INTERAKT_TEMPLATE_NAME`
- `INTERAKT_CREDIT_ALERT_TEMPLATE_NAME`
- `INTERAKT_REORDER_ALERT_TEMPLATE_NAME`
- `INTERAKT_COUNTRY_CODE`
- `INTERAKT_PORTAL_BASE_URL`
- `INTERAKT_CREDIT_PORTAL_BASE_URL` (optional, falls back to portal base)
- `INTERAKT_REORDER_PORTAL_BASE_URL` (optional, falls back to portal base + `/reorder`)
- `INTERAKT_DAYBOOK_TEMPLATE_NAME`
- `INTERAKT_DAYBOOK_PORTAL_BASE_URL` (optional, falls back to portal base + `/daybook`)
- `DAYBOOK_TABLE` (optional, defaults to `transactions`)
- `BUSINESS_TIME_ZONE` (optional, defaults to `Asia/Kolkata`)
- `CRON_SECRET` (required for job endpoint protection)

### How to trigger
Call endpoint from scheduler (Vercel Cron / UptimeRobot / cron-job.org):
- URL: `https://<your-domain>/api/jobs/scan-alerts`
- Method: `POST`
- Header: `Authorization: Bearer <CRON_SECRET>`

## 6) Daybook feature
Tally should insert each transaction into the existing `public.transactions` table. The owner link format is:
- `https://<your-domain>/daybook?access=COMPANY_TOKEN`

The page reads these `transactions` columns:
- `company_id`, `company_name`, `customer_name`
- `transaction_type`, `voucher_type`, `voucher_number`, `reference_number`
- `amount`, `tax_amount`, `discount_amount`, `net_amount`
- `transaction_date`, `payment_status`, `narration`, `remarks`

Add only the alert log table if it does not exist:
```sql
create table if not exists public.daybook_alert_logs (
  id bigserial primary key,
  snapshot_date date not null,
  company_id text not null,
  owner_phone_number text,
  transaction_count integer default 0,
  total_amount numeric default 0,
  status text not null,
  response_json jsonb,
  created_at timestamptz default now()
);

create unique index if not exists daybook_alert_logs_sent_once_idx
  on public.daybook_alert_logs(snapshot_date, company_id)
  where status = 'sent';
```

The cron job sends the owner one Interakt template message per company per day when today's `transactions` table has rows. The webpage resolves `access_token -> company` and filters rows by `company_id`/`Guid`/`company_name`, so each owner sees only their own company daybook.
