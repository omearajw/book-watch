import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { createHash } from 'crypto';
import { sites } from '../src/sites/index.mjs';
import { classify } from '../src/match.mjs';
import { pushReady, sendPush, emailReady, sendEmail } from '../src/notify.mjs';
import { embed, scorePhotos } from '../src/photo.mjs';
import { config } from '../docs/config.js';

const DRY = process.argv.includes('--dry-run');
// Item-page reads are the most likely thing to get us rate limited by Vinted, so cap them
// per run; anything left over is picked up 15 minutes later.
const DETAIL_LIMIT = 15;
const FORGET_AFTER_DAYS = 60;
const SUMMARISE_OVER = 3;

const today = new Date().toISOString().slice(0, 10);
const readJson = async (path, fallback) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } };
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const hash = s => createHash('sha256').update(s).digest('hex').slice(0, 16);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gbp = n => (n == null ? '£?' : `£${n.toFixed(2)}`);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const { watches = [] } = await readJson('data/watches.json', {});
const { subscriptions = [] } = await readJson('data/push-subscriptions.json', {});
const state = await readJson('data/state.json', {});
state.seen ??= {};
state.tested ??= {};
state.dead ??= [];

const liveSubs = subscriptions.filter(s => s.endpoint && s.keys && !state.dead.includes(hash(s.endpoint)));
const canPush = pushReady(config.vapidPublicKey, config.siteUrl);
const canEmail = emailReady();
console.log(`push: ${canPush ? `${liveSubs.length} device(s)` : 'off'}, email: ${canEmail ? 'on' : 'off'}${DRY ? ', DRY RUN' : ''}`);

const matches = { watches: {} };
const alerts = [];
let detailBudget = DETAIL_LIMIT;

async function readDetails(listing, seen) {
  const site = sites[listing.source];
  if (!site?.details || detailBudget <= 0) return false;
  detailBudget--;
  await sleep(1000);
  const d = await site.details(listing).catch(() => null);
  if (!d) return false;
  seen.details = d;
  Object.assign(listing, d);
  return true;
}

// The website builds the same path to show the example in the watch editor.
const wrongCoverPath = (watchId, listingId) => `data/photos/not/${watchId}-${listingId.replace(/[^a-z0-9]+/gi, '-')}.jpg`;

// A listing marked "Not this cover" is kept as an example: the photo of it that looks most like
// the references, which is the one that earned the badge. Returns that photo's bytes.
async function saveWrongCover(watch, id, listing, loadRefs) {
  const seen = state.seen[id];
  if (!listing || !seen) {
    console.log(`${watch.id}: ${id} is marked "not this cover" but isn't listed now; saved if it reappears`);
    return null;
  }
  if (!seen.details?.photos && !(await readDetails(listing, seen))) return null;
  const r = await scorePhotos(seen.details.photos, await loadRefs());
  if (!r) {
    delete seen.details.photos;
    return null;
  }
  if (!DRY) {
    await mkdir(dirname(wrongCoverPath(watch.id, id)), { recursive: true });
    await writeFile(wrongCoverPath(watch.id, id), r.best);
  }
  console.log(`${watch.id}: ${DRY ? 'would save' : 'saved'} ${id} as a wrong cover (it scored ${r.score})`);
  return r.best;
}

