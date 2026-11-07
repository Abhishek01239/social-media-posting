// SmartGearPicks daily poster (GitHub Actions) - SITE-DRIVEN mode.
// Every run: fetch the live sitemap of smartgearpicks.manavvalani.in, pick
// random products (duplicates across days are fine), read each product page's
// real og:title / og:image / og:description / price, compose a 1000x1500 SVG ad
// around the REAL product photo, rasterize + materialize on Cloudinary, post to
// Bluesky AND Pinterest via the Zernio API with the caption linking to THAT
// product page, then log it in Supabase "creatives" (item=0, slug set).
// No serial-number state: the site is always the source of truth.
import crypto from 'node:crypto';
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
const PER_RUN = parseInt(process.env.PRODUCTS_PER_RUN || '5', 10);
const DAILY_CAP = parseInt(process.env.DAILY_CAP || '15', 10);
const DISCLOSURE = 'Affiliate disclosure: I may earn from qualifying purchases.';

const PALETTES = [
  { bg: ['#1E5C46', '#0E3A2C', '#062018'], accent: '#E8C36A', paper: '#F6F1E7' },
  { bg: ['#2B2118', '#4A3826', '#1A130C'], accent: '#E0B36A', paper: '#F7EFDF' },
  { bg: ['#171C33', '#2A3560', '#0D1020'], accent: '#B9C6F5', paper: '#FFFFFF' },
  { bg: ['#3A1220', '#5C1F33', '#1E0812'], accent: '#F0B7C8', paper: '#FDF3F5' },
];

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clean = s => String(s).replace(/[,+]/g, ' ').replace(/\s+/g, ' ').trim();
const abs = u => (u && u.startsWith('http') ? u : u ? `${SITE}${u}` : u);

// 1. Daily cap guard (rows inserted in the last 24h, all sources)
const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const { count } = await supabase.from('creatives').select('id', { count: 'exact', head: true }).gte('created_at', since);
const made = count || 0;
if (made >= DAILY_CAP) { console.log(`Daily cap reached (${made}/${DAILY_CAP}). Exiting.`); process.exit(0); }
const budget = Math.min(PER_RUN, DAILY_CAP - made);

