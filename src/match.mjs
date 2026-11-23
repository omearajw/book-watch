// Terms are compared with spaces and punctuation stripped, so "Dire Bound" matches
// "direbound" and "Fairy Loot" matches "fairyloot".
export const norm = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

const RANK = { other: 0, possible: 1, strong: 2 };

export function classify(listing, watch) {
  const title = norm(listing.title);
  const text = norm(`${listing.title} ${listing.description ?? ''}`);
  const find = (terms, hay) => (terms ?? []).find(t => norm(t) && hay.includes(norm(t)));

  const mustInclude = watch.mustInclude?.length ? watch.mustInclude : [watch.query];
  // Exclusions look at the title only: a single copy's description often mentions the sequel.
  const relevant = mustInclude.every(t => title.includes(norm(t))) && !find(watch.exclude, title);

  const strongTerm = find(watch.strong, text);
  const possibleTerm = strongTerm ? null : find(watch.possible, text);
  const strength = strongTerm ? 'strong' : possibleTerm ? 'possible' : 'other';

  const underPrice = listing.total != null && listing.total > 0 && listing.total <= watch.maxPrice;
  const threshold = RANK[watch.alertOn] ?? RANK.possible;
  const alertable = relevant && underPrice && RANK[strength] >= threshold;

  return { relevant, strength, matchedTerm: strongTerm || possibleTerm || null, underPrice, alertable };
}