for (const watch of watches) {
  if (watch.paused) {
    matches.watches[watch.id] = { paused: true, sites: {}, listings: [] };
    continue;
  }
  const siteStatus = {};
  const found = new Map();
  for (const key of watch.sites ?? Object.keys(sites)) {
    if (!sites[key]) continue;
    try {
      const { status, listings } = await sites[key].search(watch.query);
      siteStatus[key] = status === 200 ? 'ok' : 'blocked';
      for (const l of listings) if (!found.has(l.id)) found.set(l.id, { ...l, source: key });
    } catch (e) {
      siteStatus[key] = 'error';
      console.log(`${watch.id} / ${key}: ${e.message}`);
    }
  }

  // Scores are cached per listing against a fingerprint of the reference photos and the
  // wrong-cover examples, so changing either rescores everything and an unchanged set costs nothing.
  const notThis = new Set(watch.notThis ?? []);
  let photoKey = null;
  let loadVectors;
  if (watch.photos?.length) {
    try {
      const refFiles = await Promise.all(watch.photos.map(p => readFile(p)));
      let refVectors;
      const loadRefs = () => (refVectors ??= Promise.all(refFiles.map(embed)));
      const wrongFiles = [];
      for (const id of notThis) {
        const buffer = await readFile(wrongCoverPath(watch.id, id)).catch(() => null)
          ?? await saveWrongCover(watch, id, found.get(id), loadRefs);
        if (buffer) wrongFiles.push(buffer);
      }
      photoKey = hash(['v2', ...[...refFiles, ...wrongFiles].map(f => hash(f))].join());
      let vectors;
      loadVectors = () => (vectors ??= Promise.all([loadRefs(), Promise.all(wrongFiles.map(embed))]));
    } catch (e) {
      console.log(`${watch.id}: photo matching off: ${e.message}`);
      photoKey = null;
    }
  }

  const relevant = [];
  for (const listing of found.values()) {
    const seen = (state.seen[listing.id] ??= { firstSeen: today });
    if (seen.lastSeen !== today) seen.lastSeen = today;
    if (seen.details) Object.assign(listing, seen.details);

    let cls = classify(listing, watch);
    // Details saved before photos were collected count as missing, so they're read again once.
    if (cls.relevant && cls.underPrice && !seen.details?.photos && await readDetails(listing, seen)) cls = classify(listing, watch);

    const cached = seen.photo?.[watch.id];
    let photo = photoKey && cached?.refs === photoKey ? cached : null;
    if (photoKey && !photo && cls.relevant && cls.underPrice && listing.photos?.length) {
      try {
        const [refs, wrong] = await loadVectors();
        const r = await scorePhotos(listing.photos, refs, wrong);
        if (!r) {
          // Vinted's photo links are signed and expire; drop them so the item page is read again.
          delete seen.details.photos;
        } else {
          photo = (seen.photo ??= {})[watch.id] = { refs: photoKey, score: r.score, looksLike: r.looksLike };
        }
      } catch (e) {
        console.log(`${watch.id}: photo matching failed: ${e.message}`);
        photoKey = null;
      }
    }
    const looksLike = Boolean(photo?.looksLike) && !notThis.has(listing.id);

    const cheaperThanLastAlert = seen.alertedPrice == null || listing.total < seen.alertedPrice - 0.005;
    if (cls.alertable && !listing.reserved && cheaperThanLastAlert) alerts.push({ watch, listing, cls, seen });
    if (cls.relevant) {
      relevant.push({
        site: listing.site,
        id: listing.id,
        title: listing.title,
        price: listing.price,
        total: listing.total,
        postage: listing.postage,
        condition: listing.condition ?? null,
        url: listing.url,
        image: listing.image ?? null,
        strength: cls.strength,
        matchedTerm: cls.matchedTerm,
        underPrice: cls.underPrice,
        alertable: cls.alertable,
        sellerStars: listing.sellerStars ?? null,
        sellerReviews: listing.sellerReviews ?? null,
        reserved: listing.reserved ?? false,
        photoScore: photo?.score ?? null,
        looksLike,
        firstSeen: seen.firstSeen,
      });
    }
  }

  relevant.sort((a, b) => b.looksLike - a.looksLike || (a.total ?? Infinity) - (b.total ?? Infinity) || a.id.localeCompare(b.id));
  matches.watches[watch.id] = { sites: siteStatus, listings: relevant.slice(0, 80) };
  for (const r of relevant.filter(r => r.looksLike)) console.log(`LOOKS LIKE ${r.photoScore} ${gbp(r.total)} ${r.site}: ${r.title} ${r.url}`);
  console.log(`${watch.id}: ${found.size} found, ${relevant.length} relevant, ${relevant.filter(r => r.alertable).length} under price, ${relevant.filter(r => r.photoScore != null).length} photo-scored (${relevant.filter(r => r.looksLike).length} look like), ${Object.entries(siteStatus).map(([k, v]) => `${k}=${v}`).join(' ')}`);
}

function describe({ listing, cls }) {
  const why = cls.strength === 'strong' ? `mentions "${cls.matchedTerm}"` : `might be: "${cls.matchedTerm}"`;
  const postage = listing.postage === 'not included' ? ' + postage' : '';
  const seller = listing.sellerStars != null ? `, seller ${listing.sellerStars}★ (${listing.sellerReviews})` : '';
  return { why, postage, seller };
}

let delivered = false;
const deadNow = new Set();

if (alerts.length) {
  for (const a of alerts) {
    const { why, postage, seller } = describe(a);
    console.log(`ALERT ${a.cls.strength} ${gbp(a.listing.total)}${postage} ${a.listing.site}: ${a.listing.title} (${why}${seller}) ${a.listing.url}`);
  }
}

