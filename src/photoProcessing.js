/* Photo processing at upload (2026-09-24).
 *
 * Every uploaded photo becomes three files:
 *   - thumb    ~480px long edge, JPEG q0.80  -> grids, mosaic, photo strips
 *   - display  ~2048px long edge, JPEG q0.85 -> what the lightbox opens
 *   - original full pixels, untouched       -> only fetched on "Full size"
 *
 * Why: grids were downloading 2-4 MB phone originals for ~200px tiles, which
 * is what blew through the Supabase free-plan egress cap (99.7% Storage).
 *
 * Metadata: nothing but the capture date and orientation survives. Thumb
 * and display are re-drawn through a canvas (the browser applies EXIF
 * orientation when drawing, so the pixels come out upright and no metadata
 * is carried over at all). The original's pixels are never re-encoded -
 * its APP segments are stripped byte-for-byte (EXIF incl. GPS/camera info,
 * XMP, IPTC, comments) and a minimal EXIF with only Orientation +
 * DateTimeOriginal is written back. The ICC color profile (APP2) and the
 * Adobe marker (APP14) are kept so colors don't shift.
 *
 * Non-JPEG originals (PNG/WebP/HEIC that the browser can decode) are
 * re-encoded once at full resolution as JPEG q0.92, which drops their
 * metadata too.
 */
import piexif from 'piexifjs';

export const THUMB_EDGE = 480;
export const DISPLAY_EDGE = 2048;

const toBinaryString = (bytes) => {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return s;
};
const fromBinaryString = (s) => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
};

const isJpegBytes = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/* Walk the JPEG header and drop every APPn segment except APP2 (ICC
   profile) and APP14 (Adobe), plus COM comment segments. Stops at SOS -
   everything after that is compressed image data and is copied as-is,
   so pixels are untouched. Returns null if the file doesn't parse. */
export function stripJpegSegments(bytes) {
    if (!isJpegBytes(bytes)) return null;
    const keep = [bytes.subarray(0, 2)]; // SOI
    let i = 2;
    while (i < bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const marker = bytes[i + 1];
        if (marker === 0xda) { // SOS: rest of file is scan data
            keep.push(bytes.subarray(i));
            break;
        }
        if (marker === 0xd9) { keep.push(bytes.subarray(i, i + 2)); break; } // EOI
        const len = (bytes[i + 2] << 8) | bytes[i + 3];
        const seg = bytes.subarray(i, i + 2 + len);
        const isApp = marker >= 0xe0 && marker <= 0xef;
        const drop = (isApp && marker !== 0xe2 && marker !== 0xee && marker !== 0xe0) || marker === 0xfe;
        if (!drop) keep.push(seg);
        i += 2 + len;
    }
    const total = keep.reduce((n, s) => n + s.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const s of keep) { out.set(s, o); o += s.length; }
    return out;
}

/* Read just the two fields we keep. Never throws. */
export function readKeptExif(bytes) {
    try {
        const ex = piexif.load(toBinaryString(bytes));
        return {
            orientation: ex['0th']?.[piexif.ImageIFD.Orientation] ?? null,
            dateTimeOriginal: ex.Exif?.[piexif.ExifIFD.DateTimeOriginal] ?? null,
        };
    } catch {
        return { orientation: null, dateTimeOriginal: null };
    }
}

/* "2026:09:18 14:02:11" -> "2026-09-18" (or null) */
export function exifDateToISO(dt) {
    const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(dt || '');
    if (!m) return null;
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/* Strip a JPEG to pixels + ICC, then write back a minimal EXIF holding only
   Orientation and DateTimeOriginal. Returns a Uint8Array, or null if the
   input isn't a parseable JPEG. */
export function cleanJpegOriginal(bytes) {
    const kept = readKeptExif(bytes);
    const stripped = stripJpegSegments(bytes);
    if (!stripped) return null;
    const zeroth = {};
    const exif = {};
    if (kept.orientation) zeroth[piexif.ImageIFD.Orientation] = kept.orientation;
    if (kept.dateTimeOriginal) exif[piexif.ExifIFD.DateTimeOriginal] = kept.dateTimeOriginal;
    if (!Object.keys(zeroth).length && !Object.keys(exif).length) return stripped;
    try {
        const exifBytes = piexif.dump({ '0th': zeroth, Exif: exif, GPS: {}, Interop: {}, '1st': {}, thumbnail: null });
        return fromBinaryString(piexif.insert(exifBytes, toBinaryString(stripped)));
    } catch {
        return stripped; // metadata-free is still correct, just loses date/orientation tags
    }
}

/* Load a File into an <img>. Browsers apply EXIF orientation to <img> and
   to drawImage by default, so what we draw comes out upright. */
function loadImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This image format could not be read.')); };
        img.src = url;
    });
}

/* Downscale in halving steps before the final draw - a single big jump
   (e.g. 4032px -> 480px) aliases and looks crunchy. */
function resizeToCanvas(img, maxEdge) {
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    const scale = Math.min(1, maxEdge / Math.max(w0, h0));
    const tw = Math.max(1, Math.round(w0 * scale)), th = Math.max(1, Math.round(h0 * scale));
    let src = img, sw = w0, sh = h0;
    while (sw / 2 >= tw && sh / 2 >= th) {
        const c = document.createElement('canvas');
        c.width = Math.round(sw / 2); c.height = Math.round(sh / 2);
        const cx = c.getContext('2d');
        cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
        cx.drawImage(src, 0, 0, c.width, c.height);
        src = c; sw = c.width; sh = c.height;
    }
    const out = document.createElement('canvas');
    out.width = tw; out.height = th;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, tw, th);
    return out;
}

const canvasToJpeg = (canvas, quality) => new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image.'))), 'image/jpeg', quality);
});

/* Main entry. Returns { original, thumb, display, takenOn } where the three
   files are Blobs (all JPEG) and takenOn is 'YYYY-MM-DD' or null. Throws
   only if the browser can't decode the image at all. */
export async function processPhotoForUpload(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const img = await loadImage(file);

    let original;
    let takenOn = null;
    if (isJpegBytes(bytes)) {
        takenOn = exifDateToISO(readKeptExif(bytes).dateTimeOriginal);
        const cleaned = cleanJpegOriginal(bytes);
        original = cleaned ? new Blob([cleaned], { type: 'image/jpeg' }) : null;
    }
    if (!original) {
        // Non-JPEG (or unparseable JPEG): one full-resolution re-encode.
        original = await canvasToJpeg(resizeToCanvas(img, Infinity), 0.92);
    }

    const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
    const display = longEdge <= DISPLAY_EDGE && isJpegBytes(bytes)
        ? original // already small enough - no point storing a second copy
        : await canvasToJpeg(resizeToCanvas(img, DISPLAY_EDGE), 0.85);
    const thumb = await canvasToJpeg(resizeToCanvas(img, THUMB_EDGE), 0.8);

    return { original, thumb, display, takenOn, displayIsOriginal: display === original };
}

/* Avatars only ever render small - keep one clean ~512px copy, nothing else. */
export async function processAvatarForUpload(file) {
    const img = await loadImage(file);
    return canvasToJpeg(resizeToCanvas(img, 512), 0.85);
}
