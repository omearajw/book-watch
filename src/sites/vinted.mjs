import { get, decode, money } from '../http.mjs';

// Vinted's JSON API moved and now 404s; the server-rendered catalog page carries every
// listing in its overlay link title: "<title>, Condition: <c>, <price> £, <price incl. buyer protection> £".
export async function search(query) {
  const url = `https://www.vinted.co.uk/catalog?search_text=${encodeURIComponent(query)}&order=newest_first`;
  const { status, body } = await get(url);
  const images = new Map([...body.matchAll(/<img src="([^"]+)"[^>]*data-testid="product-item-id-(\d+)--image--img"/g)].map(m => [m[2], decode(m[1])]));
  const listings = [];
  for (const m of body.matchAll(/<a href="\/items\/(\d+)([^"?]*)[^"]*"[^>]*overlay-link"[^>]*title="([^"]+)"/g)) {
    const raw = decode(m[3]);
    const p = raw.match(/^(.*?), (?:Condition: ([^,]+), )?([\d.,]+) £(?:, ([\d.,]+) £)?/);
    listings.push({
      site: 'Vinted',
      id: `vinted:${m[1]}`,
      title: p?.[1] ?? raw,
      condition: p?.[2] ?? null,
      price: money(p?.[3]),
      total: money(p?.[4]) ?? money(p?.[3]),
      postage: 'not included',
      url: `https://www.vinted.co.uk/items/${m[1]}${m[2]}`,
      image: images.get(m[1]) ?? null,
    });
  }
  return { status, listings };
}

// The catalog page has no description or seller info. Sellers often say "FairyLoot" only in
// the description, so candidate listings get their item page read once.
export async function details(listing) {
  const { status, body } = await get(listing.url);
  if (status !== 200) return null;
  const seller = body.match(/\\"feedback_count\\":(\d+),\\"feedback_reputation\\":([\d.]+)/);
  return {
    description: decode(body.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? ''),
    sellerReviews: seller ? Number(seller[1]) : null,
    sellerStars: seller ? Math.round(Number(seller[2]) * 50) / 10 : null,
    reserved: /\\"is_reserved\\":true/.test(body),
    // The page also carries photos of other sellers' items; the listing's own are marked item-photo-N.
    photos: [...new Set([...body.matchAll(/data-testid="item-photo-\d+"><img src="([^"]+)"/g)].map(m => decode(m[1])))].slice(0, 5),
  };
}
