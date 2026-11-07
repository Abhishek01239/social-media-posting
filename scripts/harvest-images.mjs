// AI-image bridge: Littlebird generates -> link queued in public.pending_uploads
// -> this script opens the viewer URL headless, extracts image bytes, uploads to
// Cloudinary SmartGearPicks/scenes, marks the row done. On ANY crash it writes a
// diagnostic row into pending_uploads so failures are readable from Supabase.
import puppeteer from 'puppeteer';
import { v2 as cloudinary } from 'cloudinary';
import { createClient } from '@supabase/supabase-js';

const STEP = ['start'];

async function reportCrash(supabase, where, e) {
  const msg = `HARVESTER CRASH at ${where} (step ${STEP.join('>')}) [${new Date().toISOString()}]: ${e?.message || e}`.slice(0, 500);
  console.error(msg);
  try {
    await supabase.from('pending_uploads').insert({ viewer_url: 'crash-report', status: 'failed', note: msg });
  } catch (e2) {
    console.error('Could not write crash report to Supabase:', e2?.message || e2);
  }
}

async function main() {
  const need = ['CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) throw new Error('Missing env vars: ' + missing.join(', '));
  console.log('Env vars present. SUPABASE_URL=' + process.env.SUPABASE_URL);

  STEP.push('supabase-client');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  STEP.push('query-queue');
  const { data: rows, error } = await supabase
    .from('pending_uploads').select('*').eq('status', 'pending').order('id').limit(5);
  if (error) throw new Error('Supabase query failed: ' + error.message);
  if (!rows?.length) { console.log('Queue empty.'); return; }
  console.log(`Processing ${rows.length} row(s): ${rows.map((r) => r.id).join(', ')}`);

  STEP.push('launch-browser');
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    for (const row of rows) {
      try {
        STEP.push(`row-${row.id}-open`);
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 1800, deviceScaleFactor: 1 });
        await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36');
        await page.goto(row.viewer_url, { waitUntil: 'networkidle2', timeout: 90000 });
        await page.waitForSelector('img', { timeout: 60000 });
        await new Promise((r) => setTimeout(r, 3000));

        STEP.push(`row-${row.id}-extract`);
        // Prefer the direct img src; fall back to screenshotting the image element.
        const src = await page.$eval('img', (el) => el.src).catch(() => null);
        let uploaded;
        if (src && src.startsWith('http')) {
          console.log(`Row ${row.id}: uploading src ${src.slice(0, 120)}`);
          uploaded = await cloudinary.uploader.upload(src,
            { asset_folder: 'SmartGearPicks/scenes', tags: 'ai-scene,harvested' });
        } else {
          const el = await page.$('img');
          if (!el) throw new Error('No <img> found on viewer page');
          const shot = await el.screenshot({ encoding: 'base64' });
          uploaded = await cloudinary.uploader.upload(`data:image/png;base64,${shot}`,
            { asset_folder: 'SmartGearPicks/scenes', tags: 'ai-scene,harvested' });
        }

        STEP.push(`row-${row.id}-mark-done`);
        await supabase.from('pending_uploads')
          .update({ status: 'done', cloudinary_url: uploaded.secure_url, note: `public_id ${uploaded.public_id}` })
          .eq('id', row.id);
        console.log(`Harvested row ${row.id} -> ${uploaded.secure_url}`);
        await page.close();
      } catch (e) {
        console.error(`Row ${row.id} failed: ${e.message}`);
        await supabase.from('pending_uploads')
          .update({ status: 'failed', note: `row ${row.id}: ${e.message}`.slice(0, 500) })
          .eq('id', row.id);
      }
    }
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (e) {
  try {
    const supabase = createClient(process.env.SUPABASE_URL || 'https://xfwhmvhremsljuebxmik.supabase.co', process.env.SUPABASE_SERVICE_KEY || 'x');
    await reportCrash(supabase, 'main', e);
  } catch {
    console.error('CRASH:', e?.message || e);
  }
  process.exit(1);
}
