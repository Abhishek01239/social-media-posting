# SmartGearPicks auto-poster

GitHub Actions engine that posts SmartGearPicks products to Bluesky + Pinterest (via the Zernio API) and harvests AI images into Cloudinary.

## Workflows
- **Daily product posts** (`.github/workflows/daily-posts.yml`) - runs 10:00 / 14:00 / 18:00 IST plus a manual Run button. Picks the next unused item from the Cloudinary `affiliate` folder (strict descending), fetches the real product title/price from the product page, builds a 1000x1500 ad, posts to both platforms, logs it in Supabase `creatives`.
- **AI image harvester** (`.github/workflows/harvester.yml`) - every 15 min. Turns Littlebird `/f/` viewer links queued in Supabase `pending_uploads` into permanent Cloudinary assets (headless Chrome).

## Required repo secrets (Settings > Secrets and variables > Actions > New repository secret)
| Secret | Value |
|---|---|
| CLOUDINARY_API_KEY | from Cloudinary console |
| CLOUDINARY_API_SECRET | from Cloudinary console |
| SUPABASE_URL | https://xfwhmvhremsljuebxmik.supabase.co |
| SUPABASE_SERVICE_KEY | service_role key from Supabase > Settings > API |
| ZERNIO_API_KEY | from zernio.com/dashboard/api-keys (shown once) |

Cloud name and the Zernio account IDs are already hardcoded in the workflow env.

## State / duplicate protection
- Used items live in Supabase table `public.creatives` (columns item, title, image_url, price, template).
- `data/product-urls.json` maps item numbers to product-page slugs (items 1-72 plus 77, 78). Add rows there when new products are added.
- Never republish item 78 (its URL went out mislabeled as 98).
- Bluesky captions are kept under 300 chars (link + disclosure included).

## First-time test
1. Add the 5 secrets above.
2. Actions > Daily product posts > Run workflow > watch it go green.
3. Verify the post on Bluesky/Pinterest, and check Zernio's failed-posts list (Zernio can return an id yet the post can still fail if the caption is over the limit).
4. After the first green run, pause the three Littlebird routines so nothing double-posts.