if (!DRY && alerts.length) {
  if (canPush && liveSubs.length) {
    const byWatch = Map.groupBy(alerts, a => a.watch.id);
    for (const group of byWatch.values()) {
      const payloads = group.length > SUMMARISE_OVER
        ? [{
            title: `${group.length} new listings: ${group[0].watch.name}`,
            body: `From ${gbp(Math.min(...group.map(a => a.listing.total)))}. Tap to see them all.`,
            url: config.siteUrl,
          }]
        : group.map(a => {
            const { why, postage } = describe(a);
            return {
              title: `${a.cls.strength === 'strong' ? 'Match' : 'Possible match'}: ${gbp(a.listing.total)}${postage} on ${a.listing.site}`,
              body: `${a.listing.title} (${why})`,
              url: a.listing.url,
            };
          });
      for (const p of payloads) {
        const { sent, dead } = await sendPush(liveSubs.filter(s => !deadNow.has(s.endpoint)), p);
        if (sent) delivered = true;
        dead.forEach(e => deadNow.add(e));
      }
    }
  }

  if (canEmail) {
    const first = alerts[0];
    const subject = alerts.length === 1
      ? `Book Watch: ${first.listing.title.slice(0, 60)} for ${gbp(first.listing.total)} on ${first.listing.site}`
      : `Book Watch: ${alerts.length} new listings under your price`;
    const rows = alerts.map(a => {
      const { why, postage, seller } = describe(a);
      return { a, why, postage, seller };
    });
    const text = rows.map(({ a, why, postage, seller }) =>
      `${gbp(a.listing.total)}${postage} on ${a.listing.site}: ${a.listing.title}\n  ${why}${seller}\n  ${a.listing.url}`).join('\n\n')
      + `\n\nAll matches: ${config.siteUrl}`;
    const html = `<div style="font-family:Georgia,serif;max-width:560px">`
      + rows.map(({ a, why, postage, seller }) =>
        `<p style="margin:0 0 18px"><a href="${esc(a.listing.url)}" style="font-size:17px;color:#5b2a6e"><b>${esc(gbp(a.listing.total))}${esc(postage)}</b> on ${esc(a.listing.site)}</a><br>`
        + `${esc(a.listing.title)}<br><span style="color:#666;font-size:14px">${esc(a.watch.name)}: ${esc(why)}${esc(seller)}</span></p>`).join('')
      + `<p style="font-size:14px"><a href="${esc(config.siteUrl)}">See all matches</a></p></div>`;
    try {
      await sendEmail({ subject, text, html });
      delivered = true;
    } catch (e) {
      console.log(`email failed: ${e.message}`);
    }
  }

  // With nowhere to deliver (no phone signed up yet, no email set), leave alerts pending
  // so they go out once a device is added instead of being silently marked as sent.
  if (delivered) {
    for (const a of alerts) {
      a.seen.alertedPrice = a.listing.total;
      a.seen.alertedAt = today;
    }
  }
}

// The website stamps a subscription with testAt when a phone is added or "Send a test" is
// tapped; a stamp we haven't answered yet gets a test notification.
if (!DRY && canPush) {
  for (const sub of liveSubs.filter(s => s.testAt && state.tested[hash(s.endpoint)] !== s.testAt && !deadNow.has(s.endpoint))) {
    const first = !(hash(sub.endpoint) in state.tested);
    const { sent, dead } = await sendPush([sub], first
      ? { title: 'Notifications are on', body: "You'll get a message here when a listing matches one of your watches.", url: config.siteUrl }
      : { title: 'Test notification', body: 'Book Watch can reach this phone.', url: config.siteUrl });
    if (sent) state.tested[hash(sub.endpoint)] = sub.testAt;
    dead.forEach(e => deadNow.add(e));
  }
}

for (const e of deadNow) state.dead.push(hash(e));

const cutoff = new Date(Date.now() - FORGET_AFTER_DAYS * 86400000).toISOString().slice(0, 10);
const seen = {};
for (const id of Object.keys(state.seen).sort()) {
  const s = state.seen[id];
  if ((s.lastSeen ?? s.firstSeen) >= cutoff) seen[id] = s;
}

if (DRY) {
  console.log(`dry run: ${alerts.length} alert(s) would be sent; nothing written`);
} else {
  await writeJson('data/state.json', { seen, tested: state.tested, dead: state.dead });
  await writeJson('data/matches.json', matches);
  console.log(`${alerts.length} alert(s), delivered: ${delivered}`);
}
