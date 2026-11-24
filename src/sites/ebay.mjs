import { decode } from '../http.mjs';

// eBay refuses scraped pages, so this uses its official Browse API, signed in with the
// Production keyset's App ID and Cert ID.
const API = 'https://api.ebay.com';
let token;

async function accessToken() {
  if (token && token.expires > Date.now()) return token.value;
  const id = process.env.EBAY_CLIENT_ID?.trim();
  const secret = process.env.EBAY_CLIENT_SECRET?.trim();
  if (!id || !secret) throw new Error('EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are not set');
  const res = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent('https://api.ebay.com/oauth/api_scope')}`,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`sign-in refused (${res.status} ${body.error ?? ''})`);
  token = { value: body.access_token, expires: Date.now() + (body.expires_in - 60) * 1000 };
  return token.value;
}

async function api(path) {
  return fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB',
      // Without a buyer location eBay leaves calculated postage out of the results.
      'X-EBAY-C-ENDUSERCTX': 'contextualLocation=country%3DGB',
    },
  });
}

const gbp = amount => (amount?.currency === 'GBP' && amount.value != null ? Number(amount.value) : null);

export async function search(query) {
  const res = await api(`/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=100&filter=${encodeURIComponent('deliveryCountry:GB')}`);
  const body = await res.json().catch(() => ({}));
  const listings = [];
  for (const item of body.itemSummaries ?? []) {
    const auction = !item.buyingOptions?.includes('FIXED_PRICE');
    const price = auction ? gbp(item.currentBidPrice) ?? gbp(item.price) : gbp(item.price);
    if (price == null) continue;
    const shipping = gbp(item.shippingOptions?.[0]?.shippingCost);
    const id = item.legacyItemId ?? item.itemId;
    const seller = item.seller?.feedbackScore > 0 ? `seller ${item.seller.feedbackPercentage}% (${item.seller.feedbackScore})` : null;
    const ends = item.itemEndDate ? new Date(item.itemEndDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' }) : null;
    listings.push({
      site: 'eBay',
      id: `ebay:${id}`,
      apiId: item.itemId,
      title: item.title,
      price,
      total: shipping == null ? price : Math.round((price + shipping) * 100) / 100,
      postage: shipping == null ? 'not included' : shipping === 0 ? 'free UK delivery' : `£${shipping.toFixed(2)} postage`,
      // An auction's price is only the current bid, so it says so where the condition is shown.
      condition: [item.condition, auction ? `auction, ${item.bidCount ?? 0} bids${ends ? `, ends ${ends}` : ''}` : null, seller].filter(Boolean).join(' · ') || null,
      url: item.legacyItemId ? `https://www.ebay.co.uk/itm/${item.legacyItemId}` : item.itemWebUrl,
      image: item.image?.imageUrl ?? item.thumbnailImages?.[0]?.imageUrl ?? null,
    });
  }
  return { status: res.status, listings };
}

// Sellers often say "FairyLoot" only in the description, and the search results carry one photo.
// The description is cut short because it's kept in state.json between runs.
export async function details(listing) {
  if (!listing.apiId) return null;
  const res = await api(`/buy/browse/v1/item/${encodeURIComponent(listing.apiId)}`);
  if (!res.ok) return null;
  const item = await res.json();
  const text = decode((item.description ?? item.shortDescription ?? '')
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>|&nbsp;/g, ' '));
  return {
    // Bulk sellers' templates list fields like "Signed : False", which would otherwise match "signed".
    description: text.replace(/[a-z][a-z ]{0,30}:\s*(false|no)\b/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000),
    photos: [item.image, ...(item.additionalImages ?? [])].map(i => i?.imageUrl).filter(Boolean).slice(0, 5),
  };
}
