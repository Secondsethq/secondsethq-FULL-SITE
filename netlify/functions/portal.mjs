/**
 * Second Set client portal: login, client data, live Stripe billing, files and admin.
 *
 * URL: https://secondsethq.com/.netlify/functions/portal?action=<action>
 * Client page: /portal   Admin page: /tools/portal-admin.html   Setup: PORTAL.md
 *
 * Structure matches connector.mjs: makeHandler({ getStore, fetch, env, now }) builds the
 * handler with its dependencies injected, so tests run it against an in-memory store.
 *
 * Stores (Netlify Blobs):
 *   portal-clients   key <clientId>                 → client record (JSON)
 *   portal-auth      key login/<sha256(token)>     → { clientId, email, expires }  (one-time link)
 *                    key session/<sha256(token)>   → { clientId, email, expires }
 *                    key rate/<email>              → { count, windowStart }
 *   portal-files     key <clientId>/<fileId>/meta  → { id, name, type, size, chunks, uploaded }
 *                    key <clientId>/<fileId>/<n>   → bytes of chunk n
 *
 * Security model: a session only ever resolves to one clientId, and every client read goes
 * through that id. Nothing a client sends can name another client. File reads check the
 * file lives under the session's client. Admin actions need ADMIN_TOKEN.
 */

import crypto from 'node:crypto';

const LOGIN_TTL_MS = 20 * 60 * 1000;          // email link lifetime
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;  // stay logged in 30 days
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;                            // login emails per address per hour
export const CHUNK_BYTES = 4 * 1024 * 1024;    // Netlify caps request/response bodies near 6 MB
const LIMIT_JSON = 512 * 1024;
const LIMIT_CHUNK = CHUNK_BYTES + 1024;
const MAX_FILE_BYTES = 500 * 1024 * 1024;
const COOKIE = 'ss_portal';
const SITE = 'https://secondsethq.com';

export const COVERAGE = ['included', 'billed', 'free'];
export const OWNERS = ['client', 'secondset'];

/* ------------------------------------------------------------------ helpers */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });
}

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function token() { return crypto.randomBytes(32).toString('base64url'); }

