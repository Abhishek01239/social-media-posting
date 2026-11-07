// SmartGearPicks daily poster (GitHub Actions).
// Picks the next unused product photo from the Cloudinary "affiliate" folder
// (strict descending item number), fetches the real product page for title and
// price, composes a 1000x1500 SVG ad, rasterizes + materializes it on
// Cloudinary, posts to Bluesky AND Pinterest via the Zernio API, and only then
// logs the item as used in Supabase "creatives".
// NOTE: affiliate display names / public_ids are bare numbers like "67"
// (no extension) - parse digits, do not require a file extension.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { v2 as cloudinary } from 'cloudinary';
import { createClient } from '@supabase/supabase-js';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const SITE = process.env.SITE_URL || 'https://smartgearpicks.manavvalani.in';
const PER_RUN = parseInt(process.env.PRODUCTS_PER_RUN || '1', 10);
const DAILY_CAP = parseInt(process.env.DAILY_CAP || '20', 10);
const today = new Date().toISOString().slice(0, 10);

// Items already published before this automation existed (covered in run log),
// plus items with no affiliate asset. Never republish item 78's URL.
const SKIP_ITEMS = new Set([11,12,13,14,15,16,21,22,25,49,68,69,70,71,72,77,78,79,
  81,82,85,86,87,88,89,90,92,93,94,95,96,97,98,101,102,103,104,105,106]);

const DISCLOSURE = 'Affiliate disclosure: I may earn from qualifying purchases.';

// Palettes only - headline text always comes from the real product page.
const PALETTES = [
  { bg: ['#1E5C46', '#0E3A2C', '#062018'], accent: '#E8C36A', paper: '#F6F1E7' },
  { bg: ['#2B2118', '#4A3826', '#1A130C'], accent: '#E0B36A', paper: '#F7EFDF' },
  { bg: ['#171C33', '#2A3560', '#0D1020'], accent: '#B9C6F5', paper: '#FFFFFF' },
  { bg: ['#3A1220', '#5C1F33', '#1E0812'], accent: '#F0B7C8', paper: '#FDF3F5' },
];

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clean = s => String(s).replace(/[,+]/g, ' ').replace(/\s+/g, ' ').trim();

// 1. Daily cap guard: creatives rows inserted in the last 24h
const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const { count } = await supabase.from('creatives').select('id', { count: 'exact', head: true }).gte('created_at', since);
const made = count || 0;
if (made >= DAILY_CAP) { console.log(`Daily cap reached (${made}). Exiting.`); process.exit(0); }
const budget = Math.min(PER_RUN, DAILY_CAP - made);
for (let i = 0; i < budget; i++) {

// 2. Next unused product: descending item number from affiliate folder.
// Item number = digits found anywhere in the display name or public_id.
const q = await cloudinary.search.expression('asset_folder:affiliate').max_results(200).execute();
const products = q.resources
  .map(r => ({ r, n: parseInt(String(r.display_name || r.public_id).match(/\d+/)?.[0] ?? 'NaN', 10) }))
  .filter(p => !Number.isNaN(p.n))
  .sort((a, b) => b.n - a.n);
console.log(`Affiliate assets found: ${q.resources.length}, with valid item numbers: ${products.length}. Highest: ${products[0]?.n}.`);
const { data: usedRows } = await supabase.from('creatives').select('item');
const used = new Set((usedRows || []).map(r => String(r.item)));
const next = products.find(p => !used.has(String(p.n)) && !SKIP_ITEMS.has(p.n));
if (!next) { console.log('No unused products left. Exiting.'); process.exit(0); }
const n = next.n, photoUrl = next.r.secure_url;
console.log(`Item ${n} -> ${photoUrl}`);

// 3. Product URL + real product facts from the product page
const slug = JSON.parse(readFileSync(new URL('../data/product-urls.json', import.meta.url), 'utf8'))[String(n)];
const productUrl = slug ? `${SITE}/product/${slug}` : SITE;
if (!slug) console.log(`WARNING: no URL mapping for item ${n}; using site homepage.`);
let title = 'Featured Pick', hook = 'Curated finds for everyday life', price = '';
try {
  const page = await fetch(productUrl, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  const html = await page.text();
  const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1]
    ?? html.match(/<title>([^<]+)<\/title>/i)?.[1];
  if (ogTitle) title = clean(ogTitle.replace(/\s*\|[^|]*$/, '')).slice(0, 90);
  const ogDesc = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1];
  if (ogDesc) hook = clean(ogDesc).slice(0, 120);
  const p = clean(html.match(/Rs\.?\s*[\d,]+(?:\.\d{2})?/i)?.[0] ?? '');
  if (p) price = p.startsWith('Rs') ? p : `Rs.${p}`;
} catch (e) { console.log(`Product page fetch failed (${e.message}); using generic copy.`); }

