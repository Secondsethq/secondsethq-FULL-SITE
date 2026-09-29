/**
 * Second Set InkSoft Connector — daily watch.
 * Emails ALERT_EMAIL (via Resend) a digest of:
 *   - licensed, non-staging sites whose last health report is older than 36h, missing, or failing
 *   - licenses (active/past_due) expiring within 7 days
 * Sends nothing when there is nothing to report, and is a no-op when RESEND_API_KEY / ALERT_EMAIL are unset.
 */

import { effectiveStatus, isStagingHost, makeMailer, realGetStore, STALE_MS } from './connector.mjs';

export const config = { schedule: '@daily' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ago(ms) {
  if (ms === null) return 'never reported';
  const h = Math.round(ms / 3600000);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function makeWatch({ getStore, fetch, env = {}, now = () => Date.now() }) {
  return async function watch() {
    if (!env.RESEND_API_KEY || !env.ALERT_EMAIL) return { sent: false, reason: 'email not configured' };
    const licenses = getStore('licenses');
    const health = getStore('health');
    const t = now();

    const { blobs } = await licenses.list();
    const problems = [];
    const expiring = [];
    for (const b of blobs) {
      const lic = await licenses.get(b.key, { type: 'json' });
      if (!lic) continue;
      const status = effectiveStatus(lic, t);
      if (!['active', 'past_due'].includes(status)) continue;
      if (lic.expires) {
        const left = Date.parse(lic.expires) - t;
        if (left > 0 && left <= 7 * 86400000) expiring.push({ lic, days: Math.ceil(left / 86400000) });
      }
      for (const host of lic.sites || []) {
        if (isStagingHost(host)) continue;
        const h = await health.get(host, { type: 'json' });
        const age = h && h.latest ? t - Date.parse(h.latest.at) : null;
        const failing = h && h.latest && h.latest.ok === false
          ? Object.entries(h.latest.checks || {}).filter(([, c]) => !c.ok).map(([n, c]) => `${n}: ${c.msg || 'failed'}`)
          : null;
        if (age === null || age > STALE_MS || failing) {
          problems.push({ host, lic, age, failing, stale: age === null || age > STALE_MS });
        }
      }
    }

    if (!problems.length && !expiring.length) return { sent: false, reason: 'nothing to report' };

    const siteRows = problems.map((p) => `<li><b>${esc(p.host)}</b> (${esc(p.lic.name || p.lic.email || p.lic.key)}, ${esc(p.lic.plan)}): `
      + [p.stale ? `last report ${ago(p.age)}` : '', p.failing ? `failing — ${esc(p.failing.join('; ') || 'overall check failed')}` : '']
        .filter(Boolean).join(', ') + '</li>').join('');
    const expRows = expiring.map((e) => `<li><b>${esc(e.lic.name || e.lic.email || e.lic.key)}</b> ${esc(e.lic.key)} (${esc(e.lic.plan)}) `
      + `expires in ${e.days} day${e.days === 1 ? '' : 's'}</li>`).join('');
    const html = (problems.length ? `<h3>Sites needing attention (${problems.length})</h3><ul>${siteRows}</ul>` : '')
      + (expiring.length ? `<h3>Licenses expiring within 7 days (${expiring.length})</h3><ul>${expRows}</ul>` : '')
      + '<p>Details: secondsethq.com/tools/connector-admin.html</p>';
    const text = [
      ...problems.map((p) => `SITE ${p.host}: ${p.stale ? 'last report ' + ago(p.age) : ''}${p.failing ? ' failing: ' + p.failing.join('; ') : ''}`),
      ...expiring.map((e) => `EXPIRING ${e.lic.key} (${e.lic.name || e.lic.email}) in ${e.days}d`),
    ].join('\n');

    const sent = await makeMailer({ fetch, env })({
      to: env.ALERT_EMAIL,
      subject: `Connector daily watch: ${problems.length} site issue${problems.length === 1 ? '' : 's'}, ${expiring.length} expiring`,
      html,
      text,
    });
    return { sent, problems: problems.length, expiring: expiring.length };
  };
}

export default async () => {
  const watch = makeWatch({ getStore: await realGetStore(), fetch: globalThis.fetch, env: process.env });
  try {
    const r = await watch();
    console.log('[connector-watch]', JSON.stringify(r));
  } catch (e) {
    console.error('[connector-watch]', e);
  }
  return new Response('ok');
};
