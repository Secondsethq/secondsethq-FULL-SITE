# Second Set Connector for InkSoft: license server

`connector.mjs` is the license, update and health endpoint for the Second Set Connector for InkSoft plugin:
`https://secondsethq.com/.netlify/functions/connector?action=...`.
`connector-watch.mjs` runs once a day and emails a digest. Data lives in Netlify Blobs (stores `licenses`, `health`, `releases`, `meta`).
Nothing needs to be created in the Netlify UI. Blobs work automatically once the site deploys.

Admin page: `https://secondsethq.com/tools/connector-admin.html` (noindex, no-store).

## Environment variables (Netlify → Site configuration → Environment variables)

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_TOKEN` | yes | Long random string. The admin page and `admin_*` actions need it as `Authorization: Bearer <token>`. If it's unset, admin is disabled (503). Generate one with `openssl rand -hex 32`. |
| `RESEND_API_KEY` | for email | Resend API key. With no key, no email is sent (alerts, digest, customer key emails). |
| `ALERT_EMAIL` | for alerts | Where health alerts, the daily digest and new-sale notices go. |
| `ALERT_FROM` | no | Sender. Default `Second Set <alerts@secondsethq.com>`. The domain must be verified in Resend. |
| `STRIPE_WEBHOOK_SECRET` | for Stripe | The `whsec_...` signing secret of the webhook endpoint below. |
| `CONNECTOR_PUBLIC_URL` | no | Override for the base URL used in update `package` links (default `https://secondsethq.com/.netlify/functions/connector`). |

Redeploy after you change env vars.

## Create a license key

On the admin page's **Licenses** tab, fill in **New license** (plan, name, email, max live sites, optional expiry) and click **Create key**. Then use **Copy key** and send the key to the customer.
Staging and local hosts (`*.wpengine.com`, `*.wpenginepowered.com`, `localhost`, `*.local`, `*.test`, `staging.*`, `*.playground.wordpress.net`) never use a seat.
To move a customer to a new domain, remove the old site (× on the site chip) or use **Reset all sites**.

With curl:
```sh
curl -X POST 'https://secondsethq.com/.netlify/functions/connector?action=admin_create' \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"plan":"premium","name":"Alchemy Print Co.","email":"owner@example.com","max_sites":1,"expires":null}'
```

## Publish a plugin release

1. Build the zip. Its top-level folder must be `second-set-inksoft-connector/`.
2. On the admin page's **Release** tab, pick the zip and enter the version (must match the plugin header), Requires WP, Requires PHP and Tested up to. Add a changelog as HTML, then click **Publish release**.
3. Licensed sites pick the update up on their next update check (WordPress checks about every 12 hours).

Limit: Netlify caps function request bodies at about 6 MB, and base64 adds a third, so keep the zip under about 4.4 MB.
Only `latest` is kept. To roll back, upload the older zip again with a higher version number.

## Stripe

- Webhook URL: `https://secondsethq.com/.netlify/functions/connector?action=stripe`
- Events to select: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`
- Copy the endpoint's signing secret into `STRIPE_WEBHOOK_SECRET`.
- The Checkout Session (Payment Link or Checkout) needs **metadata** `plan` = `basic` or `premium`. It can also set `max_sites` (default 1). Payment Links: under "Advanced options", add metadata. Checkout Sessions created by code: `metadata: { plan: 'premium' }`.
- When checkout completes, the server creates a key and stores the customer and subscription IDs. It emails the key to the buyer (Resend) and sends a notice to `ALERT_EMAIL`. Stripe retries are idempotent.
- Status mapping: subscription active/trialing → `active`; past_due/unpaid or `invoice.payment_failed` → `past_due` (still works, and the plugin shows a warning); deleted/canceled → `canceled`; paused → `suspended`; `invoice.paid` → `active`. Stripe never overrides a suspension you set by hand. A late `invoice.paid` never reactivates a canceled license.
- To link an existing manual key to a subscription, add subscription metadata `license_key=SS-...`, or set `stripe_subscription` via `admin_update`.

## Health

Each site POSTs a health report. An email goes to `ALERT_EMAIL` when a site goes from OK (or no report) to failing. There's one email per failure, and no repeats until the site recovers.
The **Site health** tab shows every site's latest checks and marks reports older than 36 h as stale.
The daily watch emails a digest only when a licensed live site is stale, missing or failing, or when a license expires within 7 days.

Set the public status line (shown in every connected site's admin) on the **Status message** tab. Leave it empty when all is well.

## Tests

```sh
node --test netlify/functions/__tests__/connector.test.mjs   # or: npm test
```
The tests use an in-memory Blobs mock and a fake fetch. No install or network needed.
