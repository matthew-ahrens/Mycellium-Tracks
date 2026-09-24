/* One-time cleanup for photos uploaded before 2026-09-24 (PC only).
 *
 * For every photo row that has no thumb_path yet:
 *   - original: strip all metadata except capture date + orientation
 *     (lossless - pixels untouched), re-upload to the same path
 *   - display:  ~2048px JPEG q85 (skipped if the original is already small)
 *   - thumb:    ~480px JPEG q80
 *   - row gets thumb_path / display_path
 * Plus the profile avatar: re-made as one ~512px JPEG, old file removed.
 * All uploads get a 1-year cache-control. Safe to re-run: rows that already
 * have a thumb_path are skipped, and small avatars are left alone.
 *
 * Needs the Supabase *secret* key (Dashboard > Project Settings > API Keys)
 * in .env.local as SUPABASE_SECRET_KEY=... - that file is gitignored and
 * Vite never ships non-VITE_ vars to the browser. Never commit the key.
 *
 *   node scripts/backfill-photos.mjs           dry run - reports only
 *   node scripts/backfill-photos.mjs --apply   does it
 *   add --dates to also set taken_on from the photo's EXIF capture date
 *   (only where the two differ; the dry run lists them first)
 */
import fs from 'node:fs';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
import { cleanJpegOriginal, readKeptExif, exifDateToISO } from '../src/photoProcessing.js';

const APPLY = process.argv.includes('--apply');
const DATES = process.argv.includes('--dates');
const CACHE = '31536000';

const env = Object.fromEntries(fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => /^\s*[A-Z_]+\s*=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const url = env.VITE_SUPABASE_URL, key = env.SUPABASE_SECRET_KEY;
if (!url || !key) { console.error('Need VITE_SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local'); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false } });
const bucket = sb.storage.from('photos');

const mb = (n) => (n / 1e6).toFixed(2) + ' MB';
const download = async (path) => {
    const { data, error } = await bucket.download(path);
    if (error) throw new Error(`download ${path}: ${error.message}`);
    return Buffer.from(await data.arrayBuffer());
};
const upload = async (path, buf) => {
    if (!APPLY) return;
    const { error } = await bucket.upload(path, buf, { upsert: true, cacheControl: CACHE, contentType: 'image/jpeg' });
    if (error) throw new Error(`upload ${path}: ${error.message}`);
};
const resized = (buf, edge, quality) => sharp(buf).rotate()
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true }).toBuffer();

console.log(APPLY ? 'APPLYING CHANGES' : 'DRY RUN - nothing will be changed (add --apply)');

const { data: photos, error } = await sb.from('photos').select('*').is('thumb_path', null).order('created_at');
if (error) { console.error(error); process.exit(1); }
console.log(`${photos.length} photo(s) to process\n`);

let before = 0, thumbs = 0, displays = 0, done = 0;
const dateFixes = [];
for (const p of photos) {
    try {
        const orig = await download(p.storage_path);
        before += orig.length;
        const bytes = new Uint8Array(orig);
        const exifDate = exifDateToISO(readKeptExif(bytes).dateTimeOriginal);
        if (exifDate && exifDate !== p.taken_on) dateFixes.push({ id: p.id, path: p.storage_path, taken_on: p.taken_on, exif: exifDate });

        const cleaned = cleanJpegOriginal(bytes);
        const meta = await sharp(orig).metadata();
        const rotated = (meta.orientation ?? 1) >= 5;
        const longEdge = Math.max(meta.width, meta.height);
        const baseName = p.storage_path.replace(/\.[^./]+$/, '');

        const thumb = await resized(orig, 480, 80);
        const thumbPath = `${baseName}-thumb.jpg`;
        let displayPath = p.storage_path;
        let display = null;
        if (longEdge > 2048 || !cleaned) {
            display = await resized(orig, 2048, 85);
            displayPath = `${baseName}-display.jpg`;
        }
        thumbs += thumb.length; displays += display?.length ?? 0;

        if (cleaned) await upload(p.storage_path, Buffer.from(cleaned));
        await upload(thumbPath, thumb);
        if (display) await upload(displayPath, display);
        if (APPLY) {
            const { error: uErr } = await sb.from('photos').update({ thumb_path: thumbPath, display_path: displayPath }).eq('id', p.id);
            if (uErr) throw new Error(`row ${p.id}: ${uErr.message}`);
        }
        done++;
        console.log(`ok  ${p.storage_path}  ${mb(orig.length)}${cleaned ? ` -> cleaned ${mb(cleaned.length)}` : ' (not a JPEG, left as-is)'}`
            + `  thumb ${(thumb.length / 1024).toFixed(0)} KB${display ? `  display ${(display.length / 1024).toFixed(0)} KB` : '  display = original'}${rotated ? '  [rotated]' : ''}`);
    } catch (e) {
        console.error(`ERR ${p.storage_path}: ${e.message}`);
    }
}

console.log(`\n${done}/${photos.length} photos. Originals: ${mb(before)}. New thumbs: ${mb(thumbs)}. New display copies: ${mb(displays)}.`);

if (dateFixes.length) {
    console.log(`\n${dateFixes.length} photo(s) whose taken_on differs from the camera's capture date:`);
    dateFixes.forEach((d) => console.log(`   ${d.path}  taken_on ${d.taken_on ?? '(none)'}  ->  camera ${d.exif}`));
    if (DATES && APPLY) {
        for (const d of dateFixes) await sb.from('photos').update({ taken_on: d.exif }).eq('id', d.id);
        console.log('   updated.');
    } else console.log('   (not changed - run with --apply --dates to use the camera dates)');
}

/* ---- avatar(s) ---- */
const { data: profiles } = await sb.from('profiles').select('id, avatar_url').not('avatar_url', 'is', null);
for (const pr of profiles ?? []) {
    try {
        const buf = await download(pr.avatar_url);
        if (buf.length < 150 * 1024) { console.log(`\navatar ${pr.avatar_url} already small, skipped`); continue; }
        const small = await resized(buf, 512, 85);
        const newPath = `avatars/${pr.id}-${Date.now()}.jpg`;
        console.log(`\navatar ${pr.avatar_url} ${mb(buf.length)} -> ${newPath} ${(small.length / 1024).toFixed(0)} KB`);
        if (APPLY) {
            await upload(newPath, small);
            const { error: aErr } = await sb.from('profiles').update({ avatar_url: newPath }).eq('id', pr.id);
            if (aErr) throw new Error(aErr.message);
            await bucket.remove([pr.avatar_url]);
        }
    } catch (e) {
        console.error(`ERR avatar ${pr.avatar_url}: ${e.message}`);
    }
}
console.log(APPLY ? '\nDone.' : '\nDry run finished - run again with --apply to do it.');
