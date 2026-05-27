import { redirect } from "next/navigation";

function decodeRef(ref: string): { access?: string; customer?: string } {
  try {
    const padded = ref + "=".repeat((4 - (ref.length % 4)) % 4);
    const raw = Buffer.from(padded, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as { a?: string; c?: string };
    return { access: parsed.a, customer: parsed.c };
  } catch {
    return {};
  }
}

export default function CreditSettingsRefPage({ params }: { params: { ref: string } }) {
  const decoded = decodeRef(params.ref);
  const access = decoded.access || "";
  const customer = decoded.customer || "";
  const query = new URLSearchParams();
  if (access) query.set("access", access);
  if (customer) query.set("customer", customer);
  redirect(`/credit-settings?${query.toString()}`);
}
