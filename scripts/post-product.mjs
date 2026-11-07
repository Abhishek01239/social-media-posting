// SmartGearPicks daily poster (GitHub Actions) - SITE-DRIVEN + AI-GENERATED creatives.
// Every run: fetch the live sitemap of smartgearpicks.manavvalani.in, pick random
// /product/ URLs (duplicates across days are fine), read each product page's real
// og:title / og:image / og:description / price, then GENERATE a fresh premium ad
// image with Pollinations (image-to-image with the real product photo as reference
// so the product stays recognizable; falls back to text-to-image). Posts to
// Bluesky AND Pinterest via the Zernio API, caption links THAT product page.
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

// Condensed from the user's master prompt: premium Pinterest ad, category-adaptive,
// preserve the real product, never invent claims, minimal text (AI text renders badly).
const masterPrompt = (title, desc) => `World-class creative director Pinterest advertisement, vertical 2:3 premium commercial product photography of: ${title}. ${desc}. Automatically detect the product category and build a category-appropriate concept: fashion = editorial with stylish models and fabric detail, beauty = luxury skincare lifestyle, fitness = dynamic gym scene, kitchen = modern kitchen food scene, electronics = futuristic gradient tech presentation, home = elegant interior lifestyle. Keep the product EXACTLY as referenced: same shape colors logo packaging proportions, do not redesign or distort it, product is the hero focal point. Cinematic lighting, realistic shadows and depth, premium background, harmonious colors, high-end retouching, professional advertising agency quality. Truthful marketing only: never invent medical technical safety performance or certification claims. Minimal or NO text in the image. Photorealistic, no clutter, no watermark, no misspelled words.`;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clean = s => String(s).replace(/[,+]/g, ' ').replace(/\s+/g, ' ').trim();
const abs = u => (u && u.startsWith('http') ? u : u ? `${SITE}${u}` : u);

// Generate ONE 1000x1500 AI creative. Reference image first (img2img keeps the
// real product recognizable), text-to-image as fallback.
async function generateCreative(prompt, refImage) {
  const seed = crypto.randomInt(1, 1_000_000);
  const base = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
  const attempts = [
    `${base}?model=kontext&image=${encodeURIComponent(refImage)}&width=1000&height=1500&nologo=true&seed=${seed}`,
    `${base}?width=1000&height=1500&nologo=true&model=flux&seed=${seed}`,
  ];
  for (const url of attempts) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
      const type = r.headers.get('content-type') || '';
      if (r.ok && type.startsWith('image/')) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 10000) return `data:${type};base64,${buf.toString('base64')}`;
      }
      console.log(`Generator attempt failed (${r.status} ${type}); trying fallback.`);
    } catch (e) { console.log(`Generator attempt failed (${e.message}); trying fallback.`); }
  }
  throw new Error('all image generation attempts failed');
}

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
    const refImg = abs(og('image'));
    const price = clean(html.match(/Rs\.?\s*[\d,]+(?:\.\d{2})?/i)?.[0] ?? '');
    const slug = productUrl.split('/product/')[1]?.replace(/\/$/, '') || productUrl;
    console.log(`\nPICKED ${slug} (${productUrl})`);

    // 4. Generate a totally new AI creative from the master prompt
    const dataUri = await generateCreative(masterPrompt(title, hook), refImg);

    // 5. Materialize on Cloudinary
    const final = await cloudinary.uploader.upload(dataUri,
      { asset_folder: 'SmartGearPicks', public_id: `${slug.slice(0, 60)}-${Date.now()}`, overwrite: true, tags: 'final, published-graphic, daily-social-posting, ai-generated' });
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
      .insert({ item: 0, slug, title, image_url: final.secure_url, price: price || null, product_url: productUrl, template: 'site-ai-generated' });
    if (insErr) console.error('WARNING: creatives insert failed:', insErr.message);
    console.log(`DONE ${slug} -> ${productUrl}`);
    done++;
  } catch (e) {
    console.error(`SKIP (${productUrl}): ${e.message}`);
  }
}
console.log(`\nFinished: ${done} posted this run.`);