function str(v, max = 300) {
  return v === undefined || v === null ? '' : String(v).trim().slice(0, max);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function normEmail(e) {
  const s = str(e, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
}

export function slug(s) {
  return str(s, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function newId() { return crypto.randomBytes(6).toString('hex'); }

async function readText(req, limit) {
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

function getCookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

function sessionCookie(value, maxAgeS) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeS}`;
}

/** A link is either one of the client's uploaded files or an https URL. */
function cleanLink(l) {
  if (!l || typeof l !== 'object') return null;
  const label = str(l.label, 80);
  const fileId = /^[a-f0-9]{12}$/.test(String(l.fileId || '')) ? String(l.fileId) : '';
  const url = /^https:\/\/[^\s"'<>]+$/i.test(String(l.url || '')) ? str(l.url, 600) : '';
  if (!fileId && !url) return null;
  return { label: label || 'Open', ...(fileId ? { fileId } : { url }) };
}
function cleanLinks(a) { return (Array.isArray(a) ? a : []).map(cleanLink).filter(Boolean).slice(0, 12); }
function list(a, max = 300) { return Array.isArray(a) ? a.slice(0, max) : []; }
function itemId(v) { return /^[a-z0-9-]{1,40}$/.test(String(v || '')) ? String(v) : newId(); }

/** Validates and normalizes a client record from the admin page. Unknown keys are dropped. */
export function cleanClient(input, existing = {}) {
  const c = input || {};
  const id = slug(c.id || existing.id || c.name);
  if (!id) throw new HttpError(400, 'Client needs a name.');
  const emails = [...new Set(list(c.emails, 10).map(normEmail).filter(Boolean))];
  return {
    id,
    name: str(c.name, 120),
    business: str(c.business, 120),
    greeting: str(c.greeting, 60),
    emails,
    stripeCustomerId: /^cus_[A-Za-z0-9]+$/.test(String(c.stripeCustomerId || '')) ? String(c.stripeCustomerId) : '',
    vaultUrl: /^https:\/\/[^\s"'<>]+$/i.test(String(c.vaultUrl || '')) ? str(c.vaultUrl, 600) : '',
    services: { ads: !!(c.services && c.services.ads) },
    headline: str(c.headline, 200),
    updated: str(c.updated, 40),
    todos: list(c.todos).map((t) => ({
      id: itemId(t.id),
      owner: OWNERS.includes(t.owner) ? t.owner : 'client',
      who: str(t.who, 40),
      title: str(t.title, 160),
      detail: str(t.detail, 600),
      done: !!t.done,
      doneDate: str(t.doneDate, 40),
      clientCanCheck: !!t.clientCanCheck,
      links: cleanLinks(t.links),
    })).filter((t) => t.title),
    deliverables: list(c.deliverables).map((d) => ({
      id: itemId(d.id),
      section: str(d.section, 80),
      date: str(d.date, 40),
      title: str(d.title, 160),
      detail: str(d.detail, 800),
      coverage: COVERAGE.includes(d.coverage) ? d.coverage : 'included',
      invoice: str(d.invoice, 40),
      inProgress: !!d.inProgress,
      links: cleanLinks(d.links),
    })).filter((d) => d.title),
    agreements: list(c.agreements, 40).map((a) => ({
      id: itemId(a.id),
      project: str(a.project, 120),
      status: str(a.status, 60),
      detail: str(a.detail, 600),
      links: cleanLinks(a.links),
    })).filter((a) => a.project),
    files: list(c.files).map((f) => ({
      id: itemId(f.id),
      section: str(f.section, 80),
      title: str(f.title, 160),
      detail: str(f.detail, 600),
      updated: str(f.updated, 40),
      links: cleanLinks(f.links),
    })).filter((f) => f.title),
    training: list(c.training).map((t) => {
      const v = String(t.video || '');
      return {
        id: itemId(t.id),
        section: str(t.section, 80),
        title: str(t.title, 160),
        detail: str(t.detail, 600),
        audience: str(t.audience, 60),
        video: youtubeId(v) ? `https://www.youtube.com/watch?v=${youtubeId(v)}` : '',
        links: cleanLinks(t.links),
      };
    }).filter((t) => t.title),
    logins: list(c.logins, 60).map((l) => ({
      service: str(l.service, 80),
      detail: str(l.detail, 160),
      loginEmail: str(l.loginEmail, 120),
      access: str(l.access, 160),
      owner: str(l.owner, 60),
      note: str(l.note, 300),
    })).filter((l) => l.service),
    reports: list(c.reports, 120).map((r) => ({
      id: itemId(r.id),
      period: str(r.period, 60),
      title: str(r.title, 160),
      summary: str(r.summary, 2000),
      links: cleanLinks(r.links),
    })).filter((r) => r.title),
  };
}

export function youtubeId(u) {
  const s = String(u || '').trim();
  const m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{11}$/.test(s) ? s : '';
}

/* ------------------------------------------------------------------ Stripe */

/** Turns Stripe invoices into what the portal shows. Drafts are "scheduled", void ones hidden. */
export function mapInvoices(invoices, nowMs) {
  const out = [];
  for (const inv of invoices || []) {
    if (!inv || ['void', 'uncollectible'].includes(inv.status)) continue;
    const lines = (inv.lines && inv.lines.data) || [];
    const parts = lines
      .map((l) => str(l.description, 200))
      .filter((d) => d && !/processing fee/i.test(d));
    const due = inv.due_date ? inv.due_date * 1000 : null;
    let state = inv.status;
    if (inv.status === 'open') state = due && due < nowMs - 24 * 3600 * 1000 ? 'overdue' : 'due';
    if (inv.status === 'draft') state = 'scheduled';
    out.push({
      id: inv.id,
      number: inv.number ? String(inv.number).split('-').pop() : '',
      description: parts.length ? parts.join(', ') : str(inv.description, 200).split('\n')[0],
      state,
      amount: inv.status === 'paid' ? inv.amount_paid : inv.amount_due,
      currency: inv.currency || 'usd',
      due: due ? new Date(due).toISOString() : null,
      paidAt: inv.status_transitions && inv.status_transitions.paid_at ? new Date(inv.status_transitions.paid_at * 1000).toISOString() : null,
      url: inv.status === 'draft' ? '' : str(inv.hosted_invoice_url, 600),
      pdf: inv.status === 'draft' ? '' : str(inv.invoice_pdf, 600),
    });
  }
  return out;
}

