import { get, decode, money } from '../http.mjs';

// Amazon answers 503 to automated requests after a handful of searches, so this is
// best effort: a blocked run returns no listings rather than failing the whole check.
export async function search(query) {
  const url = `https://www.amazon.co.uk/s?k=${encodeURIComponent(query)}`;
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await get(url);
    if (res.status === 200) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  const listings = [];
  if (res.status === 200) {
    for (const chunk of res.body.split('data-component-type="s-search-result"').slice(1)) {
      const title = chunk.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1];
      const asin = chunk.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
      if (!title || !asin) continue;
      const price = money(chunk.match(/class="a-offscreen">([^<]+)</)?.[1]);
      listings.push({
        site: 'Amazon',
        id: `amazon:${asin}`,
        title: decode(title),
        price,
        total: price,
        postage: 'see listing',
        url: `https://www.amazon.co.uk/dp/${asin}`,
      });
    }
  }
  return { status: res.status, listings };
}
