/* Second Set shared tracking layer.
 *
 * Loaded on every page. Everything here is additive: the inline per-page
 * handlers that already fire call_click, book_call_click, faq_open, scroll_75,
 * generate_lead (Tally) and schedule_call (Cal.com) keep working untouched.
 * Any element that already carries its own gtag call is skipped here so
 * nothing double counts.
 *
 * What this adds:
 *   - first touch / last touch attribution, kept in localStorage
 *   - an internal-traffic flag so Denessa's own visits stop polluting reports
 *   - email_click, phone_click, outbound_click, social_click, page_not_found
 *   - hidden attribution fields filled on every form before it submits
 */
(function () {
  'use strict';

  var LS = 'ss_attr_v1', SS = 'ss_visits_v1', INT = 'ss_internal';
  var hasGtag = function () { return typeof window.gtag === 'function'; };

  function store(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function put(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  function drop(k) { try { window.localStorage.removeItem(k); } catch (e) {} }

  /* ---------------------------------------------------- internal traffic */
  try {
    var q = new URLSearchParams(location.search);
    if (q.get('site_internal') === '1') put(INT, '1');
    if (q.get('site_internal') === '0') drop(INT);
  } catch (e) {}
  var internal = store(INT) === '1';
  if (internal && hasGtag()) window.gtag('set', { traffic_type: 'internal' });

  /* ------------------------------------------------------- attribution */
  function readParams() {
    var q;
    try { q = new URLSearchParams(location.search); } catch (e) { return null; }
    var src = q.get('utm_source'), med = q.get('utm_medium'), camp = q.get('utm_campaign');
    var gclid = q.get('gclid') || q.get('wbraid') || q.get('gbraid');
    var ref = '';
    try { ref = document.referrer ? new URL(document.referrer).hostname : ''; } catch (e) {}
    var sameSite = ref && ref.replace(/^www\./, '') === location.hostname.replace(/^www\./, '');

    if (!src && !gclid && (!ref || sameSite)) return null;   /* nothing new to record */

    if (!src) {
      if (gclid) { src = 'google'; med = 'cpc'; }
      else { src = ref; med = 'referral'; }
    }
    return {
      source: src, medium: med || '(none)', campaign: camp || '(none)',
      landing: location.pathname, referrer: ref, gclid: gclid || '',
      date: new Date().toISOString().slice(0, 10)
    };
  }

  function flat(t) {
    if (!t) return '';
    return [t.source, t.medium, t.campaign, t.landing, t.date].join(' | ');
  }

  var attr = {};
  try { attr = JSON.parse(store(LS) || '{}') || {}; } catch (e) { attr = {}; }
  var touch = readParams();
  if (touch) {
    if (!attr.first) attr.first = touch;          /* first touch is written once, kept forever */
    attr.last = touch;                             /* last touch is replaced by any new arrival */
  } else if (!attr.first) {
    attr.first = attr.last = {
      source: '(direct)', medium: '(none)', campaign: '(none)',
      landing: location.pathname, referrer: '', gclid: '',
      date: new Date().toISOString().slice(0, 10)
    };
  }
  if (!attr.last) attr.last = attr.first;
  put(LS, JSON.stringify(attr));

  var visits = 1;
  try {
    if (!window.sessionStorage.getItem(SS)) {
      visits = parseInt(store('ss_visit_count') || '0', 10) + 1;
      put('ss_visit_count', String(visits));
      window.sessionStorage.setItem(SS, '1');
    } else {
      visits = parseInt(store('ss_visit_count') || '1', 10);
    }
  } catch (e) {}

  if (hasGtag()) {
    window.gtag('set', 'user_properties', {
      first_touch_source: attr.first.source,
      first_touch_medium: attr.first.medium,
      last_touch_source: attr.last.source,
      last_touch_medium: attr.last.medium,
      lead_source: attr.last.source,
      lead_medium: attr.last.medium
    });
  }

  function send(name, params) {
    if (!hasGtag()) return;
    params = params || {};
    params.lead_source = attr.last.source;
    params.lead_medium = attr.last.medium;
    window.gtag('event', name, params);
  }
  window.ssTrack = send;
  window.ssAttr = function () {
    return { first: flat(attr.first), last: flat(attr.last), visits: visits };
  };

  /* ---------------------------------------------- where did they click */
  function ctaId(el) {
    var explicit = el.getAttribute('data-cta');
    if (explicit) return explicit;
    var scope = el.closest('nav,header,footer,form,article,section,.wrap') || document.body;
    var tag = (scope.tagName || '').toLowerCase();
    var cls = (scope.className || '').toString().split(/\s+/)[0] || '';
    return (tag === 'div' ? (cls || 'inline') : tag);
  }

  /* An element with its own inline gtag call is already counted; skip it. */
  function alreadyTracked(el) {
    var n = el;
    while (n && n !== document.body) {
      var h = n.getAttribute && n.getAttribute('onclick');
      if (h && h.indexOf('gtag') > -1) return true;
      n = n.parentElement;
    }
    return false;
  }

  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest && ev.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (alreadyTracked(a)) return;

    if (href.indexOf('mailto:') === 0) { send('email_click', { cta_id: ctaId(a) }); return; }
    if (href.indexOf('tel:') === 0)    { send('phone_click', { cta_id: ctaId(a) }); return; }
    if (href.indexOf('sms:') === 0)    { send('sms_click',   { cta_id: ctaId(a) }); return; }

    var host = '';
    try { host = new URL(a.href, location.href).hostname; } catch (e) { return; }
    if (!host || host.replace(/^www\./, '') === location.hostname.replace(/^www\./, '')) return;

    var social = /(instagram|tiktok|linkedin|nextdoor|facebook|youtube|yelp)\./.test(host);
    send(social ? 'social_click' : 'outbound_click', {
      cta_id: ctaId(a), link_domain: host, link_url: a.href
    });
  }, true);

  /* ------------------------------------------------- forms: attribution */
  function stamp(form) {
    var vals = {
      first_touch: flat(attr.first),
      last_touch: flat(attr.last),
      visits: String(visits),
      submitted_from: location.pathname
    };
    Object.keys(vals).forEach(function (k) {
      var f = form.querySelector('input[name="' + k + '"]');
      if (!f) {
        f = document.createElement('input');
        f.type = 'hidden'; f.name = k;
        form.appendChild(f);
      }
      f.value = vals[k];
    });
  }
  document.addEventListener('submit', function (ev) {
    var f = ev.target;
    if (f && f.tagName === 'FORM') { try { stamp(f); } catch (e) {} }
  }, true);
  /* Stamp on load too, so a form posted without a submit event still carries it. */
  document.addEventListener('DOMContentLoaded', function () {
    Array.prototype.forEach.call(document.querySelectorAll('form'), function (f) {
      try { stamp(f); } catch (e) {}
    });
  });

  /* ------------------------------------------------------------ 404s */
  if (/page not found|this page wandered off/i.test(document.title + ' ' + (document.querySelector('h1') || {}).textContent)) {
    send('page_not_found', { missing_path: location.pathname, referrer_host: (function () {
      try { return document.referrer ? new URL(document.referrer).hostname : ''; } catch (e) { return ''; }
    })() });
  }
})();
