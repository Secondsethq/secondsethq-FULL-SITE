/**
 * Second Set Connector for InkSoft: license, update and health server.
 *
 * URL: https://secondsethq.com/.netlify/functions/connector?action=<action>
 * Spec: the "Server" section of the plugin build contract. See CONNECTOR.md for setup.
 *
 * Structure: makeHandler({ getStore, fetch, env, now }) builds the request handler with its
 * dependencies injected, so tests can run it against an in-memory store. The default export
 * wires the real Netlify Blobs store, global fetch and process.env.
 *
 * Stores (Netlify Blobs):
 *   licenses  key "SS-XXXX-..."  → license record (JSON)
 *   health    host               → { host, key, latest, history[<=14] }
 *   releases  "latest.json"      → release meta, "latest.zip" → plugin zip (binary)
 *   meta      "status"           → { message, updated }; "stripe-sub/<id>" → license key index
 */

import crypto from 'node:crypto';

export const PLANS = ['basic', 'premium'];
export const STATUSES = ['active', 'past_due', 'canceled', 'expired', 'suspended'];
const WORKING = ['active', 'past_due'];
const HISTORY_LEN = 14;
export const STALE_MS = 36 * 3600 * 1000;
const LIMIT_RELEASE = 8 * 1024 * 1024;
const LIMIT_DEFAULT = 64 * 1024;
const LIMIT_STRIPE = 256 * 1024; // Stripe event payloads can exceed 64 KB; they are signature-checked.
const STRIPE_TOLERANCE_S = 300;
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars: no I, O, 0, 1
const ZIP_NAME = 'second-set-inksoft-connector.zip';
const PUBLIC_BASE = 'https://secondsethq.com/.netlify/functions/connector';

/* ------------------------------------------------------------------ helpers */

/** Lowercase host only: strips scheme, path, port, "www." and a trailing dot. */
export function normalizeHost(input) {
  let h = String(input || '').trim().toLowerCase();
  if (!h) return '';
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  h = h.replace(/^[^@/]*@/, '');                 // userinfo
  h = h.split(/[/?#]/)[0];                       // path, query, fragment
  if (h.startsWith('[')) {                       // [ipv6]:port
    h = h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined);
  } else {
    h = h.replace(/:\d*$/, '');
  }
  h = h.replace(/\.+$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9.:_-]{1,253}$/.test(h)) return '';
  return h;
}

/** Staging/local hosts never use a seat. */
export function isStagingHost(host) {
  const h = normalizeHost(host);
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (h.startsWith('staging.')) return true;
  return ['.wpengine.com', '.wpenginepowered.com', '.local', '.test', '.playground.wordpress.net', '.localhost']
    .some((suffix) => h.endsWith(suffix));
}

export function generateKey() {
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += KEY_ALPHABET[bytes[i] % 32]; // 256 % 32 === 0, so no bias
  return `SS-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`;
}