export function billingSummary(rows) {
  const sum = (f) => rows.filter(f).reduce((a, r) => a + (r.amount || 0), 0);
  const isOpen = (r) => r.state === 'due' || r.state === 'overdue';
  return {
    dueNow: sum(isOpen),
    dueNowCount: rows.filter(isOpen).length,
    scheduled: sum((r) => r.state === 'scheduled'),
    scheduledCount: rows.filter((r) => r.state === 'scheduled').length,
    paid: sum((r) => r.state === 'paid'),
    paidCount: rows.filter((r) => r.state === 'paid').length,
    totalOwed: sum((r) => isOpen(r) || r.state === 'scheduled'),
  };
}

/* ------------------------------------------------------------------ email */

function makeMailer({ fetch, env }) {
  return async function sendEmail({ to, subject, html, text }) {
    if (!env.RESEND_API_KEY || !to) return false;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: env.PORTAL_FROM || env.ALERT_FROM || 'Second Set <alerts@secondsethq.com>', to: [to], subject, html, text }),
      });
      return !!(res && res.ok);
    } catch {
      return false;
    }
  };
}

function loginEmail(link, name) {
  const hi = name ? `Hi ${esc(name)},` : 'Hi,';
  const html = `<!doctype html><html><body style="margin:0;background:#F0EFE9;font-family:Arial,Helvetica,sans-serif;color:#080505">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px">
<tr><td style="padding:32px 28px">
<p style="margin:0 0 16px;font-size:16px">${hi}</p>
<p style="margin:0 0 24px;font-size:16px;line-height:1.5">Here is your link to the Second Set client portal. It works once and expires in 20 minutes.</p>
<p style="margin:0 0 24px"><a href="${esc(link)}" style="display:inline-block;background:#117997;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 22px;border-radius:10px">Open my portal</a></p>
<p style="margin:0;font-size:13px;color:#6E635B;line-height:1.5">If you didn't ask for this, you can ignore this email. Nobody can get in without this link.</p>
</td></tr></table>
<p style="margin:16px 0 0;font-size:12px;color:#6E635B">Second Set · Vista, CA · secondsethq.com</p>
</td></tr></table></body></html>`;
  const text = `${name ? `Hi ${name},` : 'Hi,'}\n\nHere is your link to the Second Set client portal. It works once and expires in 20 minutes:\n\n${link}\n\nIf you didn't ask for this, you can ignore this email.\n\nSecond Set, Vista, CA`;
  return { html, text };
}

/* ------------------------------------------------------------------ handler */