// 4. Compose SVG (no commas/plus inside <text> elements - Cloudinary gotcha)
const t = PALETTES[n % PALETTES.length];
const head = esc(title), sub = esc(hook), priceLine = esc(price);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1500" viewBox="0 0 1000 1500">
<defs><radialGradient id="g" cx="0.5" cy="0.4" r="0.85"><stop offset="0" stop-color="${t.bg[0]}"/><stop offset="0.55" stop-color="${t.bg[1]}"/><stop offset="1" stop-color="${t.bg[2]}"/></radialGradient></defs>
<rect width="1000" height="1500" fill="url(#g)"/>
<text x="500" y="120" text-anchor="middle" font-family="Arial" font-size="26" letter-spacing="12" fill="${t.accent}">SMARTGEARPICKS</text>
<text x="500" y="230" text-anchor="middle" font-family="Georgia, serif" font-size="64" font-weight="bold" fill="${t.paper}">${head}</text>
<text x="500" y="300" text-anchor="middle" font-family="Georgia, serif" font-size="30" font-style="italic" fill="${t.accent}">${sub}</text>
<ellipse cx="500" cy="1215" rx="310" ry="48" fill="#000" opacity="0.45"/>
<image href="${photoUrl}" x="275" y="470" width="450" height="450"/>
${price ? `<text x="500" y="1130" text-anchor="middle" font-family="Arial" font-size="40" font-weight="bold" fill="${t.accent}">${priceLine}</text>` : ''}
<rect x="330" y="1330" width="340" height="78" rx="39" fill="${t.accent}"/>
<text x="500" y="1382" text-anchor="middle" font-family="Arial" font-size="32" font-weight="bold" letter-spacing="8" fill="${t.bg[2]}">SHOP NOW</text>
<text x="500" y="1462" text-anchor="middle" font-family="Arial" font-size="21" letter-spacing="3" fill="${t.accent}" opacity="0.75">smartgearpicks.manavvalani.in</text>
</svg>`;

// 5. Upload SVG -> rasterize -> materialize (final asset URL is bare, no commas)
const svgUpload = await cloudinary.uploader.upload(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
  { asset_folder: 'SmartGearPicks', public_id: `item-${n}-${today}-svg`, overwrite: true, tags: 'github-actions' });
const rasterized = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/f_jpg,q_auto:good/v${svgUpload.version}/${svgUpload.public_id}.jpg`;
const final = await cloudinary.uploader.upload(rasterized,
  { asset_folder: 'SmartGearPicks', public_id: `item-${n}-${today}`, overwrite: true, tags: 'final, published-graphic, daily-social-posting' });
console.log('Final JPG:', final.secure_url);

// 6. Caption - Bluesky hard limit 300 chars including link + disclosure
const withLink = `${title} - ${hook}\n\nProduct link: ${productUrl}\n${DISCLOSURE}`;
let caption = withLink.length < 280 ? `${withLink}\n#SmartGearPicks` : withLink;
if (caption.length >= 300) caption = `${title}\n\n${productUrl}\n${DISCLOSURE}`;
if (caption.length >= 300) throw new Error(`Caption still too long (${caption.length}) - aborting before post.`);
console.log(`Caption ${caption.length} chars.`);

// 7. Post via Zernio API - one call covers Bluesky AND Pinterest.
// Only mark the item used AFTER the post request succeeds.
const resp = await fetch('https://zernio.com/api/v1/posts', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${ZERNIO_API_KEY}`,
    'content-type': 'application/json',
    'idempotency-key': crypto.randomUUID(),
  },
  body: JSON.stringify({
    content: caption,
    mediaItems: [{ type: 'image', url: final.secure_url }],
    platforms: [
      { platform: 'bluesky', accountId: process.env.ZERNIO_BLUESKY_ACCOUNT_ID },
      { platform: 'pinterest', accountId: process.env.ZERNIO_PINTEREST_ACCOUNT_ID },
    ],
  }),
});
const body = await resp.json().catch(() => ({}));
if (!resp.ok) throw new Error(`Zernio post failed ${resp.status}: ${JSON.stringify(body)}`);
console.log('ZERNIO RESPONSE:', JSON.stringify(body).slice(0, 600));

// 8. Log as used (gallery row). If this fails, worst case is a duplicate next run.
const { error: insErr } = await supabase.from('creatives')
  .insert({ item: n, title, image_url: final.secure_url, price: price || null, template: `gh-actions-${t.bg[0].slice(1)}` });
if (insErr) console.error('WARNING: creatives insert failed:', insErr.message);
console.log(`DONE item ${n} -> ${productUrl}`);
}