export function normalizeKey(k) {
  return String(k || '').trim().toUpperCase().replace(/\s+/g, '');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function str(v, max = 200) {
  return v === undefined || v === null ? '' : String(v).trim().slice(0, max);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Accepts "YYYY-MM-DD" or any ISO date; returns ISO string or null. Throws on garbage. */
function parseExpires(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59Z` : s);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid expiry date.');
  return d.toISOString();
}

function clampSites(v, fallback = 1) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1000, n));
}

/** Status after applying the expiry date. */
export function effectiveStatus(lic, nowMs) {
  if (!lic) return 'invalid';
  if (lic.status === 'active' || lic.status === 'past_due') {
    if (lic.expires && Date.parse(lic.expires) <= nowMs) return 'expired';
  }
  return lic.status;
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readBody(req, limit) {
  const len = parseInt(req.headers.get('content-length') || '0', 10);
  if (len > limit) throw new HttpError(413, 'Request body too large.');
  const text = await req.text();
  if (Buffer.byteLength(text) > limit) throw new HttpError(413, 'Request body too large.');
  return text;
}

function parseJSON(text) {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    throw new HttpError(400, 'Body must be JSON.');
  }
}

/* ------------------------------------------------------------------ email */

export function makeMailer({ fetch, env }) {
  /** Sends via Resend. Never throws; returns true on success. */
  return async function sendEmail({ to, subject, html, text }) {
    const apiKey = env.RESEND_API_KEY;
    const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
    if (!apiKey || !recipients.length) return false;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: env.ALERT_FROM || 'Second Set <alerts@secondsethq.com>',
          to: recipients,
          subject,
          html,
          text,
        }),
      });
      return !!(res && res.ok);
    } catch {
      return false;
    }
  };
}

/* ------------------------------------------------------------------ handler */

export function makeHandler({ getStore, fetch, env = {}, now = () => Date.now() }) {
  const stores = {};
  const store = (name) => (stores[name] ||= getStore(name));
  const licenses = () => store('licenses');
  const health = () => store('health');
  const releases = () => store('releases');
  const meta = () => store('meta');
  const sendEmail = makeMailer({ fetch, env });
  const iso = () => new Date(now()).toISOString();

  async function getLicense(key) {
    const k = normalizeKey(key);
    if (!/^SS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(k)) return null;
    return (await licenses().get(k, { type: 'json' })) || null;
  }

  async function saveLicense(lic) {
    lic.updated = iso();
    await licenses().setJSON(lic.key, lic);
    if (lic.stripe_subscription) await meta().setJSON(`stripe-sub/${lic.stripe_subscription}`, { key: lic.key });
    return lic;
  }

  async function allLicenses() {
    const { blobs } = await licenses().list();
    const out = [];
    for (const b of blobs) {
      const lic = await licenses().get(b.key, { type: 'json' });
      if (lic) out.push(lic);
    }
    return out;
  }

  async function statusMessage() {
    const m = await meta().get('status', { type: 'json' });
    return (m && m.message) || '';
  }

  async function createLicense(fields) {
    const plan = fields.plan;
    if (!PLANS.includes(plan)) throw new HttpError(400, 'plan must be basic or premium.');
    let key;
    for (let i = 0; i < 5; i++) {
      key = generateKey();
      if (!(await licenses().get(key, { type: 'json' }))) break;
    }
    const lic = {
      key,
      plan,
      status: 'active',
      email: str(fields.email, 254),
      name: str(fields.name),
      note: str(fields.note, 1000),
      sites: [],
      staging_sites: [],
      site_info: {},
      max_sites: clampSites(fields.max_sites ?? 1),
      created: iso(),
      expires: parseExpires(fields.expires),
      stripe_customer: str(fields.stripe_customer) || null,
      stripe_subscription: str(fields.stripe_subscription) || null,
    };
    if (fields.stripe_session) lic.stripe_session = str(fields.stripe_session);
    return saveLicense(lic);
  }

  /** Public shape for activate/check. */
  function licenseReply(lic, extra = {}) {
    const status = effectiveStatus(lic, now());
    const works = WORKING.includes(status);
    return {
      ok: works,
      plan: works ? lic.plan : 'none',
      license_plan: lic.plan,
      status,
      expires: lic.expires || null,
      sites: lic.sites.length,
      max_sites: lic.max_sites,
      site_list: lic.sites,
      message: works
        ? (status === 'past_due' ? 'Your last payment failed. Update your billing details to keep Premium features and updates.' : 'License active.')
        : `This license is ${status.replace('_', ' ')}. Renew at secondsethq.com to turn Premium features and updates back on.`,
      ...extra,
    };
  }

  function invalidReply(message = 'License key not found. Check the key and try again.') {
    return { ok: false, plan: 'none', status: 'invalid', expires: null, sites: 0, message };
  }

  function recordSiteInfo(lic, host, p) {
    lic.site_info ||= {};
    lic.site_info[host] = {
      version: str(p.version, 32), wp: str(p.wp, 32), php: str(p.php, 32), last_seen: iso(),
    };
    // Keep site_info bounded: drop hosts that are no longer bound and not seen for 60 days.
    for (const [h, info] of Object.entries(lic.site_info)) {
      if (!lic.sites.includes(h) && Date.parse(info.last_seen) < now() - 60 * 86400000) delete lic.site_info[h];
    }
  }

  /* ---------------- public actions */

  async function activate(p, { bind }) {
    const lic = await getLicense(p.key);
    if (!lic) return invalidReply();
    const host = normalizeHost(p.site);
    if (!host) return { ...licenseReply(lic), ok: false, plan: 'none', message: 'Missing or invalid site host.' };

    // Persist an expiry the first time we notice it.
    const status = effectiveStatus(lic, now());
    if (status !== lic.status) { lic.status = status; await saveLicense(lic); }
    if (!WORKING.includes(status)) return licenseReply(lic);

    const staging = isStagingHost(host);
    if (staging) {
      lic.staging_sites ||= [];
      if (!lic.staging_sites.includes(host)) lic.staging_sites = [host, ...lic.staging_sites].slice(0, 20);
      recordSiteInfo(lic, host, p);
      await saveLicense(lic);
      return licenseReply(lic, { staging: true, message: 'Staging/local site: active, does not use a seat.' });
    }

    if (!lic.sites.includes(host)) {
      if (!bind) {
        return { ...licenseReply(lic), ok: false, plan: 'none', bound: false,
          message: `This key is not activated on ${host}. Activate it again from the plugin's License screen.` };
      }
      if (lic.sites.length >= lic.max_sites) {
        return { ...licenseReply(lic), ok: false, plan: 'none', bound: false,
          message: `This key is already in use on ${lic.sites.join(', ') || 'the maximum number of sites'} (${lic.max_sites} site${lic.max_sites === 1 ? '' : 's'} allowed). Deactivate it there first, or contact Second Set for another seat.` };
      }
      lic.sites.push(host);
    }
    recordSiteInfo(lic, host, p);
    await saveLicense(lic);
    return licenseReply(lic, { bound: true });
  }

  async function deactivate(p) {
    const lic = await getLicense(p.key);
    if (!lic) return { ok: false, message: 'License key not found.' };
    const host = normalizeHost(p.site);
    lic.sites = lic.sites.filter((s) => s !== host);
    lic.staging_sites = (lic.staging_sites || []).filter((s) => s !== host);
    await saveLicense(lic);
    return { ok: true, sites: lic.sites.length };
  }

  async function update(p) {
    const rel = await releases().get('latest.json', { type: 'json' });
    const lic = await getLicense(p.key);
    const works = lic && WORKING.includes(effectiveStatus(lic, now()));
    if (!rel) {
      return { ok: false, version: null, requires: null, requires_php: null, tested: null, changelog_html: '', package: null,
        message: 'No release has been published yet.' };
    }
    const key = lic ? lic.key : '';
    const site = normalizeHost(p.site);
    const base = env.CONNECTOR_PUBLIC_URL || PUBLIC_BASE;
    return {
      ok: true,
      version: rel.version,
      requires: rel.requires || '',
      requires_php: rel.requires_php || '',
      tested: rel.tested || '',
      changelog_html: rel.changelog_html || '',
      released: rel.uploaded || null,
      update_available: p.version ? compareVersions(rel.version, str(p.version, 32)) > 0 : null,
      package: works
        ? `${base}?action=download&key=${encodeURIComponent(key)}&site=${encodeURIComponent(site)}`
        : null,
      license_status: lic ? effectiveStatus(lic, now()) : 'invalid',
    };
  }

  async function download(p) {
    const lic = await getLicense(p.key);
    if (!lic || !WORKING.includes(effectiveStatus(lic, now()))) {
      return json({ ok: false, message: 'A valid, active license key is required to download updates.' }, 403);
    }
    const zip = await releases().get('latest.zip', { type: 'arrayBuffer' });
    if (!zip) return json({ ok: false, message: 'No release has been published yet.' }, 404);
    return new Response(zip, {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${ZIP_NAME}"`,
        'content-length': String(zip.byteLength),
        'cache-control': 'no-store',
      },
    });
  }

  function cleanChecks(checks) {
    const out = {};
    if (!checks || typeof checks !== 'object') return out;
    for (const [name, c] of Object.entries(checks).slice(0, 12)) {
      const n = str(name, 40).replace(/[^a-z0-9_-]/gi, '');
      if (!n || !c || typeof c !== 'object') continue;
      out[n] = { ok: !!c.ok, ms: Number.isFinite(+c.ms) ? Math.round(+c.ms) : null, msg: str(c.msg, 300) };
    }
    return out;
  }

  async function healthReport(p) {
    const status_message = await statusMessage();
    const lic = await getLicense(p.key);
    const host = normalizeHost(p.site);
    if (!lic || !host) return { ok: false, status_message, message: 'Unknown license key or site.' };

    const checks = cleanChecks(p.checks);
    const reportOk = p.ok === undefined ? Object.values(checks).every((c) => c.ok) : !!p.ok;
    const report = { at: iso(), ok: reportOk, version: str(p.version, 32), checks };

    const prev = await health().get(host, { type: 'json' });
    const history = [report, ...((prev && prev.history) || [])].slice(0, HISTORY_LEN);
    await health().setJSON(host, { host, key: lic.key, staging: isStagingHost(host), latest: report, history });

    const wasOk = !prev || !prev.latest || prev.latest.ok !== false;
    if (!reportOk && wasOk && env.ALERT_EMAIL) {
      const failing = Object.entries(checks).filter(([, c]) => !c.ok);
      const rows = failing.map(([n, c]) => `<li><b>${esc(n)}</b>: ${esc(c.msg || 'failed')}</li>`).join('');
      await sendEmail({
        to: env.ALERT_EMAIL,
        subject: `Connector health: ${host} is failing`,
        html: `<p><b>${esc(host)}</b> (${esc(lic.name || lic.email || lic.key)}, ${esc(lic.plan)}) reported a failing health check`
          + ` on plugin ${esc(report.version || '?')}.</p><ul>${rows || '<li>Overall check failed.</li>'}</ul>`
          + `<p>You won't get another alert for this site until it recovers and fails again.</p>`,
        text: `${host} reported a failing health check.\n`
          + failing.map(([n, c]) => `- ${n}: ${c.msg || 'failed'}`).join('\n'),
      });
    }
    return { ok: true, status_message };
  }

  /* ---------------- admin actions */

  function requireAdmin(req) {
    const token = env.ADMIN_TOKEN;
    if (!token) throw new HttpError(503, 'Admin access is not configured (ADMIN_TOKEN is not set).');
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || '');
    if (!m || !safeEqual(m[1].trim(), token)) throw new HttpError(401, 'Unauthorized.');
  }

  function adminView(lic) {
    return { ...lic, status_effective: effectiveStatus(lic, now()) };
  }

  async function adminList(p) {
    const q = str(p.q).toLowerCase();
    let list = await allLicenses();
    if (q) {
      list = list.filter((l) => [l.key, l.email, l.name, l.note, ...(l.sites || []), l.stripe_customer, l.stripe_subscription]
        .some((v) => v && String(v).toLowerCase().includes(q)));
    }
    list.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    return { ok: true, licenses: list.map(adminView) };
  }

  async function adminUpdate(p) {
    const lic = await getLicense(p.key);
    if (!lic) throw new HttpError(404, 'License key not found.');
    if (p.status !== undefined) {
      if (!STATUSES.includes(p.status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}.`);
      lic.status = p.status;
    }
    if (p.plan !== undefined) {
      if (!PLANS.includes(p.plan)) throw new HttpError(400, 'plan must be basic or premium.');
      lic.plan = p.plan;
    }
    for (const f of ['email', 'name', 'note']) if (p[f] !== undefined) lic[f] = str(p[f], f === 'note' ? 1000 : 254);
    if (p.max_sites !== undefined) lic.max_sites = clampSites(p.max_sites, lic.max_sites);
    if (p.expires !== undefined) {
      try { lic.expires = parseExpires(p.expires); } catch (e) { throw new HttpError(400, e.message); }
    }
    if (p.reset_sites || (Array.isArray(p.sites) && p.sites.length === 0)) { lic.sites = []; lic.staging_sites = []; }
    else if (Array.isArray(p.sites)) lic.sites = [...new Set(p.sites.map(normalizeHost).filter(Boolean))];
    if (p.remove_site) {
      const h = normalizeHost(p.remove_site);
      lic.sites = lic.sites.filter((s) => s !== h);
    }
    if (p.stripe_customer !== undefined) lic.stripe_customer = str(p.stripe_customer) || null;
    if (p.stripe_subscription !== undefined) lic.stripe_subscription = str(p.stripe_subscription) || null;
    await saveLicense(lic);
    return { ok: true, license: adminView(lic) };
  }

  async function adminRelease(p) {
    const version = str(p.version, 32);
    if (!/^\d+\.\d+(\.\d+)?([-.+][0-9A-Za-z.-]+)?$/.test(version)) throw new HttpError(400, 'version must look like 1.2.3.');
    const b64 = String(p.zip_base64 || '').replace(/^data:[^,]*,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new HttpError(400, 'zip_base64 is not a zip file.');
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const relMeta = {
      version,
      requires: str(p.requires, 16),
      requires_php: str(p.requires_php, 16),
      tested: str(p.tested, 16),
      changelog_html: String(p.changelog_html || '').slice(0, 100000),
      uploaded: iso(),
      size: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    };
    await releases().set('latest.zip', ab);
    await releases().setJSON('latest.json', relMeta);
    return { ok: true, release: relMeta };
  }

  async function adminHealth() {
    const [list, { blobs }] = await Promise.all([allLicenses(), health().list()]);
    const byKey = Object.fromEntries(list.map((l) => [l.key, l]));
    const seen = new Set();
    const sites = [];
    for (const b of blobs) {
      const h = await health().get(b.key, { type: 'json' });
      if (!h) continue;
      seen.add(h.host);
      const lic = byKey[h.key];
      const age = h.latest ? now() - Date.parse(h.latest.at) : null;
      sites.push({
        host: h.host,
        key: h.key,
        name: lic ? lic.name : '',
        plan: lic ? lic.plan : null,
        license_status: lic ? effectiveStatus(lic, now()) : 'invalid',
        staging: isStagingHost(h.host),
        bound: !!(lic && lic.sites.includes(h.host)),
        version: h.latest ? h.latest.version : '',
        last_report: h.latest ? h.latest.at : null,
        age_ms: age,
        stale: age === null || age > STALE_MS,
        ok: h.latest ? h.latest.ok : null,
        checks: h.latest ? h.latest.checks : {},
        history: (h.history || []).map((r) => ({ at: r.at, ok: r.ok })),
      });
    }
    // Licensed sites that have never reported.
    for (const lic of list) {
      for (const host of lic.sites || []) {
        if (seen.has(host)) continue;
        sites.push({ host, key: lic.key, name: lic.name, plan: lic.plan, license_status: effectiveStatus(lic, now()),
          staging: false, bound: true, version: (lic.site_info?.[host]?.version) || '', last_report: null, age_ms: null,
          stale: true, ok: null, checks: {}, history: [], never: true });
      }
    }
    sites.sort((a, b) => (a.ok === false ? -1 : 0) - (b.ok === false ? -1 : 0) || Number(b.stale) - Number(a.stale) || a.host.localeCompare(b.host));
    return { ok: true, stale_after_hours: 36, sites };
  }

  async function adminStatus(p) {
    const message = str(p.message, 500);
    await meta().setJSON('status', { message, updated: iso() });
    return { ok: true, message };
  }

  /* ---------------- Stripe */

  function verifyStripe(raw, header) {
    const secret = env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new HttpError(503, 'STRIPE_WEBHOOK_SECRET is not set.');
    const parts = String(header || '').split(',').map((s) => s.trim().split('='));
    const t = parts.find(([k]) => k === 't')?.[1];
    const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
    if (!t || !sigs.length) throw new HttpError(400, 'Missing Stripe signature.');
    if (Math.abs(now() / 1000 - Number(t)) > STRIPE_TOLERANCE_S) throw new HttpError(400, 'Stripe signature timestamp outside tolerance.');
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    if (!sigs.some((s) => safeEqual(s, expected))) throw new HttpError(400, 'Invalid Stripe signature.');
  }

  async function licenseForStripe({ subscription, licenseKey }) {
    if (licenseKey) {
      const lic = await getLicense(licenseKey);
      if (lic) return lic;
    }
    if (!subscription) return null;
    const idx = await meta().get(`stripe-sub/${subscription}`, { type: 'json' });
    if (idx) {
      const lic = await getLicense(idx.key);
      if (lic) return lic;
    }
    return (await allLicenses()).find((l) => l.stripe_subscription === subscription) || null;
  }

  function mapSubStatus(s) {
    if (s === 'active' || s === 'trialing') return 'active';
    if (s === 'past_due' || s === 'unpaid') return 'past_due';
    if (s === 'canceled' || s === 'incomplete_expired') return 'canceled';
    if (s === 'paused') return 'suspended';
    return null; // incomplete etc.: leave as is
  }

  async function setStripeStatus(lic, status, extra = {}) {
    if (!lic || !status) return false;
    if (lic.status === 'suspended' && lic.suspended_by !== 'stripe') return false; // manual suspension wins
    lic.status = status;
    lic.suspended_by = status === 'suspended' ? 'stripe' : undefined;
    Object.assign(lic, extra);
    await saveLicense(lic);
    return true;
  }

  async function stripeWebhook(req) {
    const raw = await readBody(req, LIMIT_STRIPE);
    verifyStripe(raw, req.headers.get('stripe-signature'));
    const event = parseJSON(raw);
    const obj = event.data && event.data.object ? event.data.object : {};
    const result = { ok: true, received: true, type: event.type || '' };

    switch (event.type) {
      case 'checkout.session.completed': {
        const plan = obj.metadata && obj.metadata.plan;
        if (!PLANS.includes(plan)) { result.ignored = 'no metadata.plan'; break; }
        const subscription = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id || null;
        const customer = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id || null;
        // Idempotency: Stripe retries webhooks.
        const existing = subscription ? await licenseForStripe({ subscription }) : null;
        const dup = existing || (await allLicenses()).find((l) => l.stripe_session && l.stripe_session === obj.id);
        if (dup) { result.license = dup.key; result.duplicate = true; break; }
        const email = obj.customer_details?.email || obj.customer_email || '';
        const name = obj.customer_details?.name || '';
        const lic = await createLicense({
          plan, email, name,
          note: `Stripe checkout ${obj.id || ''}`.trim(),
          max_sites: obj.metadata.max_sites || 1,
          stripe_customer: customer, stripe_subscription: subscription, stripe_session: obj.id,
        });
        result.license = lic.key;
        if (email) {
          const planLabel = plan === 'premium' ? 'Premium' : 'Basic';
          await sendEmail({
            to: email,
            subject: 'Your Second Set Connector for InkSoft license key',
            html: `<p>Hi${name ? ' ' + esc(name.split(' ')[0]) : ''},</p>`
              + `<p>Thanks for buying the Second Set Connector for InkSoft (${planLabel}). Your license key:</p>`
              + `<p style="font:600 18px/1.4 monospace;letter-spacing:.04em">${esc(lic.key)}</p>`
              + `<p>In WordPress, open <b>Second Set &rarr; License</b>, paste the key and click Activate. `
              + `It covers ${lic.max_sites} live site${lic.max_sites === 1 ? '' : 's'}; staging and local copies don't count.</p>`
              + `<p>Questions? Just reply to this email.</p><p>Second Set</p>`,
            text: `Thanks for buying the Second Set Connector for InkSoft (${planLabel}).\n\nYour license key: ${lic.key}\n\n`
              + `In WordPress, open Second Set > License, paste the key and click Activate.\n`,
          });
          if (env.ALERT_EMAIL) {
            await sendEmail({ to: env.ALERT_EMAIL, subject: `New ${planLabel} license: ${email}`,
              html: `<p>${esc(name)} &lt;${esc(email)}&gt; bought ${planLabel}. Key ${esc(lic.key)}.</p>`,
              text: `${name} <${email}> bought ${planLabel}. Key ${lic.key}.` });
          }
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const lic = await licenseForStripe({ subscription: obj.id, licenseKey: obj.metadata?.license_key });
        const status = event.type === 'customer.subscription.deleted' ? 'canceled' : mapSubStatus(obj.status);
        const extra = {};
        const periodEnd = obj.current_period_end || obj.items?.data?.[0]?.current_period_end;
        if (periodEnd) extra.current_period_end = new Date(periodEnd * 1000).toISOString();
        result.license = lic ? lic.key : null;
        result.changed = await setStripeStatus(lic, status, extra);
        break;
      }
      case 'invoice.payment_failed':
      case 'invoice.paid': {
        const subscription = (typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id)
          || obj.parent?.subscription_details?.subscription || null;
        const licenseKey = obj.subscription_details?.metadata?.license_key
          || obj.parent?.subscription_details?.metadata?.license_key || obj.metadata?.license_key;
        const lic = await licenseForStripe({ subscription, licenseKey });
        result.license = lic ? lic.key : null;
        // A late invoice.paid must not resurrect a canceled subscription.
        if (lic && !(event.type === 'invoice.paid' && lic.status === 'canceled')) {
          result.changed = await setStripeStatus(lic, event.type === 'invoice.paid' ? 'active' : 'past_due');
        }
        break;
      }
      default:
        result.ignored = 'event type not handled';
    }
    return json(result);
  }

  /* ---------------- router */

  const PUBLIC_POST = ['activate', 'check', 'deactivate', 'health'];
  const PUBLIC_GET = ['update', 'download', 'status'];
  const ADMIN = ['admin_list', 'admin_create', 'admin_update', 'admin_release', 'admin_health', 'admin_status'];

  return async function handler(req) {
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || '';
    const method = req.method.toUpperCase();
    const query = Object.fromEntries(url.searchParams.entries());

    try {
      if (action === 'status') {
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' };
        if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        return json({ ok: true, message: await statusMessage() }, 200, cors);
      }
      if (method === 'OPTIONS') return new Response(null, { status: 204 });
      if (action === 'stripe') {
        if (method !== 'POST') throw new HttpError(405, 'POST only.');
        return await stripeWebhook(req);
      }

      const isKnown = PUBLIC_POST.includes(action) || PUBLIC_GET.includes(action) || ADMIN.includes(action);
      if (!isKnown) return json({ ok: false, message: 'Unknown action.' }, 404);

      if (ADMIN.includes(action)) requireAdmin(req);

      // Params: query string merged with JSON body (body wins). GET/POST are both accepted for
      // public actions so a plugin using wp_remote_get/post interchangeably still works.
      let params = query;
      if (method === 'POST' || method === 'PUT') {
        const raw = await readBody(req, action === 'admin_release' ? LIMIT_RELEASE : LIMIT_DEFAULT);
        params = { ...query, ...parseJSON(raw) };
      } else if (method !== 'GET' && method !== 'HEAD') {
        throw new HttpError(405, 'Method not allowed.');
      }
      const WRITES = ['admin_create', 'admin_update', 'admin_release', 'admin_status'];
      if (WRITES.includes(action) && method !== 'POST') throw new HttpError(405, 'POST only.');

      switch (action) {
        case 'activate': return json(await activate(params, { bind: true }));
        case 'check': return json(await activate(params, { bind: false }));
        case 'deactivate': return json(await deactivate(params));
        case 'update': return json(await update(params));
        case 'download': return await download(params);
        case 'health': return json(await healthReport(params));
        case 'admin_list': return json(await adminList(params));
        case 'admin_create': {
          let lic;
          try { lic = await createLicense(params); } catch (e) {
            if (e instanceof HttpError) throw e;
            throw new HttpError(400, e.message);
          }
          return json({ ok: true, license: adminView(lic) });
        }
        case 'admin_update': return json(await adminUpdate(params));
        case 'admin_release': return json(await adminRelease(params));
        case 'admin_health': return json(await adminHealth());
        case 'admin_status': return json(await adminStatus(params));
      }
      return json({ ok: false, message: 'Unknown action.' }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ ok: false, message: e.message }, e.status);
      console.error('[connector]', action, e);
      return json({ ok: false, message: 'Server error.' }, 500);
    }
  };
}

export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Real store factory: strong consistency so an activation is visible to the next check. */
export async function realGetStore() {
  const { getStore } = await import('@netlify/blobs');
  return (name) => getStore({ name, consistency: 'strong' });
}

// Built per request: Blobs credentials are scoped to the invocation, so stores are not reused.
export default async (req, context) => {
  const handler = makeHandler({ getStore: await realGetStore(), fetch: globalThis.fetch, env: process.env, now: () => Date.now() });
  return handler(req, context);
};
