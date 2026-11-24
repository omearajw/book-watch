import { get, money } from '../http.mjs';

// World of Books is a Shopify store; its search page renders results client-side, so use
// Shopify's predictive search JSON instead.
export async function search(query) {
  const url = `https://www.worldofbooks.com/en-gb/search/suggest.json?q=${encodeURIComponent(query)}&resources%5Btype%5D=product&resources%5Blimit%5D=10`;
  const { status, body } = await get(url, { Accept: 'application/json' });
  let products = [];
  try { products = JSON.parse(body).resources?.results?.products ?? []; } catch {}
  const listings = products
    .filter(p => p.available)
    .map(p => {
      const price = money(p.price_min) || money(p.price_max);
      return {
        site: 'World of Books',
        id: `wob:${p.id}`,
        title: p.title,
        price,
        total: price,
        postage: 'free UK delivery',
        url: `https://www.worldofbooks.com${p.url.split('?')[0]}`,
        image: p.image ?? null,
      };
    });
  return { status, listings };
}