// 2. Live product list from the site sitemap
const sm = await fetch(`${SITE}/sitemap.xml`, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
if (!sm.ok) throw new Error(`Sitemap fetch failed ${sm.status}`);
const urls = (await sm.text()).match(/<loc>([^<]+)<\/loc>/g)
  ?.map(l => l.replace(/<\/?loc>/g, '').trim())
  .filter(u => /\/product\//.test(u)) || [];
if (!urls.length) throw new Error('No /product/ URLs in sitemap - site structure changed?');
console.log(`Sitemap: ${urls.length} products live.`);

// Random sample without replacement within this run
const picked = urls.map(u => ({ u, r: Math.random() })).sort((a, b) => a.r - b.r).slice(0, budget + 3).map(p => p.u);
let done = 0;

for (const productUrl of picked) {
  if (done >= budget) break;
  try {
    // 3. Real product facts from its page
    const page = await fetch(productUrl, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(25000) });
    if (!page.ok) throw new Error(`page ${page.status}`);
    const html = await page.text();
    const og = p => html.match(new RegExp(`<meta[^>]+property="og:${p}"[^>]+content="([^"]+)"`, 'i'))?.[1]
      ?? html.match(new RegExp(`<meta[^>]+content="([^"]+)"[^>]+property="og:${p}"`, 'i'))?.[1];
    const title = clean(og('title')?.replace(/\s*\|[^|]*$/, '') || 'Featured Pick').slice(0, 90);
    const hook = clean(og('description') || 'Curated finds for everyday life').slice(0, 120);
    const img = abs(og('image'));
    if (!img) throw new Error('no og:image - skipping');
    const price = clean(html.match(/Rs\.?\s*[\d,]+(?:\.\d{2})?/i)?.[0] ?? '');
    const slug = productUrl.split('/product/')[1]?.replace(/\/$/, '') || productUrl;
    console.log(`\nPICKED ${slug} (${productUrl})`);

    // 4. Compose SVG around the real product photo (no commas/plus in <text>)
    const t = PALETTES[Math.floor(Math.random() * PALETTES.length)];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1500" viewBox="0 0 1000 1500">
<defs><radialGradient id="g" cx="0.5" cy="0.4" r="0.85"><stop offset="0" stop-color="${t.bg[0]}"/><stop offset="0.55" stop-color="${t.bg[1]}"/><stop offset="1" stop-color="${t.bg[2]}"/></radialGradient></defs>
<rect width="1000" height="1500" fill="url(#g)"/>
<text x="500" y="120" text-anchor="middle" font-family="Arial" font-size="26" letter-spacing="12" fill="${t.accent}">SMARTGEARPICKS</text>
<text x="500" y="230" text-anchor="middle" font-family="Georgia serif" font-size="64" font-weight="bold" fill="${t.paper}">${esc(title)}</text>
<text x="500" y="300" text-anchor="middle" font-family="Georgia serif" font-size="30" font-style="italic" fill="${t.accent}">${esc(hook)}</text>
<ellipse cx="500" cy="1215" rx="310" ry="48" fill="#000" opacity="0.45"/>
<image href="${img}" x="225" y="430" width="550" height="550"/>
${price ? `<text x="500" y="1130" text-anchor="middle" font-family="Arial" font-size="40" font-weight="bold" fill="${t.accent}">${esc(price)}</text>` : ''}
<rect x="330" y="1330" width="340" height="78" rx="39" fill="${t.accent}"/>
<text x="500" y="1382" text-anchor="middle" font-family="Arial" font-size="32" font-weight="bold" letter-spacing="8" fill="${t.bg[2]}">SHOP NOW</text>
<text x="500" y="1462" text-anchor="middle" font-family="Arial" font-size="21" letter-spacing="3" fill="${t.accent}" opacity="0.75">smartgearpicks.manavvalani.in</text>
</svg>`;

    // 5. Upload SVG -> rasterize -> materialize on Cloudinary
    const svgUpload = await cloudinary.uploader.upload(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
      { asset_folder: 'SmartGearPicks', public_id: `${slug.slice(0, 60)}-${Date.now()}-svg`, overwrite: true, tags: 'github-actions' });
    const rasterized = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/f_jpg,q_auto:good/v${svgUpload.version}/${svgUpload.public_id}.jpg`;
    const final = await cloudinary.uploader.upload(rasterized,
      { asset_folder: 'SmartGearPicks', public_id: `${slug.slice(0, 60)}-${Date.now()}`, overwrite: true, tags: 'final, published-graphic, daily-social-posting' });
    console.log('Final JPG:', final.secure_url);

    // 6. Caption: product link mandatory, under 300 chars total
    const withLink = `${title} - ${hook}\n\nProduct link: ${productUrl}\n${DISCLOSURE}`;
    let caption = withLink.length < 280 ? `${withLink}\n#SmartGearPicks` : withLink;
    if (caption.length >= 300) caption = `${title}\n\n${productUrl}\n${DISCLOSURE}`;
    if (caption.length >= 300) throw new Error(`caption too long (${caption.length})`);
    console.log(`Caption ${caption.length} chars.`);

    // 7. Post to Bluesky + Pinterest via Zernio; log only after success
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
    if (!resp.ok) throw new Error(`Zernio ${resp.status}: ${JSON.stringify(body)}`);
    console.log('ZERNIO RESPONSE:', JSON.stringify(body).slice(0, 500));

    const { error: insErr } = await supabase.from('creatives')
      .insert({ item: 0, slug, title, image_url: final.secure_url, price: price || null, product_url: productUrl, template: `site-random-${t.bg[0].slice(1)}` });
    if (insErr) console.error('WARNING: creatives insert failed:', insErr.message);
    console.log(`DONE ${slug} -> ${productUrl}`);
    done++;
  } catch (e) {
    console.error(`SKIP (${productUrl}): ${e.message}`);
  }
}
console.log(`\nFinished: ${done} posted this run.`);
