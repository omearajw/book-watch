import * as vinted from '../src/sites/vinted.mjs';
import * as abebooks from '../src/sites/abebooks.mjs';
import * as wob from '../src/sites/wob.mjs';
import * as amazon from '../src/sites/amazon.mjs';

const query = process.argv[2] || 'direbound';
const sites = { vinted, abebooks, wob, amazon };
const mentions = l => /dire\s?bound/i.test(l.title);
const fairyloot = l => /fairy\s?loot/i.test(`${l.title} ${l.description ?? ''}`);

console.log(`Probing for "${query}"`);
for (const [name, site] of Object.entries(sites)) {
  try {
    const { status, listings } = await site.search(query);
    const relevant = listings.filter(mentions);
    console.log(`\n== ${name}: HTTP ${status}, ${listings.length} listings, ${relevant.length} mention Direbound`);
    for (const l of relevant.slice(0, 8)) {
      console.log(`  ${fairyloot(l) ? '[FAIRYLOOT] ' : ''}£${l.price} (total £${l.total}, postage ${l.postage}) | ${l.title.slice(0, 70)} | ${l.url}`);
    }
  } catch (e) {
    console.log(`\n== ${name}: FAILED ${e.message}`);
  }
}
