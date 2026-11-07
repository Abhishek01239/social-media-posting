// Reads public.pending_uploads in Supabase. For every row with status 'pending',
// opens the Littlebird viewer URL in a headless browser, saves the real image
// bytes, uploads to Cloudinary SmartGearPicks/scenes, and marks the row done.
// This is the AI-image bridge: Littlebird generates -> I queue the link here ->
// this script turns it into a permanent Cloudinary URL.
import puppeteer from 'puppeteer';
import { v2 as cloudinary } from 'cloudinary';
import { createClient } from '@supabase/supabase-js';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: rows, error } = await supabase
  .from('pending_uploads').select('*').eq('status', 'pending').order('id').limit(5);
if (error) throw new Error(error.message);
if (!rows?.length) { console.log('Queue empty.'); process.exit(0); }

const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
for (const row of rows) {
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 1800, deviceScaleFactor: 1 });
    await page.goto(row.viewer_url, { waitUntil: 'networkidle0', timeout: 90000 });
    await page.waitForSelector('img', { timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));
    // Prefer the direct img src; fall back to screenshotting the image element.
    const src = await page.$eval('img', el => el.src).catch(() => null);
    let uploaded;
    if (src && src.startsWith('http')) {
      uploaded = await cloudinary.uploader.upload(src,
        { asset_folder: 'SmartGearPicks/scenes', tags: 'ai-scene, harvested' });
    } else {
      const el = await page.$('img');
      const shot = await el.screenshot({ encoding: 'base64' });
      uploaded = await cloudinary.uploader.upload(`data:image/png;base64,${shot}`,
        { asset_folder: 'SmartGearPicks/scenes', tags: 'ai-scene, harvested' });
    }
    await supabase.from('pending_uploads')
      .update({ status: 'done', cloudinary_url: uploaded.secure_url, note: `public_id ${uploaded.public_id}` })
      .eq('id', row.id);
    console.log(`Harvested row ${row.id} -> ${uploaded.secure_url}`);
    await page.close();
  } catch (e) {
    console.error(`Row ${row.id} failed: ${e.message}`);
    await supabase.from('pending_uploads').update({ status: 'failed', note: e.message.slice(0, 300) }).eq('id', row.id);
  }
}
await browser.close();
