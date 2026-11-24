import { get, decode, money } from '../http.mjs';

export async function search(query) {
  const url = `https://www.abebooks.co.uk/servlet/SearchResults?kn=${encodeURIComponent(query)}&sortby=17`;
  const { status, body } = await get(url);
  const listings = [];
  for (const chunk of body.split('data-test-id="listing-item-').slice(1)) {
    const title = chunk.match(/data-test-id="listing-title"[^>]*>([^<]+)</)?.[1];
    if (!title) continue;
    const href = chunk.match(/href="([^"]+)"[^>]*data-test-id="listing-title-link"|data-test-id="listing-title-link"[^>]*href="([^"]+)"/);
    const path = href?.[1] || href?.[2] || '';
    const price = money(chunk.match(/data-test-id="listing-price">([^<]+)</)?.[1]);
    const shipText = chunk.match(/data-test-id="item-shipping-price-[^"]*"[\s\S]*?class="iOydwa_text">([^<]+)</)?.[1];
    const ship = shipText && /free/i.test(shipText) ? 0 : money(shipText);
    const desc = decode(chunk.match(/data-test-id="description-[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/)?.[1] ?? '');
    listings.push({
      site: 'AbeBooks',
      id: `abebooks:${path.match(/\/(\d+)\/bd/)?.[1] ?? path}`,
      title: decode(title),
      description: desc,
      price,
      total: price != null && ship != null ? +(price + ship).toFixed(2) : price,
      postage: shipText ? decode(shipText) : 'unknown',
      url: `https://www.abebooks.co.uk${path}`,
      image: chunk.match(/<img[^>]+src="(https:[^"]+)"/)?.[1] ?? null,
    });
  }
  return { status, listings };
}
