/* Google reviews for secondsethq.com
 *
 * Runs server-side so the API key is never exposed to the browser.
 * Cached hard at the CDN, so a page view almost never costs an API call.
 *
 * Netlify environment variables (Site configuration > Environment variables):
 *   GOOGLE_PLACES_API_KEY   required
 *   GOOGLE_PLACE_ID         optional. If absent, resolved from GOOGLE_PLACES_QUERY.
 *   GOOGLE_PLACES_QUERY     optional. Default "Second Set HQ, Vista, CA".
 *
 * Google caps review output at 5 and chooses which 5. That is an API limit,
 * not a bug here. Returning all reviews needs the Business Profile API and OAuth.
 */

const CACHE_SECONDS = 21600; // 6 hours

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
  'Access-Control-Allow-Origin': 'https://secondsethq.com'
};

function fail(status, message, detail) {
  return {
    statusCode: status,
    headers: { ...headers, 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ok: false, error: message, detail: detail || null })
  };
}

/* Places API (New). Returns up to 5 reviews. */
async function fetchNew(placeId, key) {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
  const res = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask':
        'id,displayName,rating,userRatingCount,googleMapsUri,reviews'
    }
  });
  if (!res.ok) throw new Error(`places-new ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const d = await res.json();
  return {
    source: 'places-new',
    name: d.displayName && d.displayName.text,
    rating: d.rating || null,
    total: d.userRatingCount || 0,
    profileUrl: d.googleMapsUri || null,
    reviews: (d.reviews || []).map(r => ({
      author: r.authorAttribution && r.authorAttribution.displayName,
      photo: (r.authorAttribution && r.authorAttribution.photoUri) || null,
      authorUrl: (r.authorAttribution && r.authorAttribution.uri) || null,
      rating: r.rating,
      text: (r.originalText && r.originalText.text) || (r.text && r.text.text) || '',
      when: r.relativePublishTimeDescription || '',
      publishedAt: r.publishTime || null
    }))
  };
}

/* Legacy Place Details. Fallback when only the old API is enabled. */
async function fetchLegacy(placeId, key) {
  const url =
    'https://maps.googleapis.com/maps/api/place/details/json' +
    `?place_id=${encodeURIComponent(placeId)}` +
    '&fields=name,rating,user_ratings_total,url,reviews&reviews_sort=newest' +
    `&key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const d = await res.json();
  if (d.status !== 'OK') throw new Error(`places-legacy ${d.status}: ${d.error_message || ''}`);
  const r0 = d.result || {};
  return {
    source: 'places-legacy',
    name: r0.name,
    rating: r0.rating || null,
    total: r0.user_ratings_total || 0,
    profileUrl: r0.url || null,
    reviews: (r0.reviews || []).map(r => ({
      author: r.author_name,
      photo: r.profile_photo_url || null,
      authorUrl: r.author_url || null,
      rating: r.rating,
      text: r.text || '',
      when: r.relative_time_description || '',
      publishedAt: r.time ? new Date(r.time * 1000).toISOString() : null
    }))
  };
}

/* Resolve a place id from a text query, so no id has to be configured by hand. */
async function resolvePlaceId(query, key) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.id,places.displayName'
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 1 })
  });
  if (!res.ok) throw new Error(`searchText ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const d = await res.json();
  if (!d.places || !d.places.length) throw new Error(`no place matched "${query}"`);
  return d.places[0].id;
}

exports.handler = async () => {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    return fail(500, 'GOOGLE_PLACES_API_KEY is not set on this site.',
      'Netlify: Site configuration > Environment variables.');
  }

  const query = process.env.GOOGLE_PLACES_QUERY || 'Second Set HQ, Vista, CA';
  let placeId = process.env.GOOGLE_PLACE_ID || null;

  try {
    if (!placeId) placeId = await resolvePlaceId(query, key);
  } catch (e) {
    return fail(502, 'Could not work out which Google place to read.', String(e.message));
  }

  let data;
  try {
    data = await fetchNew(placeId, key);
  } catch (eNew) {
    try {
      data = await fetchLegacy(placeId, key);
    } catch (eOld) {
      return fail(502, 'Google would not return reviews.',
        `new: ${eNew.message} | legacy: ${eOld.message}`);
    }
  }

  // Newest first, and drop empty-text ratings since they render as blank cards.
  data.reviews = data.reviews
    .filter(r => r.text && r.text.trim().length > 0)
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, placeId, fetchedAt: new Date().toISOString(), ...data })
  };
};
