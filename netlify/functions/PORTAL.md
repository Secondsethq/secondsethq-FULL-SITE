# Second Set client portal

Clients log in at **https://secondsethq.com/portal** with an email link (no password).
You manage everything at **https://secondsethq.com/tools/portal-admin.html** with the same `ADMIN_TOKEN` as the connector admin page.

Server: `portal.mjs` (Netlify Function). Data lives in Netlify Blobs (stores `portal-clients`, `portal-auth`, `portal-files`). Nothing to create in the Netlify UI.

## Environment variables (Netlify → Site configuration → Environment variables)

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_TOKEN` | yes | Already set for the connector. Same token unlocks the portal admin page. |
| `RESEND_API_KEY` | yes | Already set. Sends the login emails. |
| `STRIPE_SECRET_KEY` | for billing | A Stripe **restricted** key with read-only access to **Invoices** and **Customers**. Nothing else. Without it the Billing tab says "Billing is not connected yet." |
| `PORTAL_FROM` | no | Sender of login emails. Default is `ALERT_FROM`, then `Second Set <alerts@secondsethq.com>`. |
| `PORTAL_URL` | no | Override for the link in login emails. Default `https://secondsethq.com/portal`. |

Redeploy after changing env vars.

### Making the Stripe restricted key
Stripe Dashboard → Developers → API keys → **Create restricted key**. Name it "Client portal". Set **Invoices: Read** and **Customers: Read**, leave everything else as None, create it, and paste it into Netlify as `STRIPE_SECRET_KEY`.

## Adding a client
1. Admin page → **+ New client**, or **Import client file** for a prepared JSON file.
2. Settings tab: name, business, the emails that can log in, the Stripe customer, the Bitwarden vault link. Tick **Advertising** only if ads are in their contract.
3. **Save**. Tell the client to go to secondsethq.com/portal and enter their email.

Each email can belong to only one client. Removing an email logs that person out immediately.

## Files
Uploads tab → pick files. Large files upload in 4 MB pieces, so any normal size works (limit 500 MB per file). Then on Deliverables, Files, Proposal & contract or Training, click **+ Button** and pick the uploaded file. Deleting an upload removes its buttons for the client.

## Training videos
Upload to YouTube as **Unlisted** (not Private: private videos will not play in the portal). Paste the link in the Training entry. Blank shows "Video coming soon".

## How billing shows
Live from Stripe on every page load. Open invoices show **Pay invoice** (Stripe's hosted page). Draft invoices show as **Scheduled** with no pay link. Void invoices are hidden. Lines containing "processing fee" are left out of the description.

## Security
- Login links work once and expire in 20 minutes. Login emails are limited to 5 per address per hour.
- Sessions last 30 days in an HttpOnly, Secure cookie.
- A session resolves to exactly one client. Clients never see emails, the Stripe ID, or other clients' anything.
- Never put passwords in the portal. The Logins tab lists accounts only; passwords live in the client's Bitwarden vault.

## Tests
```sh
npm test
```
