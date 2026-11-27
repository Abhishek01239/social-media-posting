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

## YouTube to Pinterest + Facebook + Instagram (Galaxy Of Games AR)
`.github/workflows/youtube-to-pinterest.yml` runs every 3 hours (plus a manual Run button). It reads the Galaxy Of Games AR YouTube RSS feed and, for every new Short and video (last 72 h):
- **Pinterest:** pins it to the **MINECRAFT** board (YouTube thumbnail + title + link back to the video).
- **Facebook:** uploads the **real video** to the Facebook Page "mineWolrd": Shorts as **Reels**, long videos as feed videos. The original MP4 is found in the main Zernio account (the one that uploads to YouTube, read-only). If it can't be found, it falls back to a caption + YouTube link post.

- **Instagram:** every Instagram account connected in the Zernio account gets each upload: Shorts as **Reels** (the real video), long videos as a **thumbnail post** with the YouTube link in the caption. Set the optional secret `ZERNIO_INSTA_KEY` only if those Instagram accounts live in a different Zernio account; `INSTAGRAM_ACCOUNT_IDS` limits which accounts get posts.

Duplicates are blocked per platform with Zernio's `externalId` (`pin-<videoId>`, `fb-<videoId>`, `ig-<accountId>-<videoId>`). A platform that isn't connected is skipped. Standard-library Python only (`scripts/youtube_to_pinterest.py`).

Secrets: **ZERNIO_MAIN_KEY** = API key of the main Zernio account (only read, to find the original video files). It reads the posting key from the repo secret **ZERNIO_API_KEY**, which now holds the API key of the Zernio account with the Minecraft Pinterest and Facebook Page connected. Note: the SmartGearPicks workflow above reads the same secret with its own hardcoded account IDs, so it will fail unless those accounts are in this Zernio account too.

Change the board, channel, platforms (`PLATFORMS`), age window or uploads per run in the workflow `env`. Test without posting by running the script locally with `DRY_RUN=1`.