export function makeHandler({ getStore, fetch, env = {}, now = () => Date.now() }) {
  const stores = {};
  const store = (name) => (stores[name] ||= getStore(name));
  const clients = () => store('portal-clients');
  const auth = () => store('portal-auth');
  const files = () => store('portal-files');
  const sendEmail = makeMailer({ fetch, env });
  const iso = () => new Date(now()).toISOString();
  const siteUrl = (env.PORTAL_URL || `${SITE}/portal`).replace(/\/+$/, '');

  async function getClient(id) {
    const k = slug(id);
    if (!k) return null;
    return (await clients().get(k, { type: 'json' })) || null;
  }

  async function allClients() {
    const { blobs } = await clients().list();
    const out = [];
    for (const b of blobs) {
      const c = await clients().get(b.key, { type: 'json' });
      if (c) out.push(c);
    }
    return out;
  }

  async function clientByEmail(email) {
    for (const c of await allClients()) if ((c.emails || []).includes(email)) return c;
    return null;
  }

  async function sessionFrom(req) {
    const t = getCookie(req, COOKIE);
    if (!t || t.length > 100) return null;
    const s = await auth().get(`session/${sha(t)}`, { type: 'json' });
    if (!s || Date.parse(s.expires) <= now()) return null;
    const client = await getClient(s.clientId);
    // Removing an email from a client ends that person's access straight away.
    if (!client || !(client.emails || []).includes(s.email)) return null;
    return { ...s, client, key: `session/${sha(t)}` };
  }

  async function requireSession(req) {
    const s = await sessionFrom(req);
    if (!s) throw new HttpError(401, 'Please log in.');
    return s;
  }

  function requireAdmin(req) {
    if (!env.ADMIN_TOKEN) throw new HttpError(503, 'Admin is not configured.');
    const h = req.headers.get('authorization') || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!t || !safeEqual(t, env.ADMIN_TOKEN)) throw new HttpError(401, 'Unauthorized.');
  }

  async function stripeInvoices(customerId) {
    if (!customerId) return { rows: [], error: '' };
    if (!env.STRIPE_SECRET_KEY) return { rows: [], error: 'Billing is not connected yet.' };
    try {
      const all = [];
      let after = '';
      for (let page = 0; page < 5; page++) {
        const qs = new URLSearchParams({ customer: customerId, limit: '100' });
        if (after) qs.set('starting_after', after);
        const res = await fetch(`https://api.stripe.com/v1/invoices?${qs}`, {
          headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
        });
        if (!res.ok) return { rows: [], error: 'Billing is unavailable right now.' };
        const body = await res.json();
        all.push(...(body.data || []));
        if (!body.has_more || !body.data.length) break;
        after = body.data[body.data.length - 1].id;
      }
      return { rows: mapInvoices(all, now()), error: '' };
    } catch {
      return { rows: [], error: 'Billing is unavailable right now.' };
    }
  }

  /** What a client is allowed to see: never emails list, Stripe id or internal ids. */
  async function clientView(client, viewerEmail) {
    const billing = await stripeInvoices(client.stripeCustomerId);
    const fileMeta = {};
    const fileIds = new Set();
    const collect = (links) => (links || []).forEach((l) => l.fileId && fileIds.add(l.fileId));
    for (const k of ['todos', 'deliverables', 'agreements', 'files', 'training', 'reports']) (client[k] || []).forEach((i) => collect(i.links));
    for (const fid of fileIds) {
      const m = await files().get(`${client.id}/${fid}/meta`, { type: 'json' });
      if (m) fileMeta[fid] = { name: m.name, size: m.size, type: m.type, chunks: m.chunks };
    }
    const services = client.services || {};
    return {
      viewer: viewerEmail || '',
      name: client.name,
      business: client.business,
      greeting: client.greeting || (client.name || '').split(' ')[0],
      headline: client.headline,
      updated: client.updated,
      vaultUrl: client.vaultUrl,
      services,
      todos: client.todos || [],
      deliverables: client.deliverables || [],
      agreements: client.agreements || [],
      files: client.files || [],
      training: client.training || [],
      logins: client.logins || [],
      reports: services.ads ? (client.reports || []) : [],
      fileMeta,
      invoices: billing.rows,
      billing: billingSummary(billing.rows),
      billingError: billing.error,
    };
  }

  /* ---- public actions ---- */

  async function loginRequest(params) {
    const email = normEmail(params.email);
    // Same answer whether or not the address exists, so nobody can probe for clients.
    const done = { ok: true, message: 'If that email is on file, a login link is on its way.' };
    if (!email) throw new HttpError(400, 'Enter a valid email address.');
    const rateKey = `rate/${sha(email)}`;
    const r = (await auth().get(rateKey, { type: 'json' })) || { count: 0, windowStart: now() };
    if (now() - r.windowStart > RATE_WINDOW_MS) { r.count = 0; r.windowStart = now(); }
    if (r.count >= RATE_MAX) return done;
    r.count += 1;
    await auth().setJSON(rateKey, r);
    const client = await clientByEmail(email);
    if (!client) return done;
    const t = token();
    await auth().setJSON(`login/${sha(t)}`, { clientId: client.id, email, expires: new Date(now() + LOGIN_TTL_MS).toISOString() });
    const link = `${siteUrl}#login=${t}`;
    const { html, text } = loginEmail(link, client.greeting || (client.name || '').split(' ')[0]);
    await sendEmail({ to: email, subject: 'Your Second Set portal link', html, text });
    return done;
  }

  async function loginVerify(params) {
    const t = str(params.token, 100);
    if (!t) throw new HttpError(400, 'Missing login link.');
    const key = `login/${sha(t)}`;
    const rec = await auth().get(key, { type: 'json' });
    await auth().delete(key); // one use, even if it turns out to be expired
    if (!rec || Date.parse(rec.expires) <= now()) throw new HttpError(401, 'This login link has expired or was already used. Request a new one.');
    const client = await getClient(rec.clientId);
    if (!client || !(client.emails || []).includes(rec.email)) throw new HttpError(401, 'This login link is no longer valid.');
    const s = token();
    await auth().setJSON(`session/${sha(s)}`, { clientId: client.id, email: rec.email, expires: new Date(now() + SESSION_TTL_MS).toISOString(), created: iso() });
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(s, Math.floor(SESSION_TTL_MS / 1000)) });
  }

  async function logout(req) {
    const s = await sessionFrom(req);
    if (s) await auth().delete(s.key);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  async function todoDone(req, params) {
    const s = await requireSession(req);
    const c = s.client;
    const t = (c.todos || []).find((x) => x.id === str(params.id, 40));
    if (!t || t.owner !== 'client' || !t.clientCanCheck) throw new HttpError(404, 'Item not found.');
    t.done = params.done !== false;
    t.doneDate = t.done ? iso().slice(0, 10) : '';
    await clients().setJSON(c.id, c);
    return { ok: true };
  }

  async function fileChunk(clientId, fileId, n) {
    if (!/^[a-f0-9]{12}$/.test(fileId)) throw new HttpError(404, 'File not found.');
    const meta = await files().get(`${clientId}/${fileId}/meta`, { type: 'json' });
    const i = parseInt(n, 10);
    if (!meta || !Number.isInteger(i) || i < 0 || i >= meta.chunks) throw new HttpError(404, 'File not found.');
    const buf = await files().get(`${clientId}/${fileId}/${i}`, { type: 'arrayBuffer' });
    if (!buf) throw new HttpError(404, 'File not found.');
    return new Response(buf, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store', 'x-chunks': String(meta.chunks) },
    });
  }

  /* ---- admin actions ---- */

  async function adminSave(params) {
    const incoming = params.client || {};
    const id = slug(incoming.id || incoming.name);
    const existing = id ? await getClient(id) : null;
    const c = cleanClient(incoming, existing || {});
    // An email may belong to only one client, or one person could log into two accounts.
    for (const other of await allClients()) {
      if (other.id === c.id) continue;
      const clash = c.emails.find((e) => (other.emails || []).includes(e));
      if (clash) throw new HttpError(409, `${clash} already belongs to ${other.name || other.id}.`);
    }
    await clients().setJSON(c.id, c);
    return { ok: true, client: c };
  }

  async function adminFileStart(params) {
    const c = await getClient(params.clientId);
    if (!c) throw new HttpError(404, 'Client not found.');
    const size = parseInt(params.size, 10);
    if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) throw new HttpError(400, 'File size is not allowed.');
    const chunks = Math.ceil(size / CHUNK_BYTES);
    const id = newId();
    const meta = { id, name: str(params.name, 160) || 'file', type: str(params.type, 100) || 'application/octet-stream', size, chunks, received: 0, uploaded: '' };
    await files().setJSON(`${c.id}/${id}/meta`, meta);
    return { ok: true, fileId: id, chunks, chunkBytes: CHUNK_BYTES };
  }

  async function adminFileChunk(req, query) {
    const clientId = slug(query.get('clientId'));
    const fileId = String(query.get('fileId') || '');
    const n = parseInt(query.get('n'), 10);
    if (!/^[a-f0-9]{12}$/.test(fileId)) throw new HttpError(404, 'File not found.');
    const meta = await files().get(`${clientId}/${fileId}/meta`, { type: 'json' });
    if (!meta || !Number.isInteger(n) || n < 0 || n >= meta.chunks) throw new HttpError(404, 'File not found.');
    const len = parseInt(req.headers.get('content-length') || '0', 10);
    if (len > LIMIT_CHUNK) throw new HttpError(413, 'Chunk too large.');
    const buf = await req.arrayBuffer();
    if (buf.byteLength > LIMIT_CHUNK || buf.byteLength === 0) throw new HttpError(413, 'Chunk size is not allowed.');
    await files().set(`${clientId}/${fileId}/${n}`, buf);
    meta.received = Math.max(meta.received || 0, n + 1);
    if (meta.received >= meta.chunks) meta.uploaded = iso();
    await files().setJSON(`${clientId}/${fileId}/meta`, meta);
    return { ok: true, done: !!meta.uploaded };
  }

  async function adminFiles(params) {
    const c = await getClient(params.clientId);
    if (!c) throw new HttpError(404, 'Client not found.');
    const { blobs } = await files().list({ prefix: `${c.id}/` });
    const out = [];
    for (const b of blobs) {
      if (!b.key.endsWith('/meta')) continue;
      const m = await files().get(b.key, { type: 'json' });
      if (m) out.push(m);
    }
    out.sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded)));
    return { ok: true, files: out };
  }

  async function adminFileDelete(params) {
    const clientId = slug(params.clientId);
    const fileId = String(params.fileId || '');
    if (!/^[a-f0-9]{12}$/.test(fileId)) throw new HttpError(404, 'File not found.');
    const meta = await files().get(`${clientId}/${fileId}/meta`, { type: 'json' });
    if (!meta) throw new HttpError(404, 'File not found.');
    for (let i = 0; i < meta.chunks; i++) await files().delete(`${clientId}/${fileId}/${i}`);
    await files().delete(`${clientId}/${fileId}/meta`);
    return { ok: true };
  }

  async function adminCustomers() {
    if (!env.STRIPE_SECRET_KEY) return { ok: true, customers: [], error: 'STRIPE_SECRET_KEY is not set.' };
    const res = await fetch('https://api.stripe.com/v1/customers?limit=100', { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
    if (!res.ok) return { ok: true, customers: [], error: 'Stripe did not answer.' };
    const body = await res.json();
    return { ok: true, customers: (body.data || []).map((c) => ({ id: c.id, name: c.name || '', email: c.email || '' })) };
  }

  /* ---- router ---- */

  return async function handler(req) {
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || '';
    try {
      // Reads and file downloads.
      if (req.method === 'GET') {
        switch (action) {
          case 'me': {
            const s = await requireSession(req);
            return json({ ok: true, portal: await clientView(s.client, s.email) });
          }
          case 'file': {
            const s = await requireSession(req);
            return await fileChunk(s.client.id, String(url.searchParams.get('id') || ''), url.searchParams.get('n') || '0');
          }
          case 'admin_clients': {
            requireAdmin(req);
            const all = await allClients();
            return json({ ok: true, clients: all.map((c) => ({ id: c.id, name: c.name, business: c.business, emails: c.emails })) });
          }
          case 'admin_get': {
            requireAdmin(req);
            const c = await getClient(url.searchParams.get('id'));
            if (!c) throw new HttpError(404, 'Client not found.');
            return json({ ok: true, client: c });
          }
          case 'admin_preview': {
            requireAdmin(req);
            const c = await getClient(url.searchParams.get('id'));
            if (!c) throw new HttpError(404, 'Client not found.');
            return json({ ok: true, portal: await clientView(c, 'preview') });
          }
          case 'admin_file': {
            requireAdmin(req);
            return await fileChunk(slug(url.searchParams.get('clientId')), String(url.searchParams.get('id') || ''), url.searchParams.get('n') || '0');
          }
          case 'admin_files': requireAdmin(req); return json(await adminFiles({ clientId: url.searchParams.get('clientId') }));
          case 'admin_customers': requireAdmin(req); return json(await adminCustomers());
        }
        return json({ ok: false, message: 'Unknown action.' }, 404);
      }

      if (req.method !== 'POST') return json({ ok: false, message: 'Method not allowed.' }, 405);

      if (action === 'admin_file_chunk') { requireAdmin(req); return json(await adminFileChunk(req, url.searchParams)); }

      // Cookie-authenticated POSTs must be JSON, which a cross-site form cannot send.
      const ct = req.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new HttpError(415, 'Send JSON.');
      const params = parseJSON(await readText(req, LIMIT_JSON));
      switch (action) {
        case 'login': return json(await loginRequest(params));
        case 'verify': return await loginVerify(params);
        case 'logout': return await logout(req);
        case 'todo_done': return json(await todoDone(req, params));
        case 'admin_save': requireAdmin(req); return json(await adminSave(params));
        case 'admin_file_start': requireAdmin(req); return json(await adminFileStart(params));
        case 'admin_file_delete': requireAdmin(req); return json(await adminFileDelete(params));
      }
      return json({ ok: false, message: 'Unknown action.' }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ ok: false, message: e.message }, e.status);
      console.error('[portal]', action, e);
      return json({ ok: false, message: 'Server error.' }, 500);
    }
  };
}

export async function realGetStore() {
  const { getStore } = await import('@netlify/blobs');
  return (name) => getStore({ name, consistency: 'strong' });
}

export default async (req, context) => {
  const handler = makeHandler({ getStore: await realGetStore(), fetch: globalThis.fetch, env: process.env, now: () => Date.now() });
  return handler(req, context);
};
