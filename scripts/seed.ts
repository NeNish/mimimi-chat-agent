// Optional: `npm run seed` inserts a few back-dated demo exchanges so the
// memory features can be tried immediately ("On Monday we shortlisted…",
// "Last Tuesday I asked about Postgres hosting…"). Dates are computed relative
// to *now* with the same resolver the agent uses, so the phrases always line up.
// Demo answers are deliberately qualitative (no prices) — they stand in for
// what the agent would have said, and the agent re-verifies them live.

import { config } from "../src/config.js";
import { MemoryStore } from "../src/memory/store.js";
import { resolveTimeRefs } from "../src/memory/temporal.js";

const tz = process.env.SEED_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const now = new Date();
const store = new MemoryStore(config.dbPath);
const at = (phrase: string, hour: number) => {
  const ref = resolveTimeRefs(phrase, now, tz)[0];
  if (!ref) throw new Error(`could not resolve ${phrase}`);
  return Math.min(ref.start + hour * 3_600_000, now.getTime() - 60_000);
};

const demos = [
  {
    id: "demo-crm",
    when: at("on Monday", 11),
    question: "We're a 20-person sales team picking a CRM. Give me a shortlist of 5 with pricing tiers and what each is best at.",
    answer:
      "Here's a 5-tool shortlist for a 20-seat sales team:\n\n| CRM | Best at | Pricing model |\n|---|---|---|\n| HubSpot Sales Hub | All-in-one with marketing, easy adoption | Per-seat tiers (Starter / Professional / Enterprise); Professional adds sequences and forecasting [1] |\n| Pipedrive | Pipeline-first, fastest to set up | Per-seat tiers; automations and forecasting on mid tiers [2] |\n| Salesforce Sales Cloud | Customisation, enterprise reporting | Per-seat editions; most expensive to run and administer [3] |\n| Zoho CRM | Value for money, broad features | Per-seat tiers, cheapest at 20 seats [4] |\n| Close | Calling/SMS-heavy inside sales | Per-seat tiers with built-in dialer [5] |\n\nFor 20 reps doing high-volume outbound, I'd trial Close and Pipedrive first; if marketing alignment matters, HubSpot.",
    sources: [
      { id: 1, title: "HubSpot Sales Hub pricing", url: "https://www.hubspot.com/pricing/sales" },
      { id: 2, title: "Pipedrive pricing", url: "https://www.pipedrive.com/en/pricing" },
      { id: 3, title: "Salesforce Sales Cloud pricing", url: "https://www.salesforce.com/sales/pricing/" },
      { id: 4, title: "Zoho CRM pricing", url: "https://www.zoho.com/crm/zohocrm-pricing.html" },
      { id: 5, title: "Close pricing", url: "https://www.close.com/pricing" },
    ],
    note: "Shortlisted 5 CRMs for a 20-person sales team: HubSpot Sales Hub, Pipedrive, Salesforce Sales Cloud, Zoho CRM, Close. Recommended trialling Close and Pipedrive for outbound; HubSpot if marketing alignment matters.",
  },
  {
    id: "demo-postgres",
    when: at("last Tuesday", 15),
    question: "What are the main managed Postgres hosting options for a small SaaS and how is each priced?",
    answer:
      "The main options for a small SaaS:\n\n- **Neon** — serverless Postgres, usage-based (compute hours + storage) with a free tier; scales to zero [1].\n- **Supabase** — Postgres plus auth/storage; flat monthly plan plus compute add-ons [2].\n- **AWS RDS for PostgreSQL** — instance-hour pricing plus storage and I/O; most control, most ops [3].\n- **Google Cloud SQL** — similar instance-based model to RDS [4].\n\nFor an early SaaS with spiky traffic, Neon or Supabase is cheapest to start; move to RDS when you need fine-grained control.",
    sources: [
      { id: 1, title: "Neon pricing", url: "https://neon.com/pricing" },
      { id: 2, title: "Supabase pricing", url: "https://supabase.com/pricing" },
      { id: 3, title: "Amazon RDS for PostgreSQL pricing", url: "https://aws.amazon.com/rds/postgresql/pricing/" },
      { id: 4, title: "Cloud SQL pricing", url: "https://cloud.google.com/sql/pricing" },
    ],
    note: "Compared managed Postgres hosting for a small SaaS: Neon (usage-based, free tier), Supabase (flat plan + compute), AWS RDS for PostgreSQL (instance-hours), Google Cloud SQL. Suggested Neon/Supabase to start.",
  },
];

let added = 0;
for (const d of demos) {
  if (store.getConversation(d.id)) continue;
  store.createConversation(d.id, `[demo] ${d.question.slice(0, 50)}`, d.when);
  const id = store.addExchange({ conversationId: d.id, askedAt: d.when, tz, question: d.question, answer: d.answer, sources: d.sources, searches: [] });
  store.setNote(id, d.note);
  added++;
  console.log(`seeded "${d.id}" at ${new Date(d.when).toString()}`);
}
console.log(added ? `Added ${added} demo exchanges (timezone ${tz}).` : "Demo data already present.");
