/**
 * Second Set — Local SEO Standard auditor
 * Fetches a page server-side (no CORS limit) and scores it against the framework.
 * Category 2 (Local Proof, 20 pts) is entered manually by the operator and merged client-side.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i'))
         || tag.match(new RegExp(name + "\\s*=\\s*'([^']*)'", 'i'));
  return m ? m[1] : null;
}

function density(text, term) {
  if (!term) return 0;
  const words = text.split(/\s+/).length || 1;
  const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const hits = (text.match(re) || []).length;
  return { hits, pct: +((hits * term.split(/\s+/).length / words) * 100).toFixed(2), words };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bad JSON' }) }; }

  let { url, service, city, region } = body;
  if (!url) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No URL supplied' }) };
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  service = (service || '').trim();
  city = (city || '').trim();
  region = (region || '').trim();

  let html = '', status = 0, ms = 0, finalUrl = url, fetchErr = null;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      redirect: 'follow'
    });
    status = res.status; finalUrl = res.url || url;
    html = await res.text();
    ms = Date.now() - t0;
  } catch (e) {
    fetchErr = String(e.message || e);
  }
  if (fetchErr) {
    return { statusCode: 200, headers, body: JSON.stringify({
      ok: false, url, status,
      error: 'Could not reach the site: ' + fetchErr,
      advice: 'Check the URL, or the server may be refusing outside requests. Audit that page by hand.' }) };
  }
  if (status >= 400) {
    return { statusCode: 200, headers, body: JSON.stringify({
      ok: false, url, status,
      error: 'The site returned HTTP ' + status + '.',
      advice: status === 403 || status === 401
        ? 'The host is blocking automated requests, which is common on WPEngine, Cloudflare and Wordfence. This is NOT a finding about the site. Audit this page manually.'
        : 'The page may not exist at this URL. Check it in a browser first.' }) };
  }
  if (html.length < 1000) {
    return { statusCode: 200, headers, body: JSON.stringify({
      ok: false, url, status,
      error: 'The response was only ' + html.length + ' bytes.',
      advice: 'Too small to be a real page. Likely a challenge page, a redirect stub, or a JavaScript-rendered site. Audit manually.' }) };
  }

  const head = (html.match(/<head[\s\S]*?<\/head>/i) || [''])[0];
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].trim();
  const metaDescTag = (head.match(/<meta[^>]+name\s*=\s*["']description["'][^>]*>/i) || [''])[0];
  const metaDesc = metaDescTag ? (attr(metaDescTag, 'content') || '') : '';
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => textOf(m[1]));
  const h2s = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map(m => textOf(m[1]));
  const bodyText = textOf(html);
  const words = bodyText.split(/\s+/).length;

  const has = (hay, needle) => needle && hay.toLowerCase().includes(needle.toLowerCase());

  // ---------- 1. THE THREE SIGNALS /25 ----------
  const c1 = [];
  c1.push({ pts: 6, got: (has(title, service) && has(title, city)) ? 6 : 0,
    label: 'Title tag contains the primary service AND the city',
    detail: title ? `Title reads: "${title}"` : 'No title tag found.' });
  c1.push({ pts: 2, got: (title.length >= 50 && title.length <= 60) ? 2 : 0,
    label: 'Title tag is 50 to 60 characters',
    detail: `Title is ${title.length} characters.` });
  c1.push({ pts: 6, got: (h1s[0] && has(h1s[0], service) && (has(h1s[0], city) || has(h1s[0], region))) ? 6 : 0,
    label: 'H1 contains the primary service AND the city or region',
    detail: h1s.length ? `H1 reads: "${h1s[0]}"` : 'No H1 found on the page.' });
  c1.push({ pts: 3, got: h1s.length === 1 ? 3 : 0,
    label: 'Exactly one H1 on the page',
    detail: `${h1s.length} H1 element${h1s.length === 1 ? '' : 's'} found.` });
  c1.push({ pts: 5, got: (metaDesc.length >= 120 && metaDesc.length <= 160 && has(metaDesc, service) && (has(metaDesc, city) || has(metaDesc, region))) ? 5 : 0,
    label: 'Meta description 120 to 160 characters, names the service and location',
    detail: metaDesc ? `${metaDesc.length} characters. "${metaDesc.slice(0, 120)}${metaDesc.length > 120 ? '…' : ''}"` : 'No meta description found.' });
  const identical = (title && h1s[0] && title.trim().toLowerCase() === h1s[0].trim().toLowerCase())
                 || (title && metaDesc && title.trim().toLowerCase() === metaDesc.trim().toLowerCase());
  c1.push({ pts: 3, got: identical ? 0 : 3,
    label: 'Title, H1 and meta are not identical to each other',
    detail: identical ? 'At least two of the three are identical.' : 'All three are distinct.' });

  // ---------- 3. STRUCTURED DATA /15 ----------
  const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  let parsed = [];
  ld.forEach(b => { try { const j = JSON.parse(b.trim()); parsed = parsed.concat(Array.isArray(j) ? j : [j]); } catch {} });
  const types = parsed.map(p => p['@type']).flat().filter(Boolean);
  const flat = JSON.stringify(parsed);
  const isLocal = types.some(t => /LocalBusiness|ProfessionalService|Store|Restaurant|HomeAndConstructionBusiness/i.test(String(t)));

  const c3 = [];
  c3.push({ pts: 5, got: (isLocal && /"address"/.test(flat) && /"telephone"/.test(flat)) ? 5 : (isLocal ? 2 : 0),
    label: 'LocalBusiness schema with address, phone and geo coordinates',
    detail: parsed.length ? `Schema found: ${types.join(', ') || 'untyped'}.` + (/"geo"/.test(flat) ? '' : ' No geo coordinates.') : 'No JSON-LD structured data on the page at all.' });
  c3.push({ pts: 2, got: /openingHoursSpecification/i.test(flat) ? 2 : 0,
    label: 'Opening hours in openingHoursSpecification',
    detail: /openingHoursSpecification/i.test(flat) ? 'Present.' : 'Not present.' });
  c3.push({ pts: 3, got: /"areaServed"/.test(flat) ? 3 : 0,
    label: 'areaServed listing the actual service area cities',
    detail: /"areaServed"/.test(flat) ? 'Present.' : 'Not present.' });
  const faqSchema = types.some(t => /FAQPage/i.test(String(t)));
  c3.push({ pts: 3, got: faqSchema ? 3 : 0,
    label: 'FAQPage schema matching visible on-page questions',
    detail: faqSchema ? 'FAQPage schema present. Confirm the text matches what is visible.' : 'No FAQPage schema.' });
  c3.push({ pts: 2, got: types.some(t => /^(Service|Product)$/i.test(String(t))) ? 2 : 0,
    label: 'Service or Product schema where relevant',
    detail: types.some(t => /^(Service|Product)$/i.test(String(t))) ? 'Present.' : 'Not present.' });

  // ---------- 4. CONVERSION PATH /15 ----------
  const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/gi)].map(m => m[0]);
  const embedForm = /tally\.so|jotform|typeform|hsforms|cognitoforms|wufoo|gravity/i.test(html);
  const inputs = forms.length ? [...forms[0].matchAll(/<(input|select|textarea)[^>]*>/gi)]
      .filter(m => !/type\s*=\s*["'](hidden|submit|button)["']/i.test(m[0])).length : 0;
  const anchors = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].map(m => m[0]);
  const dead = anchors.filter(a => {
    const h = attr(a, 'href');
    if (h && h !== '#' && !/^javascript:\s*void/i.test(h)) return false;
    // an anchor with a JS handler is a working control, not a dead button
    if (/data-cal-link|data-tally-open|onclick=|data-modal|role\s*=\s*["']button["']/i.test(a)) return false;
    return true;
  });
  const telLinks = (html.match(/href\s*=\s*["']tel:/gi) || []).length;
  const tracking = /gtag\(|googletagmanager|fbq\(|dataLayer|clarity|hotjar/i.test(html);
  const placeholders = (bodyText.match(/lorem ipsum|sub-?text here|your text here|coming soon|\[\s*x\s*\]|placeholder|insert (?:text|copy)/gi) || []);

  const c4 = [];
  c4.push({ pts: 4, got: (forms.length || embedForm) ? 4 : 0,
    label: 'A working inquiry form on the page, not just a phone number',
    detail: forms.length ? `${forms.length} form element${forms.length === 1 ? '' : 's'} found.` : (embedForm ? 'Embedded third-party form detected.' : 'No form found anywhere on the page.') });
  c4.push({ pts: 3, got: dead.length === 0 ? 3 : 0,
    label: 'Every call to action links somewhere. No dead buttons',
    detail: dead.length ? `${dead.length} link${dead.length === 1 ? '' : 's'} with no destination.` : `All ${anchors.length} links have a destination.` });
  c4.push({ pts: 2, got: telLinks > 0 ? 2 : 0,
    label: 'Phone number is a working tel: link on mobile',
    detail: telLinks ? `${telLinks} tel: link${telLinks === 1 ? '' : 's'} found.` : 'No tel: link found. Confirm the number is tappable.' });
  c4.push({ pts: 2, got: (forms.length && inputs > 0 && inputs < 12) ? 2 : (embedForm ? 1 : 0),
    label: 'Form is short enough to finish. Under 12 fields for a first inquiry',
    detail: forms.length ? `${inputs} visible fields in the first form.` : 'Embedded form — count the fields manually.' });
  c4.push({ pts: 2, got: tracking ? 2 : 0,
    label: 'Conversion tracking wired to the form, not just pageviews',
    detail: tracking ? 'Analytics or tag manager present. Confirm a form-submit event actually fires.' : 'No analytics or tag manager detected.' });
  c4.push({ pts: 2, got: placeholders.length === 0 ? 2 : 0,
    label: 'No placeholder or unfinished copy visible anywhere',
    detail: placeholders.length ? `Found: ${[...new Set(placeholders)].slice(0, 4).join(', ')}` : 'None found.' });

  // ---------- 5. CONTENT AND KEYWORDS /15 ----------
  const d = service ? density(bodyText, service) : { hits: 0, pct: 0 };
  const h2Hits = service ? h2s.filter(h => has(h, service)).length : 0;
  const cityHits = city ? (bodyText.match(new RegExp('\\b' + city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi')) || []).length : 0;
  const faqVisible = /faq|frequently asked|common questions|questions people/i.test(bodyText) || /<details/i.test(html);

  const c5 = [];
  c5.push({ pts: 4, got: (d.pct >= 0.3 && d.pct <= 1.0) ? 4 : (d.pct > 2 ? 0 : (d.pct > 0 ? 2 : 0)),
    label: 'Primary service term appears at 0.3 to 1.0 percent density',
    detail: service ? `"${service}" appears ${d.hits} times in ${words} words — ${d.pct}%.` + (d.pct > 2 ? ' Above 2% reads as stuffing and gets discounted.' : (d.pct < 0.3 ? ' Below 0.3% is not making a claim on the term.' : '')) : 'No service term supplied.' });
  c5.push({ pts: 3, got: h2Hits >= 2 ? 3 : (h2Hits === 1 ? 1 : 0),
    label: 'Service term appears in at least two H2 headings',
    detail: `${h2Hits} of ${h2s.length} H2 headings contain the term.` });
  c5.push({ pts: 3, got: cityHits > 0 ? 3 : 0,
    label: 'Individual city names present, not just the county or region',
    detail: city ? `"${city}" appears ${cityHits} times in visible copy.` : 'No city supplied.' });
  c5.push({ pts: 3, got: faqVisible ? 3 : 0,
    label: 'An FAQ section answering questions people actually ask',
    detail: faqVisible ? 'FAQ-style content detected.' : 'No FAQ section found.' });
  c5.push({ pts: 2, got: words > 500 ? 2 : 0,
    label: 'Page is over 500 words of genuine content',
    detail: `${words} words of visible copy.` });

  // ---------- 6. TECHNICAL /10 ----------
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);
  const noAlt = imgs.filter(i => attr(i, 'alt') === null);
  const noDims = imgs.filter(i => !(attr(i, 'width') && attr(i, 'height')));
  const canonical = /rel\s*=\s*["']canonical["']/i.test(head);
  const noindex = /<meta[^>]+name\s*=\s*["']robots["'][^>]*content\s*=\s*["'][^"']*noindex/i.test(head);
  const viewport = /name\s*=\s*["']viewport["']/i.test(head);
  const kb = Math.round(html.length / 1024);

  const c6 = [];
  c6.push({ pts: 3, got: ms < 1200 ? 3 : (ms < 2500 ? 2 : 0), manual: true,
    label: 'Loads in under 3 seconds on mobile',
    detail: `HTML responded in ${ms}ms (${kb}KB). This is server response only — run PageSpeed Insights for a real mobile score.` });
  c6.push({ pts: 2, got: viewport ? 2 : 0, manual: true,
    label: 'Genuinely responsive, no horizontal scroll at 390px',
    detail: viewport ? 'Viewport meta tag present. Confirm at 390px in dev tools.' : 'No viewport meta tag — the page is almost certainly not responsive.' });
  c6.push({ pts: 2, got: (imgs.length && noAlt.length === 0) ? 2 : 0,
    label: 'Every image has alt text',
    detail: imgs.length ? `${noAlt.length} of ${imgs.length} images missing alt text.` : 'No images found.' });
  c6.push({ pts: 1, got: (imgs.length && noDims.length === 0) ? 1 : 0,
    label: 'Every image has width and height set, preventing layout shift',
    detail: imgs.length ? `${noDims.length} of ${imgs.length} images missing dimensions.` : 'No images found.' });
  c6.push({ pts: 1, got: canonical ? 1 : 0,
    label: 'Canonical tag present',
    detail: canonical ? 'Present.' : 'Missing.' });
  c6.push({ pts: 1, got: noindex ? 0 : 1,
    label: 'No noindex tag on a page meant to rank',
    detail: noindex ? 'NOINDEX FOUND. This single tag keeps the page out of Google entirely.' : 'No noindex tag.' });

  const cat = (name, weight, checks) => ({
    name, weight, checks,
    score: checks.reduce((s, c) => s + c.got, 0)
  });

  const result = {
    ok: true,
    url: finalUrl,
    status,
    ms,
    kb,
    fetchedAt: new Date().toISOString(),
    page: { title, titleLen: title.length, metaDesc, metaLen: metaDesc.length, h1s, h2Count: h2s.length, words },
    categories: [
      cat('The three signals', 25, c1),
      cat('Structured data', 15, c3),
      cat('Conversion path', 15, c4),
      cat('Content and keywords', 15, c5),
      cat('Technical', 10, c6)
    ]
  };
  result.autoScore = result.categories.reduce((s, c) => s + c.score, 0);
  result.autoMax = result.categories.reduce((s, c) => s + c.weight, 0);

  return { statusCode: 200, headers, body: JSON.stringify(result) };
};
