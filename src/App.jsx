import { supabase } from './supabaseClient'
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import QRCode from 'qrcode';
import { processPhotoForUpload, processAvatarForUpload } from './photoProcessing';
import { getSignedUrls, getSignedUrl, getOriginalUrl, thumbPathOf, displayPathOf, CACHE_CONTROL } from './photoUrls';

/* ================= DATA ================= */

/* Local date as YYYY-MM-DD. Not toISOString() - that converts to UTC,
   which rolls over to tomorrow's date during your evening. */
const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const APP_VERSION = '0.1.0';

const TYPES = { spores: "Spores", agar: "Agar", lc: "Liquid culture", grain: "Grain", bulk: "Monotub", block: "Fruiting block", cake: "Nutrient cake" };
const CODE = { spores: "SP", agar: "AG", lc: "LC", grain: "GR", bulk: "BK", block: "FB", cake: "NC" };

/* A vessel/state WITHIN a type, not a transformation. A syringe drawn off
   an LC jar is still liquid culture - same material, different container -
   so it stays type='lc' and differs only by form. Slants are the same
   story for agar. Deliberately not extra `type` values: a syringe that
   wasn't `lc` would break every "inoculate from LC" path in the app.
   Types with no entry here simply have no form choice. */
const FORMS = {
    lc: { jar: "Jar", syringe: "Syringe" },
    agar: { plate: "Plate", slant: "Slant" },
};
/* Label codes keyed off form where one exists, so syringes read BO-SY1
   rather than BO-LC2 and don't get mistaken for a second jar. */
const FORM_CODE = { syringe: "SY", slant: "SL" };
const codeFor = (type, form) => FORM_CODE[form] ?? CODE[type];

/* HOW an item was started from its parent. A third axis, separate from
   `type` (what it is) and `form` (which vessel): a lion's mane plate
   hanging off a fruiting block could be a clone from a fruit or tissue
   scraped off the block's mycelium, and those have very different
   success rates - without this it's unrecoverable from anything but
   free-text notes. Keyed on the PARENT's type, since that's what
   determines which methods are even possible. `__root` covers items
   with no parent. Every list ends in `other` + free text so the
   vocabulary never has to be exhaustive to be useful. */
const METHODS = {
    block: { fruit_clone: "Clone from fruit", block_tissue: "Tissue from block", other: "Other" },
    bulk: { fruit_clone: "Clone from fruit", block_tissue: "Tissue from substrate", other: "Other" },
    cake: { fruit_clone: "Clone from fruit", block_tissue: "Tissue from cake", other: "Other" },
    agar: { wedge: "Wedge transfer", other: "Other" },
    lc: { inoculation: "Inoculation", other: "Other" },
    grain: { grain_transfer: "Grain transfer", other: "Other" },
    spores: { spore_germ: "Spore germination", other: "Other" },
    __root: { purchased: "Purchased culture", spore_print: "Spore print", other: "Other" },
};
/* A DRAWN syringe already says how it got there via `form`, so asking
   for a method too is just redundant data entry - but that only holds
   when there's an actual parent jar it was drawn from. A syringe with no
   parent (bought directly - plenty of commercial LC ships that way) has
   no such self-explanatory lineage and needs the method field same as
   anything else, purchased included. */
const methodsFor = (parentType, form) =>
    form === 'syringe' && parentType ? null : METHODS[parentType ?? '__root'] ?? METHODS.__root;

const STATUS = {
    colonizing: { label: "Colonizing", tone: "amber", live: true },
    colonized: { label: "Colonized", tone: "jade", live: true },
    fruiting: { label: "Fruiting", tone: "jade", live: true },
    /* Added 2026-09-18 per Matt: a lot of his LC syringes (and spore
       prints/syringes) aren't "colonizing" or actively anything - they're
       just banked in the fridge for whenever he next needs them, which
       was getting miscounted as active/live work on Home's "colonizing
       right now" tally. `live: false` (the default, omitted) keeps it out
       of that count and out of LIVE_STATUSES. Not terminal either - it's
       deliberately absent from DONE_ITEM_STATUSES, since a stored culture
       is still fully viable and hasn't been judged a success or fail yet
       (see itemOutcome below) - it's just paused, not resolved. */
    stored: { label: "Stored", tone: "slate" },
    contaminated: { label: "Contaminated", tone: "clay", needsReason: true },
    failed: { label: "Failed", tone: "rust", needsReason: true },
    consumed: { label: "Consumed", tone: "slate" },
    retired: { label: "Retired", tone: "slate" },
};

/* Why it died. Contamination is an invader; failure is everything else -
   keeping them apart means contamination rate stays a real number. */
const REASONS = {
    contaminated: ["Trichoderma", "Bacterial", "Cobweb", "Black mold", "Wet spot", "Unknown"],
    failed: ["Browning / PPO", "Never colonized", "Dried out", "Heat stress", "Stalled", "Unknown"],
};

/* Item statuses that mean a stock unit consumed into it is done - not going
   back into rotation. Includes "consumed": a fully-used item is the norm
   (a spent grain bag, a drawn-dry LC jar), not the exception - a plate or
   jar that's still good for another draw is the edge case. If a specific
   unit is marked consumed too early and it's still usable, that's a status
   correction on the item, not a reason to leave the whole status out of
   this list. Used by Stock's "No longer active" grouping - see StockTab.
   Widened to include "consumed" 2026-09-12 per Matt. */
const DONE_ITEM_STATUSES = ['retired', 'contaminated', 'failed', 'consumed'];

const TONE = { amber: "#D6934A", jade: "#7FA66A", clay: "#8C3B26", rust: "#A85C35", slate: "#8A7862" };

/* No 'block' kind here on purpose (2026-09-18, Matt): a substrate block is
   just bulk substrate shaped differently at use time, not a distinct thing
   you'd stock - you never buy or make "block" as raw material, you shape it
   from bulk when you start the item. 'block' stays a valid item TYPE and a
   key in STOCK_KIND_RECIPE_CATEGORY (grouped with bulk) so old data and
   stockUsableFor() still work; it's just not offered as a stock Kind. */
const STOCK_KIND = { agar: "Agar plate", lc: "Liquid culture", grain: "Grain spawn", bulk: "Bulk substrate", cake: "Nutrient cake", aio: "AIO bag", other: "Other" };
/* Auto-numbered Stock labels use their OWN tag letters per kind - deliberately
   not the same letters as genetics' CODE (SP/AG/LC/GR/BK/FB/NC), so a label
   like TUB-MM03 can never be mistaken for a genetics container like BO1-LC3
   at a glance. Paired with a one-time `label_prefix` set on the recipe
   (library row) or supplier the first time it's used to log stock - see
   addStock's auto-numbering block below. */
const STOCK_KIND_TAG = { agar: "PLT", lc: "JAR", grain: "GRN", bulk: "TUB", cake: "CAK", aio: "AIO", other: "MSC" };
const STOCK_STATUS = {
    on_hand: { label: "On hand", tone: "jade" },
    used: { label: "Used", tone: "slate" },
    contaminated: { label: "Contaminated", tone: "clay" },
    discarded: { label: "Discarded", tone: "rust" },
};

/* Short human label for a stock row - the recipe title if made in-house,
   the product name (or supplier name as a fallback) if bought. */
function stockLabel(s, library, suppliers) {
    if (s.source === 'made') {
        const r = library.find((e) => e.id === s.recipe_id);
        return r ? r.title : STOCK_KIND[s.kind];
    }
    const sup = suppliers.find((x) => x.id === s.supplier_id);
    return s.product_name ? s.product_name : (sup ? sup.name : STOCK_KIND[s.kind]);
}

/* Groups individual stock units (rows) back into the batch they were
   logged together as - same recipe/supplier, made or bought the same
   day. There's no stored batch id; this is purely a display grouping,
   derived from the metadata every unit in one "Add stock" submission
   already shares. */
function stockBatchKey(s) {
    return [s.kind, s.source, s.recipe_id || '', s.supplier_id || '', s.product_name || '', s.made_or_bought_on || ''].join('|');
}

/* Groups stock units into "the same thing regardless of when it was
   made" - same kind/source/recipe/supplier/product, date left out on
   purpose. This is the level Matt actually wants grouped together in
   the Stock list (2026-09-23: "I just want all the master mix together
   ... instead of separated by date") - stockBatchKey above nests one
   level inside this as the per-session (same-day) grouping, so two
   Master Mix sessions made a week apart still land under one shared
   "Master Mix" heading instead of becoming two unrelated top-level
   groups sorted apart by date. */
function stockProductKey(s) {
    return [s.kind, s.source, s.recipe_id || '', s.supplier_id || '', s.product_name || ''].join('|');
}

/* Auto-numbers a batch of new stock units as {KIND_TAG}-{code}{NN}, e.g.
   TUB-MM03. Scans existing stock labels sharing the same prefix for the
   highest number in use, then counts up from there - same self-healing
   idea as items' addChild (guess, then skip past anything already taken)
   rather than a stored counter, so a manually-typed or deleted label can
   never cause a collision. Padded to 2 digits per Matt (MM01...MM99),
   widening naturally past 99 since padStart never truncates. */
function nextStockLabels(kindTag, code, count, existingStock) {
    const prefix = `${kindTag}-${code}`;
    let n = 0;
    existingStock.forEach((s) => {
        if (!s.label || !s.label.startsWith(prefix)) return;
        const suffix = s.label.slice(prefix.length);
        if (/^\d+$/.test(suffix)) n = Math.max(n, Number(suffix));
    });
    const taken = new Set(existingStock.map((s) => s.label).filter(Boolean));
    const labels = [];
    for (let k = 0; k < count; k += 1) {
        n += 1;
        let label = `${prefix}${String(n).padStart(2, '0')}`;
        while (taken.has(label)) { n += 1; label = `${prefix}${String(n).padStart(2, '0')}`; }
        taken.add(label);
        labels.push(label);
    }
    return labels;
}
const FRUITS = ["bulk", "block", "cake"];

/* An item's real OUTCOME for success-rate purposes, as opposed to its
   current `status` - worked out with Matt 2026-09-18 after noticing
   `retired` was being counted as an automatic success even when it meant
   "contaminated, salvaged what I could, then threw the rest out." What
   counts as success isn't the same for every item type, and it isn't
   always just whatever the status field currently says:
   - Fruiting substrate (bulk/block/cake, see FRUITS - cake counts here
     too, per Matt 2026-09-18: "the cake is just the 'substrate' of the
     cordyceps world," same as a monotub or fruiting block is for gilled
     species) - success means it logged at least one real flush. Sticky
     once it happens: a tub that flushed twice and then got contaminated
     on flush 3 already did its job.
   - Liquid culture - not judged directly. Success if ANY child of it
     ever succeeds; fail only once every child that has itself resolved
     has resolved to fail (a still-growing child doesn't count against it
     yet). Never overrides an individual child's own outcome - purely a
     one-way rollup, per Matt: "if everything under that LC results in a
     fail that LC is a fail, not every item underneath it."
   - Everything else (agar, grain, spores) - success just means it got
     used to start something, regardless of that child's own eventual
     fate or what happens to the leftover material afterward.
   Falls back to current status only once the type-specific "did the
   actual thing happen" test comes up empty: a DONE_ITEM_STATUSES status
   (retired/contaminated/failed/consumed) with nothing to show for it is a
   fail; anything else - including the live/still-viable 'stored' status -
   stays unresolved, since it could still be used or still flush later.
   `seen` guards against a cyclical parent chain the same defensive way
   lotSpeciesNames does, though a real one should never occur. */
function childrenOf(item, allItems) {
    return allItems.filter((i) => i.parent === item.id);
}
function itemOutcome(item, allItems, seen = new Set()) {
    if (seen.has(item.id)) return 'unresolved';
    seen.add(item.id);
    const terminal = DONE_ITEM_STATUSES.includes(item.status);

    if (FRUITS.includes(item.type)) {
        if ((item.harvests?.length ?? 0) > 0) return 'success';
        return terminal ? 'fail' : 'unresolved';
    }
    if (item.type === 'lc') {
        const kids = childrenOf(item, allItems);
        if (kids.length === 0) return terminal ? 'fail' : 'unresolved';
        const outcomes = kids.map((k) => itemOutcome(k, allItems, seen));
        if (outcomes.includes('success')) return 'success';
        if (outcomes.every((o) => o === 'fail')) return 'fail';
        return 'unresolved';
    }
    if (childrenOf(item, allItems).length > 0) return 'success';
    return terminal ? 'fail' : 'unresolved';
}

/* Shared vendor picker - Stock and genetics lines both need "pick an
   existing supplier, or type one that isn't in the list yet and have it
   just get added" rather than a dead-end select that sends you off to the
   Suppliers tab first. onCreate does the actual lookup-or-insert (see
   getOrCreateSupplier) and hands back the new id, which this reports
   through onChange exactly like picking an existing one would. */
function SupplierPicker({ suppliers, value, onChange, onCreate }) {
    const [adding, setAdding] = useState(false);
    const [name, setName] = useState('');

    if (adding) {
        const commit = async () => {
            const trimmed = name.trim();
            setAdding(false);
            setName('');
            if (!trimmed) return;
            const id = await onCreate(trimmed);
            if (id) onChange(id);
        };
        return (
            <div style={{ display: 'flex', gap: 6 }}>
                <input className="in" autoFocus value={name} placeholder="New vendor name"
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && commit()} />
                <button type="button" className="mini" onClick={commit}>Add</button>
                <button type="button" className="mini ghost" onClick={() => { setAdding(false); setName(''); }}>Cancel</button>
            </div>
        );
    }

    return (
        <select className="in sel" value={value ?? ''} onChange={(e) => {
            if (e.target.value === '__new__') setAdding(true);
            else onChange(e.target.value);
        }}>
            <option value="">— pick a vendor —</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="__new__">+ Add new vendor…</option>
        </select>
    );
}

const days = (iso) => iso ? Math.round((new Date() - new Date(iso + "T12:00:00")) / 86400000) : null;

/* Refresh-preserves-page (2026-09-16, Matt: refreshing the browser dumped
   you back to Settings' default landing page instead of staying put).
   Session-scoped on purpose - closing the tab and coming back fresh still
   opens to the default landing page, same as a first-ever visit; only a
   same-tab refresh restores. Read via lazy useState initializers in App()
   so the restored values are there on the very first render (no flash of
   the default page), and written back by a single effect that watches
   section/nav/open/openLot together. */
const NAV_STORAGE_KEY = 'sporedesk_nav_v1';
const readStoredNav = () => {
    try {
        const raw = sessionStorage.getItem(NAV_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null; // private browsing / storage disabled - just skip restoring
    }
};

/* Renders per the signed-in user's Settings > Date format preference
   (profile.date_format: 'MDY' | 'DMY' | 'YMD') - `dateFormat` is threaded
   down as a real prop from App() (same pattern as unitsPref/displayAmount)
   rather than read off a module-level variable: React's rules forbid
   mutating shared module state during render, and syncing it via an
   effect instead would leave a stale render right after `profile` loads
   or changes, since nothing would force a re-render once the effect
   finally caught up. Defaults to 'MDY' so any caller that hasn't been
   threaded yet still renders something sane instead of crashing. */
const fmt = (iso, dateFormat = 'MDY') => {
    if (!iso) return "date unknown";
    const d = new Date(iso + "T12:00:00");
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    if (dateFormat === 'DMY') return `${dd}/${mm}/${yyyy}`;
    if (dateFormat === 'YMD') return `${yyyy}-${mm}-${dd}`;
    return `${mm}/${dd}/${yyyy}`;
};

/* ================= LAYOUT ================= */

const GAP_X = 132, GAP_Y = 116;

function layout(items) {
    const kids = (id) => items.filter((i) => i.parent === id);
    const out = {};
    let cur = 0;
    /* `seen` guards against a cycle in the parent chain (e.g. two items
       that ended up sharing a label) sending this into infinite
       recursion - a duplicate label should degrade to a stray leaf on
       the tree, never a crashed page. */
    const walk = (n, d, seen) => {
        if (seen.has(n.id)) { out[n.id] = { x: cur * GAP_X, y: d * GAP_Y, depth: d }; return cur++; }
        seen.add(n.id);
        const ch = kids(n.id);
        let slot;
        if (!ch.length) slot = cur++;
        else { const s = ch.map((c) => walk(c, d + 1, seen)); slot = (s[0] + s[s.length - 1]) / 2; }
        out[n.id] = { x: slot * GAP_X, y: d * GAP_Y, depth: d };
        return slot;
    };
    /* Each root is a separate genetics line. Gap between them so parallel
       trees read as distinct rather than one big tangle. */
    items.filter((i) => !i.parent).forEach((r, n) => {
        if (n > 0) cur += 0.9;
        walk(r, 0, new Set());
    });
    return out;
}

const radius = (d) => Math.max(7, 11 - d * 0.8);
const thread = (d) => Math.max(1.2, 5.2 - d * 0.72);

function hypha(a, b) {
    const y1 = a.y + radius(a.depth) + 1.5, y2 = b.y - radius(b.depth) - 1.5;
    const dy = y2 - y1, drift = (b.x - a.x) * 0.08;
    return `M${a.x} ${y1} C${a.x + drift} ${y1 + dy * 0.42}, ${b.x - drift} ${y2 - dy * 0.42}, ${b.x} ${y2}`;
}

/* ================= APP ================= */

export default function App() {
    // Captured once on mount, before the write-back effect below ever runs,
    // so load() can tell "there's a real prior-session page to restore"
    // apart from "nothing was stored, use Settings' default landing page."
    const [hadStoredNav] = useState(() => readStoredNav() !== null);
    const [section, setSection] = useState(() => readStoredNav()?.section ?? 'cultures');
    const [library, setLibrary] = useState([]);
    const [librarySpecies, setLibrarySpecies] = useState([]); // library_species join rows: {library_id, species_id}
    const [equipment, setEquipment] = useState([]);
    const [suppliers, setSuppliers] = useState([]);
    const [stock, setStock] = useState([]);
    const [lots, setLots] = useState([]);
    const [lotLinks, setLotLinks] = useState([]);
    const [openLot, setOpenLot] = useState(() => readStoredNav()?.openLot ?? null);
    const [photos, setPhotos] = useState([]);
    const [photoUrls, setPhotoUrls] = useState({});
    /* Most-recent slice of usage_events (see load() below), newest first -
       powers Home's "most visited" quick-nav and, later, the admin-facing
       usage analytics scoped in the beta launch plan. Not called `events`
       to avoid colliding with the existing item_events concept. */
    const [usageEvents, setUsageEvents] = useState([]);
    const [items, setItems] = useState([]);
    const [species, setSpecies] = useState([]);
    const [genetics, setGenetics] = useState([]);
    const [nav, setNav] = useState(() => readStoredNav()?.nav ?? { level: 'species', speciesId: null, geneticsId: null });
    const [dir, setDir] = useState('fwd');
    const [open, setOpen] = useState(() => readStoredNav()?.open ?? null);
    const [loading, setLoading] = useState(true);
    const [printing, setPrinting] = useState(null); // { kind: 'item' | 'stock' | 'lot' | 'queue', ids: [...] }, or null
    /* Cross-screen print queue (2026-09-22, Matt: printing labels one at a
       time and reloading the printer for each was the actual pain point,
       not the per-screen picker itself - see PrintLabels). Array of
       { kind: 'item' | 'stock' | 'lot', id } added to from Detail/Tree/
       Stock/Harvests's new "+ Queue" buttons alongside their existing
       immediate-print buttons.
       In-memory only, not persisted - clears on refresh same as `printing`
       itself. Revisited alongside the "refresh should stay on the current
       page" fix (2026-09-16) and left this way on purpose - Matt wants the
       queue to keep clearing on refresh, it's meant for one sitting. */
    const [printQueue, setPrintQueue] = useState([]);
    const addToPrintQueue = (kind, ids) => {
        const idArr = Array.isArray(ids) ? ids : [ids];
        setPrintQueue((prev) => {
            const have = new Set(prev.filter((e) => e.kind === kind).map((e) => e.id));
            const additions = idArr.filter((id) => !have.has(id)).map((id) => ({ kind, id }));
            return additions.length ? [...prev, ...additions] : prev;
        });
    };
    const removeFromPrintQueue = (kind, id) =>
        setPrintQueue((prev) => prev.filter((e) => !(e.kind === kind && e.id === id)));
    /* One-shot "land on this specific tab, and this specific row" hints for
       Search results (and the ?stock= QR deep link) that point into
       Supplies/Reference - each of those screens fully remounts on every
       visit (see the render switch below), so this only has to seed their
       initial state, not stay in sync afterward. Every other navigation
       path resets both back to null so a stale hint can't quietly re-open
       an old search result the next time you visit Supplies normally. */
    const [suppliesTab, setSuppliesTab] = useState(null);
    const [suppliesOpenId, setSuppliesOpenId] = useState(null);
    const [referenceTab, setReferenceTab] = useState(null);

    // Account (profile) + Settings screens - overlays like Detail/PrintLabels,
    // not part of the `section` nav. profile mirrors the one `profiles` row
    // RLS scopes to the signed-in user; null until loaded.
    const [profile, setProfile] = useState(null);
    const [accountOpen, setAccountOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);

    // Threaded down to every component that calls fmt() - see fmt()'s own
    // comment at the top of the file for why this is a prop, not a module
    // variable synced via effect.
    const dateFormat = profile?.date_format || 'MDY';

    /* Mirrors section/nav/open/openLot into sessionStorage on every change
       - see readStoredNav()/NAV_STORAGE_KEY up top for why and the lazy
       useState initializers above that read this back in. Deep links
       (?item=/?stock=/?lot=) and the "always go home" logo click still win
       over a restored page since both call their own setSection/setOpen
       after this state has settled, same as before this existed. */
    useEffect(() => {
        try {
            sessionStorage.setItem(NAV_STORAGE_KEY, JSON.stringify({ section, nav, open, openLot }));
        } catch { /* private browsing / storage disabled - refresh just won't restore */ }
    }, [section, nav, open, openLot]);

    /* Resolved signed URL for profile.avatar_url - a private storage path
       in the same 'photos' bucket as item/equipment photos, but not a row
       in the `photos` table those load through, so it needs its own fetch.
       Re-runs whenever the path changes, which covers both the initial
       load and right after a fresh upload (uploadPhoto's onSave updates
       `profile` here). Every avatar-displaying spot in the app reads this
       one value instead of each re-deriving its own signed URL. */
    const [avatarUrl, setAvatarUrl] = useState(null);
    useEffect(() => {
        if (!profile?.avatar_url) { setAvatarUrl(null); return; }
        let cancelled = false;
        getSignedUrl(profile.avatar_url).then((url) => {
            if (!cancelled) setAvatarUrl(url);
        });
        return () => { cancelled = true; };
    }, [profile?.avatar_url]);

    const go = (next, direction = 'fwd') => { setDir(direction); setNav(next); };

    const saveProfile = async (fields) => {
        const { data, error } = await supabase.from('profiles')
            .update({ ...fields, updated_at: new Date().toISOString() })
            .eq('id', profile.id).select('*').single();
        if (error) { console.error(error); alert('Could not save - check console'); return false; }
        setProfile(data);
        return true;
    };

    useEffect(() => {
        async function load() {
            const { data, error } = await supabase
                .from('items')
                .select('*')
                .order('created_on', { nullsFirst: false });

            if (error) {
                console.error(error);
                setLoading(false);
                return;
            }

            const { data: events } = await supabase.from('item_events').select('*');
            const { data: harvests } = await supabase.from('lots').select('*').eq('form', 'wet');
            const { data: sp } = await supabase.from('species').select('*').order('common_name');
            const { data: gen } = await supabase.from('genetics').select('*').order('name');
            const { data: lib } = await supabase.from('library').select('*').order('created_at');
            const { data: libSp } = await supabase.from('library_species').select('*');
            const { data: eq } = await supabase.from('equipment').select('*').order('category').order('name');
            const { data: sup } = await supabase.from('suppliers').select('*').order('name');
            const { data: stk } = await supabase.from('stock').select('*').order('created_at');
            const { data: allLots } = await supabase.from('lots').select('*').order('harvested_on', { nullsFirst: false });
            const { data: links } = await supabase.from('lot_links').select('*');
            const { data: pics } = await supabase.from('photos').select('*').order('created_at');
            const { data: prof } = await supabase.from('profiles').select('*').maybeSingle();
            /* Capped, most-recent-first - recent usage is what "most
               visited" should weight toward, and there's no need to drag
               someone's entire history in on every load. */
            const { data: usage } = await supabase.from('usage_events').select('*')
                .order('created_at', { ascending: false }).limit(400);

            /* Only the thumb + display sizes are signed up front; originals
               are signed on demand when someone taps "Full size". Signed
               URLs come from a local cache so they stay stable between
               loads and the browser can reuse what it already downloaded. */
            if (pics?.length) {
                setPhotoUrls(await getSignedUrls(pics.flatMap((p) => [thumbPathOf(p), displayPathOf(p)])));
            }

            setSpecies(sp ?? []);
            setGenetics(gen ?? []);
            setLibrary(lib ?? []);
            setLibrarySpecies(libSp ?? []);
            setEquipment(eq ?? []);
            setSuppliers(sup ?? []);
            setStock(stk ?? []);
            setLots(allLots ?? []);
            setLotLinks(links ?? []);
            setPhotos(pics ?? []);
            setProfile(prof ?? null);
            setUsageEvents(usage ?? []);
            // Only land on the default section for a genuinely fresh tab -
            // hadStoredNav means section/nav/open/openLot were already
            // restored from sessionStorage by this component's initial
            // render, and a refresh shouldn't override that with Settings'
            // default landing page (see NAV_STORAGE_KEY up top).
            if (!hadStoredNav && prof?.default_section) setSection(prof.default_section);

            setItems(data.map((r) => ({
                id: r.label,
                uid: r.id,
                geneticsId: r.genetics_id,
                parent: data.find((p) => p.id === r.parent_id)?.label ?? null,
                type: r.type,
                form: r.form ?? '',
                amount: r.amount ?? undefined,
                amountUnit: r.amount_unit ?? '',
                method: r.method ?? '',
                methodNote: r.method_note ?? '',
                status: r.status,
                created: r.created_on,
                substrate: r.substrate ?? '',
                notes: r.notes ?? '',
                dryWeight: r.dry_substrate_g ?? undefined,
                failureReason: r.failure_reason ?? null,
                source: r.source ?? null,
                supplierId: r.supplier_id ?? null,
                harvests: (harvests ?? [])
                    .filter((h) => h.source_item_id === r.id)
                    .map((h) => ({ f: h.flush_number, date: h.harvested_on, wet: Number(h.amount_g), lotId: h.id }))
                    .sort((a, b) => a.f - b.f),
                log: (events ?? [])
                    .filter((e) => e.item_id === r.id)
                    .map((e) => ({ id: e.id, date: e.happened_on, body: e.body, kind: e.kind, lotId: e.lot_id }))
                    .sort((a, b) => a.date.localeCompare(b.date)),
            })));

            /* Deep link: ?item=EN-BK1 in the URL opens straight to that
               item, so a scanned QR label goes right to the container
               instead of the species grid. Read once here, off the data
               this load just fetched, rather than waiting on state to
               settle. Silently does nothing if the item isn't found -
               falls back to the normal landing page. */
            const wantedItem = new URLSearchParams(window.location.search).get('item');
            if (wantedItem) {
                const target = data.find((r) => r.label === wantedItem);
                const gLine = target && gen?.find((g) => g.id === target.genetics_id);
                if (target && gLine) {
                    setNav({ level: 'tree', speciesId: gLine.species_id, geneticsId: gLine.id });
                    setSection('cultures');
                    setOpen(wantedItem);
                }
            }

            /* Deep link: ?stock=<uuid> - a QR printed for a stock unit
               while it was still just "on hand." Unlike an item label, a
               stock unit isn't in the lineage tree, so this can't jump
               straight to a tree/item screen the way ?item= does - it
               lands on that exact row in Supplies/Stock instead (opened
               via the same initialOpenId hint Search results use). But
               once that unit gets consumed into a culture (consumeStock
               sets consumed_into_item_id), the SAME printed sticker starts
               resolving straight through to whatever it became, no
               reprint needed - that's the whole point of printing stock
               labels off their own id instead of waiting for an item to
               exist first. */
            const wantedStock = new URLSearchParams(window.location.search).get('stock');
            if (wantedStock) {
                const unit = (stk ?? []).find((s) => s.id === wantedStock);
                const target = unit?.consumed_into_item_id && data.find((r) => r.id === unit.consumed_into_item_id);
                const gLine = target && gen?.find((g) => g.id === target.genetics_id);
                if (target && gLine) {
                    setNav({ level: 'tree', speciesId: gLine.species_id, geneticsId: gLine.id });
                    setSection('cultures');
                    setOpen(target.label);
                } else if (unit) {
                    setSection('supplies');
                    setSuppliesTab('stock');
                    setSuppliesOpenId(unit.id);
                }
            }

            /* Deep link: ?lot=<uuid> - a QR printed for a harvested lot
               (dried batch, extract jar, whatever it got processed into).
               Lots don't sit in the lineage tree the way items do, so this
               just lands straight on that lot's own detail page in
               Harvests - no tree-jump logic to mirror from ?item=. */
            const wantedLot = new URLSearchParams(window.location.search).get('lot');
            if (wantedLot) {
                const target = (allLots ?? []).find((l) => l.id === wantedLot);
                if (target) {
                    setSection('inventory');
                    setOpenLot(target.id);
                }
            }

            /* Strip ?item=/?stock=/?lot= once they've been used, or refreshing
               the page (or just leaving the tab open - Matt's actual
               report, 2026-09-17: "lately it's taking me to a turkey
               tail item randomly") replays the same deep link forever,
               since nothing else ever clears it from the URL. This
               effect only runs once on mount (empty dep array below), so
               there's no risk of stripping a param a later run still
               needs. replaceState (not pushState) so this doesn't add a
               junk back-button entry - the params never should have been
               "navigable" history to begin with, just a one-shot landing
               instruction. */
            if (wantedItem || wantedStock || wantedLot) {
                const url = new URL(window.location.href);
                url.searchParams.delete('item');
                url.searchParams.delete('stock');
                url.searchParams.delete('lot');
                window.history.replaceState({}, '', url.pathname + url.search + url.hash);
            }

            setLoading(false);
        }
        load();
        // hadStoredNav never changes after mount (set once via lazy useState,
        // no setter ever called) - listed for lint honesty, not because this
        // should ever actually re-run.
    }, [hadStoredNav]);

    if (loading) return (
      <div className="root">
        <style>{CSS}</style>
        <div className="load-wrap">
          <img src={`${import.meta.env.BASE_URL}sporedesk-plate-256.webp`} alt="" className="load-glyph" />
        </div>
      </div>
    );

    const update = (id, fn) => setItems((p) => p.map((i) => (i.id === id ? fn(i) : i)));

    const saveStatus = async (label, status, reason) => {
        const today = todayISO();
        const patch = { status };
        if (STATUS[status].needsReason) patch.failure_reason = reason || null;
        else patch.failure_reason = null;

        const { data, error } = await supabase
            .from('items')
            .update(patch)
            .eq('label', label)
            .select('id')
            .single();

        if (error) { console.error(error); alert('Save failed - check console'); return; }

        const body = reason ? `${STATUS[status].label} — ${reason}` : STATUS[status].label;
        const { data: ev } = await supabase.from('item_events').insert({
            item_id: data.id,
            happened_on: today,
            kind: 'status',
            body,
        }).select('id').single();

        update(label, (i) => ({
            ...i, status, failureReason: patch.failure_reason,
            log: [...i.log, { id: ev?.id, date: today, body, kind: 'status' }],
        }));
    };

    const saveNote = async (label, text) => {
        const today = todayISO();
        const item = items.find((i) => i.id === label);
        const { data: ev, error } = await supabase.from('item_events').insert({
            item_id: item.uid, happened_on: today, kind: 'note', body: text,
        }).select('id').single();
        if (error) { console.error(error); alert('Note not saved - check console'); return; }
        update(label, (i) => ({ ...i, log: [...i.log, { id: ev.id, date: today, body: text, kind: 'note' }] }));
    };

    const deleteEvent = async (label, eventId) => {
        const { error } = await supabase.from('item_events').delete().eq('id', eventId);
        if (error) { console.error(error); alert('Could not delete - check console'); return; }
        update(label, (i) => ({ ...i, log: i.log.filter((l) => l.id !== eventId) }));
    };

    /* Edit a history line. Date and text both editable. */
    const editEvent = async (label, eventId, date, body) => {
        const { error } = await supabase.from('item_events')
            .update({ happened_on: date, body }).eq('id', eventId);
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        update(label, (i) => ({
            ...i,
            log: i.log.map((l) => (l.id === eventId ? { ...l, date, body } : l))
                .sort((a, b) => a.date.localeCompare(b.date)),
        }));
    };

    const saveHarvest = async (label, grams) => {
        const today = todayISO();
        const item = items.find((i) => i.id === label);
        /* Next flush number, not count+1 - deleting flush 2 of 3 would
           otherwise make the next one a duplicate 3. */
        const flush = item.harvests.reduce((m, h) => Math.max(m, h.f), 0) + 1;

        const { data: lot, error: lotErr } = await supabase.from('lots').insert({
            label: `${label} flush ${flush}`,
            form: 'wet',
            amount_g: grams,
            source_item_id: item.uid,
            flush_number: flush,
            harvested_on: today,
        }).select('*').single();
        if (lotErr) { console.error(lotErr); alert('Harvest not saved - check console'); return; }

        await supabase.from('items').update({ status: 'fruiting' }).eq('id', item.uid);
        const { data: ev } = await supabase.from('item_events').insert({
            item_id: item.uid, happened_on: today, kind: 'harvest',
            body: `Flush ${flush} - ${grams}g wet`,
            lot_id: lot.id,
        }).select('id').single();

        setLots((p) => [...p, lot]);
        update(label, (i) => ({
            ...i,
            status: 'fruiting',
            harvests: [...i.harvests, { f: flush, date: today, wet: grams, lotId: lot.id }],
            log: [...i.log, { id: ev?.id, date: today, body: `Flush ${flush} - ${grams}g wet`, kind: 'harvest', lotId: lot.id }],
        }));
    };

    /* Edit a flush. Updates the lot and its history line together. */
    const editHarvest = async (label, harvest, date, grams) => {
        const { error } = await supabase.from('lots')
            .update({ harvested_on: date, amount_g: grams }).eq('id', harvest.lotId);
        if (error) { console.error(error); alert('Could not save - check console'); return; }

        const item = items.find((i) => i.id === label);
        const line = item.log.find((l) => l.lotId === harvest.lotId);
        let newBody = line?.body;
        if (line) {
            /* Rewrite only the leading "Flush N - Xg wet" part, so any extra
               note text on the same line survives the edit. */
            newBody = line.body.replace(/^Flush \d+ - [\d.]+g wet/, `Flush ${harvest.f} - ${grams}g wet`);
            await supabase.from('item_events')
                .update({ happened_on: date, body: newBody }).eq('id', line.id);
        }

        setLots((p) => p.map((l) => (l.id === harvest.lotId ? { ...l, harvested_on: date, amount_g: grams } : l)));
        update(label, (i) => ({
            ...i,
            harvests: i.harvests.map((h) => (h.lotId === harvest.lotId ? { ...h, date, wet: grams } : h)),
            log: i.log.map((l) => (l.lotId === harvest.lotId ? { ...l, date, body: newBody } : l))
                .sort((a, b) => a.date.localeCompare(b.date)),
        }));
    };

    const deleteHarvest = async (label, harvest) => {
        /* Delete the history line first, matched by lot_id rather than text. */
        await supabase.from('item_events').delete().eq('lot_id', harvest.lotId);

        const { error } = await supabase.from('lots').delete().eq('id', harvest.lotId);
        if (error) { console.error(error); alert('Could not delete - check console'); return; }

        setLots((p) => p.filter((l) => l.id !== harvest.lotId));
        update(label, (i) => ({
            ...i,
            harvests: i.harvests.filter((h) => h.lotId !== harvest.lotId),
            log: i.log.filter((l) => l.lotId !== harvest.lotId),
        }));
    };

    /* Generic field save for an item. `patch` uses app-shape keys;
       mapped to db columns here so the UI never touches column names. */
    const saveItemFields = async (label, patch) => {
        const item = items.find((i) => i.id === label);
        const cols = {};
        if ('id' in patch) cols.label = patch.id;
        if ('type' in patch) cols.type = patch.type;
        if ('form' in patch) cols.form = patch.form || null;
        /* Recorded, never derived. Nothing decrements this - overdraw a
           syringe or spill a jar and you edit the number by hand. */
        if ('amount' in patch) cols.amount = patch.amount ?? null;
        if ('amountUnit' in patch) cols.amount_unit = patch.amountUnit || null;
        if ('method' in patch) cols.method = patch.method || null;
        /* Only 'other' carries free text - clear it otherwise so a
           stale note can't linger behind a preset value. */
        if ('methodNote' in patch) cols.method_note = patch.methodNote || null;
        if ('method' in patch && patch.method !== 'other') cols.method_note = null;
        if ('substrate' in patch) cols.substrate = patch.substrate || null;
        if ('notes' in patch) cols.notes = patch.notes || null;
        if ('created' in patch) cols.created_on = patch.created || null;
        if ('dryWeight' in patch) cols.dry_substrate_g = patch.dryWeight ?? null;
        if ('supplierId' in patch) cols.supplier_id = patch.supplierId || null;

        const { error } = await supabase.from('items').update(cols).eq('id', item.uid);
        if (error) { console.error(error); alert('Could not save - check console'); return; }

        setItems((p) => p.map((i) => {
            if (i.id === label) {
                const next = { ...i, ...patch };
                if ('method' in patch && patch.method !== 'other') next.methodNote = '';
                return next;
            }
            /* Children point at the parent by label, so a rename has to
               follow through or the tree loses its connection. */
            if ('id' in patch && i.parent === label) return { ...i, parent: patch.id };
            return i;
        }));
        if ('id' in patch && open === label) setOpen(patch.id);
    };

    const saveGeneticsFields = async (genId, patch) => {
        const cols = {};
        if ('name' in patch) cols.name = patch.name.trim();
        if ('code' in patch) cols.code = patch.code.trim().toUpperCase();
        if ('source' in patch) cols.source = patch.source?.trim() || null;
        if ('acquired_on' in patch) cols.acquired_on = patch.acquired_on || null;
        if ('notes' in patch) cols.notes = patch.notes?.trim() || null;
        if ('supplier_id' in patch) cols.supplier_id = patch.supplier_id || null;

        const { error } = await supabase.from('genetics').update(cols).eq('id', genId);
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setGenetics((p) => p.map((g) => (g.id === genId ? { ...g, ...cols } : g)));
    };

    const toggleGeneticsHidden = async (genId, hidden) => {
        const { error } = await supabase.from('genetics').update({ hidden }).eq('id', genId);
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setGenetics((p) => p.map((g) => (g.id === genId ? { ...g, hidden } : g)));
    };

    /* genetics->items is ON DELETE CASCADE in the DB, so deleting a line
       with containers under it would silently wipe their whole history
       (events, photos, harvests) along with it - blocked here rather than
       left to the foreign key. A line with nothing under it is safe to
       actually delete; the confirm-with-undo-timer lives in Tree. */
    const deleteGenetics = async (genId) => {
        if (items.some((i) => i.geneticsId === genId)) {
            alert('This line has containers under it - remove or reassign those first, or hide the line instead.');
            return;
        }
        const { error } = await supabase.from('genetics').delete().eq('id', genId);
        if (error) { console.error(error); alert('Could not delete - check console'); return; }
        setGenetics((p) => p.filter((g) => g.id !== genId));
    };

    const saveSpeciesFields = async (speciesId, patch) => {
        const cols = {
            common_name: patch.common_name.trim(),
            latin_name: patch.latin_name?.trim() || null,
            fruiting_temp: patch.fruiting_temp?.trim() || null,
            humidity: patch.humidity?.trim() || null,
            fae: patch.fae?.trim() || null,
            colonize_temp: patch.colonize_temp?.trim() || null,
            colonize_time: patch.colonize_time?.trim() || null,
            pin_to_harvest: patch.pin_to_harvest?.trim() || null,
            substrate_note: patch.substrate_note?.trim() || null,
            dry_yield_pct: patch.dry_yield_pct === '' || patch.dry_yield_pct == null ? null : Number(patch.dry_yield_pct),
            notes: patch.notes?.trim() || null,
        };
        const { error } = await supabase.from('species').update(cols).eq('id', speciesId);
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setSpecies((p) => p.map((s) => (s.id === speciesId ? { ...s, ...cols } : s)));
    };

    const toggleSpeciesHidden = async (speciesId, hidden) => {
        const { error } = await supabase.from('species').update({ hidden }).eq('id', speciesId);
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setSpecies((p) => p.map((s) => (s.id === speciesId ? { ...s, hidden } : s)));
    };

    /* genetics.species_id is ON DELETE RESTRICT (the DB itself would refuse),
       but library_species.species_id is ON DELETE CASCADE - deleting a
       species with recipes/references tagged to it would silently wipe
       those tag rows too. Both are checked up front so the message is
       clear either way rather than a raw FK error or, worse, quietly
       losing tags with no explanation. A species with neither is safe to
       actually delete; the confirm-with-undo-timer lives in Tree. */
    const deleteSpecies = async (speciesId) => {
        if (genetics.some((g) => g.species_id === speciesId)) {
            alert('This species has culture lines under it - remove or reassign those first, or hide the species instead.');
            return;
        }
        if (librarySpecies.some((r) => r.species_id === speciesId)) {
            alert('This species is tagged on one or more recipes/reference entries - untag those first (deleting the species would remove those tags too), or hide the species instead.');
            return;
        }
        const { error } = await supabase.from('species').delete().eq('id', speciesId);
        if (error) { console.error(error); alert('Could not delete - check console'); return; }
        setSpecies((p) => p.filter((s) => s.id !== speciesId));
    };

    /* Species tagging on a recipe/note is many-to-many (library_species),
       not the old single species_id column - fields.speciesIds is always
       an array here (possibly empty), and fields.general is the explicit
       "applies to every species / not species-specific" flag (Agar media,
       LC media, etc.) rather than an implied meaning of "no tags yet". */
    const addLibrary = async (fields) => {
        const { data, error } = await supabase.from('library').insert({
            title: fields.title.trim(),
            kind: fields.kind,
            url: fields.url?.trim() || null,
            body: fields.body?.trim() || null,
            categories: fields.categories?.length ? fields.categories : [],
            yield_amount: fields.yield_amount === '' || fields.yield_amount == null ? null : Number(fields.yield_amount),
            yield_unit: fields.yield_unit || null,
            ingredients: fields.ingredients?.length ? fields.ingredients : null,
            buffer_pct: fields.buffer_pct === '' || fields.buffer_pct == null ? null : Number(fields.buffer_pct),
            steps: fields.steps?.filter((s) => s.trim()).length ? fields.steps.filter((s) => s.trim()) : null,
            general: !!fields.general,
        }).select('*').single();
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setLibrary((p) => [...p, data]);
        const speciesIds = fields.speciesIds ?? [];
        if (speciesIds.length) {
            const rows = speciesIds.map((species_id) => ({ library_id: data.id, species_id }));
            const { error: linkErr } = await supabase.from('library_species').insert(rows);
            if (linkErr) { console.error(linkErr); alert('Saved, but species tags failed - check console'); return; }
            setLibrarySpecies((p) => [...p, ...rows]);
        }
    };

    const editLibrary = async (entryId, fields) => {
        const cols = {
            title: fields.title.trim(),
            kind: fields.kind,
            url: fields.url?.trim() || null,
            body: fields.body?.trim() || null,
            categories: fields.categories?.length ? fields.categories : [],
            yield_amount: fields.yield_amount === '' || fields.yield_amount == null ? null : Number(fields.yield_amount),
            yield_unit: fields.yield_unit || null,
            ingredients: fields.ingredients?.length ? fields.ingredients : null,
            buffer_pct: fields.buffer_pct === '' || fields.buffer_pct == null ? null : Number(fields.buffer_pct),
            steps: fields.steps?.filter((s) => s.trim()).length ? fields.steps.filter((s) => s.trim()) : null,
            general: !!fields.general,
        };
        const { error } = await supabase.from('library').update(cols).eq('id', entryId);
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setLibrary((p) => p.map((e) => (e.id === entryId ? { ...e, ...cols } : e)));

        // Species tags: simplest correct sync is replace-all rather than diffing.
        const speciesIds = fields.speciesIds ?? [];
        const { error: delErr } = await supabase.from('library_species').delete().eq('library_id', entryId);
        if (delErr) { console.error(delErr); alert('Saved, but species tags failed - check console'); return; }
        let newRows = [];
        if (speciesIds.length) {
            newRows = speciesIds.map((species_id) => ({ library_id: entryId, species_id }));
            const { error: insErr } = await supabase.from('library_species').insert(newRows);
            if (insErr) { console.error(insErr); alert('Saved, but species tags failed - check console'); return; }
        }
        setLibrarySpecies((p) => [...p.filter((r) => r.library_id !== entryId), ...newRows]);
    };

    const deleteLibrary = async (entryId) => {
        const { error } = await supabase.from('library').delete().eq('id', entryId);
        if (error) { console.error(error); alert('Could not delete - check console'); return; }
        setLibrary((p) => p.filter((e) => e.id !== entryId));
        setLibrarySpecies((p) => p.filter((r) => r.library_id !== entryId)); // DB cascades too, keep local state matching
    };

    /* Recipe/reference step checklists persist to the row itself (indices
       into that entry's `steps` array) instead of living in local component
       state - otherwise progress vanished every time the card collapsed or
       you left the tab, which was the whole complaint. */
    const toggleChecklistStep = async (entryId, stepIndex) => {
        const entry = library.find((e) => e.id === entryId);
        if (!entry) return;
        const current = new Set(entry.checklist_checked ?? []);
        if (current.has(stepIndex)) current.delete(stepIndex); else current.add(stepIndex);
        const next = [...current].sort((a, b) => a - b);
        const { error } = await supabase.from('library').update({ checklist_checked: next }).eq('id', entryId);
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setLibrary((p) => p.map((e) => (e.id === entryId ? { ...e, checklist_checked: next } : e)));
    };

    const resetChecklist = async (entryId) => {
        const { error } = await supabase.from('library').update({ checklist_checked: [] }).eq('id', entryId);
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setLibrary((p) => p.map((e) => (e.id === entryId ? { ...e, checklist_checked: [] } : e)));
    };

    const addEquipment = async (fields) => {
        const { data, error } = await supabase.from('equipment').insert({
            name: fields.name.trim(),
            category: fields.category?.trim() || null,
            status: fields.status || 'active',
            quantity: fields.quantity === '' || fields.quantity == null ? null : Number(fields.quantity),
            notes: fields.notes?.trim() || null,
        }).select('*').single();
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setEquipment((p) => [...p, data]);
    };

    const editEquipment = async (id, fields) => {
        const cols = {
            name: fields.name.trim(),
            category: fields.category?.trim() || null,
            status: fields.status,
            quantity: fields.quantity === '' || fields.quantity == null ? null : Number(fields.quantity),
            notes: fields.notes?.trim() || null,
        };
        const { error } = await supabase.from('equipment').update(cols).eq('id', id);
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setEquipment((p) => p.map((e) => (e.id === id ? { ...e, ...cols } : e)));
    };

    /* Separate from the full edit form on purpose - restocking or using one
       up should be a single tap, not open-form/change/save. */
    const bumpEquipmentQty = async (id, delta) => {
        const item = equipment.find((e) => e.id === id);
        const next = Math.max(0, (item?.quantity ?? 0) + delta);
        const { error } = await supabase.from('equipment').update({ quantity: next }).eq('id', id);
        if (error) { console.error(error); return; }
        setEquipment((p) => p.map((e) => (e.id === id ? { ...e, quantity: next } : e)));
    };

    const deleteEquipment = async (id) => {
        const { error } = await supabase.from('equipment').delete().eq('id', id);
        if (error) { console.error(error); alert('Could not delete - check console'); return; }
        setEquipment((p) => p.filter((e) => e.id !== id));
    };

    const addSupplier = async (fields) => {
        const { data, error } = await supabase.from('suppliers').insert({
            name: fields.name.trim(),
            category: fields.category?.trim() || null,
            rating: fields.rating || 'unproven',
            notes: fields.notes?.trim() || null,
            website: fields.website?.trim() || null,
        }).select('*').single();
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setSuppliers((p) => [...p, data]);
    };

    const editSupplier = async (id, fields) => {
        const cols = {
            name: fields.name.trim(),
            category: fields.category?.trim() || null,
            rating: fields.rating,
            notes: fields.notes?.trim() || null,
            website: fields.website?.trim() || null,
        };
        const { error } = await supabase.from('suppliers').update(cols).eq('id', id);
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setSuppliers((p) => p.map((s) => (s.id === id ? { ...s, ...cols } : s)));
    };

    const deleteSupplier = async (id) => {
        const { error } = await supabase.from('suppliers').delete().eq('id', id);
        if (error) { console.error(error); alert('Could not delete - check console'); return; }
        setSuppliers((p) => p.filter((s) => s.id !== id));
    };

    /* For the "+ Add new vendor" escape hatch on a supplier picker (Stock,
       genetics lines) - typing a name that isn't in suppliers yet shouldn't
       be a dead end or a trip to a different screen. Case-insensitive match
       against what's already there so "rhizo funga" and "Rhizo Funga" don't
       create two rows; everything else about the row (category, rating,
       website) stays unset, same as any quick add - fill it in properly
       from the Suppliers tab later if it's worth it. */
    const getOrCreateSupplier = async (name) => {
        const trimmed = name.trim();
        if (!trimmed) return null;
        const existing = suppliers.find((s) => s.name.toLowerCase() === trimmed.toLowerCase());
        if (existing) return existing.id;
        const { data, error } = await supabase.from('suppliers').insert({ name: trimmed }).select('*').single();
        if (error) { console.error(error); alert('Could not add vendor - check console'); return null; }
        setSuppliers((p) => [...p, data]);
        return data.id;
    };

    /* Every stock row is one physical unit now (a specific agar plate, LC
       jar, grain bag - not an aggregate count) - see the "stock as
       individually numbered units" note near consumeStock() below. "Add
       stock" still logs a whole batch at once (how many, made from what,
       when), but under the hood that's N individual rows sharing the same
       batch metadata, each with its own optional label. Batches are
       grouped for display by that shared metadata (see stockBatchKey),
       not by a stored batch id. */
    const addStock = async (fields) => {
        const count = Math.max(1, fields.quantity === '' || fields.quantity == null ? 1 : Number(fields.quantity));
        let labels = (fields.labels ?? '').split(',').map((s) => s.trim()).filter(Boolean);

        /* Auto-numbering: only kicks in when the Labels field was left
           blank (a manual entry there always wins, same as before). Needs
           a code to build on - the recipe's (made) or supplier's (bought)
           `label_prefix`. First time either one is used to log stock,
           the form collects fields.new_code and this persists it so it
           sticks for every future batch, exactly like genetics' code. */
        if (labels.length === 0) {
            let code = null;
            if (fields.source === 'made' && fields.recipe_id) {
                code = library.find((r) => r.id === fields.recipe_id)?.label_prefix || null;
            } else if (fields.source === 'bought' && fields.supplier_id) {
                code = suppliers.find((s) => s.id === fields.supplier_id)?.label_prefix || null;
            }
            const newCode = fields.new_code?.trim().toUpperCase() || '';
            if (!code && newCode) {
                if (fields.source === 'made' && fields.recipe_id) {
                    const { error } = await supabase.from('library').update({ label_prefix: newCode }).eq('id', fields.recipe_id);
                    if (error) { console.error(error); alert('Could not save the recipe code - check console'); }
                    else { setLibrary((p) => p.map((r) => (r.id === fields.recipe_id ? { ...r, label_prefix: newCode } : r))); code = newCode; }
                } else if (fields.source === 'bought' && fields.supplier_id) {
                    const { error } = await supabase.from('suppliers').update({ label_prefix: newCode }).eq('id', fields.supplier_id);
                    if (error) { console.error(error); alert('Could not save the supplier code - check console'); }
                    else { setSuppliers((p) => p.map((s) => (s.id === fields.supplier_id ? { ...s, label_prefix: newCode } : s))); code = newCode; }
                }
            }
            if (code) labels = nextStockLabels(STOCK_KIND_TAG[fields.kind], code, count, stock);
        }

        const rows = Array.from({ length: count }, (_, i) => ({
            kind: fields.kind,
            source: fields.source,
            recipe_id: fields.source === 'made' ? (fields.recipe_id || null) : null,
            supplier_id: fields.source === 'bought' ? (fields.supplier_id || null) : null,
            product_name: fields.source === 'bought' ? (fields.product_name?.trim() || null) : null,
            quantity: 1,
            made_or_bought_on: fields.made_or_bought_on || null,
            status: fields.status || 'on_hand',
            notes: fields.notes?.trim() || null,
            amount: fields.amount === '' || fields.amount == null ? null : Number(fields.amount),
            amount_unit: fields.amount_unit?.trim() || null,
            label: labels[i] || null,
        }));
        const { data, error } = await supabase.from('stock').insert(rows).select('*');
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setStock((p) => [...p, ...data]);
    };

    const editStock = async (id, fields) => {
        const cols = {
            kind: fields.kind,
            source: fields.source,
            recipe_id: fields.source === 'made' ? (fields.recipe_id || null) : null,
            supplier_id: fields.source === 'bought' ? (fields.supplier_id || null) : null,
            product_name: fields.source === 'bought' ? (fields.product_name?.trim() || null) : null,
            quantity: 1,
            made_or_bought_on: fields.made_or_bought_on || null,
            status: fields.status,
            label: fields.label?.trim() || null,
            notes: fields.notes?.trim() || null,
            amount: fields.amount === '' || fields.amount == null ? null : Number(fields.amount),
            amount_unit: fields.amount_unit?.trim() || null,
        };
        /* consumed_into_item_id only means anything while status is 'used' -
           if this edit is moving status away from that (undoing an
           accidental consume, or just recategorizing the unit), drop the
           link too. Otherwise a unit flipped back to "on hand" could still
           show "became <item>" even though it's no longer marked used. */
        if (fields.status !== 'used') cols.consumed_into_item_id = null;
        const { error } = await supabase.from('stock').update(cols).eq('id', id);
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setStock((p) => p.map((s) => (s.id === id ? { ...s, ...cols } : s)));
    };

    const deleteStock = async (id) => {
        const { error } = await supabase.from('stock').delete().eq('id', id);
        if (error) { console.error(error); alert('Could not delete - check console'); return; }
        setStock((p) => p.filter((s) => s.id !== id));
    };

    /* Called when a specific stock unit gets used to start a new item (from
       either the "add line" form or "Inoculate from this"). Since every row
       is one physical unit now, this is just a direct status flip + a link
       to what it became - no more decrementing a shared count. That link
       (consumed_into_item_id) is also what makes a stock QR label keep
       working after the jar becomes a culture: see the ?stock= deep link
       in the data-loading effect above, and PrintLabels' stock mode below. */
    const consumeStock = async (id, itemUid) => {
        const cols = { status: 'used', consumed_into_item_id: itemUid };
        const { error } = await supabase.from('stock').update(cols).eq('id', id);
        if (error) { console.error(error); return; }
        setStock((p) => p.map((s) => (s.id === id ? { ...s, ...cols } : s)));
    };

    /* remaining = what it started with, minus everything drawn out of it via
       lot_links, minus anything logged as lost. Never stored - always derived,
       so a lot can't drift out of sync with its own history. */
    const lotRemaining = (lotId, lotsArr = lots, linksArr = lotLinks) => {
        const lot = lotsArr.find((l) => l.id === lotId);
        if (!lot) return 0;
        const taken = linksArr.filter((k) => k.parent_lot_id === lotId).reduce((s, k) => s + Number(k.amount_taken_g), 0);
        return Number(lot.amount_g) - taken - Number(lot.lost_g || 0);
    };

    /* One action covers both transform (one source) and merge/blend (several
       sources) - the only difference is how many rows go into lot_links. */
    const processLot = async (sources, fields) => {
        const today = todayISO();
        const { data: newLot, error } = await supabase.from('lots').insert({
            label: fields.label.trim(),
            form: fields.form,
            amount_g: fields.amount,
            harvested_on: today,
            notes: fields.notes?.trim() || null,
        }).select('*').single();
        if (error) { console.error(error); alert('Could not save - check console'); return; }

        const linkRows = sources.map((s) => ({ parent_lot_id: s.lotId, child_lot_id: newLot.id, amount_taken_g: s.amount }));
        const { data: newLinks, error: linkErr } = await supabase.from('lot_links').insert(linkRows).select('*');
        if (linkErr) { console.error(linkErr); alert('Lot saved but links failed - check console'); return; }

        setLots((p) => [...p, newLot]);
        setLotLinks((p) => [...p, ...newLinks]);
        setOpenLot(newLot.id);
    };

    const logLoss = async (lotId, amount, reason) => {
        const lot = lots.find((l) => l.id === lotId);
        const newLost = Number(lot.lost_g || 0) + amount;
        const note = `${lot.notes ? lot.notes + '\n' : ''}Lost ${amount}g on ${todayISO()}${reason ? ' - ' + reason : ''}`;
        const { error } = await supabase.from('lots').update({ lost_g: newLost, notes: note }).eq('id', lotId);
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setLots((p) => p.map((l) => (l.id === lotId ? { ...l, lost_g: newLost, notes: note } : l)));
    };

    const saveLotFields = async (lotId, patch) => {
        const { error } = await supabase.from('lots').update(patch).eq('id', lotId);
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setLots((p) => p.map((l) => (l.id === lotId ? { ...l, ...patch } : l)));
    };

    /* Standalone entry - no source item, no lot_links parent. For material
       that's real but doesn't have a clean paper trail back to a specific
       flush (backfilling the cabinet, something found later, etc). Species
       is tagged directly since there's no item to trace it through. */
    const addManualLot = async (fields) => {
        const { data, error } = await supabase.from('lots').insert({
            label: fields.label.trim(),
            form: fields.form,
            amount_g: fields.amount,
            species_id: fields.speciesId || null,
            harvested_on: fields.date || todayISO(),
            notes: fields.notes?.trim() || null,
        }).select('*').single();
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setLots((p) => [...p, data]);
    };

    const deleteLot = async (lotId) => {
        const hasChildren = lotLinks.some((k) => k.parent_lot_id === lotId);
        if (hasChildren) { alert('This lot has material processed from it - remove that first, or it stays as history.'); return; }
        await supabase.from('lot_links').delete().eq('child_lot_id', lotId);
        const { error } = await supabase.from('lots').delete().eq('id', lotId);
        if (error) { console.error(error); alert('Could not delete - check console'); return; }
        setLots((p) => p.filter((l) => l.id !== lotId));
        setLotLinks((p) => p.filter((k) => k.child_lot_id !== lotId));
        setOpenLot(null);
    };

    /* Fixes a mis-entered draw amount on an existing process/blend link
       without touching the child lot it fed (that amount_g was entered
       separately at process time and isn't derived from this number).
       Capped at what the parent lot actually has free, checked against
       every *other* link off that same parent so two edits can't
       independently overdraw it. */
    const editLotLink = async (linkId, newAmount) => {
        const link = lotLinks.find((k) => k.id === linkId);
        if (!link) return;
        const parent = lots.find((l) => l.id === link.parent_lot_id);
        if (!parent) return;
        const otherTaken = lotLinks.filter((k) => k.parent_lot_id === link.parent_lot_id && k.id !== linkId)
            .reduce((s, k) => s + Number(k.amount_taken_g), 0);
        const cap = Number(parent.amount_g) - otherTaken - Number(parent.lost_g || 0);
        if (newAmount > cap + LOT_EPS) {
            alert(`Only ${fmtG(cap, parent.form)}g free on "${parent.label}" - can't set this link that high.`);
            return;
        }
        const { error } = await supabase.from('lot_links').update({ amount_taken_g: newAmount }).eq('id', linkId);
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setLotLinks((p) => p.map((k) => (k.id === linkId ? { ...k, amount_taken_g: newAmount } : k)));
    };

    /* Removes just this one link - e.g. it was recorded against the wrong
       source lot entirely. The child lot itself is untouched; the parent's
       derived remaining just goes back up since lotRemaining reads
       lot_links live. */
    const deleteLotLink = async (linkId) => {
        const { error } = await supabase.from('lot_links').delete().eq('id', linkId);
        if (error) { console.error(error); alert('Could not delete - check console'); return; }
        setLotLinks((p) => p.filter((k) => k.id !== linkId));
    };

    /* Upload goes straight from the browser to Supabase Storage, then a row
       tracks where it lives. It can attach to an item, to equipment, or to
       nothing at all - a plain gallery photo isn't required to be about
       anything.
       Each photo is stored as up to three files (see photoProcessing.js):
       original (metadata stripped to date + orientation), display (~2048px,
       what the lightbox shows) and thumb (~480px, every grid/strip). If the
       browser can't decode the image at all, the raw file goes up alone and
       every size falls back to it - same as before this existed. */
    const addPhoto = async (file, { itemId, equipmentId, eventId, caption } = {}) => {
        const folder = itemId || equipmentId || 'general';
        const base = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const put = (path, body) => supabase.storage.from('photos')
            .upload(path, body, { cacheControl: CACHE_CONTROL, contentType: body.type || undefined });

        let processed = null;
        try { processed = await processPhotoForUpload(file); }
        catch (e) { console.warn('Photo processing failed, uploading as-is', e); }

        let row;
        if (processed) {
            const path = `${base}.jpg`;
            const thumbPath = `${base}-thumb.jpg`;
            const displayPath = processed.displayIsOriginal ? path : `${base}-display.jpg`;
            const uploads = [put(path, processed.original), put(thumbPath, processed.thumb)];
            if (!processed.displayIsOriginal) uploads.push(put(displayPath, processed.display));
            const results = await Promise.all(uploads);
            const upErr = results.find((r) => r.error)?.error;
            if (upErr) {
                console.error(upErr);
                await supabase.storage.from('photos').remove([...new Set([path, thumbPath, displayPath])]);
                alert('Upload failed - check console'); return;
            }
            row = { storage_path: path, thumb_path: thumbPath, display_path: displayPath, taken_on: processed.takenOn || todayISO() };
        } else {
            const ext = file.name.split('.').pop() || 'jpg';
            const path = `${base}.${ext}`;
            const { error: upErr } = await put(path, file);
            if (upErr) { console.error(upErr); alert('Upload failed - check console'); return; }
            row = { storage_path: path, taken_on: todayISO() };
        }

        const { data, error } = await supabase.from('photos').insert({
            item_id: itemId || null, equipment_id: equipmentId || null,
            event_id: eventId || null, caption: caption?.trim() || null, ...row,
        }).select('*').single();
        if (error) { console.error(error); alert('Could not save - check console'); return; }

        const signed = await getSignedUrls([thumbPathOf(data), displayPathOf(data)]);
        setPhotoUrls((p) => ({ ...p, ...signed }));
        setPhotos((p) => [...p, data]);
    };

    const deletePhoto = async (photo) => {
        await supabase.storage.from('photos').remove(
            [...new Set([photo.storage_path, photo.thumb_path, photo.display_path].filter(Boolean))]);
        const { error } = await supabase.from('photos').delete().eq('id', photo.id);
        if (error) { console.error(error); alert('Could not delete - check console'); return; }
        setPhotos((p) => p.filter((x) => x.id !== photo.id));
    };

    const editPhoto = async (photo, patch) => {
        const cols = {
            caption: patch.caption?.trim() || null,
            taken_on: patch.taken_on || null,
        };
        const { error } = await supabase.from('photos').update(cols).eq('id', photo.id);
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setPhotos((p) => p.map((x) => (x.id === photo.id ? { ...x, ...cols } : x)));
    };

    /* Bucket is private, so photos need signed URLs (cached, see
       photoUrls.js). Pass the photo row: photoUrl(p) is the small thumb for
       grids and strips, photoUrl(p, 'display') is the lightbox size. A bare
       path string still works for anything that only has a path. */
    const photoUrl = (p, size = 'thumb') => {
        if (typeof p === 'string') return photoUrls[p] ?? '';
        const path = size === 'display' ? displayPathOf(p) : thumbPathOf(p);
        return photoUrls[path] ?? '';
    };

    const addSpecies = async (fields) => {
        const { data, error } = await supabase.from('species').insert({
            common_name: fields.common_name.trim(),
            latin_name: fields.latin_name?.trim() || null,
            fruiting_temp: fields.fruiting_temp?.trim() || null,
            humidity: fields.humidity?.trim() || null,
            fae: fields.fae?.trim() || null,
            colonize_temp: fields.colonize_temp?.trim() || null,
            colonize_time: fields.colonize_time?.trim() || null,
            pin_to_harvest: fields.pin_to_harvest?.trim() || null,
            substrate_note: fields.substrate_note?.trim() || null,
            dry_yield_pct: fields.dry_yield_pct === '' || fields.dry_yield_pct == null ? null : Number(fields.dry_yield_pct),
            notes: fields.notes?.trim() || null,
        }).select('*').single();
        if (error) { console.error(error); alert('Could not add species - check console'); return; }
        setSpecies((p) => [...p, data].sort((a, b) => a.common_name.localeCompare(b.common_name)));
        return data;
    };

    /* A genetics line always starts with one physical container - the first
       thing that actually sat on a shelf. Source lives on the line itself. */
    const addGenetics = async (speciesId, fields, firstType, stockId = null) => {
        const today = todayISO();
        const code = fields.code.trim().toUpperCase();

        const { data: gen, error } = await supabase.from('genetics').insert({
            species_id: speciesId,
            name: fields.name.trim(),
            code,
            source: fields.source?.trim() || null,
            acquired_on: fields.acquired || null,
            notes: fields.notes?.trim() || null,
            supplier_id: fields.supplier_id || null,
        }).select('*').single();
        if (error) { console.error(error); alert('Could not add line - check console'); return; }

        const label = `${code}-${CODE[firstType]}1`;
        const { data: item, error: itemErr } = await supabase.from('items').insert({
            genetics_id: gen.id,
            parent_id: null,
            label,
            type: firstType,
            status: 'colonizing',
            created_on: fields.acquired || today,
        }).select('id').single();
        if (itemErr) { console.error(itemErr); alert('Line added but first container failed - check console'); return; }

        const { data: ev } = await supabase.from('item_events').insert({
            item_id: item.id,
            happened_on: fields.acquired || today,
            kind: 'note',
            body: fields.source?.trim() ? `Acquired - ${fields.source.trim()}` : 'Line started',
        }).select('id').single();

        setGenetics((p) => [...p, gen].sort((a, b) => a.name.localeCompare(b.name)));
        setItems((p) => [...p, {
            id: label, uid: item.id, geneticsId: gen.id, parent: null,
            type: firstType, created: fields.acquired || today, status: 'colonizing',
            where: '', substrate: '', notes: '', harvests: [], dryWeight: undefined,
            log: [{ id: ev?.id, date: fields.acquired || today, kind: 'note', body: fields.source?.trim() ? `Acquired - ${fields.source.trim()}` : 'Line started' }],
        }]);
        if (stockId) consumeStock(stockId, item.id);
        return gen;
    };

    /* Deleting a container splices it out: its children are adopted by its
       parent, so a mistaken middle node can be removed without orphaning
       everything below it. */
    const deleteItem = async (label) => {
        const item = items.find((i) => i.id === label);
        const parent = items.find((i) => i.id === item.parent);
        const kids = items.filter((i) => i.parent === label);

        if (kids.length) {
            const { error } = await supabase.from('items')
                .update({ parent_id: parent?.uid ?? null }).eq('parent_id', item.uid);
            if (error) { console.error(error); alert('Could not reparent children - check console'); return; }
        }

        await supabase.from('lots').delete().eq('source_item_id', item.uid);
        const { error } = await supabase.from('items').delete().eq('id', item.uid);
        if (error) { console.error(error); alert('Could not delete - check console'); return; }

        setItems((p) => p
            .filter((i) => i.id !== label)
            .map((i) => (i.parent === label ? { ...i, parent: parent?.id ?? null } : i)));
        setOpen(parent?.id ?? null);
    };

    const reparentItem = async (label, newParentLabel) => {
        const item = items.find((i) => i.id === label);
        const np = newParentLabel ? items.find((i) => i.id === newParentLabel) : null;
        const { error } = await supabase.from('items')
            .update({ parent_id: np?.uid ?? null }).eq('id', item.uid);
        if (error) { console.error(error); alert('Could not reparent - check console'); return; }
        setItems((p) => p.map((i) => (i.id === label ? { ...i, parent: np?.id ?? null } : i)));
    };

    const addChild = async (parentLabel, type, stockId = null, extra = {}) => {
        const today = todayISO();
        const parent = items.find((i) => i.id === parentLabel);
        const code = genetics.find((g) => g.id === parent.geneticsId)?.code ?? 'X';
        const form = extra.form || '';
        const kindCode = codeFor(type, form);
        /* Start counting from how many items of this type already exist,
           but that's only a good guess - an older item's `type` can drift
           out of sync with its label (e.g. relabeled by hand), so don't
           trust the guess blindly. Keep incrementing until the generated
           label isn't already taken by something. Two items sharing a
           label breaks the tree view outright (infinite loop walking
           parent -> child -> parent), so this has to be airtight. */
        let n = items.filter((i) => i.geneticsId === parent.geneticsId
            && i.type === type && (i.form || '') === form).length + 1;
        let label = `${code}-${kindCode}${n}`;
        while (items.some((i) => i.id === label)) {
            n += 1;
            label = `${code}-${kindCode}${n}`;
        }

        const { data, error } = await supabase.from('items').insert({
            genetics_id: parent.geneticsId,
            parent_id: parent.uid,
            label, type, status: 'colonizing', created_on: today,
            form: form || null,
            amount: extra.amount ?? null,
            amount_unit: extra.amountUnit || null,
        }).select('id').single();

        if (error) { console.error(error); alert('Could not create item - check console'); return; }

        /* Drawing a syringe off a jar isn't a transformation, so it reads
           differently in the log than an inoculation does. */
        const body = extra.drawn
            ? `Drawn from ${parentLabel}`
            : `Inoculated from ${parentLabel}`;

        const { data: ev } = await supabase.from('item_events').insert({
            item_id: data.id, happened_on: today, kind: 'note',
            body,
        }).select('id').single();

        setItems((p) => [...p, {
            id: label, uid: data.id, geneticsId: parent.geneticsId,
            parent: parentLabel, type, created: today, status: 'colonizing',
            form, amount: extra.amount ?? undefined, amountUnit: extra.amountUnit || '',
            where: '', substrate: '', notes: '', harvests: [],
            dryWeight: undefined,
            log: [{ id: ev?.id, date: today, body, kind: 'note' }],
        }]);
        if (!extra.quiet) setOpen(label);
        if (stockId) consumeStock(stockId, data.id);
        return label;
    };

    /* Draw N syringes off an LC jar. Deliberately NOT a loop over
       addChild: React state hasn't flushed between calls, so every
       syringe in the batch would generate the same label, and
       reparentItem would look up a new syringe that isn't in `items`
       yet and quietly null the parent instead. One function, one
       state update.

       `assignments` maps an EXISTING child label -> index of the new
       syringe it should hang under (or null to leave it on the jar).
       This exists because grain often gets logged before anyone
       remembers to record the syringe it came from, so the syringe has
       to be insertable *between* a jar and its existing children after
       the fact - and with several syringes drawn at once, only the user
       knows which bag came off which. */
    const drawSyringes = async (parentLabel, count, amount, amountUnit, assignments = {}) => {
        const today = todayISO();
        const parent = items.find((i) => i.id === parentLabel);
        if (!parent || count < 1) return;
        const code = genetics.find((g) => g.id === parent.geneticsId)?.code ?? 'X';

        const taken = new Set(items.map((i) => i.id));
        let n = items.filter((i) => i.geneticsId === parent.geneticsId && i.form === 'syringe').length;
        const labels = [];
        for (let k = 0; k < count; k += 1) {
            let label;
            do { n += 1; label = `${code}-SY${n}`; } while (taken.has(label));
            taken.add(label);
            labels.push(label);
        }

        const { data: rows, error } = await supabase.from('items').insert(
            labels.map((label) => ({
                genetics_id: parent.geneticsId,
                parent_id: parent.uid,
                label, type: 'lc', form: 'syringe',
                status: parent.status === 'colonized' ? 'colonized' : 'colonizing',
                created_on: today,
                amount: amount ?? null,
                amount_unit: amountUnit || null,
            }))
        ).select('id,label');
        if (error) { console.error(error); alert('Could not draw syringes - check console'); return; }

        const uidFor = Object.fromEntries(rows.map((r) => [r.label, r.id]));

        const { data: evs } = await supabase.from('item_events').insert(
            labels.map((label) => ({
                item_id: uidFor[label], happened_on: today, kind: 'note',
                body: `Drawn from ${parentLabel}`,
            }))
        ).select('id,item_id');

        /* Reparent by uid, not label - the label lookup helpers all read
           from state that doesn't know these rows exist yet. */
        const moves = Object.entries(assignments)
            .filter(([, idx]) => idx !== null && idx !== undefined && idx !== '')
            .map(([childLabel, idx]) => ({ childLabel, syringe: labels[Number(idx)] }))
            .filter((m) => m.syringe);
        for (const m of moves) {
            const child = items.find((i) => i.id === m.childLabel);
            if (!child) continue;
            const { error: rErr } = await supabase.from('items')
                .update({ parent_id: uidFor[m.syringe] }).eq('id', child.uid);
            if (rErr) { console.error(rErr); alert(`Drew the syringes, but could not move ${m.childLabel} - check console`); }
        }
        const movedTo = Object.fromEntries(moves.map((m) => [m.childLabel, m.syringe]));

        setItems((p) => [
            ...p.map((i) => (movedTo[i.id] ? { ...i, parent: movedTo[i.id] } : i)),
            ...labels.map((label) => ({
                id: label, uid: uidFor[label], geneticsId: parent.geneticsId,
                parent: parentLabel, type: 'lc', form: 'syringe',
                amount: amount ?? undefined, amountUnit: amountUnit || '',
                created: today,
                status: parent.status === 'colonized' ? 'colonized' : 'colonizing',
                where: '', substrate: '', notes: '', harvests: [],
                dryWeight: undefined,
                log: [{
                    id: (evs ?? []).find((e) => e.item_id === uidFor[label])?.id,
                    date: today, body: `Drawn from ${parentLabel}`, kind: 'note',
                }],
            })),
        ]);
    };

    /* Fire-and-forget usage logging - powers Home's "most visited" and,
       later, the admin analytics scoped in the beta launch plan. Never
       blocks or breaks navigation on failure (no RLS/network hiccup
       should ever stop someone from opening an item), and updates local
       state optimistically so Home reflects a just-taken action without
       waiting on a refetch - same pattern the rest of the app already
       uses for its own optimistic updates. */
    const logUsage = (event_type, section_, entity_type, entity_id, entity_label) => {
        const row = { event_type, section: section_, entity_type: entity_type ?? null, entity_id: entity_id ?? null, entity_label: entity_label ?? null };
        setUsageEvents((p) => [{ ...row, id: `optimistic-${Date.now()}-${Math.random()}`, created_at: new Date().toISOString() }, ...p].slice(0, 400));
        supabase.from('usage_events').insert(row).then(({ error }) => { if (error) console.error(error); });
    };
    /* Every item-open entry point in the app - Tree canvas clicks, Detail's
       own parent/child/breadcrumb links, search results, Supplies' item
       shortcut - funnels through here instead of the raw setOpen setter,
       so "most visited" sees all of them, not just one path in. */
    const openItemById = (id) => { logUsage('record_open', 'cultures', 'item', id, id); setOpen(id); };
    /* Same idea for lots: Inventory's list, LotDetail's own lineage links,
       and search results all funnel through this instead of raw setOpenLot. */
    const openLotById = (id) => {
        const lot = lots.find((l) => l.id === id);
        logUsage('record_open', 'inventory', 'lot', id, lot?.label || 'Unlabeled lot');
        setOpenLot(id);
    };

    /* The logo always goes Home regardless of the viewer's default_section
       setting (Matt, 2026-09-17: "the logo should always go to the home
       page") - clears every overlay/open-record state the same way the
       sidebar NAV buttons do, so Home never renders underneath a stale
       Detail/LotDetail/Account/Settings screen. */
    const goHome = () => {
        setPrinting(null); setAccountOpen(false); setSettingsOpen(false);
        setSection('home'); setOpen(null); setOpenLot(null); setDir('fwd');
        setSuppliesTab(null); setSuppliesOpenId(null); setReferenceTab(null);
    };

    /* Shared by the sidebar NAV buttons and Home's own section cards, so
       "click Cultivation" behaves identically whether it's clicked from
       the sidebar or from a Home card - one place to keep the overlay
       resets right instead of two copies drifting apart. */
    const goSection = (k) => {
        setPrinting(null); setAccountOpen(false); setSettingsOpen(false); setSection(k); setOpen(null); setOpenLot(null);
        setDir('fwd'); setSuppliesTab(null); setSuppliesOpenId(null); setReferenceTab(null); logUsage('section_open', k);
    };

    /* "Jump to X from anywhere" handlers - full overlay reset + navigate +
       log, regardless of whatever screen is currently showing. Originally
       written inline inside searchProps (search dropdown results); pulled
       out to standalone functions (2026-09-17) so Home's most-visited/
       section cards can call the exact same navigation searchProps uses,
       and so both can be defined before the render switch below needs
       them - searchProps itself is only built right before the return,
       too late for the switch to reference it directly. */
    const jumpToItem = (label) => {
        const it = items.find((i) => i.id === label);
        const gen = genetics.find((g) => g.id === it?.geneticsId);
        setAccountOpen(false); setSettingsOpen(false);
        setPrinting(null); setSuppliesTab(null); setSuppliesOpenId(null); setReferenceTab(null);
        setSection('cultures'); setOpenLot(null);
        if (gen) go({ level: 'tree', speciesId: gen.species_id }); else setDir('fwd');
        openItemById(label);
    };
    const jumpToSpecies = (id) => {
        setAccountOpen(false); setSettingsOpen(false); setPrinting(null); setSuppliesTab(null); setSuppliesOpenId(null); setReferenceTab(null);
        setOpen(null); setOpenLot(null); setSection('cultures'); go({ level: 'tree', speciesId: id });
        logUsage('record_open', 'cultures', 'species', id, species.find((s) => s.id === id)?.common_name || id);
    };
    const jumpToLot = (id) => {
        setAccountOpen(false); setSettingsOpen(false); setPrinting(null); setSuppliesTab(null); setSuppliesOpenId(null); setReferenceTab(null);
        setOpen(null); setSection('inventory'); openLotById(id); setDir('fwd');
    };
    const jumpToLibrary = (entry) => {
        setAccountOpen(false); setSettingsOpen(false); setPrinting(null); setOpen(null); setOpenLot(null);
        setSuppliesTab(null); setSuppliesOpenId(null); setReferenceTab(entry.id); setSection('reference'); setDir('fwd');
        logUsage('record_open', 'reference', 'library', entry.id, entry.title);
    };
    const jumpToSupplies = (tab, id) => {
        setAccountOpen(false); setSettingsOpen(false); setPrinting(null); setOpen(null); setOpenLot(null); setReferenceTab(null);
        setSuppliesTab(tab); setSuppliesOpenId(id ?? null); setSection('supplies'); setDir('fwd');
        if (id) {
            const s = stock.find((r) => r.id === id);
            logUsage('record_open', 'supplies', 'supply', id, s?.label || s?.product_name || 'Supply item');
        }
    };

    const sp = species.find((s) => s.id === nav.speciesId);
    const lines = genetics.filter((g) => g.species_id === nav.speciesId);
    const lineIds = lines.map((g) => g.id);
    const mine = items.filter((i) => lineIds.includes(i.geneticsId));
    const openItem = items.find((i) => i.id === open);
    const openCulture = genetics.find((g) => g.id === openItem?.geneticsId);

    /* Declared here (before the screen/key switch below) rather than
       right above the return - Home's own branch of that switch now
       renders a SearchBox too (2026-09-18), so this has to exist before
       that branch runs or it's a temporal-dead-zone ReferenceError, same
       issue jumpToItem/etc. already ran into further up. */
    const searchProps = {
        items, genetics, species, lots, lotLinks, library, librarySpecies, equipment, suppliers, stock,
        onOpenItem: jumpToItem, onOpenSpecies: jumpToSpecies, onOpenLot: jumpToLot,
        onOpenLibrary: jumpToLibrary, onOpenSupplies: jumpToSupplies,
    };

    let screen, key;
    if (accountOpen) {
        key = 'account';
        screen = <AccountPanel profile={profile} avatarUrl={avatarUrl} onSave={saveProfile} onBack={() => setAccountOpen(false)} />;
    } else if (settingsOpen) {
        key = 'settings';
        screen = <SettingsPanel profile={profile} onSave={saveProfile} onBack={() => setSettingsOpen(false)} />;
    } else if (printing) {
        key = 'print';
        /* Building blocks for all three kinds below - `queue` combines both
           so a mixed batch (items + stock units, added from wherever) can
           print in one pass with each row's QR keyed off its own kind, not
           one shared linkParam like the single-kind cases used to assume. */
        const stockCandidate = (s) => ({
            id: s.id, kind: 'stock', linkParam: 'stock',
            printed: s.label || 'Unlabeled unit', sub: stockLabel(s, library, suppliers), started: s.made_or_bought_on,
        });
        const itemCandidate = (i) => {
            const g = genetics.find((x) => x.id === i.geneticsId);
            const sp = g && species.find((s) => s.id === g.species_id);
            return { id: i.id, kind: 'item', linkParam: 'item', printed: i.id, sub: sp?.common_name ?? '', started: i.created };
        };
        const lotCandidate = (l) => {
            const spNames = lotSpeciesNames(l.id, lots, lotLinks, items, genetics, species);
            const weight = `${fmtG(lotRemaining(l.id), l.form)}g`;
            return {
                id: l.id, kind: 'lot', linkParam: 'lot',
                printed: l.label || 'Untitled lot',
                sub: [weight, LOT_FORMS[l.form] ?? l.form, spNames.length ? spNames.join(' + ') : null].filter(Boolean).join(' · '),
                started: l.harvested_on,
            };
        };
        if (printing.kind === 'stock') {
            const candidates = printing.ids
                .map((id) => stock.find((s) => s.id === id)).filter(Boolean)
                .map(stockCandidate)
                .sort((a, b) => a.printed.localeCompare(b.printed));
            screen = <PrintLabels candidates={candidates}
                subtitle="each QR opens this unit, and once it's inoculated into a culture, follows through to that item automatically - no reprint needed."
                onClose={() => setPrinting(null)} dateFormat={dateFormat} />;
        } else if (printing.kind === 'item') {
            const candidates = printing.ids
                .map((id) => items.find((i) => i.id === id)).filter(Boolean)
                .map(itemCandidate)
                .sort((a, b) => a.printed.localeCompare(b.printed));
            screen = <PrintLabels candidates={candidates}
                subtitle="each QR opens straight to that item."
                onClose={() => setPrinting(null)} dateFormat={dateFormat} />;
        } else if (printing.kind === 'lot') {
            const candidates = printing.ids
                .map((id) => lots.find((l) => l.id === id)).filter(Boolean)
                .map(lotCandidate)
                .sort((a, b) => a.printed.localeCompare(b.printed));
            screen = <PrintLabels candidates={candidates}
                subtitle="each QR opens straight to that lot."
                onClose={() => setPrinting(null)} dateFormat={dateFormat} />;
        } else {
            // 'queue' - added to from across the app (Detail/Tree/Stock/
            // Harvests's "+ Queue" buttons); order follows queue insertion
            // order rather than being re-sorted, since that's the order
            // Matt actually worked through the grows in.
            const byKey = new Map();
            printQueue.forEach((e) => {
                if (byKey.has(`${e.kind}:${e.id}`)) return;
                if (e.kind === 'stock') {
                    const s = stock.find((x) => x.id === e.id);
                    if (s) byKey.set(`${e.kind}:${e.id}`, stockCandidate(s));
                } else if (e.kind === 'lot') {
                    const l = lots.find((x) => x.id === e.id);
                    if (l) byKey.set(`${e.kind}:${e.id}`, lotCandidate(l));
                } else {
                    const i = items.find((x) => x.id === e.id);
                    if (i) byKey.set(`${e.kind}:${e.id}`, itemCandidate(i));
                }
            });
            const candidates = printQueue.map((e) => byKey.get(`${e.kind}:${e.id}`)).filter(Boolean);
            screen = <PrintLabels candidates={candidates}
                subtitle="your print queue, added from across the app - each QR still opens the right thing, item, stock unit, or lot."
                onClose={() => setPrinting(null)} dateFormat={dateFormat}
                onRemove={removeFromPrintQueue}
                onPrinted={(printed) => setPrintQueue((prev) =>
                    prev.filter((e) => !printed.some((p) => p.kind === e.kind && p.id === e.id)))} />;
        }
    } else if (section === 'home') {
        key = 'home';
        screen = <HomeTab items={items} genetics={genetics} species={species} lots={lots} library={library} stock={stock}
            usageEvents={usageEvents} searchProps={searchProps} profile={profile}
            onGoSection={goSection}
            onOpenItem={jumpToItem} onOpenLot={jumpToLot}
            onOpenSpecies={jumpToSpecies} onOpenLibrary={jumpToLibrary}
            avatarUrl={avatarUrl}
            printQueueCount={printQueue.length} onOpenPrintQueue={() => setPrinting({ kind: 'queue' })}
            onOpenAccount={() => { setPrinting(null); setSettingsOpen(false); setAccountOpen(true); }}
            onOpenSettings={() => { setPrinting(null); setAccountOpen(false); setSettingsOpen(true); }} />;
    } else if (section === 'supplies') {
        key = 'supplies';
        screen = <Supplies stock={stock} library={library} suppliers={suppliers} species={species} equipment={equipment}
            items={items} initialTab={suppliesTab} initialOpenId={suppliesOpenId}
            onAddStock={addStock} onEditStock={editStock} onDeleteStock={deleteStock}
            onPrintStock={(ids) => setPrinting({ kind: 'stock', ids })}
            onQueueStock={(ids) => addToPrintQueue('stock', ids)}
            onOpenItem={(label) => {
                const it = items.find((i) => i.id === label);
                const gen = genetics.find((g) => g.id === it?.geneticsId);
                setPrinting(null); setSuppliesTab(null); setSuppliesOpenId(null); setReferenceTab(null);
                setSection('cultures'); setOpenLot(null);
                if (gen) go({ level: 'tree', speciesId: gen.species_id }); else setDir('fwd');
                openItemById(label);
            }}
            onAddEquip={addEquipment} onEditEquip={editEquipment} onDeleteEquip={deleteEquipment}
            photos={photos} photoUrl={photoUrl} onAddPhoto={addPhoto} onDeletePhoto={deletePhoto} onEditPhoto={editPhoto}
            onBumpEquipQty={bumpEquipmentQty}
            onAddSupplier={addSupplier} onEditSupplier={editSupplier} onDeleteSupplier={deleteSupplier}
            onGetOrCreateSupplier={getOrCreateSupplier} dateFormat={dateFormat} />;
    } else if (section === 'reference') {
        key = 'reference';
        screen = <ReferenceSection library={library} librarySpecies={librarySpecies} species={species} initialOpenId={referenceTab}
            onAdd={addLibrary} onEdit={editLibrary} onDelete={deleteLibrary}
            onToggleChecklistStep={toggleChecklistStep} onResetChecklist={resetChecklist} unitsPref={profile?.units_pref ?? 'adaptive'}
            onEditSpecies={saveSpeciesFields}
            onLogOpen={(id, label) => logUsage('record_open', 'reference', 'library', id, label)} />;
    } else if (section === 'inventory') {
        key = openLot ? 'lot-' + openLot : 'inventory';
        screen = openLot
            ? <LotDetail lots={lots} lotLinks={lotLinks} lotId={openLot} items={items} genetics={genetics} species={species}
                remaining={lotRemaining} onBack={() => setOpenLot(null)} onOpen={openLotById}
                onProcess={processLot} onLoss={logLoss} onSave={saveLotFields} onDelete={deleteLot}
                onEditLink={editLotLink} onDeleteLink={deleteLotLink}
                onPrintLot={(id) => setPrinting({ kind: 'lot', ids: [id] })}
                onQueueLot={(id) => addToPrintQueue('lot', id)} dateFormat={dateFormat} />
            : <Inventory lots={lots} lotLinks={lotLinks} items={items} genetics={genetics} species={species}
                remaining={lotRemaining} onOpen={openLotById} onAddManual={addManualLot}
                onPrintLot={(id) => setPrinting({ kind: 'lot', ids: [id] })}
                onQueueLot={(id) => addToPrintQueue('lot', id)} dateFormat={dateFormat} />;
    } else if (section === 'data') {
        key = 'data';
        screen = <DataTab items={items} genetics={genetics} species={species} suppliers={suppliers} />;
    } else if (open) {
        key = 'detail-' + open;
        screen = <Detail items={mine} id={open} culture={openCulture}
            onBack={() => { setDir('back'); setOpen(null); }}
            onOpen={openItemById} addChild={addChild} drawSyringes={drawSyringes} saveStatus={saveStatus}
            saveNote={saveNote} saveHarvest={saveHarvest} deleteEvent={deleteEvent} deleteHarvest={deleteHarvest}
            editEvent={editEvent} editHarvest={editHarvest} saveItemFields={saveItemFields}
            deleteItem={deleteItem} reparentItem={reparentItem} stock={stock} library={library} suppliers={suppliers}
            onGetOrCreateSupplier={getOrCreateSupplier}
            photos={photos} photoUrl={photoUrl} addPhoto={addPhoto} deletePhoto={deletePhoto} editPhoto={editPhoto}
            onPrintLabel={() => setPrinting({ kind: 'item', ids: [open] })}
            onQueueLabel={() => addToPrintQueue('item', open)} unitsPref={profile?.units_pref ?? 'adaptive'} dateFormat={dateFormat} />;
    } else if (nav.level === 'tree') {
        key = 'tree-' + nav.speciesId;
        screen = <Tree items={mine} lines={lines} species={sp} library={library} librarySpecies={librarySpecies} onOpen={openItemById} photos={photos} stock={stock}
            suppliers={suppliers} onGetOrCreateSupplier={getOrCreateSupplier}
            photoUrl={photoUrl} onDeletePhoto={deletePhoto} onEditPhoto={editPhoto}
            onPrintLabels={(ids) => setPrinting({ kind: 'item', ids })}
            onQueueLabels={(ids) => addToPrintQueue('item', ids)}
            onAddLine={(fields, firstType, stockId) => addGenetics(nav.speciesId, fields, firstType, stockId)}
            onEditLine={saveGeneticsFields} onDeleteLine={deleteGenetics} onToggleLineHidden={toggleGeneticsHidden}
            onEditSpecies={saveSpeciesFields} onToggleHidden={toggleSpeciesHidden} onDeleteSpecies={deleteSpecies}
            onBack={() => go({ level: 'species', speciesId: null }, 'back')} unitsPref={profile?.units_pref ?? 'adaptive'} dateFormat={dateFormat} />;
    } else {
        key = 'species';
        screen = <SpeciesGrid species={species} genetics={genetics} items={items}
            onAdd={addSpecies} onToggleHidden={toggleSpeciesHidden}
            onOpen={(id) => go({ level: 'tree', speciesId: id })} />;
    }

    /* Renamed 2026-09-17 per Matt - "Cultures" read as a weird catch-all
       word, "Inventory" was already flagged (2026-08-31 changelog) as
       colliding with Stock/Supplies, and Reference's own page has always
       been titled "Library" - the tab label just never matched it.
       Internal section keys ('cultures'/'inventory'/'reference') are left
       untouched (labels only) to avoid touching profiles.default_section,
       every setSection() call, and the search-destination handlers. */
    const NAV = [
        ['cultures', 'Cultivation', SECTION_ICONS.cultures],
        ['inventory', 'Harvests', SECTION_ICONS.inventory],
        ['supplies', 'Supplies', SECTION_ICONS.supplies],
        ['reference', 'Library', SECTION_ICONS.reference],
        ['data', 'Data', SECTION_ICONS.data],
    ];

    /* Search used to be its own nav tab; now it's a persistent dropdown
       pinned in the sidebar/mobile header (see SearchBox) instead of
       eating a bottom-tab-bar slot - same destinations as before, just
       reached from a live dropdown instead of a results page. */
    /* Every destination below closes Account/Settings first - those are
       overlays checked ahead of `section` in the render switch (see
       above), so without this a search click while either was open
       looked like it did nothing. onOpenItem also has to point `nav` at
       the item's own species, not just set `open` - Detail is rendered
       with `items={mine}`, which is filtered by nav.speciesId, so
       leaving nav on whatever species (or none) was showing before
       produced a detail page with no matching item in its list, which
       blew up white (2026-09-17, search-dropdown fixes). */

    return (
        <div className="root">
            <style>{CSS}</style>
            <div className="mobile-brand">
                <div className="mobile-brand-top" onClick={goHome} role="button" tabIndex={0} style={{ cursor: 'pointer' }}>
                    <img src={`${import.meta.env.BASE_URL}sporedesk-header-logo-light.webp`} alt="SporeDesk" className="brand-logo" />
                    <div className="mobile-brand-icons" onClick={(e) => e.stopPropagation()}>
                    <button className="mb-icon" aria-label="Account"
                        onClick={() => { setPrinting(null); setSettingsOpen(false); setAccountOpen(true); }}>
                        <AvatarBadge url={profile?.avatar_url ? avatarUrl : null} preset={profile?.avatar_preset} size={19} />
                    </button>
                    <button className="mb-icon" aria-label="Settings"
                        onClick={() => { setPrinting(null); setAccountOpen(false); setSettingsOpen(true); }}>
                        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="3" />
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                        </svg>
                    </button>
                    </div>
                </div>
                <div className="mobile-search"><SearchBox {...searchProps} /></div>
            </div>
            <div className={key === 'home' ? 'shell shell-home' : 'shell'}>
                {key !== 'home' && (
                <nav className="side">
                    <div className="brand" onClick={goHome} role="button" tabIndex={0} style={{ cursor: 'pointer' }}><img src={`${import.meta.env.BASE_URL}sporedesk-header-logo-dark.webp`} alt="SporeDesk" className="brand-logo" /></div>
                    <div className="side-search">
                        <SearchBox {...searchProps} />
                        <PrintQueueButton count={printQueue.length} onOpen={() => setPrinting({ kind: 'queue' })} />
                    </div>
                    {NAV.map(([k, label, d]) => (
                        <button key={k} className={`nav-item ${!accountOpen && !settingsOpen && section === k ? 'on' : ''}`}
                            onClick={() => goSection(k)}>
                            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
                            <span>{label}</span>
                        </button>
                    ))}
                    <div className="side-bottom">
                        <button className={`nav-item ${accountOpen ? 'on' : ''}`}
                            onClick={() => { setPrinting(null); setSettingsOpen(false); setAccountOpen(true); }}>
                            <AvatarBadge url={profile?.avatar_url ? avatarUrl : null} preset={profile?.avatar_preset} size={17} />
                            <span>Account</span>
                        </button>
                        <button className={`nav-item ${settingsOpen ? 'on' : ''}`}
                            onClick={() => { setPrinting(null); setAccountOpen(false); setSettingsOpen(true); }}>
                            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="3" />
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                            </svg>
                            <span>Settings</span>
                        </button>
                    </div>
                </nav>
                )}
                <main className="main">
                    <div key={key} className={dir === 'fwd' ? 'screen-in' : 'screen-back'}>{screen}</div>
                </main>
            </div>
        </div>
    );
}

/* ---------------- ACCOUNT ---------------- */

/* Simple procedural mushroom glyphs, distinguished by cap/stem color only -
   not real illustrated art. Matt's logo redesign is already its own
   separate future thread; treat these the same way if/when real avatar
   art gets commissioned. */
const AVATAR_PRESETS = [
    { id: 'amanita', cap: '#D6934A', stem: '#EDE3D0' },
    { id: 'oyster', cap: '#7FA66A', stem: '#EDE3D0' },
    { id: 'lions-mane', cap: '#EDE3D0', stem: '#D6934A' },
    { id: 'shiitake', cap: '#8C3B26', stem: '#5E4C36' },
    { id: 'reishi', cap: '#6B2717', stem: '#A6927A' },
    { id: 'morel', cap: '#7A6552', stem: '#4A3826' },
];

function AvatarIcon({ preset, size = 22 }) {
    const p = AVATAR_PRESETS.find((a) => a.id === preset) ?? AVATAR_PRESETS[0];
    return (
        <svg viewBox="0 0 24 24" width={size} height={size}>
            <path d="M4 12c0-4.4 3.6-8 8-8s8 3.6 8 8c0 1.1-3.6 2-8 2s-8-.9-8-2z" fill={p.cap} />
            <rect x="10" y="12" width="4" height="9" rx="2" fill={p.stem} />
        </svg>
    );
}

/* Single place every avatar-displaying spot goes through: an uploaded
   photo (once its signed URL has resolved) wins over the preset glyph,
   never both at once - matches how saving in AccountPanel treats the
   two as mutually exclusive. */
function AvatarBadge({ url, preset, size = 22 }) {
    if (url) {
        return <img src={url} alt="" width={size} height={size}
            style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block' }} />;
    }
    return <AvatarIcon preset={preset} size={size} />;
}

function AccountPanel({ profile, avatarUrl, onSave, onBack }) {
    const [name, setName] = useState(profile?.display_name ?? '');
    const [avatarPreset, setAvatarPreset] = useState(profile?.avatar_preset ?? AVATAR_PRESETS[0].id);
    /* Mirrors profile.avatar_url so the picker (and saveBasics below) has
       a single source of truth for "is a photo currently active" that
       updates the instant uploadPhoto succeeds, without waiting on a
       parent re-render. Previously saveBasics always sent avatar_url:
       null regardless of what was actually set - meant saving a plain
       display-name edit after uploading a photo silently deleted the
       photo reference. */
    const [avatarUrlLocal, setAvatarUrlLocal] = useState(profile?.avatar_url ?? null);
    const [visibility, setVisibility] = useState(profile?.visibility ?? 'private');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState('');

    const [pw1, setPw1] = useState('');
    const [pw2, setPw2] = useState('');
    const [pwMsg, setPwMsg] = useState('');

    const [deleteText, setDeleteText] = useState('');

    if (!profile) return <div className="page"><div className="page-head"><button className="back-link" onClick={onBack}>&larr; Back</button><h1>Account</h1></div></div>;

    const saveBasics = async () => {
        setBusy(true); setMsg('');
        await onSave({
            display_name: name.trim() || null,
            avatar_preset: avatarUrlLocal ? null : avatarPreset,
            avatar_url: avatarUrlLocal,
            visibility,
        });
        setBusy(false); setMsg('Saved.');
        setTimeout(() => setMsg(''), 2000);
    };

    const changePassword = async () => {
        setPwMsg('');
        if (pw1.length < 6) { setPwMsg("Password needs to be at least 6 characters."); return; }
        if (pw1 !== pw2) { setPwMsg("Passwords don't match."); return; }
        const { error } = await supabase.auth.updateUser({ password: pw1 });
        if (error) { setPwMsg(error.message); return; }
        setPw1(''); setPw2(''); setPwMsg('Password updated.');
        setTimeout(() => setPwMsg(''), 2500);
    };

    const uploadPhoto = async (file) => {
        setBusy(true); setMsg('');
        /* Avatars only ever render small: one clean ~512px JPEG, no
           metadata. Falls back to the raw file if it can't be decoded. */
        let body = file, ext = file.name.split('.').pop() || 'jpg';
        try { body = await processAvatarForUpload(file); ext = 'jpg'; }
        catch (e) { console.warn('Avatar processing failed, uploading as-is', e); }
        const path = `avatars/${profile.id}-${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage.from('photos')
            .upload(path, body, { upsert: true, cacheControl: CACHE_CONTROL, contentType: body.type || undefined });
        if (upErr) { console.error(upErr); setMsg('Could not upload - check console'); setBusy(false); return; }
        const oldPath = profile.avatar_url;
        const saved = await onSave({ avatar_url: path, avatar_preset: null });
        if (!saved) { supabase.storage.from('photos').remove([path]); setBusy(false); return; }
        if (oldPath && oldPath !== path) supabase.storage.from('photos').remove([oldPath]); // don't pile up old avatars
        setAvatarUrlLocal(path); setAvatarPreset(null);
        setBusy(false); setMsg('Saved.');
        setTimeout(() => setMsg(''), 2000);
    };

    return (
        <div className="page">
            <div className="page-head">
                <button className="back-link" onClick={onBack}>&larr; Back</button>
                <h1>Account</h1>
            </div>

            <div className="acct-card">
                <div className="acct-section-title">Profile</div>
                <label>Display name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What should SporeDesk call you?" />

                <label>Avatar</label>
                <div className="avatar-row">
                    {/* Live preview of whatever's currently active - a
                        preset swaps instantly (no async round trip), a
                        fresh upload catches up to its own signed URL a
                        moment after avatarUrlLocal matches the saved
                        profile.avatar_url (see App()'s avatarUrl effect). */}
                    <div className="avatar-preview">
                        {avatarUrlLocal && avatarUrlLocal === profile.avatar_url
                            ? <AvatarBadge url={avatarUrl} size={48} />
                            : <AvatarIcon preset={avatarPreset} size={48} />}
                    </div>
                    {AVATAR_PRESETS.map((p) => (
                        <button key={p.id} className={`avatar-pick ${avatarPreset === p.id && !avatarUrlLocal ? 'on' : ''}`}
                            onClick={() => { setAvatarPreset(p.id); setAvatarUrlLocal(null); }}>
                            <AvatarIcon preset={p.id} size={28} />
                        </button>
                    ))}
                    <label className="avatar-upload">
                        Upload photo
                        <input type="file" accept="image/*" style={{ display: 'none' }}
                            onChange={(e) => e.target.files[0] && uploadPhoto(e.target.files[0])} />
                    </label>
                </div>
                {avatarUrlLocal && <div className="acct-hint">Using your uploaded photo - pick a mushroom above to switch back.</div>}

                <label>Visibility (placeholder)</label>
                <div className="seg">
                    <button className={visibility === 'private' ? 'on' : ''} onClick={() => setVisibility('private')}>Private</button>
                    <button className={visibility === 'shared' ? 'on' : ''} onClick={() => setVisibility('shared')}>Shared</button>
                </div>
                <div className="acct-hint">Doesn't gate anything yet - there's no shared-reference system built to control. Wires up once multi-user accounts exist.</div>

                <button className="btn-primary" disabled={busy} onClick={saveBasics}>{busy ? 'Saving…' : 'Save'}</button>
                {msg && <div className="acct-msg">{msg}</div>}
            </div>

            <div className="acct-card">
                <div className="acct-section-title">Password</div>
                <label>New password</label>
                <input type="password" value={pw1} onChange={(e) => setPw1(e.target.value)} minLength={6} />
                <label>Confirm new password</label>
                <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} minLength={6} />
                <button className="btn-primary" onClick={changePassword}>Update password</button>
                {pwMsg && <div className="acct-msg">{pwMsg}</div>}
            </div>

            <div className="acct-card">
                {/* Was missing entirely until 2026-09-18 - Matt only noticed
                    because he'd been testing sign-up in an incognito window
                    (the one place you don't need to sign out of anything).
                    AuthGate's onAuthStateChange listener already reacts to
                    the session going null, so signOut() alone is enough -
                    it swaps straight back to the sign-in screen with no
                    extra state to manage here. */}
                <div className="acct-section-title">Sign out</div>
                <div className="acct-hint">Signs you out of SporeDesk on this device. You'll need your email and password to sign back in.</div>
                <button className="btn-primary" onClick={() => supabase.auth.signOut()}>Sign out</button>
            </div>

            <div className="acct-card acct-danger">
                <div className="acct-section-title">Delete account</div>
                <div className="acct-hint">
                    Not wired up yet, on purpose - there's only one account in the whole app right now and no
                    self-serve sign-up, so actually deleting it would lock you out with no way back in. Gets real
                    functionality once the multi-tenant account system is built. Type DELETE below to confirm you
                    understand this is currently a placeholder.
                </div>
                <input value={deleteText} onChange={(e) => setDeleteText(e.target.value)} placeholder="Type DELETE" />
                <button className="btn-danger" disabled={deleteText !== 'DELETE'}
                    onClick={() => alert("Account deletion isn't wired up yet - see the note above.")}>
                    Delete account
                </button>
            </div>

            <div className="acct-card">
                <div className="acct-section-title">Legal</div>
                <div className="acct-hint">Opens on sporedesk.com.</div>
                <a className="acct-link" href="https://sporedesk.com/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a>
                <a className="acct-link" href="https://sporedesk.com/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
            </div>
        </div>
    );
}

/* ---------------- SETTINGS ---------------- */

const SECTION_LABELS = {
    home: 'Home', cultures: 'Cultivation', inventory: 'Harvests', supplies: 'Supplies',
    reference: 'Library', data: 'Data',
};

/* Same path data the sidebar/mobile-bar NAV icons already use (hoisted
   here 2026-09-18 so Home's cards can reuse them instead of carrying a
   second copy that could drift) - Home has no icon of its own since it
   isn't a NAV entry. */
const SECTION_ICONS = {
    cultures: 'M4 14c3-6 6-8 8-8s5 2 8 8',
    inventory: 'M5 10h14l-1.4 8.6a2 2 0 0 1-2 1.7H8.4a2 2 0 0 1-2-1.7L5 10zM8 10V7a4 4 0 0 1 8 0v3',
    supplies: 'M4 8l8-4 8 4-8 4-8-4zM4 8v8l8 4 8-4V8M12 12v8',
    reference: 'M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z',
    data: 'M4 19V10M10 19V4M16 19v-7M4 19h16',
};

/* Home-only accent tones, deliberately restrained: reuses the same
   jade/amber/rust/clay/slate vocabulary STATUS already uses for live/
   success/fail/neutral elsewhere in the app, rather than inventing five
   arbitrary colors just for variety. Cultivation is jade (growth/live,
   same tone STATUS gives colonizing/colonized/fruiting); Harvests is
   amber (the actual payoff - also the app's general accent color);
   Supplies is slate (logistics, neutral); Library is amber-ink (a
   muted/quieter amber - reference material, calm rather than a second
   bright accent). Data has no fixed entry here - its color is computed
   from the success rate itself (jade/amber/rust) so it actually reports
   something instead of just decorating. */
const SECTION_ACCENTS = {
    cultures: 'var(--jade)', inventory: 'var(--amber)', supplies: 'var(--slate)', reference: 'var(--amber-ink)',
};

function SettingsPanel({ profile, onSave, onBack }) {
    const [defaultSection, setDefaultSection] = useState(profile?.default_section ?? 'cultures');
    const [unitsPref, setUnitsPref] = useState(profile?.units_pref ?? 'adaptive');
    const [dateFormat, setDateFormat] = useState(profile?.date_format ?? 'MDY');
    const [msg, setMsg] = useState('');
    const [eraseText, setEraseText] = useState('');

    if (!profile) return <div className="page"><div className="page-head"><button className="back-link" onClick={onBack}>&larr; Back</button><h1>Settings</h1></div></div>;

    const save = async (fields) => {
        setMsg('');
        await onSave(fields);
        setMsg('Saved.');
        setTimeout(() => setMsg(''), 2000);
    };

    return (
        <div className="page">
            <div className="page-head">
                <button className="back-link" onClick={onBack}>&larr; Back</button>
                <h1>Settings</h1>
            </div>

            <div className="acct-card">
                <div className="acct-section-title">Default landing tab</div>
                <div className="acct-hint">Which screen SporeDesk opens to.</div>
                <select value={defaultSection}
                    onChange={(e) => { setDefaultSection(e.target.value); save({ default_section: e.target.value }); }}>
                    {Object.entries(SECTION_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
            </div>

            <div className="acct-card">
                <div className="acct-section-title">Units</div>
                <div className="acct-hint">
                    Applies to weight/volume amounts in Items, Stock, and Recipe ingredients (including a recipe's
                    batch-size field). Metric shows those in g/mL, Imperial in oz/fl oz - new entries there now
                    pick from a unit dropdown instead of free text, and old values convert on display. Adaptive
                    shows everything exactly as it was recorded, no conversion. Species cheat-sheet temperature
                    fields are free-text notes, not structured data, so under Metric they're left exactly as
                    written with a (°C) equivalent appended after each °F reading instead of being rewritten -
                    everything else on the cheat sheet (humidity, FAE, timing, substrate) is untouched. Inventory
                    (harvest weights) is also left out - grams-only there, no unit field exists.
                </div>
                <select value={unitsPref}
                    onChange={(e) => { setUnitsPref(e.target.value); save({ units_pref: e.target.value }); }}>
                    <option value="adaptive">Adaptive</option>
                    <option value="metric">Metric</option>
                    <option value="imperial">Imperial</option>
                </select>
            </div>

            <div className="acct-card">
                <div className="acct-section-title">Date format</div>
                <div className="acct-hint">Applies to every date shown across the app.</div>
                <select value={dateFormat}
                    onChange={(e) => { setDateFormat(e.target.value); save({ date_format: e.target.value }); }}>
                    <option value="MDY">MM/DD/YYYY</option>
                    <option value="DMY">DD/MM/YYYY</option>
                    <option value="YMD">YYYY-MM-DD</option>
                </select>
            </div>

            {msg && <div className="acct-msg">{msg}</div>}

            <div className="acct-card">
                <div className="acct-section-title">Shared references</div>
                <div className="acct-hint">Placeholder - visibility controls for shared/default library entries once the multi-tenant account system and shared-reference tiers exist.</div>
            </div>

            <div className="acct-card">
                <div className="acct-section-title">AI connector</div>
                <div className="acct-hint">Placeholder - settings for the read-and-summarize assistant connector once it's built.</div>
            </div>

            <div className="acct-card">
                <div className="acct-section-title">Notifications</div>
                <div className="acct-hint">Placeholder - no notification system exists yet.</div>
            </div>

            <div className="acct-card acct-danger">
                <div className="acct-section-title">Erase all content</div>
                <div className="acct-hint">
                    Wipes every grow, culture, stock unit, recipe, and photo - keeps your login. <strong>Not wired
                    up yet</strong> - this would delete real data across ten tables and deserves its own careful,
                    tested pass rather than being rushed in alongside everything else. Type ERASE below to confirm
                    you understand this is currently a placeholder.
                </div>
                <input value={eraseText} onChange={(e) => setEraseText(e.target.value)} placeholder="Type ERASE" />
                <button className="btn-danger" disabled={eraseText !== 'ERASE'}
                    onClick={() => alert("Erase-all-content isn't wired up yet - see the note above.")}>
                    Erase all content
                </button>
            </div>

            <div className="app-version">
                <img src={`${import.meta.env.BASE_URL}sporedesk-lockup-stacked-dark.webp`} alt="SporeDesk" className="app-version-mark" />
                <span>v{APP_VERSION}</span>
            </div>
        </div>
    );
}

/* ---------------- CALCULATORS ---------------- */

function CalcCard({ title, sub, children }) {
    return (
        <div className="calc-card">
            <div className="calc-head">
                <div className="calc-title">{title}</div>
                {sub && <div className="calc-sub">{sub}</div>}
            </div>
            <div className="calc-body">{children}</div>
        </div>
    );
}

function NumField({ label, value, onChange, placeholder, unit }) {
    return (
        <div className="calc-field">
            <label>{label}</label>
            <div className="calc-input-wrap">
                <input className="in" inputMode="decimal" value={value} placeholder={placeholder}
                    onChange={(e) => onChange(e.target.value)} />
                {unit && <span className="calc-unit">{unit}</span>}
            </div>
        </div>
    );
}

const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };

/* Species dropdowns exclude hidden species by default, but keep whatever
   is already selected visible even if it's since been hidden - otherwise
   opening a lot/stock unit/recipe already tagged to a since-hidden
   species would just show it blank instead of what's actually saved. */
const visibleSpeciesFor = (species, currentId) => species.filter((s) => !s.hidden || s.id === currentId);

function SpawnRatio() {
    const [grain, setGrain] = useState('');
    const [bulk, setBulk] = useState('');
    const [ratioTarget, setRatioTarget] = useState('5');
    const g = n(grain), b = n(bulk), rt = n(ratioTarget);

    /* Whichever field the person typed in most recently drives the other -
       so "I have 500g grain" and "I have 2500g substrate" both work. */
    const [lastEdited, setLastEdited] = useState(null);
    const ratio = g && b ? (b / g) : null;
    const impliedBulk = lastEdited === 'grain' && g && rt ? g * rt : null;
    const impliedGrain = lastEdited === 'bulk' && b && rt ? b / rt : null;

    return (
        <CalcCard title="Spawn ratio" sub="Grain to bulk substrate - works either direction">
            <NumField label="Grain (colonized spawn)" value={grain}
                onChange={(v) => { setGrain(v); setLastEdited('grain'); }} placeholder="e.g. 500" unit="g" />
            <NumField label="Bulk substrate" value={bulk}
                onChange={(v) => { setBulk(v); setLastEdited('bulk'); }} placeholder="e.g. 2500" unit="g" />

            {g && b ? (
                <div className="calc-result">
                    <strong>1 : {ratio.toFixed(1)}</strong>
                    <span>1 part grain to {ratio.toFixed(1)} parts bulk</span>
                </div>
            ) : (g || b) && (
                <>
                    <NumField label="Target ratio (parts bulk per part grain)" value={ratioTarget}
                        onChange={setRatioTarget} placeholder="5" unit="× grain" />
                    {impliedBulk && (
                        <div className="calc-result">
                            <strong>{impliedBulk.toFixed(0)} g substrate</strong>
                            <span>needed for {grain} g grain at 1:{ratioTarget}</span>
                        </div>
                    )}
                    {impliedGrain && (
                        <div className="calc-result">
                            <strong>{impliedGrain.toFixed(0)} g grain</strong>
                            <span>needed for {bulk} g substrate at 1:{ratioTarget}</span>
                        </div>
                    )}
                </>
            )}
            <p className="calc-note">
                Ratio is mostly about method, not species - how aggressive the culture is and how much
                colonization time you're willing to trade for less spawn. 1:3 to 1:5 is a common range;
                slower or less aggressive spawn does better closer to 1:3.
            </p>
        </CalcCard>
    );
}

function Hydration() {
    const [dry, setDry] = useState('');
    const [ratio, setRatio] = useState('1.65');
    const d = n(dry), r = n(ratio);
    const water = d && r ? d * r : null;

    return (
        <CalcCard title="Substrate hydration" sub="Broth or water needed for a dry substrate weight">
            <NumField label="Dry substrate weight" value={dry} onChange={setDry} placeholder="e.g. 200" unit="g" />
            <NumField label="Ratio (mL per g)" value={ratio} onChange={setRatio} placeholder="1.65" unit="mL/g" />
            {water && (
                <div className="calc-result">
                    <strong>{water.toFixed(0)} mL</strong>
                    <span>of broth or water</span>
                </div>
            )}
            <p className="calc-note">Default 1.65 mL/g matches the commonly-used Cordyceps militaris rice/broth ratio (North Spore's published jar tek runs ~1.64 mL/g). Change it for other substrates or teks.</p>
        </CalcCard>
    );
}

function BECalc() {
    const [wet, setWet] = useState('');
    const [dry, setDry] = useState('');
    const w = n(wet), d = n(dry);
    const be = w && d ? (w / d) * 100 : null;

    return (
        <CalcCard title="Biological efficiency (BE)" sub="How much you got out, relative to what you put in">
            <NumField label="Total wet harvest" value={wet} onChange={setWet} placeholder="e.g. 710.87" unit="g" />
            <NumField label="Dry substrate weight" value={dry} onChange={setDry} placeholder="e.g. 950" unit="g" />
            {be && (
                <div className="calc-result">
                    <strong>{be.toFixed(1)}%</strong>
                    <span>{be >= 100 ? 'Excellent - over 100% is a very good block' : be >= 50 ? 'Solid, typical range for oysters' : 'On the low side for most species'}</span>
                </div>
            )}
            <p className="calc-note">
                BE is wet harvest weight as a percentage of dry substrate weight. 100% means you harvested
                the same weight of mushrooms as the dry substrate you started with - genuinely good. Oysters
                often land 50-100%+; slower species like chestnut and shiitake usually run lower. It only
                means anything if the dry weight is real - an estimated dry weight gives an estimated BE.
            </p>
        </CalcCard>
    );
}

function DryYield({ species }) {
    const [wet, setWet] = useState('');
    const visible = species.filter((s) => !s.hidden);
    const [spId, setSpId] = useState(visible[0]?.id ?? '');
    const sp = visible.find((s) => s.id === spId) ?? visible[0];
    const w = n(wet);
    const hasRealPct = sp?.dry_yield_pct != null;
    const pct = hasRealPct ? Number(sp.dry_yield_pct) : 10;
    const dry = w ? w * (pct / 100) : null;

    if (visible.length === 0) {
        return (
            <CalcCard title="Dry yield estimate" sub="Roughly what a wet harvest will weigh once dried">
                <p className="nf-help">Add a species first - this estimates off each species' own logged dry-yield figure.</p>
            </CalcCard>
        );
    }

    return (
        <CalcCard title="Dry yield estimate" sub="Roughly what a wet harvest will weigh once dried">
            <NumField label="Wet harvest weight" value={wet} onChange={setWet} placeholder="e.g. 300" unit="g" />
            <div className="calc-field">
                <label>Species</label>
                <select className="in sel" value={spId || sp?.id} onChange={(e) => setSpId(e.target.value)}>
                    {visible.map((s) => <option key={s.id} value={s.id}>{s.common_name}{s.dry_yield_pct != null ? ` (~${s.dry_yield_pct}%)` : ''}</option>)}
                </select>
            </div>
            {dry && (
                <div className="calc-result">
                    <strong>~{dry.toFixed(0)} g dry</strong>
                    <span>at ~{pct}% {hasRealPct ? `logged for ${sp.common_name}` : '(general average, not species-specific)'}</span>
                </div>
            )}
            <p className="calc-note">
                {hasRealPct
                    ? `${sp.common_name}'s ${pct}% comes from its own Species page - update it any time you weigh a real dry run.`
                    : `No dry-yield figure logged for ${sp?.common_name ?? 'this species'} yet, so this uses a general 10% average across most gourmet species rather than guessing a species-specific number. Weigh a real dry run once and add it from the Species page for an actual figure.`}
            </p>
        </CalcCard>
    );
}

/* Lives inside an expanded recipe card. Owns its own target-amount state,
   defaulting to the recipe's stored batch size - scales every ingredient
   live as you type or tap a multiplier, no separate calculator needed. */
function RecipeIngredients({ recipe, unitsPref }) {
    /* recipe.yield_amount/yield_unit are the recipe's own native unit -
       dispYield is that same batch size shown in whatever unit the Units
       setting picks. The user types/taps into dispYield's unit, and we
       convert back to native before computing the scale factor, so the
       actual ingredient math always happens in the recipe's own unit
       regardless of display setting. */
    const dispYield = displayAmount(recipe.yield_amount, recipe.yield_unit, unitsPref);
    const [target, setTarget] = useState(dispYield.amount != null ? String(dispYield.amount) : '');
    const t = n(target);
    const nativeTarget = t != null ? convertUnits(t, dispYield.unit, recipe.yield_unit) : null;
    const factor = recipe.yield_amount && nativeTarget ? nativeTarget / recipe.yield_amount : null;

    return (
        <div className="recipe-scale">
            {recipe.yield_amount != null && (
                <div className="rs-row">
                    <span className="rs-label">Batch size</span>
                    <input className="in sm" inputMode="decimal" value={target}
                        onChange={(e) => setTarget(e.target.value)} />
                    <span className="rs-unit">{dispYield.unit}</span>
                    <div className="chips">
                        {[0.5, 2, 3, 5].map((m) => (
                            <button key={m} className="chip"
                                onClick={() => setTarget(String(round2(dispYield.amount * m)))}>×{m}</button>
                        ))}
                    </div>
                </div>
            )}
            <table className="ing-table">
                <tbody>
                    {recipe.ingredients.map((row, i) => {
                        const amt = n(row.amount);
                        const scaled = amt != null && factor ? amt * factor : amt;
                        const conv = displayAmount(scaled, row.unit, unitsPref);
                        return (
                            <tr key={i}>
                                <td className="ing-amt">
                                    {conv.amount != null ? (conv.amount % 1 === 0 ? conv.amount : conv.amount.toFixed(2)) : row.amount}{conv.unit}
                                </td>
                                <td>{row.name}</td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

/* Capsule blends scale differently from lab media: the per-capsule dose is
   FIXED regardless of batch size (a capsule holds what it holds) - what
   scales is the total weight to weigh out, driven by capsule count and a
   spillage buffer. Genuinely different math from RecipeIngredients above,
   not a variant of it. */
function CapsuleBlendCard({ recipe, species }) {
    const [count, setCount] = useState(recipe.yield_amount != null ? String(recipe.yield_amount) : '');
    const c = n(count);
    const buffer = n(recipe.buffer_pct) || 0;
    const multiplier = c ? c * (1 + buffer / 100) : null;
    const totalPerCapsule = recipe.ingredients.reduce((s, r) => s + (n(r.mg) || 0), 0);

    return (
        <div className="recipe-scale">
            <div className="rs-row">
                <span className="rs-label">Capsule count</span>
                <input className="in sm" inputMode="numeric" value={count}
                    onChange={(e) => setCount(e.target.value)} />
                {buffer > 0 && <span className="rs-unit">+{buffer}% buffer</span>}
                <div className="chips">
                    {[100, 200, 300].map((m) => (
                        <button key={m} className="chip" onClick={() => setCount(String(m))}>{m}</button>
                    ))}
                </div>
            </div>
            <table className="ing-table">
                <thead>
                    <tr><th></th><th>mg / capsule</th><th>total to weigh</th></tr>
                </thead>
                <tbody>
                    {recipe.ingredients.map((row, i) => {
                        const sp = species.find((s) => s.id === row.species_id);
                        const mg = n(row.mg);
                        const totalMg = mg != null && multiplier ? mg * multiplier : null;
                        const totalG = totalMg != null ? totalMg / 1000 : null;
                        return (
                            <tr key={i}>
                                <td>{sp?.common_name ?? 'Unknown species'}</td>
                                <td className="ing-amt">{mg}mg</td>
                                <td className="ing-amt">{totalG != null ? (totalG % 1 === 0 ? totalG : totalG.toFixed(2)) : '—'}g</td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            <p className={`calc-note ${totalPerCapsule > 500 ? 'over-limit' : ''}`} style={{ marginTop: 8 }}>
                {totalPerCapsule}mg per capsule{totalPerCapsule > 500 ? ' — over a standard 500mg 00 capsule fill' : ' — fits a standard 500mg 00 capsule'}
            </p>
        </div>
    );
}

/* Straight mass/volume conversions are exact. Grain-by-volume is not a real
   unit - it's mass divided by an approximate density, so it's kept separate
   and clearly labeled as approximate rather than folded into the same table. */
const MASS = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
const VOLUME = { mL: 1, L: 1000, tsp: 4.92892, tbsp: 14.7868, cup: 236.588, 'fl oz': 29.5735, qt: 946.353 };

/* Historic amount_unit/amountUnit values were free-typed, so real data has
   casing/pluralization/typo drift (LBS, Lb, cc, ;bs, ...). This maps whatever
   we find to a canonical MASS/VOLUME key; anything unrecognized returns null
   and the caller falls back to showing the value unconverted rather than
   guessing. cc is treated as an exact alias for mL (both are 1cm^3). */
const UNIT_ALIASES = {
    g: 'g', gram: 'g', grams: 'g',
    kg: 'kg', kilogram: 'kg', kilograms: 'kg',
    oz: 'oz', ounce: 'oz', ounces: 'oz',
    lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
    ml: 'mL', milliliter: 'mL', milliliters: 'mL', cc: 'mL',
    l: 'L', liter: 'L', liters: 'L',
    tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
    tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
    cup: 'cup', cups: 'cup',
    'fl oz': 'fl oz', floz: 'fl oz', 'fl. oz': 'fl oz',
    qt: 'qt', quart: 'qt', quarts: 'qt',
};

function normalizeUnit(raw) {
    if (!raw) return null;
    const key = String(raw).trim().toLowerCase().replace(/\.$/, '');
    return UNIT_ALIASES[key] ?? null;
}

function unitTableFor(unit) {
    if (unit in MASS) return MASS;
    if (unit in VOLUME) return VOLUME;
    return null;
}

const round2 = (x) => Math.round(x * 100) / 100;

/* Direct unit-to-unit conversion (not tied to the Metric/Imperial setting) -
   used where a user-typed number needs converting back to whatever unit the
   underlying data is actually stored/calculated in. Same graceful fallback
   as everywhere else: unrecognized or cross-system (mass vs volume) pairs
   just return the amount unconverted rather than guessing. */
function convertUnits(amount, fromUnit, toUnit) {
    if (amount == null || !fromUnit || !toUnit || fromUnit === toUnit) return amount;
    const fu = normalizeUnit(fromUnit), tu = normalizeUnit(toUnit);
    if (!fu || !tu) return amount;
    const table = unitTableFor(fu);
    if (!table || !(tu in table)) return amount;
    return (amount * table[fu]) / table[tu];
}

/* Converts amount+unit for display per the Metric/Imperial/Adaptive setting.
   Adaptive means "show it the way it was recorded" - no conversion at all.
   Anything we can't confidently recognize is also shown unconverted, same
   as the cheat-sheet/reference free text - never guess-convert real data. */
function displayAmount(amount, rawUnit, unitsPref) {
    const fallback = { amount, unit: rawUnit || '' };
    if (amount == null || !unitsPref || unitsPref === 'adaptive') return fallback;
    const unit = normalizeUnit(rawUnit);
    if (!unit) return fallback;
    const table = unitTableFor(unit);
    if (!table) return fallback;
    const target = unitsPref === 'metric'
        ? (table === MASS ? 'g' : 'mL')
        : (table === MASS ? 'oz' : 'fl oz');
    if (unit === target) return { amount, unit };
    return { amount: round2((amount * table[unit]) / table[target]), unit: target };
}

function fmtAmount(amount, rawUnit, unitsPref) {
    if (amount == null) return '';
    const { amount: a, unit: u } = displayAmount(amount, rawUnit, unitsPref);
    return `${a}${u ? ' ' + u : ''}`;
}

const fToC = (f) => Math.round(((f - 32) * 5) / 9);

/* Species cheat-sheet temp fields (fruiting_temp/colonize_temp) are free-text
   prose, not structured data - checked against every real row before writing
   this (see backlog). Rather than rewriting that prose, this ANNOTATES it:
   finds the dominant "NN-NNF" / "NN°F" shapes and appends a (°C) equivalent
   right after each one, leaving the original text completely untouched.
   Anything that doesn't match plainly (a bare "68-75" with no F, an odd
   phrasing) is left exactly as written - same fallback principle as the
   rest of the units work, never guess-convert real data. Only runs under
   Metric; Imperial and Adaptive show the text exactly as recorded. */
const TEMP_RE = /(-?\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(-?\d+(?:\.\d+)?)\s*°?F\b|(-?\d+(?:\.\d+)?)\s*°?F\b/gi;
function displayTempText(text, unitsPref) {
    if (!text) return text ?? '';
    if (unitsPref !== 'metric') return text;
    return text.replace(TEMP_RE, (m, lo, hi, single) => {
        if (lo != null && hi != null) return `${m} (${fToC(Number(lo))}–${fToC(Number(hi))}°C)`;
        return `${m} (${fToC(Number(single))}°C)`;
    });
}

/* Dropdown replacement for what used to be a free-text unit field, so new
   data comes in clean. Shows whatever raw value is already stored (even if
   it's an old messy one) as a plain option so it doesn't look blank/wrong
   until the user actually changes it. */
function UnitSelect({ value, onChange, className }) {
    const known = normalizeUnit(value);
    return (
        <select className={className ?? "in sel"} value={known ?? value ?? ''} onChange={(e) => onChange(e.target.value)}>
            <option value="">unit…</option>
            {!known && value && <option value={value}>{value}</option>}
            <optgroup label="Mass">
                {Object.keys(MASS).map((u) => <option key={u} value={u}>{u}</option>)}
            </optgroup>
            <optgroup label="Volume">
                {Object.keys(VOLUME).map((u) => <option key={u} value={u}>{u}</option>)}
            </optgroup>
        </select>
    );
}
const GRAIN_DENSITY = {
    'Rye berries (dry)': 0.78, 'Millet (dry)': 0.72, 'Wild bird seed / milo (dry)': 0.75,
    'Popcorn (dry)': 0.72, 'Brown rice (dry)': 0.80,
};

function UnitConverter() {
    const [kind, setKind] = useState('mass');
    const [val, setVal] = useState('');
    const [from, setFrom] = useState('g');
    const [to, setTo] = useState('oz');
    const table = kind === 'mass' ? MASS : VOLUME;
    const v = n(val);
    const result = v ? (v * table[from]) / table[to] : null;

    return (
        <CalcCard title="Unit converter" sub="Mass and volume, exact conversions">
            <div className="calc-field">
                <label>Type</label>
                <select className="in sel" value={kind} onChange={(e) => { setKind(e.target.value); setFrom(e.target.value === 'mass' ? 'g' : 'mL'); setTo(e.target.value === 'mass' ? 'oz' : 'cup'); }}>
                    <option value="mass">Mass (weight)</option>
                    <option value="volume">Volume</option>
                </select>
            </div>
            <NumField label="Amount" value={val} onChange={setVal} placeholder="e.g. 100" />
            <div className="calc-row2">
                <div className="calc-field">
                    <label>From</label>
                    <select className="in sel" value={from} onChange={(e) => setFrom(e.target.value)}>
                        {Object.keys(table).map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                </div>
                <div className="calc-field">
                    <label>To</label>
                    <select className="in sel" value={to} onChange={(e) => setTo(e.target.value)}>
                        {Object.keys(table).map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                </div>
            </div>
            {result !== null && (
                <div className="calc-result">
                    <strong>{result < 1 ? result.toFixed(3) : result.toFixed(2)} {to}</strong>
                    <span>{val} {from} exactly</span>
                </div>
            )}
        </CalcCard>
    );
}

function GrainVolume() {
    const [amount, setAmount] = useState('');
    const [dir, setDir] = useState('massToVol');   // massToVol | volToMass
    const [grain, setGrain] = useState('Rye berries (dry)');
    const [massUnit, setMassUnit] = useState('g');
    const [volUnit, setVolUnit] = useState('cup');
    const a = n(amount);
    const density = GRAIN_DENSITY[grain];   // g per mL

    let result = null;
    if (a && dir === 'massToVol') {
        const grams = a * MASS[massUnit];
        const mL = grams / density;
        result = { val: mL / VOLUME[volUnit], unit: volUnit };
    } else if (a && dir === 'volToMass') {
        const mL = a * VOLUME[volUnit];
        const grams = mL * density;
        result = { val: grams / MASS[massUnit], unit: massUnit };
    }

    return (
        <CalcCard title="Grain: weight ↔ volume" sub="Approximate - grain density varies by moisture and how packed it is">
            <div className="calc-field">
                <label>Grain type</label>
                <select className="in sel" value={grain} onChange={(e) => setGrain(e.target.value)}>
                    {Object.keys(GRAIN_DENSITY).map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
            </div>
            <div className="calc-field">
                <label>Direction</label>
                <select className="in sel" value={dir} onChange={(e) => setDir(e.target.value)}>
                    <option value="massToVol">I know the weight, want volume</option>
                    <option value="volToMass">I know the volume, want weight</option>
                </select>
            </div>
            {dir === 'massToVol' ? (
                <div className="calc-row2">
                    <NumField label="Weight" value={amount} onChange={setAmount} placeholder="e.g. 500" />
                    <div className="calc-field"><label>Unit</label>
                        <select className="in sel" value={massUnit} onChange={(e) => setMassUnit(e.target.value)}>
                            {Object.keys(MASS).map((u) => <option key={u} value={u}>{u}</option>)}
                        </select></div>
                </div>
            ) : (
                <div className="calc-row2">
                    <NumField label="Volume" value={amount} onChange={setAmount} placeholder="e.g. 2" />
                    <div className="calc-field"><label>Unit</label>
                        <select className="in sel" value={volUnit} onChange={(e) => setVolUnit(e.target.value)}>
                            {Object.keys(VOLUME).map((u) => <option key={u} value={u}>{u}</option>)}
                        </select></div>
                </div>
            )}
            {dir === 'massToVol' && (
                <div className="calc-field"><label>Show volume as</label>
                    <select className="in sel" value={volUnit} onChange={(e) => setVolUnit(e.target.value)}>
                        {Object.keys(VOLUME).map((u) => <option key={u} value={u}>{u}</option>)}
                    </select></div>
            )}
            {dir === 'volToMass' && (
                <div className="calc-field"><label>Show weight as</label>
                    <select className="in sel" value={massUnit} onChange={(e) => setMassUnit(e.target.value)}>
                        {Object.keys(MASS).map((u) => <option key={u} value={u}>{u}</option>)}
                    </select></div>
            )}
            {result && (
                <div className="calc-result">
                    <strong>≈ {result.val.toFixed(2)} {result.unit}</strong>
                    <span>using {density} g/mL for {grain.toLowerCase()}</span>
                </div>
            )}
            <p className="calc-note">
                Approximate on purpose - grain volume depends on moisture and how settled it is in the
                container. Fine for "how big a jar do I need," not precise enough for a recipe ratio.
            </p>
        </CalcCard>
    );
}

function Calculators({ species, embedded = false }) {
    const grid = (
        <div className="calc-grid">
            <SpawnRatio />
            <Hydration />
            <BECalc />
            <DryYield species={species} />
            <UnitConverter />
            <GrainVolume />
        </div>
    );
    if (embedded) return grid;
    return (
        <div className="page">
            <div className="bar">
                <div>
                    <div className="eyebrow">Numbers you'd otherwise do in your head</div>
                    <h1>Calculators</h1>
                </div>
            </div>
            {grid}
        </div>
    );
}

/* ---------------- INVENTORY ---------------- */

const LOT_FORMS = {
    wet: 'Wet', dried: 'Dried', powder: 'Powder', tincture: 'Tincture',
    capsules: 'Capsules', extract: 'Extract', other: 'Other',
};

/* Below this many grams, a lot reads as "used up." Comfortably bigger than a
   rounding slip (174.1 entered instead of 174.11) but far too small to hide
   a real remainder. */
const LOT_EPS = 0.05;

/* One decimal for weight display everywhere - two only for extracts, where
   a tenth of a gram in a tincture actually changes the dose. Trims to a
   whole number when there's nothing after the decimal, and rounds both
   sides of a "remaining / started with" pair the same way so they can't
   read as remaining > original from formatting alone. */
const fmtG = (n, form) => {
    const num = Number(n);
    if (!Number.isFinite(num)) return n;
    return num % 1 === 0 ? String(num) : num.toFixed(form === 'extract' ? 2 : 1);
};

/* Traces a lot's genetics upward through the merge graph and returns the
   set of species involved - a raw harvest has one, a blend can have several. */
function lotSpeciesNames(lotId, lots, lotLinks, items, genetics, species, seen = new Set()) {
    if (seen.has(lotId)) return [];
    seen.add(lotId);
    const lot = lots.find((l) => l.id === lotId);
    if (!lot) return [];
    if (lot.source_item_id) {
        const item = items.find((i) => i.uid === lot.source_item_id);
        const gen = genetics.find((g) => g.id === item?.geneticsId);
        const sp = species.find((s) => s.id === gen?.species_id);
        return sp ? [sp.common_name] : [];
    }
    if (lot.species_id) {
        const sp = species.find((s) => s.id === lot.species_id);
        if (sp) return [sp.common_name];
    }
    const parents = lotLinks.filter((k) => k.child_lot_id === lotId);
    const names = new Set();
    parents.forEach((p) => lotSpeciesNames(p.parent_lot_id, lots, lotLinks, items, genetics, species, seen).forEach((n) => names.add(n)));
    return [...names];
}

function LotCard({ lot, rem, sp, onOpen, onPrintLot, onQueueLot, dateFormat }) {
    const pct = lot.amount_g ? (rem / lot.amount_g) * 100 : 0;
    const used = rem <= LOT_EPS;
    return (
        <div className={`lot-card ${used ? 'used' : ''}`} role="button" tabIndex={0}
            onClick={() => onOpen(lot.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(lot.id); } }}>
            <div className="lot-top">
                <span className={`pill tone-${used ? 'slate' : 'amber'}`}>{LOT_FORMS[lot.form] ?? lot.form}</span>
                <span className="lot-sp">{sp.length ? sp.join(' + ') : 'unknown origin'}</span>
            </div>
            <div className="lot-label">{lot.label || 'Untitled lot'}</div>
            <div className="lot-amt">
                <strong>{fmtG(rem, lot.form)} g</strong>
                <span> / {fmtG(lot.amount_g, lot.form)} g</span>
            </div>
            {!used && <div className="lot-bar"><div className="lot-bar-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>}
            {lot.harvested_on && <div className="lot-date">{fmt(lot.harvested_on, dateFormat)}</div>}
            {/* Own click handler stops propagation so tapping Print/Queue
                doesn't also fire the card's onOpen underneath it - see the
                2026-09-22 layout-bug note on .pl-icon-row for why this
                pair always lives in its own wrapper rather than as loose
                siblings. */}
            <div className="pl-icon-row" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="pl-icon-btn pl-trigger" title="Print a QR sticker for this lot"
                    onClick={() => onPrintLot(lot.id)}><PrinterIcon /></button>
                <button type="button" className="pl-icon-btn pl-queue" title="Add to the print queue instead - print it later alongside other labels"
                    onClick={() => onQueueLot(lot.id)}><PrinterQueueIcon /></button>
            </div>
        </div>
    );
}

/* ---------------- SEARCH ---------------- */
/* Everything lives in state already (loaded whole on login, no pagination -
   see the data-loading effect near the top of App()), so a global search is
   just a client-side scan across every array, no extra query needed.
   Lives as a live dropdown pinned in the sidebar (desktop) / top brand bar
   (mobile) rather than its own nav tab - see SearchBox below - so it's
   always reachable without spending a slot in the already-crowded bottom
   tab bar (2026-09-17, tab rebalance). */
const SEARCH_MIN = 1;

const norm = (s) => (s ?? '').toString().toLowerCase();

/* Checks a record's fields in order and returns the first one that
   contains the query, plus a short surrounding snippet - so a result says
   *why* it matched (e.g. "matched: Notes") instead of just showing up. */
function firstMatch(fields, nq) {
    for (const [label, raw] of fields) {
        if (raw === undefined || raw === null || raw === '') continue;
        const val = raw.toString();
        const idx = norm(val).indexOf(nq);
        if (idx === -1) continue;
        const start = Math.max(0, idx - 24);
        const end = Math.min(val.length, idx + nq.length + 40);
        const snippet = (start > 0 ? '…' : '') + val.slice(start, end).trim() + (end < val.length ? '…' : '');
        return { label, snippet };
    }
    return null;
}

/* Groups over this many hits get truncated in the dropdown, with a
   "show N more" button to expand - a phone hunting for one Library
   recipe shouldn't have to scroll past a wall of Cultivation items
   first just because the species name also matched (2026-09-17). */
const SEARCH_GROUP_CAP = 5;

/* Small persistent entry point into the cross-screen print queue (see
   printQueue/addToPrintQueue near the top of App) - sits next to
   SearchBox wherever it renders on desktop (.side-search, .home-search).
   Deliberately NOT placed in .mobile-search - printing is desktop-only
   for now (see .pl-trigger/.pl-queue), so surfacing this on mobile would
   just be a dead end. Renders nothing once the queue is empty rather
   than sitting there dimmed. */
/* Printer icon for the compact icon-only Print/Queue button pairs on
   Detail, Tree, and Stock (see .pl-icon-btn below) - Matt's ask
   2026-09-22 after the text-label versions kept colliding on the Stock
   screen (see the .stock-batch-head fix). Same glyph as PrintQueueButton's
   own badge icon. */
function PrinterIcon({ size = 15 }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 6 2 18 2 18 9" />
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
            <rect x="6" y="14" width="12" height="8" />
        </svg>
    );
}

/* Queue variant - the exact same PrinterIcon (same size, same color, so
   the two buttons read as a matched pair) with a small "+" badge
   overlaid on its corner, rather than trying to cram a second printer
   glyph and a plus into one squeezed 24x24 viewBox. That combined-glyph
   version (2026-09-22's first pass) came out "wonky" per Matt and its
   color didn't match the plain Print icon - this is the redo: identical
   printer icon underneath, a small filled circle badge (cut into the
   page with its own background so it reads as sitting ON the icon, not
   just overlapping it) with a plus mark, the standard "add a variant of
   this" pattern. */
function PrinterQueueIcon({ size = 15 }) {
    const badge = Math.round(size * 0.62);
    return (
        <span className="pl-icon-badge-wrap">
            <PrinterIcon size={size} />
            <svg className="pl-icon-badge" viewBox="0 0 24 24" width={badge} height={badge}>
                <circle cx="12" cy="12" r="11" className="pl-icon-badge-bg" stroke="currentColor" strokeWidth="2" />
                <path d="M12 6v12M6 12h12" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
            </svg>
        </span>
    );
}

function PrintQueueButton({ count, onOpen, className }) {
    if (!count) return null;
    return (
        <button type="button" className={`pq-badge ${className || ''}`} onClick={onOpen}
            title={`${count} label${count === 1 ? '' : 's'} queued to print`}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 6 2 18 2 18 9" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <rect x="6" y="14" width="12" height="8" />
            </svg>
            <span className="pq-count">{count}</span>
        </button>
    );
}

function SearchBox({ items, genetics, species, lots, lotLinks, library, librarySpecies, equipment, suppliers, stock,
    onOpenItem, onOpenSpecies, onOpenLot, onOpenLibrary, onOpenSupplies }) {
    const [q, setQ] = useState('');
    const [open, setOpen] = useState(false);
    const [expanded, setExpanded] = useState({});
    const [expandedForQuery, setExpandedForQuery] = useState('');
    const boxRef = useRef(null);
    const nq = norm(q.trim());

    // A fresh query starts every group collapsed again. Reset during render
    // (React's documented way to adjust state when a value changes) rather
    // than in an effect, which would fire a redundant extra render.
    if (nq !== expandedForQuery) {
        setExpandedForQuery(nq);
        setExpanded({});
    }

    useEffect(() => {
        const onDocClick = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
        document.addEventListener('mousedown', onDocClick);
        return () => document.removeEventListener('mousedown', onDocClick);
    }, []);

    const groups = useMemo(() => {
        if (nq.length < SEARCH_MIN) return [];
        const out = [];

        const itemHits = items.map((i) => {
            const gen = genetics.find((g) => g.id === i.geneticsId);
            const sp = species.find((s) => s.id === gen?.species_id);
            const m = firstMatch([
                ['Label', i.id], ['Species', sp?.common_name], ['Type', TYPES[i.type]],
                ['Substrate', i.substrate], ['Notes', i.notes],
                ['Status', STATUS[i.status]?.label ?? i.status],
            ], nq);
            return m && {
                id: i.id, title: i.id, subtitle: sp?.common_name ?? 'Unknown species',
                match: m.label, snippet: m.snippet, onClick: () => onOpenItem(i.id),
            };
        }).filter(Boolean);
        if (itemHits.length) out.push({ key: 'items', label: 'Cultivation — items', hits: itemHits });

        const genHits = genetics.map((g) => {
            const sp = species.find((s) => s.id === g.species_id);
            const m = firstMatch([
                ['Name', g.name], ['Code', g.code], ['Source', g.source], ['Notes', g.notes],
            ], nq);
            return m && {
                id: g.id, title: `${g.name} (${g.code})`, subtitle: sp?.common_name ?? '',
                match: m.label, snippet: m.snippet, onClick: () => sp && onOpenSpecies(sp.id),
            };
        }).filter(Boolean);
        if (genHits.length) out.push({ key: 'genetics', label: 'Cultivation — genetics lines', hits: genHits });

        const spHits = species.map((s) => {
            const m = firstMatch([
                ['Common name', s.common_name], ['Latin name', s.latin_name], ['Notes', s.notes],
            ], nq);
            return m && {
                id: s.id, title: s.common_name, subtitle: s.latin_name ?? '',
                match: m.label, snippet: m.snippet, onClick: () => onOpenSpecies(s.id),
            };
        }).filter(Boolean);
        if (spHits.length) out.push({ key: 'species', label: 'Cultivation — species', hits: spHits });

        const lotHits = lots.map((l) => {
            const sp = lotSpeciesNames(l.id, lots, lotLinks, items, genetics, species);
            const m = firstMatch([
                ['Label', l.label], ['Species', sp.join(', ')], ['Notes', l.notes],
            ], nq);
            return m && {
                id: l.id, title: l.label || 'Untitled lot', subtitle: sp.join(' + ') || 'Unknown origin',
                match: m.label, snippet: m.snippet, onClick: () => onOpenLot(l.id),
            };
        }).filter(Boolean);
        if (lotHits.length) out.push({ key: 'lots', label: 'Harvests — lots', hits: lotHits });

        const libHits = library.map((e) => {
            const tagNames = librarySpecies.filter((r) => r.library_id === e.id)
                .map((r) => species.find((s) => s.id === r.species_id)?.common_name).filter(Boolean).join(', ');
            const ingredientNames = e.ingredients?.map((row) => row.name).filter(Boolean).join(', ');
            const m = firstMatch([
                ['Title', e.title], ['Category', e.categories?.join(', ')], ['Ingredients', ingredientNames],
                ['Notes', e.body], ['Species', e.general ? 'General' : tagNames],
            ], nq);
            return m && {
                id: e.id, title: e.title,
                subtitle: e.kind === 'recipe' ? (e.categories?.[0] || 'Recipe') : (KINDS[e.kind] ?? e.kind),
                match: m.label, snippet: m.snippet, onClick: () => onOpenLibrary(e),
            };
        }).filter(Boolean);
        if (libHits.length) out.push({ key: 'library', label: 'Library — recipes & reference', hits: libHits });

        const equipHits = equipment.map((e) => {
            const m = firstMatch([
                ['Name', e.name], ['Category', e.category], ['Notes', e.notes],
            ], nq);
            return m && {
                id: e.id, title: e.name, subtitle: e.category || '',
                match: m.label, snippet: m.snippet, onClick: () => onOpenSupplies('equipment', e.id),
            };
        }).filter(Boolean);
        if (equipHits.length) out.push({ key: 'equipment', label: 'Supplies — equipment', hits: equipHits });

        const supHits = suppliers.map((s) => {
            const m = firstMatch([
                ['Name', s.name], ['Category', s.category], ['Notes', s.notes], ['Website', s.website],
            ], nq);
            return m && {
                id: s.id, title: s.name, subtitle: s.category || '',
                match: m.label, snippet: m.snippet, onClick: () => onOpenSupplies('suppliers', s.id),
            };
        }).filter(Boolean);
        if (supHits.length) out.push({ key: 'suppliers', label: 'Supplies — suppliers', hits: supHits });

        const stockHits = stock.map((s) => {
            const m = firstMatch([
                ['Product', s.product_name], ['Kind', s.kind], ['Notes', s.notes],
            ], nq);
            return m && {
                id: s.id, title: s.product_name || s.kind, subtitle: '',
                match: m.label, snippet: m.snippet, onClick: () => onOpenSupplies('stock', s.id),
            };
        }).filter(Boolean);
        if (stockHits.length) out.push({ key: 'stock', label: 'Supplies — stock', hits: stockHits });

        return out;
    }, [nq, items, genetics, species, lots, lotLinks, library, librarySpecies, equipment, suppliers, stock]);

    const total = groups.reduce((n, g) => n + g.hits.length, 0);

    const pick = (fn) => { fn(); setQ(''); setOpen(false); };

    return (
        <div className="search-box" ref={boxRef}>
            <input className="in" value={q}
                placeholder="Search…"
                onFocus={() => setOpen(true)}
                onChange={(e) => { setQ(e.target.value); setOpen(true); }}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') { setQ(''); setOpen(false); e.currentTarget.blur(); }
                    else if (e.key === 'Enter') { const first = groups[0]?.hits?.[0]; if (first) pick(first.onClick); }
                }} />

            {open && nq.length >= SEARCH_MIN && (
                <div className="search-dropdown">
                    {total === 0 && <p className="notes empty-note">No matches for "{q.trim()}".</p>}
                    {groups.map((g) => {
                        const isExpanded = !!expanded[g.key];
                        const shown = isExpanded ? g.hits : g.hits.slice(0, SEARCH_GROUP_CAP);
                        const remainingCount = g.hits.length - shown.length;
                        return (
                            <div key={g.key} className="sr-group">
                                <div className="sr-group-label">{g.label} · {g.hits.length}</div>
                                {shown.map((h) => (
                                    <button key={h.id} className="sr-hit" onClick={() => pick(h.onClick)}>
                                        <div className="lib-title">{h.title}</div>
                                        <div className="lib-meta">
                                            {h.subtitle && <span className="lib-sp">{h.subtitle}</span>}
                                            <span className="lib-kind">matched: {h.match}</span>
                                        </div>
                                        {h.snippet && <div className="sr-snippet">{h.snippet}</div>}
                                    </button>
                                ))}
                                {remainingCount > 0 && (
                                    <button className="sr-more" onClick={() => setExpanded((p) => ({ ...p, [g.key]: true }))}>
                                        Show {remainingCount} more
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function Inventory({ lots, lotLinks, items, genetics, species, remaining, onOpen, onAddManual, onPrintLot, onQueueLot, dateFormat }) {
    const [formFilter, setFormFilter] = useState('all');
    const [hideUsed, setHideUsed] = useState(true);
    const [adding, setAdding] = useState(false);
    const blank = { label: '', form: 'dried', amount: '', speciesId: '', date: '', notes: '' };
    const [f, setF] = useState(blank);

    const withRem = lots.map((l) => ({ lot: l, rem: remaining(l.id) }));
    const visible = withRem
        .filter((x) => formFilter === 'all' || x.lot.form === formFilter)
        .filter((x) => !hideUsed || x.rem > LOT_EPS)
        .sort((a, b) => (b.lot.harvested_on ?? '').localeCompare(a.lot.harvested_on ?? ''));

    const totalsByForm = {};
    lots.forEach((l) => { totalsByForm[l.form] = (totalsByForm[l.form] ?? 0) + remaining(l.id); });

    return (
        <div className="page">
            <div className="bar">
                <div>
                    <div className="eyebrow">Everything that's been harvested, and what it became</div>
                    <h1>Harvests</h1>
                </div>
                {!adding && <button className="sw" onClick={() => { setF(blank); setAdding(true); }}>+ Add lot</button>}
            </div>

            {adding && (
                <div className="new-form">
                    <div className="nf-title">Add a lot</div>
                    <p className="nf-help">
                        For material that's real but doesn't trace cleanly back to a specific flush -
                        backfilling from the cabinet, something you found later. Tag the species directly
                        since there's no item to trace it through.
                    </p>
                    <div className="nf-grid">
                        <div className="nf-field wide"><label>Label</label>
                            <input className="in" autoFocus value={f.label} placeholder="e.g. Blue Oyster dried, unknown flush breakdown"
                                onChange={(e) => setF({ ...f, label: e.target.value })} /></div>
                        <div className="nf-field"><label>Form</label>
                            <select className="in sel" value={f.form} onChange={(e) => setF({ ...f, form: e.target.value })}>
                                {Object.keys(LOT_FORMS).map((k) => <option key={k} value={k}>{LOT_FORMS[k]}</option>)}
                            </select></div>
                        <div className="nf-field"><label>Amount on hand (g)</label>
                            <input className="in" inputMode="decimal" value={f.amount} placeholder="e.g. 40"
                                onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
                        <div className="nf-field"><label>Species (optional)</label>
                            <select className="in sel" value={f.speciesId} onChange={(e) => setF({ ...f, speciesId: e.target.value })}>
                                <option value="">— unknown / mixed —</option>
                                {visibleSpeciesFor(species, f.speciesId).map((s) => <option key={s.id} value={s.id}>{s.common_name}</option>)}
                            </select></div>
                        <div className="nf-field"><label>Date (optional)</label>
                            <input className="in" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
                        <div className="nf-field wide"><label>Notes</label>
                            <textarea className="in ta" rows="2" value={f.notes} placeholder="why there's no clean trail, if worth remembering"
                                onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
                    </div>
                    <div className="edit-row">
                        <button className="mini" onClick={() => {
                            if (!f.label.trim()) { alert('Label is required.'); return; }
                            const amt = n(f.amount);
                            if (!amt) { alert('Enter an amount on hand.'); return; }
                            onAddManual({ ...f, amount: amt });
                            setAdding(false);
                        }}>Add lot</button>
                        <button className="mini ghost" onClick={() => setAdding(false)}>Cancel</button>
                    </div>
                </div>
            )}

            <div className="inv-totals">
                {Object.keys(LOT_FORMS).filter((f) => totalsByForm[f] > LOT_EPS).map((f) => (
                    <div key={f} className="inv-total"><strong>{totalsByForm[f].toFixed(0)}g</strong><span>{LOT_FORMS[f]}</span></div>
                ))}
                {lots.length === 0 && <p className="nf-help">Nothing yet - log a flush on a fruiting item and it lands here automatically.</p>}
            </div>

            <div className="tabs">
                <button className={`tab ${formFilter === 'all' ? 'on' : ''}`} onClick={() => setFormFilter('all')}>All</button>
                {Object.keys(LOT_FORMS).map((f) => (
                    <button key={f} className={`tab ${formFilter === f ? 'on' : ''}`} onClick={() => setFormFilter(f)}>{LOT_FORMS[f]}</button>
                ))}
                <button className="sw tabs-toggle" onClick={() => setHideUsed(!hideUsed)}>
                    {hideUsed ? 'Show used up' : 'Hide used up'}
                </button>
            </div>

            <div className="lot-grid">
                {visible.map(({ lot, rem }) => (
                    <LotCard key={lot.id} lot={lot} rem={rem}
                        sp={lotSpeciesNames(lot.id, lots, lotLinks, items, genetics, species)}
                        onOpen={onOpen} onPrintLot={onPrintLot} onQueueLot={onQueueLot} dateFormat={dateFormat} />
                ))}
            </div>
        </div>
    );
}

/* ---------------- LOT DETAIL ---------------- */

function LotDetail({ lots, lotLinks, lotId, items, genetics, species, remaining, onBack, onOpen, onProcess, onLoss, onSave, onDelete, onEditLink, onDeleteLink, onPrintLot, onQueueLot, dateFormat }) {
    const lot = lots.find((l) => l.id === lotId);
    const [editing, setEditing] = useState(false);
    const [f, setF] = useState({});
    const [processing, setProcessing] = useState(false);
    const [losing, setLosing] = useState(false);
    const [lossAmt, setLossAmt] = useState('');
    const [lossReason, setLossReason] = useState('');
    const [editingNotes, setEditingNotes] = useState(false);
    const [notesDraft, setNotesDraft] = useState('');
    const [editingLinkId, setEditingLinkId] = useState(null);
    const [linkAmt, setLinkAmt] = useState('');

    if (!lot) return <div className="page"><button className="back" onClick={onBack}>← Inventory</button></div>;

    const rem = remaining(lotId);
    /* What's already spoken for (processed elsewhere or logged as lost) -
       amount_g can't be edited below this without going negative. */
    const consumedOrLost = Number(lot.amount_g) - rem;
    const sp = lotSpeciesNames(lotId, lots, lotLinks, items, genetics, species);
    const parents = lotLinks.filter((k) => k.child_lot_id === lotId);
    const children = lotLinks.filter((k) => k.parent_lot_id === lotId);
    const available = lots.filter((l) => l.id !== lotId && remaining(l.id) > LOT_EPS);

    return (
        <div className="page">
            <button className="back" onClick={onBack}>← Inventory</button>

            <div className="d-head">
                <div className="d-mark" style={{ borderColor: rem > LOT_EPS ? TONE.amber : TONE.slate }}>
                    <span style={{ background: rem > LOT_EPS ? TONE.amber : TONE.slate }} />
                </div>
                {editing ? (
                    <div className="head-edit">
                        <input className="in" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="label" />
                        <select className="in sel" value={f.form} onChange={(e) => setF({ ...f, form: e.target.value })}>
                            {Object.keys(LOT_FORMS).map((k) => <option key={k} value={k}>{LOT_FORMS[k]}</option>)}
                        </select>
                        <input className="in sm" inputMode="decimal" value={f.amount_g}
                            onChange={(e) => setF({ ...f, amount_g: e.target.value })} placeholder="started with, g" />
                        <select className="in sel" value={f.species_id} onChange={(e) => setF({ ...f, species_id: e.target.value })}>
                            <option value="">— unknown / mixed —</option>
                            {visibleSpeciesFor(species, f.species_id).map((s) => <option key={s.id} value={s.id}>{s.common_name}</option>)}
                        </select>
                        <input className="in sm" type="date" value={f.harvested_on ?? ''} onChange={(e) => setF({ ...f, harvested_on: e.target.value })} />
                        <button className="mini" onClick={() => {
                            if (!f.label.trim()) { alert('Label is required.'); return; }
                            const amt = n(f.amount_g);
                            if (!amt) { alert('Enter a started-with amount.'); return; }
                            if (amt < consumedOrLost - LOT_EPS) {
                                alert(`Can't go below ${fmtG(consumedOrLost, f.form)}g - that's already been processed or logged as lost from this lot.`);
                                return;
                            }
                            onSave(lotId, { label: f.label.trim(), form: f.form, amount_g: amt,
                                species_id: f.species_id || null, harvested_on: f.harvested_on || null });
                            setEditing(false);
                        }}>Save</button>
                        <button className="mini ghost" onClick={() => setEditing(false)}>Cancel</button>
                        <button className="mini danger" onClick={() => {
                            if (confirm(`Delete "${lot.label}"?`)) onDelete(lotId);
                        }}>Delete</button>
                    </div>
                ) : (
                    <div className="head-read">
                        <h1 className="d-id" style={{ fontFamily: 'var(--serif)', fontSize: 25 }}>{lot.label || 'Untitled lot'}</h1>
                        <div className="d-sub">{LOT_FORMS[lot.form] ?? lot.form} · {sp.length ? sp.join(' + ') : 'unknown origin'}{lot.harvested_on ? ` · ${fmt(lot.harvested_on, dateFormat)}` : ''}</div>
                    </div>
                )}
                {!editing && (
                    <>
                        <button className="edit-btn" title="Edit"
                            onClick={() => { setF({ label: lot.label ?? '', form: lot.form, amount_g: lot.amount_g ?? '',
                                species_id: lot.species_id ?? '', harvested_on: lot.harvested_on ?? '' }); setEditing(true); }}>✎</button>
                        <div className="pl-icon-row">
                            <button className="pl-icon-btn pl-trigger" title="Print a QR sticker for this lot" onClick={() => onPrintLot(lotId)}><PrinterIcon /></button>
                            <button className="pl-icon-btn pl-queue" title="Add to the print queue instead - print it later alongside other labels" onClick={() => onQueueLot(lotId)}><PrinterQueueIcon /></button>
                        </div>
                    </>
                )}
            </div>

            <div className="lot-amount-hero">
                <div><strong>{fmtG(rem, lot.form)} g</strong><span>remaining</span></div>
                <div><strong>{fmtG(lot.amount_g, lot.form)} g</strong><span>started with</span></div>
                {Number(lot.lost_g) > 0 && <div><strong style={{ color: TONE.clay }}>{lot.lost_g} g</strong><span>used up</span></div>}
            </div>

            <div className="cols">
                <div>
                    <Sec title="Process into a new lot" />
                    {!processing ? (
                        <button className="cta" disabled={rem <= LOT_EPS} onClick={() => setProcessing(true)}>
                            {rem <= LOT_EPS ? 'Nothing left to process' : 'Dry, grind, blend, or extract'}
                        </button>
                    ) : (
                        <ProcessForm sourceLot={lot} sourceRemaining={rem} available={available} remaining={remaining}
                            onSubmit={(sources, fields) => { onProcess(sources, fields); setProcessing(false); }}
                            onCancel={() => setProcessing(false)} />
                    )}

                    <Sec title="Used up" />
                    {!losing ? (
                        <button className="mini ghost" disabled={rem <= LOT_EPS} onClick={() => setLosing(true)}>Log eaten, given away, sampled, or lost</button>
                    ) : (
                        <div className="field-form">
                            <div className="edit-row">
                                <NumField label="Amount" value={lossAmt} onChange={setLossAmt} placeholder="e.g. 5" unit="g" />
                                <button className="chip" style={{ marginTop: 18 }}
                                    onClick={() => setLossAmt(String(rem))}>
                                    All ({fmtG(rem, lot.form)}g)
                                </button>
                            </div>
                            <label style={{ marginTop: 4 }}>What happened to it</label>
                            <div className="chips">
                                {['Cooked & eaten', 'Given away', 'Sample / taste test', 'Spilled', 'Other'].map((r) => (
                                    <button key={r} className={`chip ${lossReason === r ? 'on' : ''}`} onClick={() => setLossReason(r)}>{r}</button>
                                ))}
                            </div>
                            <input className="in" value={lossReason} onChange={(e) => setLossReason(e.target.value)}
                                placeholder="or type your own" style={{ marginTop: 4 }} />
                            <div className="edit-row">
                                <button className="mini" onClick={() => {
                                    const g = n(lossAmt);
                                    if (!g) { alert('Enter an amount.'); return; }
                                    if (g > rem + LOT_EPS) { alert(`Only ${fmtG(rem, lot.form)}g remaining.`); return; }
                                    onLoss(lotId, Math.min(g, rem), lossReason.trim());
                                    setLosing(false); setLossAmt(''); setLossReason('');
                                }}>Save</button>
                                <button className="mini ghost" onClick={() => setLosing(false)}>Cancel</button>
                            </div>
                        </div>
                    )}

                    <Sec title="Made from" />
                    {parents.length ? (
                        <div className="lineage-list">
                            {parents.map((k) => {
                                const pl = lots.find((l) => l.id === k.parent_lot_id);
                                if (!pl) return null;
                                if (editingLinkId === k.id) {
                                    return (
                                        <div key={k.id} className="lnk-row-edit">
                                            <span className="lnk-edit-label">{pl.label}</span>
                                            <input className="in sm" inputMode="decimal" value={linkAmt}
                                                onChange={(e) => setLinkAmt(e.target.value)} />
                                            <button className="mini" onClick={() => {
                                                const amt = n(linkAmt);
                                                if (!amt) { alert('Enter an amount.'); return; }
                                                onEditLink(k.id, amt);
                                                setEditingLinkId(null);
                                            }}>Save</button>
                                            <button className="mini ghost" onClick={() => setEditingLinkId(null)}>Cancel</button>
                                            <button className="mini danger" onClick={() => {
                                                if (confirm(`Remove this link? "${pl.label}" will show ${k.amount_taken_g}g as free again.`)) {
                                                    onDeleteLink(k.id);
                                                    setEditingLinkId(null);
                                                }
                                            }}>Delete</button>
                                        </div>
                                    );
                                }
                                return (
                                    <div key={k.id} className="lnk-row-outer">
                                        <button className="lnk-row" onClick={() => onOpen(pl.id)}>
                                            <span>{pl.label}</span><span className="lnk-amt">{k.amount_taken_g}g used</span>
                                        </button>
                                        <button className="edit-btn" title="Edit amount"
                                            onClick={() => { setLinkAmt(String(k.amount_taken_g)); setEditingLinkId(k.id); }}>✎</button>
                                    </div>
                                );
                            })}
                        </div>
                    ) : <p className="notes empty-note">This is an original harvest - nothing feeds into it.</p>}

                    <Sec title="Went into" />
                    {children.length ? (
                        <div className="lineage-list">
                            {children.map((k) => {
                                const cl = lots.find((l) => l.id === k.child_lot_id);
                                if (!cl) return null;
                                if (editingLinkId === k.id) {
                                    return (
                                        <div key={k.id} className="lnk-row-edit">
                                            <span className="lnk-edit-label">{cl.label}</span>
                                            <input className="in sm" inputMode="decimal" value={linkAmt}
                                                onChange={(e) => setLinkAmt(e.target.value)} />
                                            <button className="mini" onClick={() => {
                                                const amt = n(linkAmt);
                                                if (!amt) { alert('Enter an amount.'); return; }
                                                onEditLink(k.id, amt);
                                                setEditingLinkId(null);
                                            }}>Save</button>
                                            <button className="mini ghost" onClick={() => setEditingLinkId(null)}>Cancel</button>
                                            <button className="mini danger" onClick={() => {
                                                if (confirm(`Remove this link? "${lot.label}" will show ${k.amount_taken_g}g as free again.`)) {
                                                    onDeleteLink(k.id);
                                                    setEditingLinkId(null);
                                                }
                                            }}>Delete</button>
                                        </div>
                                    );
                                }
                                return (
                                    <div key={k.id} className="lnk-row-outer">
                                        <button className="lnk-row" onClick={() => onOpen(cl.id)}>
                                            <span>{cl.label}</span><span className="lnk-amt">took {k.amount_taken_g}g</span>
                                        </button>
                                        <button className="edit-btn" title="Edit amount"
                                            onClick={() => { setLinkAmt(String(k.amount_taken_g)); setEditingLinkId(k.id); }}>✎</button>
                                    </div>
                                );
                            })}
                        </div>
                    ) : <p className="notes empty-note">Nothing made from this yet.</p>}
                </div>

                <div>
                    <Sec title="Notes" onEdit={() => { setNotesDraft(lot.notes ?? ''); setEditingNotes(true); }} />
                    {editingNotes ? (
                        <div className="field-form">
                            <textarea className="in ta" rows="6" value={notesDraft}
                                onChange={(e) => setNotesDraft(e.target.value)}
                                placeholder="Anything worth remembering about this lot." />
                            <div className="edit-row">
                                <button className="mini" onClick={() => { onSave(lotId, { notes: notesDraft.trim() || null }); setEditingNotes(false); }}>Save</button>
                                <button className="mini ghost" onClick={() => setEditingNotes(false)}>Cancel</button>
                            </div>
                        </div>
                    ) : (
                        lot.notes
                            ? <p className="notes">{lot.notes.split('\n').map((line, n2) => <span key={n2}>{line}<br /></span>)}</p>
                            : <p className="notes empty-note">No notes.</p>
                    )}
                </div>
            </div>
        </div>
    );
}

function ProcessForm({ sourceLot, sourceRemaining, available, remaining, onSubmit, onCancel }) {
    const [rows, setRows] = useState([{ lotId: sourceLot.id, amount: String(sourceRemaining) }]);
    const [form, setForm] = useState('dried');
    const [amount, setAmount] = useState('');
    const [label, setLabel] = useState('');
    const [notes, setNotes] = useState('');
    const [picking, setPicking] = useState(false);

    const setRowAmt = (i, v) => setRows((r) => r.map((row, idx) => (idx === i ? { ...row, amount: v } : row)));
    const removeRow = (i) => setRows((r) => r.filter((_, idx) => idx !== i));
    const addSource = (lotId) => {
        setRows((r) => [...r, { lotId, amount: String(remaining(lotId)) }]);
        setPicking(false);
    };

    const valid = rows.every((r) => n(r.amount) > 0) && label.trim() && n(amount) > 0;

    return (
        <div className="new-form">
            <div className="nf-title">New lot from {rows.length > 1 ? `${rows.length} sources` : sourceLot.label}</div>
            <p className="nf-help">
                One source is a transform (dry it, grind it). Add more sources to blend species or batches together.
                The amount you enter here is what actually gets used up from each - the rest stays where it is.
            </p>

            <div className="process-rows">
                {rows.map((row, i) => {
                    const rowLot = i === 0 ? sourceLot : available.find((l) => l.id === row.lotId);
                    const cap = i === 0 ? sourceRemaining : remaining(row.lotId);
                    return (
                        <div key={row.lotId} className="process-row">
                            <span className="pr-label">{rowLot?.label ?? '?'}</span>
                            <input className="in sm" inputMode="decimal" value={row.amount}
                                onChange={(e) => setRowAmt(i, e.target.value)} />
                            <span className="pr-cap">/ {fmtG(cap, rowLot?.form)}g avail</span>
                            {i > 0 && <button className="log-x" onClick={() => removeRow(i)}>×</button>}
                        </div>
                    );
                })}
            </div>

            {!picking ? (
                <button className="mini ghost" onClick={() => setPicking(true)}>+ Add another source lot</button>
            ) : (
                <div className="chips">
                    {available.filter((l) => !rows.some((r) => r.lotId === l.id)).map((l) => (
                        <button key={l.id} className="chip go" onClick={() => addSource(l.id)}>{l.label} ({LOT_FORMS[l.form]})</button>
                    ))}
                    <button className="chip" onClick={() => setPicking(false)}>Cancel</button>
                </div>
            )}

            <div className="nf-grid" style={{ marginTop: 14 }}>
                <div className="nf-field"><label>Resulting form</label>
                    <select className="in sel" value={form} onChange={(e) => setForm(e.target.value)}>
                        {Object.keys(LOT_FORMS).map((k) => <option key={k} value={k}>{LOT_FORMS[k]}</option>)}
                    </select></div>
                <div className="nf-field"><label>Weighed amount (once done)</label>
                    <input className="in" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 40" /></div>
                <div className="nf-field wide"><label>Label</label>
                    <input className="in" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Blue Oyster dried batch 1" /></div>
                <div className="nf-field wide"><label>Notes</label>
                    <textarea className="in ta" rows="2" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
            </div>

            <div className="edit-row">
                <button className="mini" disabled={!valid} onClick={() => {
                    const sources = rows.map((r) => ({ lotId: r.lotId, amount: n(r.amount) }));
                    onSubmit(sources, { form, amount: n(amount), label, notes });
                }}>Create lot</button>
                <button className="mini ghost" onClick={onCancel}>Cancel</button>
            </div>
        </div>
    );
}

/* ---------------- LIBRARY / RECIPES ---------------- */

const KINDS = { note: 'Written note', link: 'Link', video: 'Video', pdf: 'PDF (linked)', recipe: 'Recipe' };
const RECIPE_CATEGORIES = ['Agar media', 'LC media', 'Grain spawn', 'Bulk substrate', 'Nutrient broth', 'Casing mix', 'Extraction', 'Capsule blend', 'Other'];
const SUPPLIER_RATING = {
    trusted: { label: 'Trusted', tone: 'jade' },
    mixed: { label: 'Mixed', tone: 'amber' },
    unproven: { label: 'Unproven', tone: 'slate' },
    avoid: { label: 'Avoid', tone: 'clay' },
};

function SupplierTab({ suppliers, onAdd, onEdit, onDelete, initialOpenId }) {
    const blank = { name: '', category: '', rating: 'unproven', notes: '', website: '' };
    const [form, setForm] = useState(null);
    const [f, setF] = useState(blank);

    const submit = () => {
        if (!f.name.trim()) { alert('Name is required.'); return; }
        if (form === 'new') onAdd(f); else onEdit(form, f);
        setForm(null); setF(blank);
    };

    /* Arriving here from a Search hit ("Supplies - suppliers") used to just
       switch to this tab and leave you to scroll and find the row yourself.
       Opens straight into editing the matched supplier instead - same
       ref-for-the-list trick as the delete-undo timers elsewhere, so this
       only fires once for the id Search actually sent, not every time the
       suppliers array changes underneath it. */
    const suppliersRef = useRef(suppliers);
    useEffect(() => { suppliersRef.current = suppliers; });
    useEffect(() => {
        if (!initialOpenId) return;
        const s = suppliersRef.current.find((x) => x.id === initialOpenId);
        if (!s) return;
        setF({ name: s.name, category: s.category ?? '', rating: s.rating, notes: s.notes ?? '', website: s.website ?? '' });
        setForm(s.id);
    }, [initialOpenId]);

    const order = ['trusted', 'mixed', 'unproven', 'avoid'];
    const sorted = [...suppliers].sort((a, b) => order.indexOf(a.rating) - order.indexOf(b.rating));

    return (
        <>
            <div className="bar" style={{ marginTop: 4 }}>
                <div className="eyebrow">Track record - what's proven, what to skip</div>
                {form === null && <button className="sw" onClick={() => { setF(blank); setForm('new'); }}>+ Add supplier</button>}
            </div>

            {form !== null && (
                <div className="new-form">
                    <div className="nf-title">{form === 'new' ? 'New' : 'Edit'} supplier</div>
                    <div className="nf-grid">
                        <div className="nf-field wide"><label>Name</label>
                            <input className="in" autoFocus value={f.name} placeholder="e.g. North Spore"
                                onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
                        <div className="nf-field wide"><label>What you buy from them</label>
                            <input className="in" value={f.category} placeholder="Fruiting blocks, LC, grain…"
                                onChange={(e) => setF({ ...f, category: e.target.value })} /></div>
                        <div className="nf-field wide"><label>Website (optional)</label>
                            <input className="in" value={f.website} placeholder="https://…"
                                onChange={(e) => setF({ ...f, website: e.target.value })} /></div>
                        <div className="nf-field"><label>Rating</label>
                            <select className="in sel" value={f.rating} onChange={(e) => setF({ ...f, rating: e.target.value })}>
                                {Object.keys(SUPPLIER_RATING).map((r) => <option key={r} value={r}>{SUPPLIER_RATING[r].label}</option>)}
                            </select></div>
                        <div className="nf-field wide"><label>Notes - what actually happened</label>
                            <textarea className="in ta" rows="4" value={f.notes}
                                placeholder="Specific outcomes, not vibes - what shipped, what failed, what you'd reorder"
                                onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
                    </div>
                    <div className="edit-row">
                        <button className="mini" onClick={submit}>Save</button>
                        <button className="mini ghost" onClick={() => setForm(null)}>Cancel</button>
                        {form !== 'new' && (
                            <button className="mini danger" onClick={() => {
                                if (confirm(`Remove "${f.name}"?`)) { onDelete(form); setForm(null); }
                            }}>Delete</button>
                        )}
                    </div>
                </div>
            )}

            <div className="lib-list">
                {sorted.map((s) => {
                    const isOpen = form === s.id;
                    const r = SUPPLIER_RATING[s.rating] ?? SUPPLIER_RATING.unproven;
                    return (
                        <div key={s.id} className="lib-card">
                            <button className="lib-head" onClick={() => {
                                setF({ name: s.name, category: s.category ?? '', rating: s.rating, notes: s.notes ?? '', website: s.website ?? '' });
                                setForm(isOpen ? null : s.id);
                            }}>
                                <div>
                                    <div className="lib-title">{s.name}</div>
                                    <div className="lib-meta">
                                        {s.category && <span className="lib-sp">{s.category}</span>}
                                    </div>
                                </div>
                                <span className={`pill tone-${r.tone}`}>{r.label}</span>
                            </button>
                            {!isOpen && (s.website || s.notes) && (
                                <div className="lib-body" style={{ paddingTop: 0, borderTop: 'none' }}>
                                    {s.website && <a className="lib-link" href={s.website} target="_blank" rel="noreferrer">{s.website}</a>}
                                    {s.notes && <p className="notes" style={{ fontSize: 12 }}>{s.notes}</p>}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
            {suppliers.length === 0 && form === null && (
                <p className="nf-help nf-help-page" style={{ marginTop: 18 }}>No suppliers logged yet.</p>
            )}
        </>
    );
}

const EQUIP_STATUS = {
    active: { label: 'Active', tone: 'jade' },
    needs_repair: { label: 'Needs repair', tone: 'amber' },
    broken: { label: 'Broken', tone: 'clay' },
    retired: { label: 'Retired', tone: 'slate' },
    wishlist: { label: 'Wishlist', tone: 'slate' },
};

function EquipmentTab({ equipment, onAdd, onEdit, onDelete, photos, photoUrl, onAddPhoto, onDeletePhoto, onEditPhoto, onBumpQty, initialOpenId, dateFormat }) {
    const blank = { name: '', category: '', status: 'active', quantity: '', notes: '' };
    const [form, setForm] = useState(null);
    const [f, setF] = useState(blank);

    const submit = () => {
        if (!f.name.trim()) { alert('Name is required.'); return; }
        if (form === 'new') onAdd(f); else onEdit(form, f);
        setForm(null); setF(blank);
    };

    const equipmentRef = useRef(equipment);
    useEffect(() => { equipmentRef.current = equipment; });
    useEffect(() => {
        if (!initialOpenId) return;
        const e = equipmentRef.current.find((x) => x.id === initialOpenId);
        if (!e) return;
        setF({ name: e.name, category: e.category ?? '', status: e.status, quantity: e.quantity ?? '', notes: e.notes ?? '' });
        setForm(e.id);
    }, [initialOpenId]);

    const groups = {};
    equipment.forEach((e) => { (groups[e.category || 'Uncategorized'] ||= []).push(e); });

    return (
        <>
            <div className="bar" style={{ marginTop: 4 }}>
                <div className="eyebrow">Gear you'd want an assistant to already know about</div>
                {form === null && <button className="sw" onClick={() => { setF(blank); setForm('new'); }}>+ Add item</button>}
            </div>

            {form !== null && (
                <div className="new-form">
                    <div className="nf-title">{form === 'new' ? 'New' : 'Edit'} equipment</div>
                    <div className="nf-grid">
                        <div className="nf-field wide"><label>Name</label>
                            <input className="in" autoFocus value={f.name} placeholder="e.g. Presto 23qt pressure canner"
                                onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
                        <div className="nf-field"><label>Category</label>
                            <input className="in" value={f.category} placeholder="Sterilization, Environment, Processing…"
                                onChange={(e) => setF({ ...f, category: e.target.value })} /></div>
                        <div className="nf-field"><label>Status</label>
                            <select className="in sel" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
                                {Object.keys(EQUIP_STATUS).map((s) => <option key={s} value={s}>{EQUIP_STATUS[s].label}</option>)}
                            </select></div>
                        <div className="nf-field"><label>Quantity (optional)</label>
                            <input className="in" inputMode="numeric" value={f.quantity} placeholder="leave blank if not a count"
                                onChange={(e) => setF({ ...f, quantity: e.target.value.replace(/[^\d]/g, '') })} /></div>
                        <div className="nf-field wide"><label>Notes</label>
                            <textarea className="in ta" rows="2" value={f.notes}
                                placeholder="Model quirks, what broke, what you'd upgrade to"
                                onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
                    </div>

                    {form !== 'new' && (
                        <PhotoStrip attach={{ equipmentId: form }} photos={photos.filter((p) => p.equipment_id === form)}
                            photoUrl={photoUrl} onAdd={onAddPhoto} onDelete={onDeletePhoto} onEdit={onEditPhoto} label="Photo (optional)" dateFormat={dateFormat} />
                    )}

                    <div className="edit-row">
                        <button className="mini" onClick={submit}>Save</button>
                        <button className="mini ghost" onClick={() => setForm(null)}>Cancel</button>
                        {form !== 'new' && (
                            <button className="mini danger" onClick={() => {
                                if (confirm(`Remove "${f.name}" from the list?`)) { onDelete(form); setForm(null); }
                            }}>Delete</button>
                        )}
                    </div>
                </div>
            )}

            {Object.keys(groups).sort().map((cat) => (
                <div key={cat}>
                    <div className="sec" style={{ marginTop: 22 }}><span>{cat}</span></div>
                    <div className="equip-list">
                        {groups[cat].map((e) => {
                            const st = EQUIP_STATUS[e.status] ?? EQUIP_STATUS.active;
                            const thumb = photos.find((p) => p.equipment_id === e.id);
                            const tracked = e.quantity !== null && e.quantity !== undefined;
                            return (
                                <div key={e.id} className="equip-row">
                                    <button className="equip-row-main" onClick={() => {
                                        setF({ name: e.name, category: e.category ?? '', status: e.status, quantity: e.quantity ?? '', notes: e.notes ?? '' });
                                        setForm(e.id);
                                    }}>
                                        {thumb
                                            ? <img className="equip-thumb" src={photoUrl(thumb)} alt="" loading="lazy" decoding="async" />
                                            : <span className="equip-thumb equip-thumb-empty" />}
                                        <span className="equip-name">{e.name}</span>
                                        {e.notes && <span className="equip-note">{e.notes}</span>}
                                        <span className={`pill tone-${st.tone}`}>{st.label}</span>
                                    </button>
                                    {tracked && (
                                        <div className="equip-qty">
                                            <button className="qty-btn" onClick={() => onBumpQty(e.id, -1)}>−</button>
                                            <span className={`qty-num ${e.quantity === 0 ? 'zero' : ''}`}>{e.quantity}</span>
                                            <button className="qty-btn" onClick={() => onBumpQty(e.id, 1)}>+</button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
            {equipment.length === 0 && form === null && (
                <p className="nf-help nf-help-page" style={{ marginTop: 18 }}>No equipment listed yet.</p>
            )}
        </>
    );
}

/* Every row in `stock` is one physical unit (a specific plate, jar, bag),
   not an aggregate count - see addStock/consumeStock. This groups them
   back into the batch they were logged together as (stockBatchKey) so the
   screen still reads "6 plates from Tuesday's PDA batch," while each
   individual unit underneath gets its own label, status, and - once
   consumed - a link to exactly which culture it became. */
/* Narrows the Recipe dropdown in the stock form to recipes whose category
   matches the selected stock Kind, so you're not scrolling every recipe in
   the library to find e.g. an LC media recipe when adding liquid culture
   stock. Kinds with no clean 1:1 recipe category (currently just 'aio')
   fall back to showing the full recipe list. */
const STOCK_KIND_RECIPE_CATEGORY = {
    agar: 'Agar media',
    lc: 'LC media',
    grain: 'Grain spawn',
    bulk: 'Bulk substrate',
    block: 'Bulk substrate',
    cake: 'Bulk substrate',
    other: 'Other',
};

/* Whether a stock unit can supply a given item type when starting a new
   culture from it (2026-09-18, found via Matt's real MM01/MM02 case: same
   Master's Mix batch, half went in a monotub - bulk - the other half got
   hand-formed into a fruiting block - block - same substrate either way).
   Reuses the same bulk/block/cake grouping STOCK_KIND_RECIPE_CATEGORY
   already uses for recipe-matching, rather than a strict kind===type
   check - a bulk-substrate stock bag's eventual shape depends on what you
   do with it, not which kind label it was logged under. agar/lc/grain
   still only match themselves, since those categories are already 1:1
   with their own kind. */
const stockUsableFor = (stockKind, itemType) =>
    STOCK_KIND_RECIPE_CATEGORY[stockKind] === STOCK_KIND_RECIPE_CATEGORY[itemType];

function StockTab({ stock, library, suppliers, species, onAdd, onEdit, onDelete, onPrintStock, onQueueStock, onOpenItem, items, initialOpenId, onGetOrCreateSupplier, dateFormat }) {
    const blank = { kind: 'agar', source: 'made', recipe_id: '', supplier_id: '', product_name: '',
        quantity: '1', labels: '', made_or_bought_on: '', status: 'on_hand', notes: '', label: '',
        amount: '', amount_unit: '', new_code: '' };
    const [form, setForm] = useState(null);
    const [f, setF] = useState(blank);
    /* Kind filter for the list below (agar/grain/etc.) - separate from
       f.kind, which is just the form's own "what am I adding" field. '' means
       show every kind, same convention as the empty option in the <select>. */
    const [kindFilter, setKindFilter] = useState('');
    const recipes = library.filter((e) => e.kind === 'recipe');
    const recipeCategory = STOCK_KIND_RECIPE_CATEGORY[f.kind];
    const filteredRecipes = recipeCategory ? recipes.filter((r) => r.categories?.includes(recipeCategory)) : recipes;
    const isNew = form === 'new';
    /* Whether the currently-picked recipe/supplier already has an
       auto-numbering code (library/suppliers.label_prefix). When it
       doesn't, the form below asks for one once - see addStock, which
       persists it and uses it to generate labels going forward. */
    const existingCode = f.source === 'made'
        ? recipes.find((r) => r.id === f.recipe_id)?.label_prefix
        : suppliers.find((s) => s.id === f.supplier_id)?.label_prefix;
    const needsCode = isNew && !existingCode
        && ((f.source === 'made' && f.recipe_id) || (f.source === 'bought' && f.supplier_id));
    /* The edit form renders inline right at the unit being edited (see
       formPanel below), so a normal click never needs to scroll anywhere -
       the panel just opens exactly where you already are. The one case
       that still needs help is a deep link (search result, QR code):
       that mounts the tab fresh with some unit possibly far down a long
       list pre-selected for editing, and the page has no reason to have
       scrolled there on its own. formRef + deepLinkOpen flag that one
       case only, so a manual click never gets an unwanted scroll. */
    const formRef = useRef(null);
    const deepLinkOpen = useRef(false);

    const stockRef = useRef(stock);
    useEffect(() => { stockRef.current = stock; });
    useEffect(() => {
        if (!initialOpenId) return;
        const s = stockRef.current.find((x) => x.id === initialOpenId);
        if (!s) return;
        setF({ kind: s.kind, source: s.source, recipe_id: s.recipe_id ?? '',
            supplier_id: s.supplier_id ?? '', product_name: s.product_name ?? '',
            quantity: '1', labels: '',
            label: s.label ?? '',
            made_or_bought_on: s.made_or_bought_on ?? '', status: s.status, notes: s.notes ?? '',
            amount: s.amount ?? '', amount_unit: s.amount_unit ?? '' });
        deepLinkOpen.current = true;
        setForm(s.id);
    }, [initialOpenId]);
    useEffect(() => {
        if (form !== null && deepLinkOpen.current) {
            formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            deepLinkOpen.current = false;
        }
    }, [form]);

    const submit = () => {
        if (f.source === 'made' && !f.recipe_id) {
            alert("Pick a recipe, or switch to Bought if this stock isn't something you made.");
            return;
        }
        if (f.source === 'bought' && !f.supplier_id && !f.product_name.trim()) {
            alert('Pick a supplier or enter a product name so you can tell this stock apart later.');
            return;
        }
        if (isNew) onAdd(f); else onEdit(form, f);
        setForm(null); setF(blank);
    };

    const kindGroups = {};
    stock.forEach((s) => { (kindGroups[s.kind] ||= []).push(s); });

    /* Rendered in one of two spots below, never both at once (form only
       ever holds one value): at the top for a new unit, or inline right
       under the specific row being edited, via {form === s.id && formPanel}
       inside renderUnit - that's what lets an edit expand in place instead
       of always opening at the top of the tab. */
    const formPanel = (
        <div className="new-form" ref={formRef}>
            <div className="nf-title">{isNew ? 'New' : 'Edit'} stock</div>
            <div className="nf-grid">
                        <div className="nf-field"><label>Kind</label>
                            <select className="in sel" value={f.kind} onChange={(e) => {
                                const newKind = e.target.value;
                                const cat = STOCK_KIND_RECIPE_CATEGORY[newKind];
                                const stillValid = !cat || recipes.some((r) => r.id === f.recipe_id && r.categories?.includes(cat));
                                setF({ ...f, kind: newKind, recipe_id: stillValid ? f.recipe_id : '' });
                            }}>
                                {Object.keys(STOCK_KIND).map((k) => <option key={k} value={k}>{STOCK_KIND[k]}</option>)}
                            </select></div>
                        <div className="nf-field"><label>Source</label>
                            <select className="in sel" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
                                <option value="made">Made in-house</option>
                                <option value="bought">Bought</option>
                            </select></div>
                        {f.source === 'made' ? (
                            <div className="nf-field wide"><label>Recipe</label>
                                <select className="in sel" value={f.recipe_id} onChange={(e) => setF({ ...f, recipe_id: e.target.value })}>
                                    <option value="">{filteredRecipes.length ? '— pick a recipe —' : '— no recipes in this category yet —'}</option>
                                    {filteredRecipes.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
                                </select></div>
                        ) : (
                            <>
                                <div className="nf-field wide"><label>Supplier</label>
                                    <SupplierPicker suppliers={suppliers} value={f.supplier_id}
                                        onChange={(id) => setF({ ...f, supplier_id: id })}
                                        onCreate={onGetOrCreateSupplier} /></div>
                                <div className="nf-field wide"><label>Product name</label>
                                    <input className="in" value={f.product_name} placeholder="e.g. AIO substrate bag"
                                        onChange={(e) => setF({ ...f, product_name: e.target.value })} /></div>
                            </>
                        )}
                        {isNew ? (
                            <>
                                {needsCode && (
                                    <div className="nf-field wide">
                                        <label>Code (for auto-numbering, e.g. MM)</label>
                                        <input className="in" value={f.new_code} placeholder="e.g. MM"
                                            onChange={(e) => setF({ ...f, new_code: e.target.value.toUpperCase() })} />
                                        <span className="nf-help" style={{ margin: 0 }}>
                                            First time using this {f.source === 'made' ? 'recipe' : 'supplier'} for stock -
                                            set a short code and it'll auto-number every batch from here on
                                            (e.g. {STOCK_KIND_TAG[f.kind]}-{(f.new_code || 'MM')}01). Leave blank to skip
                                            auto-numbering and just type labels below instead.
                                        </span>
                                    </div>
                                )}
                                <div className="nf-field"><label>How many units</label>
                                    <input className="in" inputMode="numeric" value={f.quantity}
                                        onChange={(e) => setF({ ...f, quantity: e.target.value.replace(/[^\d]/g, '') })} /></div>
                                <div className="nf-field wide"><label>Labels (optional, comma-separated)</label>
                                    <input className="in" value={f.labels}
                                        placeholder={existingCode ? `leave blank to auto-number (${STOCK_KIND_TAG[f.kind]}-${existingCode}##)` : "e.g. LC10, LC11, LC12, LC13"}
                                        onChange={(e) => setF({ ...f, labels: e.target.value })} /></div>
                            </>
                        ) : (
                            <div className="nf-field"><label>Label</label>
                                <input className="in" value={f.label} placeholder="e.g. LC10"
                                    onChange={(e) => setF({ ...f, label: e.target.value })} /></div>
                        )}
                        <div className="nf-field"><label>Date made / bought</label>
                            <input className="in" type="date" value={f.made_or_bought_on}
                                onChange={(e) => setF({ ...f, made_or_bought_on: e.target.value })} /></div>
                        <div className="nf-field"><label>Status</label>
                            <select className="in sel" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
                                {Object.keys(STOCK_STATUS).map((s) => <option key={s} value={s}>{STOCK_STATUS[s].label}</option>)}
                            </select></div>
                        <div className="nf-field amt"><label>Weight (optional)</label>
                            <div className="amt-pair">
                                <input className="in" type="number" step="any" value={f.amount ?? ''}
                                    onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="amount" />
                                <UnitSelect value={f.amount_unit ?? ''}
                                    onChange={(v) => setF({ ...f, amount_unit: v })} />
                            </div></div>
                        <div className="nf-field wide"><label>Notes</label>
                            <textarea className="in ta" rows="2" value={f.notes}
                                onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
                    </div>
                    <div className="edit-row">
                        <button className="mini" onClick={submit}>Save</button>
                        <button className="mini ghost" onClick={() => setForm(null)}>Cancel</button>
                        {!isNew && (
                            <button className="mini danger" onClick={() => {
                                if (confirm('Remove this unit from stock?')) { onDelete(form); setForm(null); }
                            }}>Delete</button>
                        )}
                    </div>
        </div>
    );

    return (
        <>
            <div className="bar" style={{ marginTop: 4 }}>
                <div className="eyebrow">Sterile and uninoculated - not yet in the lineage tree</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select className="in sel" style={{ flex: '0 0 auto', width: 'auto' }} value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
                        <option value="">All kinds</option>
                        {Object.keys(kindGroups).sort().map((k) => <option key={k} value={k}>{STOCK_KIND[k]}</option>)}
                    </select>
                    {form === null && <button className="sw" onClick={() => { setF(blank); setForm('new'); }}>+ Add stock</button>}
                </div>
            </div>

            {form === 'new' && formPanel}

            {Object.keys(kindGroups).sort().filter((k) => !kindFilter || k === kindFilter).map((k) => {
                /* Two levels: product (same recipe/supplier/product -
                   "all the Master Mix together," Matt's ask 2026-09-23) is
                   the outer grouping now, with session (the old top-level
                   grouping - same day's Add-stock submission, via
                   stockBatchKey) nested inside it. A session still shows
                   its own date and still gets its own Print/Queue and
                   active/done split exactly as before - it just no longer
                   splits its product apart from every other session of
                   the same thing. */
                const products = {};
                kindGroups[k].forEach((s) => { (products[stockProductKey(s)] ||= []).push(s); });
                const productList = Object.values(products).sort((a, b) => {
                    const latest = (arr) => arr.reduce((m, s) => ((s.made_or_bought_on ?? '') > m ? (s.made_or_bought_on ?? '') : m), '');
                    return latest(b).localeCompare(latest(a));
                });

                return (
                    <div key={k}>
                        <div className="sec" style={{ marginTop: 22 }}><span>{STOCK_KIND[k]}</span></div>
                        {productList.map((productUnits) => {
                            const sessions = {};
                            productUnits.forEach((s) => { (sessions[stockBatchKey(s)] ||= []).push(s); });
                            const sessionList = Object.values(sessions).sort((a, b) =>
                                (b[0].made_or_bought_on ?? '').localeCompare(a[0].made_or_bought_on ?? ''));
                            const rep = [...productUnits].sort((a, b) =>
                                (b.made_or_bought_on ?? '').localeCompare(a.made_or_bought_on ?? ''))[0];
                            const productOnHand = productUnits.filter((s) => s.status === 'on_hand').length;

                            return (
                                <div key={stockProductKey(rep)} className="stock-product">
                                    <div className="stock-product-head">
                                        <span className="equip-name">{stockLabel(rep, library, suppliers)}</span>
                                        <span className="equip-note">{productOnHand} of {productUnits.length} on hand</span>
                                    </div>
                                    {sessionList.map((units) => {
                                        const sorted = [...units].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
                                        const first = sorted[0];
                                        const onHand = sorted.filter((s) => s.status === 'on_hand');

                                        /* A unit whose item is done (retired/contaminated/
                                           failed/consumed - see DONE_ITEM_STATUSES) isn't
                                           going back into rotation 9 times out of 10, so
                                           it's a record now, not something to hunt through
                                           active stock for. */
                                        const madeIntoFor = (s) => s.consumed_into_item_id && items.find((it) => it.uid === s.consumed_into_item_id);
                                        const isDone = (s) => DONE_ITEM_STATUSES.includes(madeIntoFor(s)?.status);
                                        const withIdx = sorted.map((s, i) => ({ s, i }));
                                        const activeUnits = withIdx.filter(({ s }) => !isDone(s));
                                        const doneUnits = withIdx.filter(({ s }) => isDone(s));

                                        const renderUnit = ({ s, i }) => {
                                            const st = STOCK_STATUS[s.status] ?? STOCK_STATUS.on_hand;
                                            const madeInto = madeIntoFor(s);
                                            const done = isDone(s);
                                            return (
                                                <div key={s.id}>
                                                <div className={`equip-row${done ? ' done' : ''}`}>
                                                    <button className="equip-row-main" onClick={() => {
                                                        setF({ kind: s.kind, source: s.source, recipe_id: s.recipe_id ?? '',
                                                            supplier_id: s.supplier_id ?? '', product_name: s.product_name ?? '',
                                                            quantity: '1', labels: '',
                                                            label: s.label ?? '',
                                                            made_or_bought_on: s.made_or_bought_on ?? '', status: s.status, notes: s.notes ?? '',
                                                            amount: s.amount ?? '', amount_unit: s.amount_unit ?? '' });
                                                        setForm(s.id);
                                                    }}>
                                                        <span className="equip-name">{s.label || `Unit ${i + 1}`}</span>
                                                        {madeInto && <span className="equip-note">→ became {madeInto.id}</span>}
                                                        <span className={`pill tone-${st.tone}`}>{st.label}</span>
                                                    </button>
                                                    {madeInto && (
                                                        <div className="equip-side">
                                                            <button className="mini ghost" onClick={() => onOpenItem(madeInto.id)}>Open {madeInto.id}</button>
                                                        </div>
                                                    )}
                                                </div>
                                                {form === s.id && formPanel}
                                                </div>
                                            );
                                        };

                                        return (
                                            <div key={stockBatchKey(first)} className="stock-batch">
                                                <div className="stock-batch-head">
                                                    <div>
                                                        <span className="equip-name">{first.made_or_bought_on ? fmt(first.made_or_bought_on, dateFormat) : 'No date logged'}</span>
                                                        <span className="equip-note">
                                                            {first.source === 'made' ? 'made' : 'bought'}
                                                            {' · '}{onHand.length} of {sorted.length} on hand
                                                        </span>
                                                    </div>
                                                    {onHand.length > 0 && (
                                                        <div className="pl-icon-row">
                                                            <button className="pl-icon-btn pl-trigger" title="Print labels for this session's on-hand units"
                                                                onClick={() => onPrintStock(onHand.map((s) => s.id))}>
                                                                <PrinterIcon />
                                                            </button>
                                                            <button className="pl-icon-btn pl-queue" title="Add this session's on-hand labels to the print queue instead"
                                                                onClick={() => onQueueStock(onHand.map((s) => s.id))}>
                                                                <PrinterQueueIcon />
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="equip-list">
                                                    {activeUnits.map(renderUnit)}
                                                </div>
                                                {doneUnits.length > 0 && (
                                                    <>
                                                        <div className="stock-archive-label">No longer active</div>
                                                        <div className="equip-list">
                                                            {doneUnits.map(renderUnit)}
                                                        </div>
                                                    </>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            );
                        })}
                    </div>
                );
            })}
            {stock.length === 0 && form === null && (
                <p className="nf-help nf-help-page" style={{ marginTop: 18 }}>Nothing in stock yet.</p>
            )}
        </>
    );
}

/* ---------------- SUPPLIES ---------------- */
/* "What's on hand, or where I get it" - Stock, Equipment, Suppliers.
   Each of the three sub-tabs is a fully self-contained component with its
   own add/edit form, so this shell is just the tab switcher - no shared
   form state needed here. Split out from the old combined "Library"
   screen (2026-08-31): Stock/Equipment/Suppliers used to live as three of
   four tabs alongside Reference under a screen literally named "Library",
   which had drifted into a catch-all with no real shared identity. This
   half keeps the "stuff I have or can get" grouping; see ReferenceSection
   below for the "stuff I read" half. */
function Supplies({ stock, library, species, suppliers, equipment, initialTab, initialOpenId, items,
    onAddStock, onEditStock, onDeleteStock, onPrintStock, onQueueStock, onOpenItem,
    onAddEquip, onEditEquip, onDeleteEquip, photos, photoUrl, onAddPhoto, onDeletePhoto, onEditPhoto, onBumpEquipQty,
    onAddSupplier, onEditSupplier, onDeleteSupplier, onGetOrCreateSupplier, dateFormat }) {
    const [tab, setTab] = useState(initialTab || 'stock');
    return (
        <div className="page">
            <div className="bar">
                <div>
                    <div className="eyebrow">What's on hand, and where it comes from</div>
                    <h1>Supplies</h1>
                </div>
            </div>
            <div className="tabs">
                <button className={`tab ${tab === 'stock' ? 'on' : ''}`} onClick={() => setTab('stock')}>Stock</button>
                <button className={`tab ${tab === 'equipment' ? 'on' : ''}`} onClick={() => setTab('equipment')}>Equipment</button>
                <button className={`tab ${tab === 'suppliers' ? 'on' : ''}`} onClick={() => setTab('suppliers')}>Suppliers</button>
            </div>
            {tab === 'stock' ? (
                <StockTab stock={stock} library={library} suppliers={suppliers} species={species} items={items}
                    onAdd={onAddStock} onEdit={onEditStock} onDelete={onDeleteStock}
                    onPrintStock={onPrintStock} onQueueStock={onQueueStock} onOpenItem={onOpenItem} initialOpenId={initialOpenId}
                    onGetOrCreateSupplier={onGetOrCreateSupplier} dateFormat={dateFormat} />
            ) : tab === 'equipment' ? (
                <EquipmentTab equipment={equipment} onAdd={onAddEquip} onEdit={onEditEquip} onDelete={onDeleteEquip}
                    photos={photos} photoUrl={photoUrl} onAddPhoto={onAddPhoto} onDeletePhoto={onDeletePhoto} onEditPhoto={onEditPhoto}
                    onBumpQty={onBumpEquipQty} initialOpenId={initialOpenId} dateFormat={dateFormat} />
            ) : (
                <SupplierTab suppliers={suppliers} onAdd={onAddSupplier} onEdit={onEditSupplier} onDelete={onDeleteSupplier}
                    initialOpenId={initialOpenId} />
            )}
        </div>
    );
}

/* ---------------- REFERENCE ---------------- */
/* "What I read, or what I follow" - recipes, instruction sheets/notes, and
   the species cheat sheet, merged into one filterable feed (2026-09-08
   redesign - was two tabs plus a separate cheat-sheet section before).
   Three chip rows AND together: Type (Recipe/Reference/Cheat Sheet),
   Category (shared field across recipes+notes, cheat sheet has none so it
   naturally drops out whenever a category chip is active), and Species
   (true multi-select, plus an explicit General chip - "applies to every
   species" is a real flag on the row, never implied by an empty tag list).
   Recipes and notes both live in `library`, split by `kind`; species tags
   live in the `library_species` join table, not a single species_id
   column, since one recipe can suit several species. */
function StepChecklist({ steps, checked, onToggle, onReset }) {
    const checkedSet = new Set(checked ?? []);
    return (
        <div className="checklist">
            <div className="check-progress">
                {checkedSet.size}/{steps.length} done
                {checkedSet.size > 0 && <button className="mini ghost" onClick={onReset}>Reset</button>}
            </div>
            {steps.map((step, i) => (
                <button key={i} type="button" className={`check-row ${checkedSet.has(i) ? 'done' : ''}`} onClick={() => onToggle(i)}>
                    <span className="check-box">{checkedSet.has(i) ? '\u2713' : i + 1}</span>
                    <span className="check-label">{step}</span>
                </button>
            ))}
        </div>
    );
}

/* Species-level cultivation facts, pulled straight from the species record
   (fruiting_temp, humidity, fae, colonize_temp, colonize_time, pin_to_harvest,
   substrate_note, notes) - no separate copy of this data lives in library. */
const QUICK_FACT_LABELS = [
    ['fruiting_temp', 'Fruit \u00b0F'], ['colonize_temp', 'Colonize \u00b0F'], ['humidity', 'RH %'], ['fae', 'FAE'],
    ['colonize_time', 'Colonize time'], ['pin_to_harvest', 'Pin to harvest'], ['substrate_note', 'Substrate'],
];

function SpeciesFactsCard({ sp, isOpen, onToggle, unitsPref, onEditSpecies }) {
    const facts = QUICK_FACT_LABELS.filter(([key]) => sp[key]);
    const [editing, setEditing] = useState(false);
    const [sf, setSf] = useState(null);
    const startEdit = () => {
        setSf({
            common_name: sp.common_name ?? "", latin_name: sp.latin_name ?? "",
            fruiting_temp: sp.fruiting_temp ?? "", humidity: sp.humidity ?? "",
            fae: sp.fae ?? "",
            colonize_temp: sp.colonize_temp ?? "", colonize_time: sp.colonize_time ?? "",
            pin_to_harvest: sp.pin_to_harvest ?? "", substrate_note: sp.substrate_note ?? "",
            dry_yield_pct: sp.dry_yield_pct ?? "", notes: sp.notes ?? "",
        });
        setEditing(true);
    };
    return (
        <div className={`lib-card ${isOpen ? 'open' : ''}`}>
            <button className="lib-head" onClick={onToggle}>
                <div>
                    <div className="lib-title">{sp.common_name}</div>
                    <div className="lib-meta"><span className="lib-sp">{sp.latin_name}</span></div>
                </div>
                <span className="lib-chev">{isOpen ? '\u2212' : '+'}</span>
            </button>
            {isOpen && (
                <div className="lib-body">
                    {editing && (
                        /* Same field set/order as Tree's "Edit species" form (Cultures side) -
                           both write through the same saveSpeciesFields function, so editing
                           from here or from Cultures ends up at the exact same record. */
                        <div className="new-form">
                            <div className="nf-title">Edit species</div>
                            <div className="nf-grid">
                                <div className="nf-field wide"><label>Common name</label>
                                    <input className="in" value={sf.common_name} onChange={(e) => setSf({ ...sf, common_name: e.target.value })} /></div>
                                <div className="nf-field wide"><label>Latin name</label>
                                    <input className="in" value={sf.latin_name} onChange={(e) => setSf({ ...sf, latin_name: e.target.value })} /></div>
                                <div className="nf-field"><label>Fruiting temp</label>
                                    <input className="in" value={sf.fruiting_temp} onChange={(e) => setSf({ ...sf, fruiting_temp: e.target.value })} /></div>
                                <div className="nf-field"><label>Humidity</label>
                                    <input className="in" value={sf.humidity} onChange={(e) => setSf({ ...sf, humidity: e.target.value })} /></div>
                                <div className="nf-field"><label>FAE</label>
                                    <input className="in" value={sf.fae} onChange={(e) => setSf({ ...sf, fae: e.target.value })} /></div>
                                <div className="nf-field"><label>Colonize temp</label>
                                    <input className="in" value={sf.colonize_temp} onChange={(e) => setSf({ ...sf, colonize_temp: e.target.value })} /></div>
                                <div className="nf-field"><label>Colonize time</label>
                                    <input className="in" value={sf.colonize_time} onChange={(e) => setSf({ ...sf, colonize_time: e.target.value })} /></div>
                                <div className="nf-field"><label>Pin to harvest</label>
                                    <input className="in" value={sf.pin_to_harvest} onChange={(e) => setSf({ ...sf, pin_to_harvest: e.target.value })} /></div>
                                <div className="nf-field wide"><label>Substrate</label>
                                    <input className="in" value={sf.substrate_note} onChange={(e) => setSf({ ...sf, substrate_note: e.target.value })} /></div>
                                <div className="nf-field"><label>Dry yield % (optional)</label>
                                    <input className="in" inputMode="decimal" value={sf.dry_yield_pct} placeholder="e.g. 8.9"
                                        onChange={(e) => setSf({ ...sf, dry_yield_pct: e.target.value })} /></div>
                                <div className="nf-field wide"><label>Notes</label>
                                    <textarea className="in ta" rows="3" value={sf.notes} onChange={(e) => setSf({ ...sf, notes: e.target.value })} /></div>
                            </div>
                            <div className="edit-row">
                                <button className="mini" onClick={() => {
                                    if (!sf.common_name.trim()) { alert('Common name is required.'); return; }
                                    onEditSpecies(sp.id, sf); setEditing(false);
                                }}>Save</button>
                                <button className="mini ghost" onClick={() => setEditing(false)}>Cancel</button>
                            </div>
                        </div>
                    )}
                    {!editing && (
                        <>
                            {facts.length > 0 && (
                                <div className="qf-grid">
                                    {facts.map(([key, label]) => {
                                        const isTemp = key === 'fruiting_temp' || key === 'colonize_temp';
                                        const value = isTemp ? displayTempText(sp[key], unitsPref) : sp[key];
                                        const shownLabel = isTemp && unitsPref === 'metric' ? `${label} (+°C)` : label;
                                        return (
                                            <div key={key} className="qf-tile">
                                                <div className="qf-label">{shownLabel}</div>
                                                <div className="qf-value">{value}</div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            {sp.notes && <p className="qf-note">{sp.notes}</p>}
                            {facts.length === 0 && !sp.notes && (
                                <p className="notes empty-note">No cheat-sheet facts saved yet - edit below to add them.</p>
                            )}
                            <button className="mini ghost" onClick={startEdit}>Edit</button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

/* Card rendering, shared across every kind now that Recipes/Reference/
   Cheat Sheet are one merged feed. A real component (not a closure called
   during render) so state like the open/close chevron works cleanly.
   `recipes` used to come from which tab you were on - now each card
   decides its own layout purely from e.kind, and shows every species it's
   tagged to (not just one) plus a General badge when that flag is set. */
function LibCard({ e, species, librarySpecies, isOpen, onToggle, onEdit, onToggleChecklistStep, onResetChecklist, unitsPref }) {
    const isRecipe = e.kind === 'recipe';
    const tagIds = new Set(librarySpecies.filter((r) => r.library_id === e.id).map((r) => r.species_id));
    const tags = species.filter((s) => tagIds.has(s.id));
    return (
        <div className={`lib-card ${isOpen ? 'open' : ''}`}>
            <button className="lib-head" onClick={onToggle}>
                <div>
                    <div className="lib-title">{e.title}</div>
                    <div className="lib-meta">
                        <span className="lib-kind">{isRecipe ? 'Recipe' : (KINDS[e.kind] ?? e.kind)}</span>
                        {e.categories?.map((c) => <span key={c} className="lib-kind">{c}</span>)}
                        {isRecipe && e.yield_amount && <span className="lib-kind">
                            {e.categories?.includes('Capsule blend') ? `${e.yield_amount} capsules` : `makes ${e.yield_amount}${e.yield_unit}`}
                        </span>}
                        {e.general && <span className="lib-sp">General</span>}
                        {tags.map((s) => <span key={s.id} className="lib-sp">{s.common_name}</span>)}
                    </div>
                </div>
                <span className="lib-chev">{isOpen ? '\u2212' : '+'}</span>
            </button>
            {isOpen && (
                <div className="lib-body">
                    {e.url && <a className="lib-link" href={e.url} target="_blank" rel="noreferrer">{e.url}</a>}
                    {isRecipe && e.categories?.includes('Capsule blend') && e.ingredients?.length > 0 && (
                        <CapsuleBlendCard recipe={e} species={species} />
                    )}
                    {isRecipe && !e.categories?.includes('Capsule blend') && e.ingredients?.length > 0 && <RecipeIngredients recipe={e} unitsPref={unitsPref} />}
                    {e.steps?.length > 0 && <StepChecklist steps={e.steps} checked={e.checklist_checked}
                        onToggle={(i) => onToggleChecklistStep(e.id, i)} onReset={() => onResetChecklist(e.id)} />}
                    {e.body && (
                        e.steps?.length > 0
                            ? <details className="lib-fulltext"><summary>Full notes</summary><pre className="lib-text">{e.body}</pre></details>
                            : <pre className="lib-text">{e.body}</pre>
                    )}
                    {!e.url && !e.body && !(e.ingredients?.length) && <p className="notes empty-note">No content saved.</p>}
                    <button className="mini ghost" onClick={onEdit}>Edit</button>
                </div>
            )}
        </div>
    );
}

/* Tiny inline icon, shared by the hero/secondary cards and the
   most-visited tiles - same stroke style as the sidebar NAV icons
   (SECTION_ICONS), just resizable per call site. */
function HomeIcon({ path, size = 18 }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
            strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>
    );
}

/* ---------------- HOME ---------------- */
/* The real default landing screen (2026-09-17, "a true Home Screen, not
   just a half landing page" per Matt) - five cards giving a genuine
   at-a-glance read on each section, plus a "most visited" quick-nav
   blending record opens and section opens (Matt: "a section that is
   most visited links to speed up navigation"; AskUserQuestion answer:
   "Both", synced across devices). Every card doubles as a link into its
   own section - Matt's explicit build requirement. Calls the same
   itemOutcome() helper the real Data tab uses (hoisted to module scope,
   see its definition near FRUITS/DONE_ITEM_STATUSES) so the Data card's
   rate can never drift from the real Data tab's.

   Redesigned 2026-09-18 - Matt's first-launch reaction was "it's kinda
   dull": five identical dark boxes, no icons, no color, huge dead
   whitespace, and none of the app's own visual language (the sidebar's
   own icons, the jade/amber/rust status-tone vocabulary already used
   everywhere else). This pass gives Cultivation a featured hero card
   (it's the "what's alive right now" headline stat), reuses SECTION_ICONS/
   SECTION_ACCENTS on every card and on Most Visited's tiles, colors the
   Data card by the success rate itself instead of a fixed tone, and
   clamps subtitle text to one line so card heights stop being ragged. */
function HomeTab({ items, genetics, species, lots, library, stock, usageEvents, searchProps, profile, avatarUrl, onGoSection, onOpenItem, onOpenLot, onOpenSpecies, onOpenLibrary, onOpenAccount, onOpenSettings, printQueueCount, onOpenPrintQueue }) {
    const geneticsFor = (item) => genetics.find((g) => g.id === item.geneticsId);
    const speciesFor = (item) => { const gen = geneticsFor(item); return gen && species.find((s) => s.id === gen.species_id); };
    const visibleItems = items.filter((i) => !speciesFor(i)?.hidden && !geneticsFor(i)?.hidden);

    // Cultivation: what's actually alive right now, broken down by stage -
    // a single "44 active" reads as an empty number on a wide desktop hero
    // card, so the breakdown is what actually fills that space with real
    // content instead of padding it out cosmetically.
    const colonizingCount = visibleItems.filter((i) => i.status === 'colonizing').length;
    const colonizedCount = visibleItems.filter((i) => i.status === 'colonized').length;
    const fruitingCount = visibleItems.filter((i) => i.status === 'fruiting').length;
    const activeCount = visibleItems.filter((i) => STATUS[i.status]?.live).length;

    // Harvests: most recent lot + this calendar month's total (gross
    // harvested, not remaining-on-hand - "how much did I actually pull
    // this month" is the at-a-glance question here).
    const sortedLots = [...lots].sort((a, b) => (b.harvested_on ?? '').localeCompare(a.harvested_on ?? ''));
    const latestLot = sortedLots[0];
    const thisMonth = todayISO().slice(0, 7);
    const monthTotalG = lots.filter((l) => (l.harvested_on ?? '').startsWith(thisMonth))
        .reduce((s, l) => s + Number(l.amount_g || 0), 0);

    /* Supplies: no reorder-threshold field exists in the schema yet, so
       "low stock" isn't answerable - this just flags the one boundary
       condition that IS answerable (nothing on hand at all). A real
       low-stock threshold would need a schema change; worth revisiting
       if Matt wants per-item reorder points later. */
    const onHandStock = stock.filter((s) => s.status === 'on_hand');
    const onHandCount = onHandStock.reduce((s, r) => s + (Number(r.quantity) || 1), 0);

    // Library: how much is in there + the newest addition.
    const sortedLibrary = [...library].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    const latestEntry = sortedLibrary[0];

    // Data: identical resolved-runs-only success rate as the real Data tab -
    // itemOutcome, not raw status (see its definition) so this stays in
    // sync with how Data itself now judges a run.
    const successCount = visibleItems.filter((i) => itemOutcome(i, items) === 'success').length;
    const failCount = visibleItems.filter((i) => itemOutcome(i, items) === 'fail').length;
    const resolvedCount = successCount + failCount;
    const successRate = resolvedCount ? Math.round((successCount / resolvedCount) * 100) : null;
    // Colored by the number itself, not a fixed tone - this is the one
    // card where color can actually report something rather than just
    // decorate. Thresholds are deliberately generous (a home cultivation
    // hobby isn't a lab) - just enough to separate "going well" from
    // "worth a look" from "rough patch."
    const dataAccent = successRate == null ? 'var(--slate)' : successRate >= 70 ? 'var(--jade)' : successRate >= 40 ? 'var(--amber)' : 'var(--rust)';

    /* Most-visited: frequency within the capped, most-recent-400-event
       window already fetched in App() - that cap makes the count itself
       recency-biased without needing separate time-decay math. Ties
       broken by most recent occurrence. section_open events are dropped
       entirely here - all 5 sections already have their own card up top
       (hero + secondary), so repeating them as tiles here was pure
       duplication (Matt: "I dont really want the tab duplicated from the
       top to the most visited space"). This is specific records only -
       a species, a recipe, a lot - capped at 5. */
    const visitCounts = new Map();
    (usageEvents || []).forEach((ev) => {
        if (ev.event_type === 'section_open') return;
        const k = `${ev.entity_type}:${ev.entity_id}`;
        const existing = visitCounts.get(k);
        if (existing) existing.count += 1;
        else visitCounts.set(k, {
            count: 1, lastAt: ev.created_at, section: ev.section,
            entityType: ev.entity_type, entityId: ev.entity_id,
            label: ev.entity_label || ev.entity_id,
        });
    });
    const mostVisited = [...visitCounts.values()]
        .sort((a, b) => b.count - a.count || (b.lastAt ?? '').localeCompare(a.lastAt ?? ''))
        .slice(0, 5);

    const openVisit = (v) => {
        if (v.entityType === 'item') onOpenItem(v.entityId);
        else if (v.entityType === 'lot') onOpenLot(v.entityId);
        else if (v.entityType === 'species') onOpenSpecies(v.entityId);
        else if (v.entityType === 'library') onOpenLibrary({ id: v.entityId, title: v.label });
        // Supply entries and anything else without a full jump-back path
        // yet just land on their section - still faster than hunting
        // through the sidebar.
        else onGoSection(v.section);
    };

    const secondary = [
        { key: 'inventory', title: 'Harvests', stat: monthTotalG ? `${monthTotalG}g` : '—',
            sub: `this month${latestLot ? ` · latest: ${latestLot.label}` : ''}` },
        { key: 'supplies', title: 'Supplies', stat: onHandCount,
            sub: onHandCount === 0 ? 'nothing in stock' : 'on hand' },
        { key: 'reference', title: 'Library', stat: library.length,
            sub: `entries${latestEntry ? ` · latest: ${latestEntry.title}` : ''}` },
        { key: 'data', title: 'Data', stat: successRate == null ? '—' : `${successRate}%`,
            sub: 'success rate', accent: dataAccent },
    ];

    return (
        <div className="page">
            {/* Sidebar (with its .brand logo) is hidden on Home - see
                shell-home in App.jsx - so this is the only branding left on
                a desktop-width screen. Mobile already has its own logo in
                .mobile-brand up top, so this is CSS-hidden there. */}
            <div className="home-logo">
                <img src={`${import.meta.env.BASE_URL}sporedesk-header-logo-light.webp`} alt="SporeDesk" className="brand-logo" />
            </div>

            <div className="bar">
                <div>
                    <div className="eyebrow">Everything, at a glance</div>
                    <h1>Home</h1>
                </div>
                {/* Desktop-only stand-in for the sidebar's search, same as
                    .home-logo above - mobile already has one pinned in
                    .mobile-brand regardless of section. */}
                <div className="home-search">
                    <SearchBox {...searchProps} />
                    <PrintQueueButton count={printQueueCount} onOpen={onOpenPrintQueue} />
                </div>
            </div>

            <div className="home-top-row">
                <button className="home-hero" onClick={() => onGoSection('cultures')} style={{ '--accent': SECTION_ACCENTS.cultures }}>
                    <div className="home-hero-icon"><HomeIcon path={SECTION_ICONS.cultures} size={28} /></div>
                    <div className="home-hero-body">
                        <div className="home-card-title">Cultivation</div>
                        <div className="home-hero-stat">{activeCount}<span className="home-hero-stat-unit">active</span></div>
                    </div>
                    {/* Breaks the headline number down by stage - on a wide
                        desktop card, "44 active" alone left most of the box
                        empty; this is what actually fills that space with real
                        content instead of padding. Desktop-only, see CSS. */}
                    <div className="home-hero-divider" />
                    <div className="home-hero-breakdown">
                        <div className="home-hero-bd-item"><span className="home-hero-bd-num">{colonizingCount}</span><span className="home-hero-bd-label">Colonizing</span></div>
                        <div className="home-hero-bd-item"><span className="home-hero-bd-num">{colonizedCount}</span><span className="home-hero-bd-label">Colonized</span></div>
                        <div className="home-hero-bd-item"><span className="home-hero-bd-num">{fruitingCount}</span><span className="home-hero-bd-label">Fruiting</span></div>
                    </div>
                </button>

                {/* Account/Settings used to live only in the sidebar, which
                    Home hides - these fill the space that used to sit dead
                    to the hero's right on a wide desktop screen (Matt: "account
                    and settings need to be to the right of cultivation to fill
                    that space under the search bar in two separate cards"),
                    and stack under the hero on mobile instead (see CSS). */}
                <button className="home-side-card" onClick={onOpenAccount} style={{ '--accent': 'var(--slate)' }}>
                    <div className="home-side-icon">
                        <AvatarBadge url={profile?.avatar_url ? avatarUrl : null} preset={profile?.avatar_preset} size={22} />
                    </div>
                    <div>
                        <div className="home-card-title">Account</div>
                        <div className="home-side-value">{profile?.display_name || 'View profile'}</div>
                    </div>
                </button>
                <button className="home-side-card" onClick={onOpenSettings} style={{ '--accent': 'var(--slate)' }}>
                    <div className="home-side-icon">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="3" />
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                        </svg>
                    </div>
                    <div>
                        <div className="home-card-title">Settings</div>
                        <div className="home-side-value">Preferences</div>
                    </div>
                </button>
            </div>

            {/* Secondary sections as a dense list instead of a card grid -
                a sparse 4-5 metric dashboard is a bad fit for a KPI-grid:
                Grid's auto-fit columns are always equal-width regardless of
                content, so content-hugging boxes in those columns produced
                uneven "welded together / big gap" spacing (Harvests' long
                line vs. Supplies' short one) no matter how the box itself
                was padded or sized. A list has no per-item box to leave
                dead space inside - each row just spans the full list width
                and sits a fixed 1px rule above the next one. */}
            <div className="home-list">
                {secondary.map((c) => (
                    <button key={c.key} className="home-list-row" onClick={() => onGoSection(c.key)}
                        style={{ '--accent': c.accent ?? SECTION_ACCENTS[c.key] }}>
                        <div className="home-list-icon"><HomeIcon path={SECTION_ICONS[c.key]} size={18} /></div>
                        <div className="home-list-title">{c.title}</div>
                        <div className="home-list-stat" style={c.accent ? { color: c.accent } : undefined}>{c.stat}</div>
                        <div className="home-list-sub">{c.sub}</div>
                        <div className="home-list-chev">&rsaquo;</div>
                    </button>
                ))}
            </div>

            {mostVisited.length > 0 && (
                <div className="home-mv">
                    <div className="home-mv-title">Most visited</div>
                    <div className="home-mv-list">
                        {mostVisited.map((v) => (
                            <button key={`${v.entityType}:${v.entityId}`}
                                className="home-mv-item" onClick={() => openVisit(v)}
                                style={{ '--accent': SECTION_ACCENTS[v.section] ?? 'var(--slate)' }}>
                                <span className="home-mv-icon"><HomeIcon path={SECTION_ICONS[v.section] ?? SECTION_ICONS.data} size={14} /></span>
                                <span className="home-mv-text">
                                    <span className="home-mv-label">{v.label}</span>
                                    <span className="home-mv-meta">{SECTION_LABELS[v.section] ?? v.section}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function ReferenceSection({ library, librarySpecies, species, initialOpenId, onAdd, onEdit, onDelete, onToggleChecklistStep, onResetChecklist, unitsPref, onEditSpecies, onLogOpen }) {
    const [form, setForm] = useState(null);   // null | 'new' | entry id
    const blank = { title: '', kind: 'recipe', url: '', body: '', speciesIds: [], general: false,
        categories: [], yield_amount: '', yield_unit: 'mL', ingredients: [], buffer_pct: '', steps: [] };
    const [f, setF] = useState(blank);
    const [openId, setOpenId] = useState(initialOpenId || null);
    /* Three dropdown filters, ANDed together - Type narrows to Recipe/
       Reference/Cheat Sheet (or "All" = everything mixed); Category picks
       one value from `library.categories` (text[] - an entry can carry
       several, e.g. Cordyceps Nutrient Broth is both Nutrient broth AND
       Bulk substrate, but the filter just needs the entry to include
       whichever one you pick; a Cheat Sheet card has no categories, so
       it simply can't match once a category is picked - expected, not
       a bug); Species picks one species (or "General" for non-species-
       specific entries) via the library_species join table. These used
       to be multi-select chip rows - swapped for single-select dropdowns
       2026-09-13 per Matt (too many chips, too busy) - so stacking two
       categories or two species in one filter pass isn't possible
       anymore, but picking one is one click instead of hunting a chip. */
    const [typeFilter, setTypeFilter] = useState('');          // '' | 'recipe' | 'note' | 'cheat'
    const [categoryFilter, setCategoryFilter] = useState('');  // '' = all
    const [speciesFilter, setSpeciesFilter] = useState('');    // '' | 'general' | species id
    /* Calculators used to be its own nav tab; folded in here 2026-09-17
       (tab rebalance) since it's barely used next to the others and
       doesn't need a dedicated bottom-bar slot - a segmented toggle
       swaps between the library view above and the calculator grid. */
    const [viewMode, setViewMode] = useState('library');       // 'library' | 'calculators'
    const filterableSpecies = species.filter((s) => !s.hidden);
    const categories = [...new Set(library.flatMap((e) => e.categories ?? []))].sort();
    const speciesIdsFor = (entryId) => librarySpecies.filter((r) => r.library_id === entryId).map((r) => r.species_id);

    /* Every ingredient name already used anywhere in the library, so typing
       one in offers the browser's native autocomplete instead of retyping
       it fresh - and keeps spelling consistent across recipes over time. */
    const knownIngredients = [...new Set(
        library.flatMap((e) => e.ingredients?.map((row) => row.name?.trim()).filter(Boolean) ?? [])
    )].sort();

    const submit = () => {
        if (!f.title.trim()) { alert('Title is required.'); return; }
        if (form === 'new') onAdd(f);
        else onEdit(form, f);
        setForm(null); setF(blank);
    };

    const startEdit = (e) => {
        setF({
            title: e.title, kind: e.kind, url: e.url ?? '', body: e.body ?? '',
            speciesIds: speciesIdsFor(e.id), general: !!e.general,
            categories: e.categories ?? [], yield_amount: e.yield_amount ?? '', yield_unit: e.yield_unit ?? 'mL',
            ingredients: e.ingredients ?? [], buffer_pct: e.buffer_pct ?? '', steps: e.steps ?? [],
        });
        setForm(e.id);
    };

    const cheatCards = filterableSpecies.map((s) => ({ cardType: 'cheat', cardId: `sp:${s.id}`, sp: s }));
    const libCards = library.map((e) => ({
        cardType: e.kind === 'recipe' ? 'recipe' : 'note',
        cardId: e.id, e,
        categories: e.categories ?? [],
        speciesIds: speciesIdsFor(e.id),
        general: !!e.general,
    }));
    const visibleCards = [...cheatCards, ...libCards]
        .filter((c) => !typeFilter || c.cardType === typeFilter)
        .filter((c) => !categoryFilter || c.categories?.includes(categoryFilter))
        .filter((c) => {
            if (!speciesFilter) return true;
            if (c.cardType === 'cheat') return speciesFilter !== 'general' && c.sp.id === speciesFilter;
            return speciesFilter === 'general' ? c.general : c.speciesIds.includes(speciesFilter);
        })
        .sort((a, b) => (a.cardType === 'cheat' ? a.sp.common_name : a.e.title)
            .localeCompare(b.cardType === 'cheat' ? b.sp.common_name : b.e.title));

    return (
        <div className="page">
            <div className="bar">
                <div>
                    <div className="eyebrow">Recipes, reference & the species cheat sheet - filter by any combination</div>
                    <h1>Library</h1>
                </div>
                {viewMode === 'library' && form === null && (
                    <button className="sw" onClick={() => { setF(blank); setForm('new'); }}>+ Add</button>
                )}
            </div>

            <div className="seg">
                <button className={viewMode === 'library' ? 'on' : ''} onClick={() => setViewMode('library')}>Library</button>
                <button className={viewMode === 'calculators' ? 'on' : ''} onClick={() => setViewMode('calculators')}>Calculators</button>
            </div>

            {viewMode === 'calculators' && <Calculators species={species} embedded />}

            {viewMode === 'library' && (<>

            <div className="sp-chips">
                <span className="sp-chips-label">Type:</span>
                <select className="in sel" style={{ flex: '0 0 auto', width: 'auto' }}
                    value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                    <option value="">All</option>
                    <option value="recipe">Recipe</option>
                    <option value="note">Reference</option>
                    <option value="cheat">Cheat Sheet</option>
                </select>

                {categories.length > 0 && (
                    <>
                        <span className="sp-chips-label">Category:</span>
                        <select className="in sel" style={{ flex: '0 0 auto', width: 'auto' }}
                            value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
                            <option value="">All</option>
                            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                    </>
                )}

                {filterableSpecies.length > 0 && (
                    <>
                        <span className="sp-chips-label">Species:</span>
                        <select className="in sel" style={{ flex: '0 0 auto', width: 'auto' }}
                            value={speciesFilter} onChange={(e) => setSpeciesFilter(e.target.value)}>
                            <option value="">All species</option>
                            <option value="general">General</option>
                            {filterableSpecies.map((s) => <option key={s.id} value={s.id}>{s.common_name}</option>)}
                        </select>
                    </>
                )}
            </div>

            {form !== null && (
                <div className="new-form">
                    <div className="nf-title">{form === 'new' ? 'New' : 'Edit'} entry</div>
                    <div className="nf-grid">
                        <div className="nf-field wide"><label>Title</label>
                            <input className="in" autoFocus value={f.title}
                                placeholder="Homemade MEA - 8 oz jar"
                                onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
                        <div className="nf-field"><label>Kind</label>
                            <select className="in sel" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
                                {Object.keys(KINDS).map((k) => <option key={k} value={k}>{KINDS[k]}</option>)}
                            </select></div>
                        <div className="nf-field wide"><label>Species (pick any that apply)</label>
                            <div className="sp-chips" style={{ marginTop: 4 }}>
                                <button type="button" className={`sp-chip ${f.general ? 'on' : ''}`}
                                    onClick={() => setF({ ...f, general: !f.general })}>General (all species)</button>
                                {species.filter((s) => !s.hidden || f.speciesIds.includes(s.id)).map((s) => (
                                    <button type="button" key={s.id} className={`sp-chip ${f.speciesIds.includes(s.id) ? 'on' : ''}`}
                                        onClick={() => setF({ ...f, speciesIds: f.speciesIds.includes(s.id)
                                            ? f.speciesIds.filter((id) => id !== s.id) : [...f.speciesIds, s.id] })}>
                                        {s.common_name}
                                    </button>
                                ))}
                            </div>
                            <p className="nf-help" style={{ marginTop: 6 }}>
                                Pick any species this applies to, or General for something like Agar/LC media
                                that isn't species-specific. Not required, but every entry should get one or
                                the other before shipping to testers.
                            </p></div>
                        <div className="nf-field wide"><label>Link (optional)</label>
                            <input className="in" value={f.url} placeholder="https://…"
                                onChange={(e) => setF({ ...f, url: e.target.value })} /></div>

                        {f.kind === 'recipe' ? (
                            <>
                                <div className="nf-field wide"><label>Category (pick any that apply)</label>
                                    <div className="sp-chips" style={{ marginTop: 4 }}>
                                        {RECIPE_CATEGORIES.map((c) => (
                                            <button type="button" key={c} className={`sp-chip ${f.categories.includes(c) ? 'on' : ''}`}
                                                onClick={() => {
                                                    const wasCapsule = f.categories.includes('Capsule blend');
                                                    const nextCategories = f.categories.includes(c)
                                                        ? f.categories.filter((x) => x !== c) : [...f.categories, c];
                                                    const isCapsule = nextCategories.includes('Capsule blend');
                                                    /* The two ingredient shapes ({amount,unit,name} vs {species_id,mg})
                                                       aren't compatible - clear rows when crossing that line so a
                                                       half-filled row from one shape can't leak into the other. */
                                                    setF({ ...f, categories: nextCategories, ingredients: wasCapsule !== isCapsule ? [] : f.ingredients });
                                                }}>{c}</button>
                                        ))}
                                    </div></div>

                                {f.categories.includes('Capsule blend') ? (
                                    <>
                                        <div className="nf-field"><label>Capsule count</label>
                                            <input className="in" inputMode="numeric" value={f.yield_amount} placeholder="e.g. 100"
                                                onChange={(e) => setF({ ...f, yield_amount: e.target.value, yield_unit: 'capsules' })} /></div>
                                        <div className="nf-field"><label>Buffer (spillage margin, %)</label>
                                            <input className="in" inputMode="decimal" value={f.buffer_pct} placeholder="e.g. 3"
                                                onChange={(e) => setF({ ...f, buffer_pct: e.target.value })} /></div>

                                        <div className="nf-field wide">
                                            <label>Species, dose per capsule</label>
                                            <div className="ing-rows">
                                                {f.ingredients.map((row, i) => (
                                                    <div key={i} className="ing-row">
                                                        <select className="in sel" style={{ flex: 1 }} value={row.species_id ?? ''}
                                                            onChange={(e) => setF({ ...f, ingredients: f.ingredients.map((r, idx) => idx === i ? { ...r, species_id: e.target.value } : r) })}>
                                                            <option value="">— pick species —</option>
                                                            {visibleSpeciesFor(species, row.species_id).map((s) => <option key={s.id} value={s.id}>{s.common_name}</option>)}
                                                        </select>
                                                        <input className="in sm" inputMode="decimal" value={row.mg ?? ''} placeholder="mg"
                                                            onChange={(e) => setF({ ...f, ingredients: f.ingredients.map((r, idx) => idx === i ? { ...r, mg: e.target.value } : r) })} />
                                                        <span className="ing-unit-label">mg/cap</span>
                                                        <button className="log-x" onClick={() => setF({ ...f, ingredients: f.ingredients.filter((_, idx) => idx !== i) })}>×</button>
                                                    </div>
                                                ))}
                                            </div>
                                            <button className="mini ghost" style={{ marginTop: 7 }}
                                                onClick={() => setF({ ...f, ingredients: [...f.ingredients, { species_id: '', mg: '' }] })}>+ Add species</button>
                                            {f.ingredients.length > 0 && (() => {
                                                const total = f.ingredients.reduce((s, r) => s + (parseFloat(r.mg) || 0), 0);
                                                return (
                                                    <p className={`calc-note ${total > 500 ? 'over-limit' : ''}`} style={{ marginTop: 8 }}>
                                                        {total}mg per capsule{total > 500 ? ' — over a standard 500mg 00 capsule fill' : total > 0 ? ' — fits a standard 500mg 00 capsule' : ''}
                                                    </p>
                                                );
                                            })()}
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="nf-field"><label>This recipe makes (finished liquid, not jar size)</label>
                                            <div className="calc-row2">
                                                <input className="in" inputMode="decimal" value={f.yield_amount} placeholder="e.g. 175"
                                                    onChange={(e) => setF({ ...f, yield_amount: e.target.value })} />
                                                <select className="in sel" value={f.yield_unit} onChange={(e) => setF({ ...f, yield_unit: e.target.value })}>
                                                    {[...Object.keys(VOLUME), ...Object.keys(MASS)].map((u) => <option key={u} value={u}>{u}</option>)}
                                                </select>
                                            </div></div>

                                        <div className="nf-field wide">
                                            <label>Ingredients, at that batch size</label>
                                            <div className="ing-rows">
                                                {f.ingredients.map((row, i) => (
                                                    <div key={i} className="ing-row">
                                                        <input className="in sm" inputMode="decimal" value={row.amount} placeholder="amt"
                                                            onChange={(e) => setF({ ...f, ingredients: f.ingredients.map((r, idx) => idx === i ? { ...r, amount: e.target.value } : r) })} />
                                                        <select className="in sel ing-unit" value={row.unit}
                                                            onChange={(e) => setF({ ...f, ingredients: f.ingredients.map((r, idx) => idx === i ? { ...r, unit: e.target.value } : r) })}>
                                                            <option value="">count</option>
                                                            {[...Object.keys(VOLUME), ...Object.keys(MASS)].map((u) => <option key={u} value={u}>{u}</option>)}
                                                        </select>
                                                        <input className="in" value={row.name} placeholder="ingredient" list="ingredient-names"
                                                            onChange={(e) => setF({ ...f, ingredients: f.ingredients.map((r, idx) => idx === i ? { ...r, name: e.target.value } : r) })} />
                                                        <button className="log-x" onClick={() => setF({ ...f, ingredients: f.ingredients.filter((_, idx) => idx !== i) })}>×</button>
                                                    </div>
                                                ))}
                                            </div>
                                            <button className="mini ghost" style={{ marginTop: 7 }}
                                                onClick={() => setF({ ...f, ingredients: [...f.ingredients, { amount: '', unit: '', name: '' }] })}>+ Add ingredient</button>
                                            <datalist id="ingredient-names">
                                                {knownIngredients.map((name) => <option key={name} value={name} />)}
                                            </datalist>
                                        </div>
                                    </>
                                )}

                                <div className="nf-field wide"><label>Method / notes</label>
                                    <textarea className="in ta" rows="6" value={f.body}
                                        placeholder="Instant Pot Mini, 30 min at max pressure. Pours brown and translucent."
                                        onChange={(e) => setF({ ...f, body: e.target.value })} /></div>
                            </>
                        ) : (
                        <div className="nf-field wide"><label>The actual content</label>
                            <textarea className="in ta" rows="10" value={f.body}
                                placeholder="Paste the text from your printed sheet here so it is searchable and on your phone."
                                onChange={(e) => setF({ ...f, body: e.target.value })} /></div>
                        )}

                        <div className="nf-field wide">
                            <label>Checklist steps (optional)</label>
                            <p className="nf-help" style={{ marginTop: 0 }}>
                                Add steps to turn this into a tap-to-check list on the card - handy for
                                anything you follow start to finish, like making a nutrient broth. Leave
                                empty for a plain reference entry.
                            </p>
                            <div className="ing-rows">
                                {f.steps.map((step, i) => (
                                    <div key={i} className="ing-row">
                                        <span className="step-num">{i + 1}</span>
                                        <input className="in" style={{ flex: 1 }} value={step}
                                            placeholder="Mix dry ingredients first, then add coconut water and stir to dissolve."
                                            onChange={(e) => setF({ ...f, steps: f.steps.map((s, idx) => idx === i ? e.target.value : s) })} />
                                        <button className="mini ghost" type="button" disabled={i === 0}
                                            onClick={() => setF({ ...f, steps: (() => {
                                                const next = [...f.steps];
                                                [next[i - 1], next[i]] = [next[i], next[i - 1]];
                                                return next;
                                            })() })}>&uarr;</button>
                                        <button className="mini ghost" type="button" disabled={i === f.steps.length - 1}
                                            onClick={() => setF({ ...f, steps: (() => {
                                                const next = [...f.steps];
                                                [next[i], next[i + 1]] = [next[i + 1], next[i]];
                                                return next;
                                            })() })}>&darr;</button>
                                        <button className="mini danger" type="button"
                                            onClick={() => setF({ ...f, steps: f.steps.filter((_, idx) => idx !== i) })}>Remove</button>
                                    </div>
                                ))}
                            </div>
                            <button className="mini ghost" type="button" style={{ marginTop: 8 }}
                                onClick={() => setF({ ...f, steps: [...f.steps, ''] })}>+ Add step</button>
                        </div>
                    </div>
                    <div className="edit-row">
                        <button className="mini" onClick={submit}>Save</button>
                        <button className="mini ghost" onClick={() => setForm(null)}>Cancel</button>
                        {form !== 'new' && (
                            <button className="mini danger" onClick={() => {
                                if (confirm(`Delete "${f.title}"?`)) { onDelete(form); setForm(null); }
                            }}>Delete</button>
                        )}
                    </div>
                </div>
            )}

            {visibleCards.length === 0 && form === null && (
                <p className="nf-help nf-help-page" style={{ marginTop: 18 }}>
                    Nothing matches these filters yet. Try clearing a chip above, or add a new recipe
                    or reference entry.
                </p>
            )}

            <div className="lib-list">
                {visibleCards.map((c) => c.cardType === 'cheat' ? (
                    <SpeciesFactsCard key={c.cardId} sp={c.sp} isOpen={openId === c.cardId}
                        onToggle={() => { const next = openId === c.cardId ? null : c.cardId; setOpenId(next); if (next) onLogOpen(next, c.sp?.name || 'Species facts'); }} unitsPref={unitsPref}
                        onEditSpecies={onEditSpecies} />
                ) : (
                    <LibCard key={c.cardId} e={c.e} species={species} librarySpecies={librarySpecies}
                        isOpen={openId === c.e.id} onToggle={() => { const next = openId === c.e.id ? null : c.e.id; setOpenId(next); if (next) onLogOpen(next, c.e.title); }}
                        onEdit={() => startEdit(c.e)}
                        onToggleChecklistStep={onToggleChecklistStep} onResetChecklist={onResetChecklist} unitsPref={unitsPref} />
                ))}
            </div>

            </>)}
        </div>
    );
}

/* ---------------- DATA ---------------- */
/* Horizontal single-hue bar chart for a "success rate by X" breakdown -
   magnitude comparison across a handful of categories, one series, so one
   consistent hue and direct labels do the job (dataviz skill: no legend
   needed for a single series). `rows` is pre-sorted by the caller
   (descending by rate) and pre-filtered to resolved>0 only. */
function RateBarChart({ rows }) {
    return (
        <div className="rate-chart">
            {rows.map((row) => (
                <div key={row.key} className="rate-chart-row">
                    <div className="rate-chart-label">
                        <span className="rate-chart-name">{row.label}</span>
                        <span className="rate-chart-stat"><strong>{row.rate}%</strong> · {row.success}/{row.resolved}</span>
                    </div>
                    <div className="rate-chart-track">
                        <div className="rate-chart-fill" style={{ width: `${row.rate}%` }} />
                    </div>
                </div>
            ))}
        </div>
    );
}

/* Tester-facing rollup, not the admin analytics from the beta-launch-plan
   doc - reads rows the app already logs (item status, the STATUS/live
   flags, genetics->species) via plain aggregation, same spirit as
   Calculators: a view over existing state, no new tracking table.
   Stage 1 (2026-09-09): hero success rate + a live-right-now board by
   species. Stage 2: contamination/failure-reason breakdown, by-source,
   colonization speed. Stage 3 (2026-09-11): success rate by species/vendor
   as horizontal bar charts, replacing the activity heatmap - see
   sporedesk-beta-launch-plan.md. */
// "Resolved" = the run is actually over, good or bad, per itemOutcome
// (see its definition near FRUITS/DONE_ITEM_STATUSES up top) - colonizing
// (or stored, or anything else itemOutcome calls 'unresolved') is still
// in flight and shouldn't count against (or for) the rate yet. Rate math
// below is hoisted-function-based now (2026-09-18, replacing the old flat
// SUCCESS_STATUSES/FAIL_STATUSES membership check - see itemOutcome's own
// comment for why "current status" alone stopped being enough), so
// HomeTab's Data card and the real Data tab both call the same function
// rather than keeping two copies of the rule in sync by hand.
// Just the two fail *kinds* that get their own all-time total-count card
// below - not a rate-determining list anymore.
const FAIL_KINDS = ['contaminated', 'failed'];

function DataTab({ items, genetics, species, suppliers }) {
    const geneticsFor = (item) => genetics.find((g) => g.id === item.geneticsId);
    const speciesFor = (item) => {
        const gen = geneticsFor(item);
        return gen && species.find((s) => s.id === gen.species_id);
    };

    /* Every rollup below reads from this, not the raw `items` prop, so a
       hidden species (Blue Meanie, or whatever gets hidden next) actually
       disappears from the Data tab instead of just the species list it
       shows up on. An item whose species can't be resolved at all stays
       in rather than getting silently dropped - only an explicit hidden
       flag excludes it. Also excludes items on a hidden GENETICS line even
       when its species is still visible (2026-09-16 fix) - hiding one
       strain of an otherwise-visible species used to leave its runs baked
       into the success rate/colonization speed/everything else here, the
       same leak the AI-connector hidden-items rule exists to avoid. */
    const visibleItems = items.filter((i) => !speciesFor(i)?.hidden && !geneticsFor(i)?.hidden);

    /* Every rate/breakdown below runs items through itemOutcome once and
       reuses the result, rather than re-deriving it inline everywhere (and
       risking the type-specific rule drifting out of sync between spots). */
    const outcome = (i) => itemOutcome(i, items);
    const successCount = visibleItems.filter((i) => outcome(i) === 'success').length;
    const failCount = visibleItems.filter((i) => outcome(i) === 'fail').length;
    const resolvedCount = successCount + failCount;
    const successRate = resolvedCount ? Math.round((successCount / resolvedCount) * 100) : null;

    const LIVE_STATUSES = ['colonizing', 'colonized', 'fruiting'];
    const liveItems = visibleItems.filter((i) => STATUS[i.status]?.live);
    const storedItems = visibleItems.filter((i) => i.status === 'stored');

    // Made in-house vs. bought pre-colonized - `items.source` is just this
    // binary. The by-vendor cut below is the richer version now that
    // supplier_id is actually getting logged.
    const SOURCE_LABEL = { made: 'Made in-house', bought: 'Bought' };
    const bySource = Object.keys(SOURCE_LABEL).map((src) => {
        const rows = visibleItems.filter((i) => i.source === src && outcome(i) !== 'unresolved');
        const s = rows.filter((i) => outcome(i) === 'success').length;
        return { key: src, label: SOURCE_LABEL[src], rate: rows.length ? Math.round((s / rows.length) * 100) : null, resolved: rows.length, success: s };
    }).filter((row) => row.resolved > 0).sort((a, b) => b.rate - a.rate);

    /* Success rate by vendor - same resolved-runs-only rule, gated on
       supplier_id actually being logged (13/78 items as of 2026-09-11, still
       thin but real). Matt asked to revisit this as more purchases get
       tagged with a vendor. */
    const bySupplier = suppliers.map((sup) => {
        const rows = visibleItems.filter((i) => i.supplierId === sup.id && outcome(i) !== 'unresolved');
        const s = rows.filter((i) => outcome(i) === 'success').length;
        return { key: sup.id, label: sup.name, rate: rows.length ? Math.round((s / rows.length) * 100) : null, resolved: rows.length, success: s };
    }).filter((row) => row.resolved > 0).sort((a, b) => b.rate - a.rate);

    /* failure_reason is free text Matt types, not a clean enum - "Never
       colonized, too much gypsum dried out the grain" is real logged text,
       not an option from a dropdown. Bucketing it against the app's own
       REASONS list via a literal substring match (first match in list
       order wins) is honest about what it can and can't catch - a close
       paraphrase that doesn't share the exact phrase lands in "Other"
       rather than getting force-fit into the wrong bucket. Every pill
       carries the real logged text in its title tooltip so nothing here
       hides behind a category label.
       Reads the History log instead of the live failureReason column
       (2026-09-18) - that column gets wiped the moment status changes
       again, so an item that was Contaminated and later got Retired
       would otherwise silently drop out of this breakdown even though it
       still very much belongs here. Scanning every status-kind log entry
       for the "Contaminated —"/"Failed —" prefix picks up every reason
       ever logged for an item, not just whatever's true of it right now -
       genuinely "what's actually going wrong," full history included. */
    const reasonTally = (statusKey) => {
        const keywords = REASONS[statusKey];
        const buckets = {};
        keywords.forEach((k) => { buckets[k] = []; });
        buckets.Other = [];
        const prefix = `${STATUS[statusKey].label} — `;
        visibleItems.forEach((i) => {
            (i.log ?? []).filter((e) => e.kind === 'status' && e.body?.startsWith(prefix)).forEach((e) => {
                const reasonText = e.body.slice(prefix.length);
                const text = reasonText.toLowerCase();
                const hit = keywords.find((k) => text.includes(k.toLowerCase()));
                (buckets[hit] ?? buckets.Other).push(reasonText);
            });
        });
        return Object.entries(buckets).filter(([, ex]) => ex.length > 0).sort((a, b) => b[1].length - a[1].length);
    };
    const contamReasons = reasonTally('contaminated');
    const failReasons = reasonTally('failed');

    /* Colonization speed - early days: only a handful of "Colonized" log
       entries exist yet, most caught whenever Matt happened to check in
       rather than the exact day it finished, so every number here is an
       upper bound, not a precise measurement. Same-day created->colonized
       entries are dropped - those are LC jars logged after the fact when
       drawn into syringes (an already-colonized culture being subcultured,
       not tracked from inoculation), so "0 days" would be a logging
       artifact, not a real result. Confirmed with Matt 2026-09-09. */
    const colonizeSpeeds = visibleItems
        .filter((i) => i.created)
        .map((i) => {
            const colEvent = i.log?.find((e) => e.kind === 'status' && e.body === 'Colonized');
            if (!colEvent) return null;
            const days = Math.round((new Date(colEvent.date) - new Date(i.created)) / 86400000);
            if (days <= 0) return null;
            return { sp: speciesFor(i), days };
        })
        .filter((row) => row?.sp);

    const speedBySpecies = {};
    colonizeSpeeds.forEach(({ sp, days }) => {
        (speedBySpecies[sp.id] ??= { sp, days: [] }).days.push(days);
    });
    const speedRows = Object.values(speedBySpecies).sort((a, b) => a.sp.common_name.localeCompare(b.sp.common_name));

    /* Success rate by species - same resolved-runs-only rule as by-source.
       Replaces the old activity heatmap in this slot (Matt: "not a helpful
       metric", 2026-09-11) - a per-species magnitude comparison is a bar
       chart's job, not a calendar. */
    const bySpecies = species
        .filter((s) => !s.hidden)
        .map((sp) => {
            const rows = visibleItems.filter((i) => speciesFor(i)?.id === sp.id && outcome(i) !== 'unresolved');
            const s = rows.filter((i) => outcome(i) === 'success').length;
            return { key: sp.id, label: sp.common_name, rate: rows.length ? Math.round((s / rows.length) * 100) : null, resolved: rows.length, success: s };
        })
        .filter((row) => row.resolved > 0)
        .sort((a, b) => b.rate - a.rate);

    const liveBySpecies = species
        .filter((s) => !s.hidden)
        .map((s) => {
            const counts = {};
            LIVE_STATUSES.forEach((st) => {
                counts[st] = liveItems.filter((i) => i.status === st && speciesFor(i)?.id === s.id).length;
            });
            const total = LIVE_STATUSES.reduce((n, st) => n + counts[st], 0);
            return { sp: s, counts, total };
        })
        .filter((row) => row.total > 0)
        .sort((a, b) => b.total - a.total);

    /* In storage, by species - Matt: "storage is like Stock but for living
       tissue" (2026-09-18). Broken down by item TYPE rather than by status
       like liveBySpecies above, since every row here already shares the
       one status (stored) - type is the dimension that's actually
       informative here (3 LC vs. 2 spore prints reads very differently). */
    const storageBySpecies = species
        .filter((s) => !s.hidden)
        .map((s) => {
            const counts = {};
            storedItems.filter((i) => speciesFor(i)?.id === s.id).forEach((i) => {
                counts[i.type] = (counts[i.type] ?? 0) + 1;
            });
            const total = Object.values(counts).reduce((n, c) => n + c, 0);
            return { sp: s, counts, total };
        })
        .filter((row) => row.total > 0)
        .sort((a, b) => b.total - a.total);

    return (
        <div className="page">
            <div className="bar">
                <div>
                    <div className="eyebrow">How the grows are actually going</div>
                    <h1>Data</h1>
                </div>
                <div className="bar-actions">
                    <div className="tally"><span className="num">{liveItems.length}</span><span className="tally-l">live<br />right now</span></div>
                </div>
            </div>

            <div className="calc-grid">
                <div className="calc-card">
                    <div className="calc-head">
                        <div className="calc-title">Success rate</div>
                        <div className="calc-sub">What "success" means depends on the item - a flush for fruiting substrate, getting used for agar/grain/spores, at least one successful child for LC. Still-colonizing or stored items aren't counted either way yet.</div>
                    </div>
                    {successRate === null ? (
                        <p className="calc-note">Nothing's resolved yet - once a culture finishes, good or bad, it shows up here.</p>
                    ) : (
                        <div className="calc-result block">
                            <strong>{successRate}%</strong>
                            <span>{successCount} of {resolvedCount} resolved runs made it</span>
                        </div>
                    )}
                </div>

                {LIVE_STATUSES.map((st) => (
                    <div key={st} className="calc-card">
                        <div className="calc-head">
                            <div className="calc-title">{STATUS[st].label}</div>
                            <div className="calc-sub">Right now, across every species.</div>
                        </div>
                        <div className="tally">
                            <span className="num" style={{ color: TONE[STATUS[st].tone] }}>
                                {liveItems.filter((i) => i.status === st).length}
                            </span>
                            <span className="tally-l">active<br />{STATUS[st].label.toLowerCase()}</span>
                        </div>
                    </div>
                ))}

                {FAIL_KINDS.map((st) => (
                    <div key={st} className="calc-card">
                        <div className="calc-head">
                            <div className="calc-title">{STATUS[st].label}</div>
                            <div className="calc-sub">All-time count, including ones since retired or consumed - not just current status.</div>
                        </div>
                        <div className="tally">
                            <span className="num" style={{ color: TONE[STATUS[st].tone] }}>
                                {visibleItems.filter((i) => (i.log ?? []).some((e) => e.kind === 'status' && e.body?.startsWith(STATUS[st].label))).length}
                            </span>
                            <span className="tally-l">total<br />{STATUS[st].label.toLowerCase()}</span>
                        </div>
                    </div>
                ))}
            </div>

            {bySource.length > 0 && (
                <>
                    <div className="bar" style={{ marginTop: 30 }}>
                        <div>
                            <div className="eyebrow">Resolved runs only - made vs. bought</div>
                            <h1 style={{ fontSize: 21 }}>Success rate by source</h1>
                        </div>
                    </div>
                    <div className="calc-card">
                        <RateBarChart rows={bySource} />
                    </div>
                </>
            )}

            {bySupplier.length > 0 && (
                <>
                    <div className="bar" style={{ marginTop: 30 }}>
                        <div>
                            <div className="eyebrow">Resolved runs only, by vendor - still early, small sample sizes</div>
                            <h1 style={{ fontSize: 21 }}>Success rate by vendor</h1>
                        </div>
                    </div>
                    <div className="calc-card">
                        <RateBarChart rows={bySupplier} />
                    </div>
                </>
            )}

            {(contamReasons.length > 0 || failReasons.length > 0) && (
                <>
                    <div className="bar" style={{ marginTop: 30 }}>
                        <div>
                            <div className="eyebrow">Grouped by keyword match on the logged reason - hover a pill for the exact text</div>
                            <h1 style={{ fontSize: 21 }}>What's actually going wrong</h1>
                        </div>
                    </div>
                    <div className="calc-grid">
                        {contamReasons.length > 0 && (
                            <div className="calc-card">
                                <div className="calc-head">
                                    <div className="calc-title">Contaminated</div>
                                    <div className="calc-sub">Logged reason, bucketed.</div>
                                </div>
                                <div className="calc-body" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                                    {contamReasons.map(([reason, examples]) => (
                                        <span key={reason} className="pill tone-clay" title={examples.join('\n')}>{examples.length} {reason}</span>
                                    ))}
                                </div>
                            </div>
                        )}
                        {failReasons.length > 0 && (
                            <div className="calc-card">
                                <div className="calc-head">
                                    <div className="calc-title">Failed</div>
                                    <div className="calc-sub">Logged reason, bucketed.</div>
                                </div>
                                <div className="calc-body" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                                    {failReasons.map(([reason, examples]) => (
                                        <span key={reason} className="pill tone-rust" title={examples.join('\n')}>{examples.length} {reason}</span>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </>
            )}

            {speedRows.length > 0 && (
                <>
                    <div className="bar" style={{ marginTop: 30 }}>
                        <div>
                            <div className="eyebrow">Early data - upper bounds, not exact days. Same-day LC harvests excluded</div>
                            <h1 style={{ fontSize: 21 }}>Colonization speed</h1>
                        </div>
                    </div>
                    <div className="calc-grid">
                        {speedRows.map(({ sp, days }) => (
                            <div key={sp.id} className="calc-card">
                                <div className="calc-head">
                                    <div className="calc-title">{sp.common_name}</div>
                                    <div className="calc-sub">{sp.colonize_time ? `Reference: ${sp.colonize_time}` : 'No reference colonize time logged for this species yet.'}</div>
                                </div>
                                <div className="calc-body" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                                    {days.map((d, idx) => (
                                        <span key={idx} className="pill tone-slate">{d}d</span>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </>
            )}

            {bySpecies.length > 0 && (
                <>
                    <div className="bar" style={{ marginTop: 30 }}>
                        <div>
                            <div className="eyebrow">Resolved runs only, by species</div>
                            <h1 style={{ fontSize: 21 }}>Success rate by species</h1>
                        </div>
                    </div>
                    <div className="calc-card">
                        <RateBarChart rows={bySpecies} />
                    </div>
                </>
            )}

            <div className="bar" style={{ marginTop: 30 }}>
                <div>
                    <div className="eyebrow">Snapshot, not history - resolved runs don't appear here</div>
                    <h1 style={{ fontSize: 21 }}>What's live right now, by species</h1>
                </div>
            </div>

            {liveBySpecies.length === 0 ? (
                <p className="nf-help nf-help-page" style={{ marginTop: 18 }}>Nothing actively growing right now.</p>
            ) : (
                <div className="calc-grid">
                    {liveBySpecies.map(({ sp, counts, total }) => (
                        <div key={sp.id} className="calc-card">
                            <div className="calc-head">
                                <div className="calc-title">{sp.common_name}</div>
                                {sp.latin_name && <div className="calc-sub" style={{ fontStyle: 'italic' }}>{sp.latin_name}</div>}
                            </div>
                            <div className="calc-body" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                                {LIVE_STATUSES.filter((st) => counts[st] > 0).map((st) => (
                                    <span key={st} className={`pill tone-${STATUS[st].tone}`}>{counts[st]} {STATUS[st].label}</span>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Storage - your culture bank, per Matt (2026-09-18): "it's
                like stock but for living tissue." Same shape as the
                live-right-now section above, but broken down by item type
                since everything here already shares one status. */}
            <div className="bar" style={{ marginTop: 30 }}>
                <div>
                    <div className="eyebrow">Banked for later - not counted toward success or fail until it's used</div>
                    <h1 style={{ fontSize: 21 }}>In storage, by species ({storedItems.length})</h1>
                </div>
            </div>

            {storageBySpecies.length === 0 ? (
                <p className="nf-help nf-help-page" style={{ marginTop: 18 }}>Nothing marked Stored yet.</p>
            ) : (
                <div className="calc-grid">
                    {storageBySpecies.map(({ sp, counts }) => (
                        <div key={sp.id} className="calc-card">
                            <div className="calc-head">
                                <div className="calc-title">{sp.common_name}</div>
                                {sp.latin_name && <div className="calc-sub" style={{ fontStyle: 'italic' }}>{sp.latin_name}</div>}
                            </div>
                            <div className="calc-body" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                                {Object.keys(counts).map((t) => (
                                    <span key={t} className="pill tone-slate">{counts[t]} {TYPES[t]}</span>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/* ---------------- SPECIES GRID ---------------- */

/* Quick-add starter data for the "New species" form - picking one just
   prefills the fields below, nothing is locked in until Save, and every
   field stays editable afterward. Every number here is sourced from real
   cultivation guides (North Spore, Field & Forest, GroCycle, Out-Grow,
   FreshCap, plus one peer-reviewed paper for Turkey Tail) rather than
   guessed, per the app's standing "don't fabricate species facts" rule -
   see the Calculators data-leak fix (2026-09-06). Where guides for a
   species disagreed, the range was picked from whichever source looked
   most credible/specific, never split the difference blindly.
   dry_yield_pct is left blank on EVERY template on purpose: this field is
   dried weight as a % of *fresh harvest* weight (see DryYield calculator -
   dry = wet * pct/100), which is basically moisture content and only
   really documented for a couple of species (Blue Oyster's real 8.9% is
   already in the species table). What's commonly published in grow guides
   is Biological Efficiency (fresh yield / dry SUBSTRATE weight) - a
   completely different metric - so plugging those numbers in here would
   look like real data while actually being wrong. Better to leave it
   blank and let the calculator's general-average fallback handle it than
   fabricate-by-mislabeling.
   One template per commercial species, not per strain (2026-09-13 per
   Matt) - where a species' own strains genuinely vary, the note below
   says "typical - adjust to your results" rather than pretending false
   precision. */
const SPECIES_TEMPLATES = [
    {
        common_name: 'Blue Oyster', latin_name: 'Pleurotus ostreatus',
        fruiting_temp: '55-75F', humidity: '85-95%', fae: 'High',
        colonize_temp: '70-75F', colonize_time: '10-14 d', pin_to_harvest: '5-7 d',
        substrate_note: 'Supp. hardwood or straw', dry_yield_pct: '',
        notes: 'Typical ranges from grower guides (North Spore, Out-Grow) - adjust to your results.',
    },
    {
        common_name: 'Pink Oyster', latin_name: 'Pleurotus djamor',
        fruiting_temp: '70-80F', humidity: '85-95%', fae: 'High',
        colonize_temp: '75-85F', colonize_time: '7-14 d', pin_to_harvest: '3-5 d',
        substrate_note: 'Straw or supp. hardwood', dry_yield_pct: '',
        notes: 'Typical ranges from grower guides (North Spore, Field & Forest, Out-Grow) - adjust to your results. Won\'t fruit below ~65F; fast fruiting cycle needs daily monitoring.',
    },
    {
        common_name: 'Yellow Oyster', latin_name: 'Pleurotus citrinopileatus',
        fruiting_temp: '65-80F', humidity: '85-95%', fae: 'High',
        colonize_temp: '75-82F', colonize_time: '10-14 d', pin_to_harvest: '5-10 d',
        substrate_note: 'Straw or supp. hardwood', dry_yield_pct: '',
        notes: 'Typical ranges from grower guides (North Spore, GroCycle, Out-Grow) - adjust to your results.',
    },
    {
        common_name: 'King Oyster', latin_name: 'Pleurotus eryngii',
        fruiting_temp: '50-65F', humidity: '85-95%', fae: 'Low',
        colonize_temp: '70-75F', colonize_time: '2-3 wk', pin_to_harvest: '5-10 d',
        substrate_note: 'Supp. hardwood, casing optional', dry_yield_pct: '',
        notes: 'Typical ranges from grower guides (North Spore, Field & Forest, GroCycle, FreshCap) - adjust to your results. Deliberately kept lower-FAE than other oysters, to form thick single stems instead of clusters; needs 10+ hr/day light to fruit well.',
    },
    {
        common_name: "Lion's Mane", latin_name: 'Hericium erinaceus',
        fruiting_temp: '55-65F', humidity: '85-95%', fae: 'High',
        colonize_temp: '70-75F', colonize_time: '2-3 wk', pin_to_harvest: '5-10 d',
        substrate_note: 'Supp. hardwood sawdust block', dry_yield_pct: '',
        notes: 'Typical ranges from grower guides (North Spore, Out-Grow) - adjust to your results.',
    },
    {
        common_name: 'Chestnut', latin_name: 'Pholiota adiposa',
        fruiting_temp: '55-65F', humidity: '85-95%', fae: 'Medium',
        colonize_temp: '70-75F', colonize_time: '2-3 wk', pin_to_harvest: '10-14 d',
        substrate_note: 'Supp. hardwood sawdust, no casing', dry_yield_pct: '',
        notes: 'Less documented than most gourmet species - sourced from one commercial grow guide (Out-Grow) plus experienced-grower reports, not extension/university sources. Treat as a rougher starting point and lean on your own results more than usual.',
    },
    {
        common_name: 'Shiitake', latin_name: 'Lentinula edodes',
        fruiting_temp: '55-70F', humidity: '85-95%', fae: 'Low',
        colonize_temp: '70-75F', colonize_time: '8-12 wk', pin_to_harvest: '5-10 d',
        substrate_note: 'Supp. sawdust block', dry_yield_pct: '',
        notes: 'Typical ranges from grower guides (North Spore, Field & Forest) - adjust to your results. Notably slower to colonize and more CO2-tolerant than oyster species. Sawdust-block tek, not log-grown.',
    },
    {
        common_name: 'Reishi', latin_name: 'Ganoderma lucidum',
        fruiting_temp: '70-80F', humidity: '85-95%', fae: 'Low',
        colonize_temp: '75-81F', colonize_time: '2-4 wk', pin_to_harvest: '',
        substrate_note: 'Supp. hardwood sawdust block', dry_yield_pct: '',
        notes: 'Typical ranges from grower guides (North Spore, GroCycle, Out-Grow). Doesn\'t flush like gilled species - after pinning it grows into a conk (or antler form, depending on FAE) over roughly 4-8 wk before being cut and dried, so "pin to harvest" is left blank on purpose.',
    },
    {
        common_name: 'Turkey Tail', latin_name: 'Trametes versicolor',
        fruiting_temp: '65-80F', humidity: '85-95%', fae: 'Medium',
        colonize_temp: '70-80F', colonize_time: '3-6 wk', pin_to_harvest: '7-14 d',
        substrate_note: 'Supp. hardwood sawdust', dry_yield_pct: '',
        notes: 'Typical ranges from grower guides and one peer-reviewed cultivation study - adjust to your results. Forms brackets, not classic pins, so pin-to-harvest is approximate.',
    },
    {
        common_name: 'Maitake', latin_name: 'Grifola frondosa',
        fruiting_temp: '50-60F', humidity: '85-95%', fae: 'Medium',
        colonize_temp: '70-75F', colonize_time: '6-10 wk', pin_to_harvest: '14-21 d',
        substrate_note: 'Supp. hardwood sawdust', dry_yield_pct: '',
        notes: 'Typical ranges from grower guides (North Spore, Field & Forest, Out-Grow) - adjust to your results.',
    },
    {
        common_name: 'Cordyceps militaris', latin_name: 'Cordyceps militaris',
        fruiting_temp: '60-72F', humidity: '80-95%', fae: 'Low',
        colonize_temp: '65-72F', colonize_time: '2-4 wk', pin_to_harvest: '',
        substrate_note: 'Grain/rice + nutrient broth', dry_yield_pct: '',
        notes: 'Typical ranges from North Spore\'s (William Padilla-Brown) method and Out-Grow - adjust to your results. Doesn\'t pin like gilled species - strands emerge gradually across the grain. Rough total timeline: ~2-4 wk colonize, 1-2 wk to visible strands, then 10-20 d fruiting development to harvest (~4-8 wk inoculation to harvest overall) - left pin-to-harvest blank since it doesn\'t map cleanly to one number.',
    },
    {
        common_name: 'Enoki', latin_name: 'Flammulina velutipes',
        fruiting_temp: '45-60F', humidity: '90-95%', fae: 'Low',
        colonize_temp: '70-77F', colonize_time: '2-4 wk', pin_to_harvest: '7-10 d',
        substrate_note: 'Supp. hardwood + rice bran', dry_yield_pct: '',
        notes: 'Typical ranges from grower guides (North Spore, GroCycle, Out-Grow) - adjust to your results. Low FAE here is deliberate, not a problem: commercial growers restrict fresh air on purpose (high CO2) to force the classic long, thin stems and suppress cap expansion - more air gives you shorter, capped enoki instead.',
    },
];

function SpeciesGrid({ species, genetics, items, onOpen, onAdd, onToggleHidden }) {
    const live = items.filter((i) => STATUS[i.status].live).length;
    const [adding, setAdding] = useState(false);
    const [showHidden, setShowHidden] = useState(false);
    const [f, setF] = useState({ common_name: "", latin_name: "", fruiting_temp: "", humidity: "", fae: "", colonize_temp: "", colonize_time: "", pin_to_harvest: "", substrate_note: "", dry_yield_pct: "", notes: "" });
    const hiddenCount = species.filter((s) => s.hidden).length;
    const visible = showHidden ? species : species.filter((s) => !s.hidden);

    const submit = async () => {
        if (!f.common_name.trim()) { alert('Common name is required.'); return; }
        await onAdd(f);
        setF({ common_name: "", latin_name: "", fruiting_temp: "", humidity: "", fae: "", colonize_temp: "", colonize_time: "", pin_to_harvest: "", substrate_note: "", dry_yield_pct: "", notes: "" });
        setAdding(false);
    };

    return (
        <div className="page">
            <div className="bar">
                <div>
                    <div className="eyebrow">Cultures on the shelf</div>
                    <h1>Species</h1>
                </div>
                <div className="bar-actions">
                    {hiddenCount > 0 && (
                        <button className="sw" onClick={() => setShowHidden((v) => !v)}>
                            {showHidden ? 'Hide hidden species' : `Show hidden species (${hiddenCount})`}
                        </button>
                    )}
                    <div className="tally"><span className="num">{live}</span><span className="tally-l">live<br />items</span></div>
                </div>
            </div>

            {adding && (
                <div className="new-form">
                    <div className="nf-title">New species</div>
                    <div className="sp-chips" style={{ marginBottom: 4 }}>
                        <span className="sp-chips-label">Start from a template:</span>
                        <select className="in sel" style={{ flex: '0 0 auto', width: 'auto' }} value=""
                            onChange={(e) => {
                                const t = SPECIES_TEMPLATES.find((x) => x.common_name === e.target.value);
                                if (t) setF({ ...t });
                            }}>
                            <option value="">— pick a species, or fill in your own —</option>
                            {SPECIES_TEMPLATES.map((t) => <option key={t.common_name} value={t.common_name}>{t.common_name}</option>)}
                        </select>
                        <span className="nf-help" style={{ margin: 0 }}>Prefills every field below - all still editable before you save.</span>
                    </div>
                    <div className="nf-grid">
                        <div className="nf-field wide">
                            <label>Common name</label>
                            <input className="in" autoFocus value={f.common_name} placeholder="Chestnut"
                                onChange={(e) => setF({ ...f, common_name: e.target.value })}
                                onKeyDown={(e) => e.key === 'Enter' && submit()} />
                        </div>
                        <div className="nf-field wide">
                            <label>Latin name</label>
                            <input className="in" value={f.latin_name} placeholder="Pholiota adiposa"
                                onChange={(e) => setF({ ...f, latin_name: e.target.value })} />
                        </div>
                        <div className="nf-field">
                            <label>Fruiting temp</label>
                            <input className="in" value={f.fruiting_temp} placeholder="55-65F"
                                onChange={(e) => setF({ ...f, fruiting_temp: e.target.value })} />
                        </div>
                        <div className="nf-field">
                            <label>Humidity</label>
                            <input className="in" value={f.humidity} placeholder="90-95%"
                                onChange={(e) => setF({ ...f, humidity: e.target.value })} />
                        </div>
                        <div className="nf-field">
                            <label>FAE</label>
                            <input className="in" value={f.fae} placeholder="High"
                                onChange={(e) => setF({ ...f, fae: e.target.value })} />
                        </div>
                        <div className="nf-field">
                            <label>Colonize temp</label>
                            <input className="in" value={f.colonize_temp} placeholder="70-75F"
                                onChange={(e) => setF({ ...f, colonize_temp: e.target.value })} />
                        </div>
                        <div className="nf-field">
                            <label>Colonize time</label>
                            <input className="in" value={f.colonize_time} placeholder="2-3 wk"
                                onChange={(e) => setF({ ...f, colonize_time: e.target.value })} />
                        </div>
                        <div className="nf-field">
                            <label>Pin to harvest</label>
                            <input className="in" value={f.pin_to_harvest} placeholder="5-10 d"
                                onChange={(e) => setF({ ...f, pin_to_harvest: e.target.value })} />
                        </div>
                        <div className="nf-field wide">
                            <label>Substrate</label>
                            <input className="in" value={f.substrate_note} placeholder="Supp. hardwood, no casing"
                                onChange={(e) => setF({ ...f, substrate_note: e.target.value })} />
                        </div>
                        <div className="nf-field">
                            <label>Dry yield % (optional)</label>
                            <input className="in" inputMode="decimal" value={f.dry_yield_pct} placeholder="e.g. 8.9"
                                onChange={(e) => setF({ ...f, dry_yield_pct: e.target.value })} />
                        </div>
                        <div className="nf-field wide">
                            <label>Notes</label>
                            <textarea className="in ta" rows="2" value={f.notes}
                                placeholder="Anything you want to remember about this species generally."
                                onChange={(e) => setF({ ...f, notes: e.target.value })} />
                        </div>
                    </div>
                    <div className="edit-row">
                        <button className="mini" onClick={submit}>Add species</button>
                        <button className="mini ghost" onClick={() => setAdding(false)}>Cancel</button>
                    </div>
                </div>
            )}

            <div className="grid">
                {visible.map((s) => {
                    const lines = genetics.filter((g) => g.species_id === s.id);
                    const ids = lines.map((g) => g.id);
                    const mine = items.filter((i) => ids.includes(i.geneticsId));
                    const liveN = mine.filter((i) => STATUS[i.status].live).length;
                    return (
                        <div key={s.id} className="tile-wrap">
                            <button className="tile" onClick={() => onOpen(s.id)} style={s.hidden ? { opacity: .55 } : undefined}>
                                <div className="tile-name">{s.common_name}</div>
                                <div className="tile-latin">{s.latin_name}</div>
                                <div className="tile-foot">
                                    <span className="src">{lines.length} {lines.length === 1 ? 'line' : 'lines'}</span>
                                    <span className={liveN ? 'live-c' : 'dormant'}>{s.hidden ? 'hidden' : liveN ? `${liveN} live` : 'dormant'}</span>
                                </div>
                            </button>
                            <button className="tile-hide-btn" title={s.hidden ? 'Show on this list' : 'Hide from this list'}
                                onClick={(e) => { e.stopPropagation(); onToggleHidden(s.id, !s.hidden); }}>
                                {s.hidden ? 'Unhide' : 'Hide'}
                            </button>
                        </div>
                    );
                })}
                {!adding && (
                    <button className="tile add-tile" onClick={() => setAdding(true)}>
                        <span className="add-plus">+</span>
                        <span className="add-label">Add a species</span>
                    </button>
                )}
            </div>
        </div>
    );
}

/* ---------------- TREE ---------------- */

/* Deterministic tile size for the lineage photo mosaic below - hashed off
   the photo's own id so a given photo always lands on the same size
   (stable across re-renders/reloads) instead of reshuffling every time,
   weighted toward small so a handful of bigger tiles stand out rather
   than everything competing for attention. */
function tileSize(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    const r = h % 10;
    if (r < 5) return 'sm';
    if (r < 7) return 'md';
    if (r < 9) return 'wide';
    return 'big';
}

function Tree({ items, lines, species, library, librarySpecies, onOpen, onBack, onAddLine, onEditLine, onDeleteLine, onToggleLineHidden, onEditSpecies, onToggleHidden, onDeleteSpecies, photos, stock, onPrintLabels, onQueueLabels, photoUrl, onDeletePhoto, onEditPhoto, suppliers, onGetOrCreateSupplier, unitsPref, dateFormat }) {
    const [view, setView] = useState({ x: 0, y: 0, k: 1 });
    const [hover, setHover] = useState(null);
    const [lightbox, setLightbox] = useState(null);
    const [addingLine, setAddingLine] = useState(false);
    const [editLineId, setEditLineId] = useState(null);
    const [editSp, setEditSp] = useState(false);
    const [lf, setLf] = useState({});
    const [sf, setSf] = useState({});
    const [nf, setNf] = useState({ name: "", code: "", source: "", supplier_id: "", acquired: "", notes: "", firstType: "lc", stockId: "" });
    const [deletingLine, setDeletingLine] = useState(null);   // { id, secondsLeft } while a delete is pending undo
    const [deletingSpecies, setDeletingSpecies] = useState(null);   // { secondsLeft } while a delete is pending undo
    const box = useRef(null), ptrs = useRef(new Map()), pinch = useRef(null), moved = useRef(false);
    const pos = useMemo(() => layout(items), [items]);

    const onDeleteLineRef = useRef(onDeleteLine);
    useEffect(() => { onDeleteLineRef.current = onDeleteLine; });

    useEffect(() => {
        if (!deletingLine) return;
        const t = setTimeout(() => {
            if (deletingLine.secondsLeft <= 1) { onDeleteLineRef.current(deletingLine.id); setDeletingLine(null); }
            else setDeletingLine((d) => d && { ...d, secondsLeft: d.secondsLeft - 1 });
        }, 1000);
        return () => clearTimeout(t);
    }, [deletingLine]);

    const onDeleteSpeciesRef = useRef(onDeleteSpecies);
    useEffect(() => { onDeleteSpeciesRef.current = onDeleteSpecies; });
    const onBackRef = useRef(onBack);
    useEffect(() => { onBackRef.current = onBack; });

    useEffect(() => {
        if (!deletingSpecies) return;
        const t = setTimeout(() => {
            if (deletingSpecies.secondsLeft <= 1) { onDeleteSpeciesRef.current(deletingSpecies.id); setDeletingSpecies(null); onBackRef.current(); }
            else setDeletingSpecies((d) => d && { ...d, secondsLeft: d.secondsLeft - 1 });
        }, 1000);
        return () => clearTimeout(t);
    }, [deletingSpecies]);

    /* genetics->items cascades in the DB, so a line with containers under
       it is never offered a real delete - hiding is the only removal for
       those. A clean line gets a 5s undo window instead of an immediate
       confirm(), since "accidentally selected the wrong line" is exactly
       the kind of misclick this is meant to protect against. */
    const requestDeleteLine = (genId) => {
        if (items.some((i) => i.geneticsId === genId)) {
            alert("This line has containers under it - remove or reassign those first, or hide the line instead.");
            return;
        }
        setEditLineId(null);
        setDeletingLine({ id: genId, secondsLeft: 5 });
    };

    /* Mirrors requestDeleteLine above, aimed at the species itself: blocked
       outright if it has lines or library entries hanging off it (a DB
       RESTRICT and a DB CASCADE respectively - see deleteSpecies), same 5s
       undo window otherwise. */
    const requestDeleteSpecies = () => {
        if (lines.length) {
            alert('This species has culture lines under it - remove or reassign those first, or hide the species instead.');
            return;
        }
        if (librarySpecies.some((r) => r.species_id === species.id)) {
            alert('This species is tagged on one or more recipes/reference entries - untag those first, or hide the species instead.');
            return;
        }
        setDeletingSpecies({ id: species.id, secondsLeft: 5 });
    };

    /* Every photo tied to any item in this species' whole lineage (`items`
       here is already pre-filtered to this species by the caller), most
       recent first - the "collage" living under the tree canvas below. */
    const linPhotos = useMemo(() => photos
        .filter((p) => items.some((i) => i.uid === p.item_id))
        .sort((a, b) => (b.taken_on ?? '').localeCompare(a.taken_on ?? '')),
        [photos, items]);

    const litChain = useMemo(() => {
        if (!hover) return [];
        const out = [];
        let c = items.find((i) => i.id === hover);
        while (c) { out.push(c.id); c = items.find((i) => i.id === c.parent); }
        return out;
    }, [hover, items]);

    const fit = useCallback(() => {
        const el = box.current; if (!el) return;
        const xs = Object.values(pos).map((p) => p.x), ys = Object.values(pos).map((p) => p.y);
        const minX = Math.min(...xs) - 96, maxX = Math.max(...xs) + 96;
        const minY = Math.min(...ys) - 54, maxY = Math.max(...ys) + 78;
        const k = Math.min(el.clientWidth / (maxX - minX), el.clientHeight / (maxY - minY), 1.2);
        setView({ k, x: el.clientWidth / 2 - ((minX + maxX) / 2) * k, y: el.clientHeight / 2 - ((minY + maxY) / 2) * k });
    }, [pos]);

    useEffect(() => { const t = setTimeout(fit, 60); return () => clearTimeout(t); }, [fit]);

    /* Native (non-React) wheel listener, deliberately not the JSX onWheel prop.
       React attaches onWheel at the root as a passive listener, so
       e.preventDefault() inside a synthetic handler is silently ignored by
       the browser and the page scrolls right along with the zoom - this is
       what caused the tree's zoom-also-scrolls-the-page bug. Attaching
       directly to the canvas element with { passive: false } is the only
       way to actually block the page scroll while zooming. */
    useEffect(() => {
        const el = box.current;
        if (!el) return;
        const handleWheel = (e) => {
            e.preventDefault();
            const r = el.getBoundingClientRect();
            const mx = e.clientX - r.left, my = e.clientY - r.top;
            setView((v) => {
                const k = Math.min(2.6, Math.max(0.25, v.k * (e.deltaY < 0 ? 1.12 : 0.893)));
                return { k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) };
            });
        };
        el.addEventListener('wheel', handleWheel, { passive: false });
        return () => el.removeEventListener('wheel', handleWheel);
    }, []);
    const onDown = (e) => {
        moved.current = false;
        ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (ptrs.current.size === 2) {
            const [a, b] = [...ptrs.current.values()];
            pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k };
        }
    };
    useEffect(() => {
        const move = (e) => {
            if (!ptrs.current.has(e.pointerId) || !box.current) return;
            const prev = ptrs.current.get(e.pointerId);
            ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y) > 3) moved.current = true;
            if (ptrs.current.size === 2 && pinch.current) {
                const [a, b] = [...ptrs.current.values()];
                const d = Math.hypot(a.x - b.x, a.y - b.y);
                const r = box.current.getBoundingClientRect();
                const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
                setView((v) => {
                    const k = Math.min(2.6, Math.max(0.25, pinch.current.k * (d / pinch.current.d)));
                    return { k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) };
                });
                return;
            }
            setView((v) => ({ ...v, x: v.x + (e.clientX - prev.x), y: v.y + (e.clientY - prev.y) }));
        };
        const up = (e) => { ptrs.current.delete(e.pointerId); if (ptrs.current.size < 2) pinch.current = null; };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
        return () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
        };
    }, []);

    return (
        <div className="page">
            <button className="back" onClick={onBack}>← Species</button>
            <div className="bar">
                <div>
                    <div className="eyebrow">{species?.latin_name}</div>
                    <h1>{species?.common_name}</h1>
                </div>
                <div className="bar-actions">
                    <button className="sw" onClick={() => {
                        setSf({
                            common_name: species?.common_name ?? "", latin_name: species?.latin_name ?? "",
                            fruiting_temp: species?.fruiting_temp ?? "", humidity: species?.humidity ?? "",
                            fae: species?.fae ?? "",
                            colonize_temp: species?.colonize_temp ?? "", colonize_time: species?.colonize_time ?? "",
                            pin_to_harvest: species?.pin_to_harvest ?? "", substrate_note: species?.substrate_note ?? "",
                            dry_yield_pct: species?.dry_yield_pct ?? "", notes: species?.notes ?? "",
                        });
                        setEditSp(true);
                    }}>✎ Species</button>
                    <button className="sw" onClick={() => setAddingLine(true)}>+ Add line</button>
                    {items.length > 0 && (
                        <div className="pl-icon-row">
                            <button className="pl-icon-btn pl-trigger" title="Print labels for every item shown here"
                                onClick={() => onPrintLabels(items.map((i) => i.id))}>
                                <PrinterIcon />
                            </button>
                            <button className="pl-icon-btn pl-queue" title="Add every item shown here to the print queue instead - print it later alongside other labels"
                                onClick={() => onQueueLabels(items.map((i) => i.id))}>
                                <PrinterQueueIcon />
                            </button>
                        </div>
                    )}
                    <button className="sw" onClick={fit}>Fit</button>
                    <button className="sw" onClick={() => onToggleHidden(species.id, !species.hidden)}>
                        {species?.hidden ? 'Unhide' : 'Hide'}
                    </button>
                    <button className="sw danger" onClick={requestDeleteSpecies}>Delete species</button>
                </div>
            </div>
            {species?.hidden && <p className="spec-note">Hidden from the species list - visible here until you unhide it.</p>}

            {deletingSpecies && (
                <div className="new-form" style={{ borderColor: 'var(--rust)' }}>
                    <div className="nf-title">Deleting "{species?.common_name}"…</div>
                    <p className="nf-help">This species has no culture lines or library entries tied to it, so this is a real delete - can't be undone once it happens. Going ahead in {deletingSpecies.secondsLeft}s.</p>
                    <div className="edit-row">
                        <button className="mini" onClick={() => setDeletingSpecies(null)}>Undo</button>
                    </div>
                </div>
            )}

            <div className="line-strip">
                {lines.map((g) => (
                    <span key={g.id} className={`line-chip ${g.hidden ? 'hidden' : ''}`}>
                        <span className="lc-code">{g.code}</span>
                        <span className="lc-name">{g.name}{g.hidden ? ' (hidden)' : ''}</span>
                        <button className="edit-btn" title="Edit this line" onClick={() => {
                            setLf({ name: g.name, code: g.code, source: g.source ?? "", supplier_id: g.supplier_id ?? "", acquired_on: g.acquired_on ?? "", notes: g.notes ?? "" });
                            setEditLineId(g.id);
                        }}>✎</button>
                    </span>
                ))}
            </div>

            {deletingLine && (
                <div className="new-form" style={{ borderColor: 'var(--rust)' }}>
                    <div className="nf-title">Deleting "{lines.find((l) => l.id === deletingLine.id)?.name}"…</div>
                    <p className="nf-help">This line has no containers under it, so this is a real delete - can't be undone once it happens. Going ahead in {deletingLine.secondsLeft}s.</p>
                    <div className="edit-row">
                        <button className="mini" onClick={() => setDeletingLine(null)}>Undo</button>
                    </div>
                </div>
            )}

            {editSp && (
                <div className="new-form">
                    <div className="nf-title">Edit species</div>
                    <div className="nf-grid">
                        <div className="nf-field wide"><label>Common name</label>
                            <input className="in" value={sf.common_name} onChange={(e) => setSf({ ...sf, common_name: e.target.value })} /></div>
                        <div className="nf-field wide"><label>Latin name</label>
                            <input className="in" value={sf.latin_name} onChange={(e) => setSf({ ...sf, latin_name: e.target.value })} /></div>
                        <div className="nf-field"><label>Fruiting temp</label>
                            <input className="in" value={sf.fruiting_temp} onChange={(e) => setSf({ ...sf, fruiting_temp: e.target.value })} /></div>
                        <div className="nf-field"><label>Humidity</label>
                            <input className="in" value={sf.humidity} onChange={(e) => setSf({ ...sf, humidity: e.target.value })} /></div>
                        <div className="nf-field"><label>FAE</label>
                            <input className="in" value={sf.fae} onChange={(e) => setSf({ ...sf, fae: e.target.value })} /></div>
                        <div className="nf-field"><label>Colonize temp</label>
                            <input className="in" value={sf.colonize_temp} onChange={(e) => setSf({ ...sf, colonize_temp: e.target.value })} /></div>
                        <div className="nf-field"><label>Colonize time</label>
                            <input className="in" value={sf.colonize_time} onChange={(e) => setSf({ ...sf, colonize_time: e.target.value })} /></div>
                        <div className="nf-field"><label>Pin to harvest</label>
                            <input className="in" value={sf.pin_to_harvest} onChange={(e) => setSf({ ...sf, pin_to_harvest: e.target.value })} /></div>
                        <div className="nf-field wide"><label>Substrate</label>
                            <input className="in" value={sf.substrate_note} onChange={(e) => setSf({ ...sf, substrate_note: e.target.value })} /></div>
                        <div className="nf-field"><label>Dry yield % (optional)</label>
                            <input className="in" inputMode="decimal" value={sf.dry_yield_pct} placeholder="e.g. 8.9"
                                onChange={(e) => setSf({ ...sf, dry_yield_pct: e.target.value })} /></div>
                        <div className="nf-field wide"><label>Notes</label>
                            <textarea className="in ta" rows="3" value={sf.notes} onChange={(e) => setSf({ ...sf, notes: e.target.value })} /></div>
                    </div>
                    <div className="edit-row">
                        <button className="mini" onClick={() => {
                            if (!sf.common_name.trim()) { alert('Common name is required.'); return; }
                            onEditSpecies(species.id, sf); setEditSp(false);
                        }}>Save</button>
                        <button className="mini ghost" onClick={() => setEditSp(false)}>Cancel</button>
                    </div>
                </div>
            )}

            {editLineId && (
                <div className="new-form">
                    <div className="nf-title">Edit line</div>
                    <p className="nf-help">
                        The code is the label prefix for this line's containers. Changing it does not
                        rename containers that already exist.
                    </p>
                    <div className="nf-grid">
                        <div className="nf-field wide"><label>Line name</label>
                            <input className="in" value={lf.name} onChange={(e) => setLf({ ...lf, name: e.target.value })} /></div>
                        <div className="nf-field"><label>Code</label>
                            <input className="in mono-in" maxLength="5" value={lf.code}
                                onChange={(e) => setLf({ ...lf, code: e.target.value.toUpperCase() })} /></div>
                        <div className="nf-field"><label>Acquired</label>
                            <input className="in" type="date" value={lf.acquired_on}
                                onChange={(e) => setLf({ ...lf, acquired_on: e.target.value })} /></div>
                        <div className="nf-field">
                            <label>Vendor (optional)</label>
                            <SupplierPicker suppliers={suppliers} value={lf.supplier_id}
                                onChange={(id) => setLf({ ...lf, supplier_id: id })}
                                onCreate={onGetOrCreateSupplier} />
                        </div>
                        <div className="nf-field wide"><label>Source note</label>
                            <input className="in" value={lf.source} onChange={(e) => setLf({ ...lf, source: e.target.value })} /></div>
                        <div className="nf-field wide"><label>Notes</label>
                            <textarea className="in ta" rows="3" value={lf.notes}
                                onChange={(e) => setLf({ ...lf, notes: e.target.value })} /></div>
                    </div>
                    <div className="edit-row">
                        <button className="mini" onClick={() => {
                            if (!lf.name.trim()) { alert('Line name is required.'); return; }
                            if (!lf.code.trim()) { alert('Code is required.'); return; }
                            onEditLine(editLineId, lf); setEditLineId(null);
                        }}>Save</button>
                        <button className="mini ghost" onClick={() => setEditLineId(null)}>Cancel</button>
                        <button className="mini ghost" onClick={() => {
                            const g = lines.find((l) => l.id === editLineId);
                            onToggleLineHidden(editLineId, !g?.hidden);
                        }}>{lines.find((l) => l.id === editLineId)?.hidden ? 'Unhide' : 'Hide'}</button>
                        <button className="mini danger" onClick={() => requestDeleteLine(editLineId)}>Delete</button>
                    </div>
                </div>
            )}

            {addingLine && (
                <div className="new-form">
                    <div className="nf-title">New genetics line — {species?.common_name}</div>
                    <p className="nf-help">
                        One line per acquisition. A second purchase of the same strain is a separate
                        line, since you can't verify it's the same genetics.
                    </p>
                    <div className="nf-grid">
                        <div className="nf-field wide">
                            <label>Line name</label>
                            <input className="in" autoFocus value={nf.name} placeholder="Chestnut A"
                                onChange={(e) => setNf({ ...nf, name: e.target.value })} />
                        </div>
                        <div className="nf-field">
                            <label>Code (label prefix)</label>
                            <input className="in mono-in" value={nf.code} placeholder="CH" maxLength="5"
                                onChange={(e) => setNf({ ...nf, code: e.target.value.toUpperCase() })} />
                        </div>
                        <div className="nf-field">
                            <label>Acquired</label>
                            <input className="in" type="date" value={nf.acquired}
                                onChange={(e) => setNf({ ...nf, acquired: e.target.value })} />
                        </div>
                        <div className="nf-field">
                            <label>Vendor (optional)</label>
                            <SupplierPicker suppliers={suppliers} value={nf.supplier_id}
                                onChange={(id) => setNf({ ...nf, supplier_id: id })}
                                onCreate={onGetOrCreateSupplier} />
                        </div>
                        <div className="nf-field wide">
                            <label>Source note</label>
                            <input className="in" value={nf.source} placeholder="Commercial LC — Out-Grow"
                                onChange={(e) => setNf({ ...nf, source: e.target.value })} />
                        </div>
                        <div className="nf-field wide">
                            <label>First container — what actually arrived or got made</label>
                            <select className="in sel" value={nf.firstType}
                                onChange={(e) => setNf({ ...nf, firstType: e.target.value, stockId: "" })}>
                                {Object.keys(TYPES).map((t) => <option key={t} value={t}>{TYPES[t]}</option>)}
                            </select>
                        </div>
                        {stock.filter((s) => stockUsableFor(s.kind, nf.firstType) && s.status === 'on_hand').length > 0 && (
                            <div className="nf-field wide">
                                <label>Made from on-hand stock (optional) — pick the exact unit</label>
                                <select className="in sel" value={nf.stockId} onChange={(e) => setNf({ ...nf, stockId: e.target.value })}>
                                    <option value="">— not from stock —</option>
                                    {stock.filter((s) => stockUsableFor(s.kind, nf.firstType) && s.status === 'on_hand')
                                        .map((s) => <option key={s.id} value={s.id}>
                                            {s.label || 'Unlabeled unit'}{s.amount != null ? ` · ${fmtAmount(s.amount, s.amount_unit, unitsPref)}` : ''}{s.made_or_bought_on ? ` · ${fmt(s.made_or_bought_on, dateFormat)}` : ''}
                                        </option>)}
                                </select>
                            </div>
                        )}
                        <div className="nf-field wide">
                            <label>Notes on this line</label>
                            <textarea className="in ta" rows="3" value={nf.notes}
                                placeholder="How it performs, quirks, anything about the genetics itself."
                                onChange={(e) => setNf({ ...nf, notes: e.target.value })} />
                        </div>
                    </div>
                    <div className="edit-row">
                        <button className="mini" onClick={async () => {
                            if (!nf.name.trim()) { alert('Line name is required.'); return; }
                            if (!nf.code.trim()) { alert('Code is required.'); return; }
                            await onAddLine(nf, nf.firstType, nf.stockId || null);
                            setNf({ name: "", code: "", source: "", supplier_id: "", acquired: "", notes: "", firstType: "lc", stockId: "" });
                            setAddingLine(false);
                        }}>Add line</button>
                        <button className="mini ghost" onClick={() => setAddingLine(false)}>Cancel</button>
                    </div>
                </div>
            )}

            <div className="canvas" ref={box} onPointerDown={onDown}>
                <svg width="100%" height="100%">
                    <g className="stage" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
                        {items.filter((i) => !i.parent).map((r) => {
                            const g = lines.find((l) => l.id === r.geneticsId);
                            const p = pos[r.id];
                            return (
                                <text key={'lbl' + r.id} x={p.x} y={p.y - 34} className="line-label" textAnchor="middle">
                                    {g?.name ?? 'Unknown line'}
                                </text>
                            );
                        })}
                        {items.map((i) => i.parent && (
                            <path key={i.id}
                                className={`hypha ${i.form === 'syringe' ? "drawn " : ""}${litChain.includes(i.id) && litChain.includes(i.parent) ? "lit" : hover ? "dim" : ""}`}
                                d={hypha(pos[i.parent], pos[i.id])} strokeWidth={thread(pos[i.id].depth)} />
                        ))}
                        {items.map((i) => {
                            const p = pos[i.id], st = STATUS[i.status], tone = TONE[st.tone], r = radius(p.depth);
                            const hasPhoto = photos.some((ph) => ph.item_id === i.uid);
                            return (
                                <g key={i.id} className={`node ${hover && !litChain.includes(i.id) ? "faded" : ""}`}
                                    style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
                                    onMouseEnter={() => setHover(i.id)}
                                    onMouseLeave={() => setHover(null)}
                                    onClick={() => { if (!moved.current) onOpen(i.id); }}>
                                    {st.live && <circle r={r + 6} fill={tone} className="pulse" />}
                                    <circle r={r} fill="#111720" stroke={tone} strokeWidth="1.9" />
                                    {st.tone !== "slate" && <circle r={r * 0.42} fill={tone} />}
                                    {hasPhoto && <circle cx={r * 0.72} cy={-r * 0.72} r="2.6" className="photo-dot" />}
                                    <text y={r + 17} className="n-id" textAnchor="middle">{i.id}</text>
                                    <text y={r + 30} className="n-sub" textAnchor="middle">{FORMS[i.type]?.[i.form] ?? TYPES[i.type]}{days(i.created) !== null ? ` · d${days(i.created)}` : ""}</text>
                                </g>
                            );
                        })}
                    </g>
                </svg>
                <div className="hint">drag to pan · scroll or pinch to zoom · tap a node</div>
            </div>

            <div className="lineage-collage">
                <div className="eyebrow">Every photo across this lineage, not just one item</div>
                <h2 className="lc-h2">Photos</h2>
                {linPhotos.length === 0 ? (
                    <p className="nf-help">No photos logged for this lineage yet - add one from any item's page.</p>
                ) : (
                    <div className="lc-mosaic">
                        {linPhotos.map((p) => {
                            const it = items.find((i) => i.uid === p.item_id);
                            return (
                                <button key={p.id} className={`lc-tile sz-${tileSize(p.id)}`}
                                    onClick={() => setLightbox({ photo: p, item: it })}>
                                    <img src={photoUrl(p)} alt={p.caption ?? ''} loading="lazy" decoding="async" />
                                    <div className="lc-meta">
                                        <span>{it?.id ?? 'Unlinked'}</span>
                                        {p.taken_on && <span>{fmt(p.taken_on, dateFormat)}</span>}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>

            {lightbox && (
                <Lightbox photo={lightbox.photo} url={photoUrl(lightbox.photo, 'display')}
                    onClose={() => setLightbox(null)} onDelete={onDeletePhoto} onEdit={onEditPhoto} dateFormat={dateFormat}
                    extra={lightbox.item && <button className="mini ghost" onClick={() => onOpen(lightbox.item.id)}>Open {lightbox.item.id}</button>} />
            )}
        </div>
    );
}

/* ---------------- DETAIL PAGE ---------------- */

function Detail({ items, id, culture, onBack, onOpen, addChild, drawSyringes, saveStatus, saveNote, saveHarvest, deleteEvent, deleteHarvest, editEvent, editHarvest, saveItemFields, deleteItem, reparentItem, stock, library, suppliers, onGetOrCreateSupplier, photos, photoUrl, addPhoto, deletePhoto, editPhoto, onPrintLabel, onQueueLabel, unitsPref, dateFormat }) {
    const it = items.find((i) => i.id === id);
    const [picking, setPicking] = useState(false);
    const [pickedType, setPickedType] = useState(null);
    const [note, setNote] = useState("");
    const [wet, setWet] = useState("");
    const [editing, setEditing] = useState(null);   // event id or lot id
    const [draft, setDraft] = useState({ date: "", body: "", wet: "" });
    const [editHead, setEditHead] = useState(false);
    const [editNotes, setEditNotes] = useState(false);
    /* null = closed. Otherwise the in-progress draw. */
    const [drawing, setDrawing] = useState(null);
    const [f, setF] = useState({});                 // field drafts

    const kids = items.filter((i) => i.parent === id);

    /* Everything below this item. Excluded from the parent dropdown so an
       item can't be reparented under its own descendant and orphan a loop.
       `seen` stops this from spinning forever if a duplicate label ever
       creates an actual cycle in the parent chain. */
    const descendants = (() => {
        const out = [];
        const seen = new Set();
        const walk = (lbl) => {
            if (seen.has(lbl)) return;
            seen.add(lbl);
            items.filter((i) => i.parent === lbl).forEach((c) => { out.push(c.id); walk(c.id); });
        };
        walk(id);
        return out;
    })();
    const chain = [];
    { let c = it; while (c) { chain.unshift(c); c = items.find((i) => i.id === c.parent); } }

    const st = STATUS[it.status], tone = TONE[st.tone];
    const totalWet = it.harvests.reduce((s, h) => s + h.wet, 0);
    const be = it.dryWeight && totalWet ? ((totalWet / it.dryWeight) * 100).toFixed(1) : null;

    const [pendingStatus, setPendingStatus] = useState(null);
    const [reason, setReason] = useState("");

    const setStatus = (s) => {
        /* Re-clicking the status the item is already at (to fix a typo'd
           or add-more-detail reason) should start from what's already
           there, not wipe it - only a genuine status *change* starts the
           box blank. */
        if (STATUS[s].needsReason) { setPendingStatus(s); setReason(it.status === s ? (it.failureReason || "") : ""); return; }
        saveStatus(id, s);
    };
    const addNote = () => {
        if (!note.trim()) return;
        saveNote(id, note.trim());
        setNote("");
    };
    const addHarvest = () => {
        const g = parseFloat(wet);
        if (!g) return;
        saveHarvest(id, g);
        setWet("");
    };

    return (
        <div className="page detail">
            <button className="back" onClick={onBack}>← {culture?.name}</button>

            <div className="d-head">
                <div className="d-mark" style={{ borderColor: tone }}>
                    <span style={{ background: tone }} />
                </div>
                {editHead ? (
                    <div className="head-edit">
                        <input className="in" value={f.id ?? ""} onChange={(e) => setF({ ...f, id: e.target.value })}
                            placeholder="label, e.g. BO-GR2" />
                        <select className="in sel" value={f.type ?? it.type} onChange={(e) => setF({ ...f, type: e.target.value, form: "" })}>
                            {Object.keys(TYPES).map((t) => <option key={t} value={t}>{TYPES[t]}</option>)}
                        </select>
                        {FORMS[f.type ?? it.type] && (
                            <select className="in sel" value={f.form ?? ""} onChange={(e) => setF({ ...f, form: e.target.value })}>
                                <option value="">— form not set —</option>
                                {Object.entries(FORMS[f.type ?? it.type]).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                            </select>
                        )}
                        <div className="amt-pair">
                            <input className="in sm" type="number" step="any" value={f.amount ?? ""}
                                onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="amount" />
                            <UnitSelect className="in sel sm" value={f.amountUnit ?? ""}
                                onChange={(v) => setF({ ...f, amountUnit: v })} />
                        </div>
                        {/* Options depend on what the PARENT is, so changing the
                            parent above changes what's on offer here. */}
                        {methodsFor(items.find((c) => c.id === (f.parent ?? it.parent))?.type, f.form ?? it.form) && (
                            <select className="in sel" value={f.method ?? ""} onChange={(e) => setF({ ...f, method: e.target.value })}>
                                <option value="">— how it was started —</option>
                                {Object.entries(methodsFor(items.find((c) => c.id === (f.parent ?? it.parent))?.type, f.form ?? it.form))
                                    .map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                            </select>
                        )}
                        {f.method === 'other' && (
                            <input className="in" value={f.methodNote ?? ""}
                                onChange={(e) => setF({ ...f, methodNote: e.target.value })}
                                placeholder="how? e.g. spore syringe from a swab" />
                        )}
                        {/* Not gated on method - the vendor may be for the raw
                            material (a bought all-in-one bag, say) even when
                            the culture itself was self-inoculated, and it
                            shouldn't require a Stock record to exist. */}
                        <SupplierPicker suppliers={suppliers} value={f.supplierId}
                            onChange={(supId) => setF({ ...f, supplierId: supId })}
                            onCreate={onGetOrCreateSupplier} />
                        <input className="in sm" type="date" value={f.created ?? ""} onChange={(e) => setF({ ...f, created: e.target.value })} />
                        <input className="in" value={f.substrate ?? ""} onChange={(e) => setF({ ...f, substrate: e.target.value })}
                            placeholder="substrate, e.g. Supp. hardwood bag" />
                        <input className="in sm" inputMode="decimal" value={f.dryWeight ?? ""}
                            onChange={(e) => setF({ ...f, dryWeight: e.target.value })} placeholder="dry substrate (g)" />
                        <select className="in sel" value={f.parent ?? ""} onChange={(e) => setF({ ...f, parent: e.target.value })}>
                            <option value="">— no parent (start of the line) —</option>
                            {items.filter((c) => c.id !== id && !descendants.includes(c.id))
                                .map((c) => <option key={c.id} value={c.id}>came from {c.id}</option>)}
                        </select>
                        <button className="mini" onClick={() => {
                            const patch = {};
                            if (f.id?.trim() && f.id.trim() !== it.id) patch.id = f.id.trim();
                            if (f.type && f.type !== it.type) patch.type = f.type;
                            if ((f.form ?? "") !== (it.form ?? "")) patch.form = f.form ?? "";
                            {
                                /* Blank clears it; anything unparseable is
                                   ignored rather than silently stored as NaN. */
                                const raw = (f.amount ?? "").toString().trim();
                                const next = raw === "" ? null : Number(raw);
                                if (raw === "" || Number.isFinite(next)) {
                                    if (next !== (it.amount ?? null)) patch.amount = next;
                                }
                                if ((f.amountUnit ?? "") !== (it.amountUnit ?? "")) patch.amountUnit = f.amountUnit ?? "";
                            }
                            if ((f.method ?? "") !== (it.method ?? "")) patch.method = f.method ?? "";
                            if ((f.methodNote ?? "") !== (it.methodNote ?? "")) patch.methodNote = f.methodNote ?? "";
                            if ((f.supplierId || "") !== (it.supplierId || "")) patch.supplierId = f.supplierId || null;
                            if ((f.created || null) !== it.created) patch.created = f.created || null;
                            if ((f.substrate ?? "").trim() !== (it.substrate ?? "")) patch.substrate = (f.substrate ?? "").trim();
                            {
                                const raw = (f.dryWeight ?? "").toString().trim();
                                const dw = raw === "" ? null : parseFloat(raw);
                                if ((raw === "" || !Number.isNaN(dw)) && dw !== (it.dryWeight ?? null)) patch.dryWeight = dw;
                            }
                            if (Object.keys(patch).length) saveItemFields(id, patch);
                            if ((f.parent || null) !== (it.parent || null)) reparentItem(patch.id ?? id, f.parent || null);
                            setEditHead(false);
                        }}>Save</button>
                        <button className="mini ghost" onClick={() => setEditHead(false)}>Cancel</button>
                        <button className="mini danger" onClick={() => {
                            const kids = items.filter((c) => c.parent === id);
                            const msg = kids.length
                                ? `Delete ${it.id}? Its ${kids.length} child container${kids.length > 1 ? 's' : ''} will attach to ${it.parent ?? 'nothing (they become roots)'} instead.`
                                : `Delete ${it.id}? This also removes its harvests and history.`;
                            if (confirm(msg)) deleteItem(id);
                        }}>Delete</button>
                    </div>
                ) : (
                    <div className="head-read">
                        <h1 className="d-id">{it.id}</h1>
                    </div>
                )}
                {!editHead && (
                    <>
                        <button className="edit-btn" title="Edit label, type, form, amount, method, vendor, start date, substrate"
                            onClick={() => { setF({ id: it.id, type: it.type, form: it.form ?? "", amount: it.amount ?? "", amountUnit: it.amountUnit ?? "", method: it.method ?? "", methodNote: it.methodNote ?? "", created: it.created ?? "", parent: it.parent ?? "", supplierId: it.supplierId ?? "", substrate: it.substrate ?? "", dryWeight: it.dryWeight ?? "" }); setEditHead(true); }}>✎</button>
                        <div className="pl-icon-row">
                            <button className="pl-icon-btn pl-trigger" title="Print a QR sticker for this item" onClick={onPrintLabel}><PrinterIcon /></button>
                            <button className="pl-icon-btn pl-queue" title="Add to the print queue instead - print it later alongside other labels" onClick={onQueueLabel}><PrinterQueueIcon /></button>
                        </div>
                        <span className="pill" style={{ background: tone, color: 'var(--panel)' }}>{st.label}</span>
                    </>
                )}
            </div>

            <div className="crumbs">
                {chain.map((c, n) => (
                    <span key={c.id}>
                        {n > 0 && <span className="arrow">→</span>}
                        <button className={`crumb ${c.id === id ? "here" : ""}`} onClick={() => c.id !== id && onOpen(c.id)}>{c.id}</button>
                    </span>
                ))}
            </div>

            <PhotoStrip attach={{ itemId: it.uid }} photos={photos.filter((p) => p.item_id === it.uid)}
                photoUrl={photoUrl} onAdd={addPhoto} onDelete={deletePhoto} onEdit={editPhoto} dateFormat={dateFormat} />

            <div className="actions">
                {/* Only a jar can be drawn from - a syringe isn't decanted
                    into further syringes. Form may be unset on older rows,
                    so anything that isn't explicitly a syringe counts. */}
                {it.type === 'lc' && it.form !== 'syringe' && !picking && !drawing && (
                    <button className="cta ghost" onClick={() => setDrawing({ count: 1, amount: "", unit: "mL", assign: {} })}>
                        Draw syringes
                    </button>
                )}
                {drawing && (
                    <div className="picker draw">
                        <span className="pk-l">Draw off {it.id}. The jar stays as it is - retire it yourself when it's spent.</span>
                        <div className="draw-row">
                            <label>How many</label>
                            <input className="in sm" type="number" min="1" max="24" value={drawing.count}
                                onChange={(e) => setDrawing({ ...drawing, count: e.target.value })} />
                            <label>Each</label>
                            <input className="in sm" type="number" step="any" placeholder="10" value={drawing.amount}
                                onChange={(e) => setDrawing({ ...drawing, amount: e.target.value })} />
                            <UnitSelect className="in sel sm" value={drawing.unit}
                                onChange={(v) => setDrawing({ ...drawing, unit: v })} />
                        </div>
                        {kids.filter((k) => k.form !== 'syringe').length > 0 && (
                            <div className="draw-assign">
                                <span className="pk-l">
                                    Anything already under {it.id} that actually came off one of these? Move it, and the
                                    syringe slots in between.
                                </span>
                                {/* Syringes already drawn off this jar are excluded -
                                    a syringe never hangs under another syringe, and
                                    listing them just clutters a repeat draw. */}
                                {kids.filter((k) => k.form !== 'syringe').map((k) => (
                                    <div className="draw-row" key={k.id}>
                                        <label>{k.id}</label>
                                        <select className="in sel sm" value={drawing.assign[k.id] ?? ""}
                                            onChange={(e) => setDrawing({ ...drawing, assign: { ...drawing.assign, [k.id]: e.target.value } })}>
                                            <option value="">stays on {it.id}</option>
                                            {Array.from({ length: Math.max(1, Math.min(24, Number(drawing.count) || 1)) })
                                                .map((_, n) => <option key={n} value={n}>syringe {n + 1}</option>)}
                                        </select>
                                    </div>
                                ))}
                            </div>
                        )}
                        <button className="chip go" onClick={() => {
                            const count = Math.max(1, Math.min(24, Number(drawing.count) || 1));
                            const raw = String(drawing.amount).trim();
                            const amt = raw === "" ? null : Number(raw);
                            /* Drop assignments pointing past the final count -
                               easy to strand one by lowering the number after
                               picking, and a dangling index would silently
                               leave that child on the jar with no warning. */
                            const assign = Object.fromEntries(
                                Object.entries(drawing.assign).filter(([, v]) => v !== "" && Number(v) < count)
                            );
                            drawSyringes(id, count, Number.isFinite(amt) ? amt : null, drawing.unit.trim(), assign);
                            setDrawing(null);
                        }}>Draw {Math.max(1, Math.min(24, Number(drawing.count) || 1))}</button>
                        <button className="chip" onClick={() => setDrawing(null)}>Cancel</button>
                    </div>
                )}
                {!picking ? (
                    <button className="cta" onClick={() => setPicking(true)}>Inoculate from this</button>
                ) : !pickedType ? (
                    <div className="picker">
                        <span className="pk-l">Into what?</span>
                        {["agar", "lc", "grain", "bulk", "block", "cake"].map((t) => {
                            const matches = stock.filter((s) => stockUsableFor(s.kind, t) && s.status === 'on_hand');
                            return (
                                <button key={t} className="chip go" onClick={() => {
                                    if (matches.length) setPickedType(t);
                                    else { addChild(id, t); setPicking(false); }
                                }}>{TYPES[t]}</button>
                            );
                        })}
                        <button className="chip" onClick={() => setPicking(false)}>Cancel</button>
                    </div>
                ) : (
                    <div className="picker">
                        <span className="pk-l">From stock, or fresh? Pick the exact unit.</span>
                        {stock.filter((s) => stockUsableFor(s.kind, pickedType) && s.status === 'on_hand').map((s) => (
                            <button key={s.id} className="chip go" onClick={() => {
                                addChild(id, pickedType, s.id); setPicking(false); setPickedType(null);
                            }}>{s.label || stockLabel(s, library, suppliers)}{s.amount != null ? ` · ${fmtAmount(s.amount, s.amount_unit, unitsPref)}` : ''}</button>
                        ))}
                        <button className="chip" onClick={() => { addChild(id, pickedType); setPicking(false); setPickedType(null); }}>Not from stock</button>
                        <button className="chip" onClick={() => setPickedType(null)}>Back</button>
                    </div>
                )}
            </div>

            <div className="cols">
                <div>
                    <Sec title="Status" />
                    <div className="chips">
                        {Object.keys(STATUS).map((s) => (
                            <button key={s} className={`chip ${it.status === s ? "on" : ""}`} onClick={() => setStatus(s)}>{STATUS[s].label}</button>
                        ))}
                    </div>

                    {pendingStatus && (
                        <div className="reason-box">
                            <div className="rb-title">Why? — {STATUS[pendingStatus].label}</div>
                            <div className="chips">
                                {REASONS[pendingStatus].map((r) => (
                                    <button key={r} className={`chip ${reason === r ? "on" : ""}`} onClick={() => setReason(r)}>{r}</button>
                                ))}
                            </div>
                            <div className="edit-row">
                                <input className="in" value={reason} placeholder="or type your own"
                                    onChange={(e) => setReason(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && reason.trim()) { saveStatus(id, pendingStatus, reason.trim()); setPendingStatus(null); }
                                        if (e.key === 'Escape') setPendingStatus(null);
                                    }} />
                                <button className="mini" onClick={() => {
                                    if (!reason.trim()) return;
                                    saveStatus(id, pendingStatus, reason.trim());
                                    setPendingStatus(null);
                                }}>Save</button>
                                <button className="mini ghost" onClick={() => setPendingStatus(null)}>Cancel</button>
                            </div>
                        </div>
                    )}

                    {it.failureReason && !pendingStatus && (
                        <p className="fail-note" style={{ color: tone }}>{st.label} — {it.failureReason}</p>
                    )}

                    {FRUITS.includes(it.type) && (
                        <>
                            <Sec title="Harvests" />
                            {it.harvests.length > 0 && (
                                <table className="tbl">
                                    <thead><tr><th>Flush</th><th>Date</th><th>Wet</th><th></th></tr></thead>
                                    <tbody>
                                        {it.harvests.map((h) => editing === h.lotId ? (
                                            <tr key={h.lotId}>
                                                <td>{h.f}</td>
                                                <td colSpan="3">
                                                    <div className="edit-row">
                                                        <input className="in sm" type="date" value={draft.date}
                                                            onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
                                                        <input className="in sm" inputMode="decimal" value={draft.wet}
                                                            onChange={(e) => setDraft({ ...draft, wet: e.target.value })} placeholder="grams" />
                                                        <button className="mini" onClick={() => {
                                                            const g = parseFloat(draft.wet);
                                                            if (!g || !draft.date) return;
                                                            editHarvest(id, h, draft.date, g);
                                                            setEditing(null);
                                                        }}>Save</button>
                                                        <button className="mini ghost" onClick={() => setEditing(null)}>Cancel</button>
                                                        <button className="mini danger" onClick={() => {
                                                            if (confirm(`Delete flush ${h.f} (${h.wet}g)? This removes the inventory lot too.`)) {
                                                                deleteHarvest(id, h); setEditing(null);
                                                            }
                                                        }}>Delete</button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ) : (
                                            <tr key={h.lotId ?? h.f}>
                                                <td>{h.f}</td>
                                                <td>{fmt(h.date, dateFormat)}</td>
                                                <td className="num">{h.wet} g</td>
                                                <td className="x-cell">
                                                    {h.lotId && (
                                                        <button className="log-x" title="Edit this flush"
                                                            onClick={() => { setEditing(h.lotId); setDraft({ date: h.date, wet: String(h.wet), body: "" }); }}>✎</button>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                            <div className="row-in">
                                <input className="in" inputMode="numeric" placeholder="wet grams" value={wet} onChange={(e) => setWet(e.target.value)} />
                                <button className="mini" onClick={addHarvest}>Log flush</button>
                            </div>
                            {it.dryWeight && (
                                <div className="be">
                                    <span>{totalWet} g wet ÷ {it.dryWeight} g dry substrate</span>
                                    <strong style={{ color: be ? TONE.jade : "#5B6773" }}>{be ? `${be}% BE` : "— BE"}</strong>
                                </div>
                            )}
                        </>
                    )}

                    <Sec title="Details" />
                    <dl className="facts">
                        <dt>Type</dt>
                        <dd>{TYPES[it.type]}{it.form && FORMS[it.type]?.[it.form] ? ` · ${FORMS[it.type][it.form]}` : ""}</dd>
                        <dt>Amount</dt>
                        <dd>{it.amount != null ? fmtAmount(it.amount, it.amountUnit, unitsPref) : "—"}</dd>
                        <dt>Started</dt>
                        <dd>{fmt(it.created, dateFormat)}{days(it.created) !== null ? ` · day ${days(it.created)}` : ""}</dd>
                        <dt>Method</dt>
                        <dd>{it.method
                            ? <>
                                {it.method === 'other'
                                    ? (it.methodNote || 'Other')
                                    : (methodsFor(items.find((c) => c.id === it.parent)?.type, it.form)?.[it.method] ?? it.method)}
                                {it.parent ? ` from ${it.parent}` : ""}
                            </>
                            : "—"}</dd>
                        <dt>Vendor</dt>
                        <dd>{it.supplierId ? (suppliers.find((s) => s.id === it.supplierId)?.name ?? 'unknown vendor') : "—"}</dd>
                        <dt>Substrate</dt><dd>{it.substrate || "—"}</dd>
                        <dt>Dry substrate</dt><dd>{it.dryWeight != null ? `${it.dryWeight} g` : "—"}</dd>
                        <dt>Came from</dt><dd>{it.parent ? <button className="lnk" onClick={() => onOpen(it.parent)}>{it.parent}</button> : "origin of this line"}</dd>
                        <dt>Produced</dt>
                        <dd>{kids.length ? kids.map((k) => <button key={k.id} className="lnk" onClick={() => onOpen(k.id)}>{k.id}</button>) : "nothing yet"}</dd>
                    </dl>

                    <Sec title="Notes" onEdit={editNotes ? null : () => { setF({ notes: it.notes ?? "" }); setEditNotes(true); }} />
                    {editNotes ? (
                        <div className="field-form">
                            <textarea className="in ta" rows="6" value={f.notes}
                                onChange={(e) => setF({ ...f, notes: e.target.value })}
                                placeholder="Anything worth remembering about this container. One thought per line." />
                            <div className="edit-row">
                                <button className="mini" onClick={() => { saveItemFields(id, { notes: f.notes }); setEditNotes(false); }}>Save</button>
                                <button className="mini ghost" onClick={() => setEditNotes(false)}>Cancel</button>
                            </div>
                        </div>
                    ) : (
                        it.notes
                            ? <p className="notes">{it.notes.split('\n').map((line, n) => <span key={n}>{line}<br /></span>)}</p>
                            : <p className="notes empty-note">No notes yet.</p>
                    )}
                </div>

                <div>
                    <Sec title="History" />
                    <ul className="log">
                        {[...it.log].reverse().map((l, n) => editing === l.id ? (
                            <li key={l.id} className="editing">
                                <div className="edit-row wrap">
                                    <input className="in sm" type="date" value={draft.date}
                                        onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
                                    <input className="in" value={draft.body}
                                        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && draft.body.trim() && draft.date) {
                                                editEvent(id, l.id, draft.date, draft.body.trim());
                                                setEditing(null);
                                            }
                                            if (e.key === 'Escape') setEditing(null);
                                        }} />
                                    <button className="mini" onClick={() => {
                                        if (!draft.body.trim() || !draft.date) return;
                                        editEvent(id, l.id, draft.date, draft.body.trim());
                                        setEditing(null);
                                    }}>Save</button>
                                    <button className="mini ghost" onClick={() => setEditing(null)}>Cancel</button>
                                    <button className="mini danger" onClick={() => {
                                        if (confirm(`Delete "${l.body}"?`)) { deleteEvent(id, l.id); setEditing(null); }
                                    }}>Delete</button>
                                </div>
                            </li>
                        ) : (
                            <li key={l.id ?? n}>
                                <span className="log-d">{fmt(l.date, dateFormat)}</span>
                                <span className="log-t">{l.body}</span>
                                {l.id && (
                                    <EventPhotos photos={photos.filter((p) => p.event_id === l.id)} photoUrl={photoUrl}
                                        onAdd={(file) => addPhoto(file, { itemId: it.uid, eventId: l.id })}
                                        onDelete={deletePhoto} onEdit={editPhoto} dateFormat={dateFormat} />
                                )}
                                {l.id && (
                                    <button className="log-x" title="Edit this entry"
                                        onClick={() => { setEditing(l.id); setDraft({ date: l.date, body: l.body, wet: "" }); }}>✎</button>
                                )}
                            </li>
                        ))}
                    </ul>
                    <div className="row-in">
                        <input className="in" placeholder="add a note…" value={note} onChange={(e) => setNote(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && addNote()} />
                        <button className="mini" onClick={addNote}>Add</button>
                    </div>
                </div>
            </div>
        </div>
    );
}

/* ---------------- PRINT LABELS ---------------- */

/* Live web origin when actually running as the web app; falls back to
   the known public URL when running from the packaged desktop app
   (file:// isn't something a phone camera can open) OR from a local
   dev server (localhost/127.0.0.1/LAN dev addresses aren't reachable
   by a phone camera off-network either - a QR printed while running
   `npm run dev` would otherwise encode a dead link). This is what a
   scanned QR label actually resolves to. */
const isPublicHttpOrigin = (origin) => {
    if (!/^https?:/.test(origin)) return false;
    try {
        const host = new URL(origin).hostname;
        return host !== 'localhost' && host !== '127.0.0.1' && !/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(host);
    } catch {
        return false;
    }
};
const APP_URL = (typeof window !== 'undefined' && isPublicHttpOrigin(window.location.origin))
    ? window.location.origin + window.location.pathname
    : 'https://mycellium-tracks.vercel.app/';

/* Standard 3-across x 10-down address label sheet (Avery 5160 and its
   many compatible equivalents - what Matt actually has on hand) - the
   most common label format there is, so unlike the earlier 22805
   guess these numbers are well-documented and cross-checked against
   multiple sources: 2.625" x 1" labels, 0.5" top margin, 0.1875"
   (3/16") left margin, 0.125" (1/8") gap between columns, labels
   touch vertically (no row gap). All four still editable below in
   case a real test print needs a small nudge for this printer. */
const LABEL_W_IN = 2.625, LABEL_H_IN = 1;
const COLS = 3, ROWS = 10;
const PER_SHEET = COLS * ROWS;
const DEFAULT_TOP = 0.5, DEFAULT_LEFT = 0.1875, DEFAULT_GAP_X = 0.125, DEFAULT_GAP_Y = 0;

/* Generalized over what's being printed - items (kept in the lineage tree,
   QR = ?item=<label>) or stock units (not in the tree yet, QR = ?stock=
   <id>, see the deep-link handling in the data-loading effect and
   consumeStock() for why that keeps working after the unit is consumed).
   `candidates` is already the fully-resolved, caller-sorted browsable list
   - every entry starts checked, and unchecking just drops it from what
   prints without removing it from the list, same as before.

   Each candidate now carries its own `kind`/`linkParam` (2026-09-22, print
   queue) rather than one shared `linkParam` prop - the queue view mixes
   items and stock units in one list, so the QR for each row has to be
   built from that row's own kind, not a batch-wide assumption. Identity
   throughout (checked-set, qrs cache, React keys) uses `kind:id` rather
   than bare `id` for the same reason - an item id and a stock uuid living
   in the same list should never be able to collide.

   `onRemove(kind, id)` and `onPrinted(printedList)` are only passed for
   the print-queue view (see the `printing.kind === 'queue'` branch in the
   render switch) - undefined for the plain single-kind call sites, where
   there's no persistent queue to remove from or clear. */
function PrintLabels({ candidates, subtitle, onClose, onRemove, onPrinted, dateFormat }) {
    const ckey = (c) => `${c.kind}:${c.id}`;
    const [checked, setChecked] = useState(() => new Set(candidates.map(ckey)));
    const [startAt, setStartAt] = useState(1);
    const [topIn, setTopIn] = useState(String(DEFAULT_TOP));
    const [leftIn, setLeftIn] = useState(String(DEFAULT_LEFT));
    const [gapXIn, setGapXIn] = useState(String(DEFAULT_GAP_X));
    const [gapYIn, setGapYIn] = useState(String(DEFAULT_GAP_Y));
    const [qrs, setQrs] = useState({});

    const selected = useMemo(() => candidates.filter((c) => checked.has(ckey(c))), [candidates, checked]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const entries = await Promise.all(selected.map(async (c) => {
                const url = `${APP_URL}?${c.linkParam}=${encodeURIComponent(c.id)}`;
                // Error correction Q (~25% recovery) rather than the default M -
                // these end up on jars and tubs in a humid grow space, splashed
                // and misted, so a little print/label damage shouldn't kill the scan.
                const svg = await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'Q' });
                return [ckey(c), svg];
            }));
            if (!cancelled) setQrs(Object.fromEntries(entries));
        })();
        return () => { cancelled = true; };
    }, [selected]);

    const toggle = (key) => setChecked((p) => {
        const next = new Set(p);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });

    const blanks = Math.max(0, (parseInt(startAt, 10) || 1) - 1);
    const totalSlots = blanks + selected.length;
    const sheetCount = Math.max(1, Math.ceil(totalSlots / PER_SHEET));
    const gapX = parseFloat(gapXIn) || 0;
    const gapY = parseFloat(gapYIn) || 0;
    const top = parseFloat(topIn) || 0;
    const left = parseFloat(leftIn) || 0;

    return (
        <div className="page pl-wrap">
            <div className="pl-controls">
                <button className="back" onClick={onClose}>← Back</button>
                <div className="bar"><div><h1>Print labels</h1>
                    <div className="d-sub">Standard address labels (3 across x 10 down, {PER_SHEET} per sheet) - {subtitle}</div>
                </div></div>

                <div className="pl-field-row">
                    <label>Start at label #<input className="in sm" type="number" min="1" max={PER_SHEET}
                        value={startAt} onChange={(e) => setStartAt(e.target.value)} /></label>
                    <span className="nf-help nf-help-page">Already used some labels on this sheet? Skip them instead of reprinting over them.</span>
                </div>
                <div className="pl-field-row">
                    <label>Top margin (in)<input className="in sm" type="number" step="0.02"
                        value={topIn} onChange={(e) => setTopIn(e.target.value)} /></label>
                    <label>Left margin (in)<input className="in sm" type="number" step="0.02"
                        value={leftIn} onChange={(e) => setLeftIn(e.target.value)} /></label>
                    <label>Column gap (in)<input className="in sm" type="number" step="0.02"
                        value={gapXIn} onChange={(e) => setGapXIn(e.target.value)} /></label>
                    <label>Row gap (in)<input className="in sm" type="number" step="0.02"
                        value={gapYIn} onChange={(e) => setGapYIn(e.target.value)} /></label>
                    <span className="nf-help nf-help-page">Set to the standard Avery 5160-style spec (0.5"/0.1875"/0.125"/0") - nudge these if your test print is off.</span>
                </div>

                {candidates.length > 0 && (
                    <div className="pl-field-row">
                        <button type="button" className="sw" onClick={() => setChecked(new Set(candidates.map(ckey)))}>Select all</button>
                        <button type="button" className="sw" onClick={() => setChecked(new Set())}>Deselect all</button>
                        <span className="nf-help nf-help-page">{selected.length} of {candidates.length} selected</span>
                    </div>
                )}
                <div className="pl-list">
                    {candidates.length === 0 && <p className="nf-help nf-help-page">Nothing to print here.</p>}
                    {candidates.map((c) => (
                        <label key={ckey(c)} className="pl-item">
                            <input type="checkbox" checked={checked.has(ckey(c))} onChange={() => toggle(ckey(c))} />
                            <span className="lc-code">{c.printed}</span>
                            <span className="lc-name">{c.sub}</span>
                            {onRemove && <button type="button" className="mini ghost pl-remove"
                                onClick={(e) => { e.preventDefault(); onRemove(c.kind, c.id); }}>Remove</button>}
                        </label>
                    ))}
                </div>

                <button className="cta" disabled={!selected.length} onClick={() => { onPrinted?.(selected.map((c) => ({ kind: c.kind, id: c.id }))); window.print(); }}>
                    Print {selected.length} label{selected.length === 1 ? '' : 's'} ({sheetCount} sheet{sheetCount === 1 ? '' : 's'})
                </button>
            </div>

            <div className="pl-sheets">
                {Array.from({ length: sheetCount }).map((_, s) => (
                    <div className="pl-sheet" key={s} style={{ paddingTop: `${top}in`, paddingLeft: `${left}in` }}>
                        <div className="pl-grid" style={{
                            gridTemplateColumns: `repeat(${COLS}, ${LABEL_W_IN}in)`,
                            gridTemplateRows: `repeat(${ROWS}, ${LABEL_H_IN}in)`,
                            columnGap: `${gapX}in`,
                            rowGap: `${gapY}in`,
                        }}>
                            {Array.from({ length: PER_SHEET }).map((_, n) => {
                                const slot = s * PER_SHEET + n;
                                const item = slot >= blanks ? selected[slot - blanks] : null;
                                if (!item) return <div className="pl-cell empty" key={n} />;
                                return (
                                    <div className="pl-cell" key={n}>
                                        {qrs[ckey(item)]
                                            ? <div className="pl-qr" dangerouslySetInnerHTML={{ __html: qrs[ckey(item)] }} />
                                            : <div className="pl-qr pl-qr-pending">…</div>}
                                        <div className="pl-text">
                                            <span className="pl-id">{item.printed}</span>
                                            {item.sub && <span className="pl-sp">{item.sub}</span>}
                                            {item.started && <span className="pl-date">{fmt(item.started, dateFormat)}</span>}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

const Sec = ({ title, onEdit }) => (
    <div className="sec">
        <span>{title}</span>
        {onEdit && <button className="edit-btn sec-edit" title={`Edit ${title.toLowerCase()}`} onClick={onEdit}>✎</button>}
    </div>
);

/* ---------------- PHOTOS ---------------- */

function Lightbox({ photo, url, onClose, onDelete, onEdit, extra, dateFormat }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState({ caption: photo.caption ?? '', taken_on: photo.taken_on ?? '' });

    const save = () => {
        onEdit(photo, draft);
        setEditing(false);
    };

    /* The lightbox shows the ~2048px display copy. The untouched original
       is only signed and downloaded when someone actually asks for it.
       The tab is opened synchronously (popup blockers only allow that
       inside the click) and pointed at the URL once it's signed. */
    const hasFullSize = !!photo.display_path && photo.display_path !== photo.storage_path;
    const openFullSize = async () => {
        const win = window.open('', '_blank');
        const full = await getOriginalUrl(photo.storage_path);
        if (!full) { win?.close(); alert('Could not load the full-size photo.'); return; }
        if (win) win.location.href = full; else window.location.href = full;
    };

    return (
        <div className="lb-scrim" onClick={onClose}>
            <div className="lb-frame" onClick={(e) => e.stopPropagation()}>
                <img src={url} alt={photo.caption ?? ''} className="lb-img" />
                {editing ? (
                    <div className="lb-bar editing">
                        <input className="in sm" type="date" value={draft.taken_on}
                            onChange={(e) => setDraft({ ...draft, taken_on: e.target.value })} />
                        <input className="in" value={draft.caption} placeholder="caption"
                            onChange={(e) => setDraft({ ...draft, caption: e.target.value })}
                            onKeyDown={(e) => e.key === 'Enter' && save()} />
                        <div>
                            <button className="mini" onClick={save}>Save</button>
                            <button className="mini ghost" onClick={() => setEditing(false)}>Cancel</button>
                        </div>
                    </div>
                ) : (
                    <div className="lb-bar">
                        <span>{photo.taken_on ? fmt(photo.taken_on, dateFormat) : ''}{photo.caption ? ' · ' + photo.caption : ''}</span>
                        <div>
                            {extra}
                            {hasFullSize && <button className="mini ghost" onClick={openFullSize}>Full size</button>}
                            {onEdit && <button className="mini ghost" onClick={() => { setDraft({ caption: photo.caption ?? '', taken_on: photo.taken_on ?? '' }); setEditing(true); }}>Edit</button>}
                            <button className="mini danger" onClick={() => { if (confirm('Delete this photo?')) { onDelete(photo); onClose(); } }}>Delete</button>
                            <button className="mini ghost" onClick={onClose}>Close</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

/* Small inline photo attachment for a single History log entry - reuses
   the addPhoto/deletePhoto/editPhoto plumbing that already supports
   photos.event_id, which nothing in the app called with an eventId
   before this. Usually 0 or 1 photo per note, but nothing stops more. */
function EventPhotos({ photos, photoUrl, onAdd, onDelete, onEdit, dateFormat }) {
    const [lightbox, setLightbox] = useState(null);
    const fileRef = useRef(null);
    const onFile = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        onAdd(file);
        e.target.value = '';
    };
    return (
        <span className="log-photos">
            {photos.map((p) => (
                <button key={p.id} className="log-photo" onClick={() => setLightbox(p)}>
                    <img src={photoUrl(p)} alt={p.caption ?? ''} loading="lazy" decoding="async" />
                </button>
            ))}
            <button type="button" className="log-photo-add" title="Attach a photo to this note"
                onClick={() => fileRef.current?.click()}>+</button>
            <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
            {lightbox && (
                <Lightbox photo={lightbox} url={photoUrl(lightbox, 'display')}
                    onClose={() => setLightbox(null)} onDelete={onDelete} onEdit={onEdit} dateFormat={dateFormat} />
            )}
        </span>
    );
}

/* Sits on the item page, the equipment edit form, or the Gallery itself.
   `attach` carries whatever this strip's photos should be tagged with -
   { itemId } or { equipmentId } or {} for a plain unattached gallery shot.
   Deliberately no `capture` attribute on the file input - that forces
   mobile browsers straight into the camera and hides the "choose from
   library" option, which is exactly what's needed to backlog old photos. */
function PhotoStrip({ attach = {}, photos, photoUrl, onAdd, onDelete, onEdit, label, dateFormat }) {
    const [adding, setAdding] = useState(false);
    const [caption, setCaption] = useState('');
    const [lightbox, setLightbox] = useState(null);
    const fileRef = useRef(null);

    const pick = () => fileRef.current?.click();
    const onFile = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        onAdd(file, { ...attach, caption });
        setCaption(''); setAdding(false);
        e.target.value = '';
    };

    return (
        <div className="photo-strip-wrap">
            {label && <div className="sec"><span>{label}</span></div>}
            <div className="photo-strip">
                {photos.map((p) => (
                    <button key={p.id} className="photo-thumb" onClick={() => setLightbox(p)}>
                        <img src={photoUrl(p)} alt={p.caption ?? ''} loading="lazy" decoding="async" />
                    </button>
                ))}
                <button className="photo-add" onClick={() => setAdding(true)}>
                    <span>+</span>
                </button>
            </div>
            {adding && (
                <div className="photo-add-form">
                    <input className="in" value={caption} onChange={(e) => setCaption(e.target.value)}
                        placeholder="caption (optional)" onKeyDown={(e) => e.key === 'Enter' && pick()} />
                    <button className="mini" onClick={pick}>Choose photo</button>
                    <button className="mini ghost" onClick={() => setAdding(false)}>Cancel</button>
                    <input ref={fileRef} type="file" accept="image/*"
                        style={{ display: 'none' }} onChange={onFile} />
                </div>
            )}
            {lightbox && <Lightbox photo={lightbox} url={photoUrl(lightbox, 'display')} onClose={() => setLightbox(null)} onDelete={onDelete} onEdit={onEdit} dateFormat={dateFormat} />}
        </div>
    );
}

/* ================= STYLE ================= */

const CSS = `
.root{
  --ground:#B3966B;--panel:#241811;--panel2:#2F2216;--line:#4A3826;--bone:#EDE3D0;--dim:#A6927A;--amber:#D6934A;
  --jade:#7FA66A;--clay:#8C3B26;--rust:#A85C35;--slate:#8A7862;
  --ink:#2B2013;--ink-dim:#5E4C36;--border-warm:#5C4630;--muted-warm:#7A6552;--amber-ink:#9C6423;
  --serif:'Libre Caslon Display','Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,'Segoe UI',sans-serif;
  background:var(--ground);color:var(--ink);font-family:var(--sans);min-height:100vh;-webkit-font-smoothing:antialiased;
  /* clip, not hidden - setting overflow-x alone to a non-visible value
     silently promotes overflow-y to auto too (CSS Overflow spec), which
     turned .root into its own scroll container instead of the page
     itself. That broke the sidebar's position:sticky + height:100vh -
     its black background would visibly run out partway down during
     scroll, worst on trackpad/inertial scrolling. clip is exempt from
     that promotion, so the real page scrolls again and sticky holds. */
  overflow-x:clip;max-width:100vw;
}
.root *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
.root button{touch-action:manipulation;}
.page{max-width:1080px;margin:0 auto;padding:22px 20px 60px;}
.load-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;}
.load-glyph{width:84px;height:84px;animation:load-spin 6s linear infinite,load-pulse 1.8s ease-in-out infinite;}
@keyframes load-spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}
@keyframes load-pulse{0%,100%{opacity:.65;}50%{opacity:1;}}

.shell{display:flex;min-height:100vh;}
.side{flex:0 0 186px;background:var(--panel);border-right:1px solid var(--line);padding:22px 12px;display:flex;flex-direction:column;gap:3px;position:sticky;top:0;height:100vh;}
.brand{font-family:var(--serif);font-size:19px;padding:0 10px 18px;color:var(--bone);display:flex;align-items:center;gap:8px;}
.brand-logo{height:30px;width:auto;display:block;flex:0 0 auto;}
.nav-item{display:flex;align-items:center;gap:10px;background:none;border:none;border-radius:9px;padding:9px 10px;color:var(--dim);font-size:13px;cursor:pointer;font-family:var(--sans);text-align:left;transition:background .15s,color .15s;}
.nav-item:hover{background:var(--panel2);color:var(--bone);}
.nav-item.on{background:var(--panel2);color:var(--amber);}
.side-bottom{margin-top:auto;display:flex;flex-direction:column;gap:3px;padding-top:10px;border-top:1px solid var(--line);}
.main{flex:1;min-width:0;}
.acct-card{background:var(--panel);color:var(--bone);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:14px;max-width:480px;}
.acct-card label{display:block;font-family:ui-monospace,monospace;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin:12px 0 5px;}
.acct-card label:first-of-type{margin-top:0;}
.acct-card input,.acct-card select{width:100%;box-sizing:border-box;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:9px 11px;color:var(--bone);font-size:13.5px;}
.acct-card input:focus,.acct-card select:focus{outline:none;border-color:var(--amber);}
.acct-section-title{font-family:var(--serif);font-size:15px;color:var(--bone);margin-bottom:4px;}
.acct-hint{font-size:12px;line-height:1.55;color:var(--dim);margin:4px 0 10px;}
.acct-msg{font-size:12px;color:var(--amber);margin-top:8px;}
.acct-danger{border-color:#6B2717;}
.acct-danger .acct-hint{color:#D4886B;}
.acct-link{display:block;font-size:13px;color:var(--amber);text-decoration:none;margin-top:4px;opacity:.75;cursor:default;}
.page-head{display:flex;align-items:baseline;gap:14px;margin-bottom:16px;}
.page-head h1{font-family:var(--serif);font-size:22px;color:var(--ink);margin:0;}
.back-link{background:none;border:none;color:var(--amber-ink);font-size:13px;cursor:pointer;padding:4px 0;}
.avatar-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px;}
.avatar-pick{width:44px;height:44px;border-radius:50%;background:var(--panel2);border:2px solid transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.avatar-pick.on{border-color:var(--amber);}
.avatar-preview{width:52px;height:52px;border-radius:50%;overflow:hidden;background:var(--panel2);border:1px solid var(--line);
  display:flex;align-items:center;justify-content:center;flex:0 0 auto;margin-right:6px;}
.avatar-upload{font-size:12px;color:var(--amber);border:1px dashed var(--line);border-radius:8px;padding:9px 12px;cursor:pointer;margin-left:4px;}
.seg{display:flex;gap:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;width:fit-content;margin-top:6px;}
.seg button{background:var(--panel2);border:none;color:var(--dim);font-size:12.5px;padding:8px 16px;cursor:pointer;}
.seg button.on{background:var(--amber);color:var(--panel);}
.btn-primary{margin-top:14px;background:var(--amber);color:var(--panel);border:none;border-radius:9px;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;}
.btn-primary:disabled{opacity:.6;cursor:default;}
.btn-danger{margin-top:10px;background:none;border:1px solid #6B2717;color:#D4886B;border-radius:9px;padding:9px 16px;font-size:13px;cursor:pointer;}
.btn-danger:disabled{opacity:.4;cursor:default;}
.app-version{display:flex;flex-direction:column;align-items:center;gap:4px;margin-top:24px;opacity:.7;}
.app-version-mark{width:110px;height:auto;}
.app-version span{font-size:11px;color:var(--dim);}
.mobile-brand{display:none;}
.mobile-search{display:none;}
.side-search{padding:0 10px 14px;position:relative;display:flex;align-items:center;gap:6px;}
.search-box{position:relative;}
.search-box .in{width:100%;box-sizing:border-box;}
.side-search .search-box{flex:1 1 auto;min-width:0;}
/* Print-queue badge, dark-panel variant (.side-search lives inside .side,
   which is the dark-panel half of the app's two-color-half system - see
   the CSS comment above .root for the bone/dim/amber vs ink/ink-dim/
   amber-ink split). */
.side-search .pq-badge{color:var(--bone);}
.side-search .pq-badge:hover{color:var(--amber);}
.side-search .pq-count{background:var(--amber);color:var(--panel);}
.pq-badge{flex:0 0 auto;display:flex;align-items:center;gap:4px;background:none;border:none;cursor:pointer;padding:6px;border-radius:8px;transition:color .15s;}
.pq-count{font-family:var(--mono);font-size:10.5px;font-weight:600;border-radius:9px;padding:1px 6px;min-width:14px;text-align:center;line-height:1.4;}
.search-dropdown{position:absolute;top:calc(100% + 6px);left:0;width:380px;max-width:calc(100vw - 40px);background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px;max-height:70vh;max-height:70dvh;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;touch-action:pan-y;overscroll-behavior:contain;z-index:50;box-shadow:0 14px 30px rgba(0,0,0,.4);color:var(--bone);scrollbar-width:thin;scrollbar-color:var(--line) var(--panel);}
.search-dropdown::-webkit-scrollbar{width:8px;}
.search-dropdown::-webkit-scrollbar-track{background:var(--panel);}
.search-dropdown::-webkit-scrollbar-thumb{background:var(--line);border-radius:10px;}
.search-dropdown::-webkit-scrollbar-thumb:hover{background:var(--dim);}
.search-dropdown .sr-group{margin-bottom:14px;}
.search-dropdown .sr-group:last-child{margin-bottom:0;}
.sr-hit{display:block;width:100%;text-align:left;background:none;border:none;padding:8px 6px;border-radius:8px;cursor:pointer;color:inherit;font-family:var(--sans);}
.sr-hit:hover{background:var(--panel2);}
.sr-more{display:block;width:100%;text-align:center;background:none;border:none;padding:7px 6px;border-radius:8px;cursor:pointer;color:var(--amber);font-family:var(--sans);font-size:12px;margin-top:2px;}
.sr-more:hover{background:var(--panel2);}
/* Below 760px the side rail stops being a sidebar and becomes a fixed
   bottom tab bar - the standard native mobile-app nav pattern (thumb
   reach, no horizontal scrolling to find a tab), so this shell already
   reads as "app-shaped" if it's ever wrapped in a native/Capacitor-style
   container instead of shown in a browser chrome. env(safe-area-inset-*)
   keeps it clear of notches / home-indicator strips on real devices -
   harmless no-ops in a plain browser tab. */
@media(max-width:760px){
  .root{overscroll-behavior-y:contain;}
  .shell{flex-direction:column;}
  .side{
    flex:none;order:2;height:auto;
    position:fixed;top:auto;left:0;right:0;bottom:0;z-index:40;
    flex-direction:row;justify-content:space-around;align-items:stretch;gap:0;
    overflow-x:visible;border-right:none;border-top:1px solid var(--line);border-bottom:none;
    padding:4px 4px calc(4px + env(safe-area-inset-bottom));
  }
  .brand{display:none;}
  .side-search{display:none;}
  /* Mobile already shows the logo + search in .mobile-brand above the
     page - these are the desktop-only stand-ins for the sidebar's .brand
     and .side-search, so they'd be duplicates here otherwise. */
  .home-logo{display:none;}
  .home-search{display:none;}
  .mobile-brand{
    display:flex;flex-direction:column;gap:8px;font-family:var(--serif);font-size:18px;color:var(--ink);
    padding:calc(14px + env(safe-area-inset-top)) 16px 10px;
  }
  .mobile-brand-top{display:flex;align-items:center;justify-content:space-between;gap:8px;}
  .mobile-brand-icons{display:flex;gap:4px;}
  .mb-icon{background:none;border:none;color:var(--ink-dim);padding:6px;border-radius:8px;display:flex;cursor:pointer;}
  .mb-icon:active{background:rgba(43,32,19,.08);}
  .mobile-search{display:block;}
  .side-bottom{display:none;}
  .nav-item{flex:1 1 0;flex-direction:column;gap:3px;padding:7px 4px;border-radius:11px;}
  .nav-item span{display:block;font-size:9.5px;}
  .nav-item svg{width:20px;height:20px;}
  .main{order:1;padding-bottom:calc(72px + env(safe-area-inset-bottom));}
  /* Home hides .side entirely (see shell-home in App.jsx), so it doesn't
     need the space normally reserved for the fixed bottom tab bar. */
  .shell-home .main{padding-bottom:env(safe-area-inset-bottom);}
  .page{padding-left:max(20px,env(safe-area-inset-left));padding-right:max(20px,env(safe-area-inset-right));}
  /* Label printing needs exact physical page control that mobile
     browsers don't reliably give a webpage (iOS Safari especially) -
     hide the trigger here rather than let it produce a broken print.
     Desktop/native app is where this actually works.
     Compound selector (.pl-icon-btn.pl-trigger, not bare .pl-trigger) is
     deliberate, not decorative - 2026-09-22's .pl-icon-btn (display:
     inline-flex) redesign sits later in this stylesheet and, at equal
     single-class specificity, source order alone let it silently win
     over a bare .pl-trigger rule and bring these back on mobile. Bumping
     to two classes (0-2-0) beats .pl-icon-btn's 0-1-0 regardless of
     where either is declared, so this can't regress again the next time
     something gets added after this block. */
  .pl-icon-btn.pl-trigger{display:none;}
  /* The cross-screen print queue (badge + "+ Queue" buttons + the queue
     print screen) is desktop-only for the same reason as .pl-trigger
     above - printing doesn't work reliably from a mobile browser yet.
     Making mobile printing work is its own future task; until then the
     whole queue feature stays out of the mobile view rather than
     half-working there. Same compound-selector fix as .pl-trigger above. */
  .pl-icon-btn.pl-queue{display:none;}
  .lc-mosaic{grid-template-columns:repeat(2,1fr);gap:7px;}
}

.lib-list{display:flex;flex-direction:column;gap:9px;margin-top:20px;}
.recipe-scale{margin-bottom:4px;}
.rs-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:11px;padding-bottom:11px;border-bottom:1px solid var(--line);}
.rs-label{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);}
.rs-row .in.sm{width:70px;}
.rs-unit{font-family:var(--mono);font-size:11.5px;color:var(--dim);margin-right:4px;}
.lib-card{background:var(--panel);color:var(--bone);border:1px solid var(--line);border-radius:12px;overflow:hidden;transition:border-color .15s;}
.lib-card:hover{border-color:var(--border-warm);}
.lib-card.open{border-color:var(--amber);}
.lib-head{width:100%;display:flex;justify-content:space-between;align-items:center;gap:12px;background:none;border:none;padding:14px 16px;color:inherit;cursor:pointer;text-align:left;font-family:var(--sans);}
.lib-title{font-family:var(--serif);font-size:17px;}
.lib-meta{display:flex;gap:9px;margin-top:4px;}
.lib-kind,.lib-sp{font-family:var(--mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);}
.lib-sp{color:var(--amber);opacity:.75;}
.lib-chev{font-family:var(--mono);font-size:16px;color:var(--dim);}
.lib-body{padding:0 16px 16px;border-top:1px solid var(--line);padding-top:14px;}
.sr-input{margin-bottom:20px;}
.sr-group{margin-bottom:22px;}
.sr-group-label{font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-dim);margin-bottom:8px;}
.sr-group .lib-card{margin-bottom:8px;}
.sr-snippet{font-family:var(--sans);font-size:12.5px;color:var(--dim);margin-top:6px;line-height:1.5;}
.lib-link{display:block;font-family:var(--mono);font-size:11.5px;color:var(--amber);word-break:break-all;margin-bottom:11px;}
.lib-text{font-family:var(--sans);font-size:13px;line-height:1.6;white-space:pre-wrap;margin:0 0 13px;color:var(--bone);}
.sp-chips{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin:14px 0 4px;}
.sp-chips-label{font-family:var(--mono);font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-dim);margin-right:2px;}
.step-num{flex:0 0 auto;width:22px;height:22px;border-radius:6px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);font-family:var(--mono);font-size:11px;display:flex;align-items:center;justify-content:center;}
.sp-chip{font-family:var(--sans);font-size:12.5px;padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--dim);cursor:pointer;transition:border-color .15s,color .15s;}
/* These chips carry their own dark --panel fill, so they take the
   dark-panel palette (bone/dim/amber) - NOT the tan-ground palette
   (ink/ink-dim/amber-ink). Both states below had it backwards and were
   rendering dark-on-dark. */
.sp-chip:hover{border-color:var(--border-warm);color:var(--bone);}
.sp-chip.on{border-color:var(--amber);color:var(--amber);background:var(--panel2);}
.qf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:12px;}
.qf-tile{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;}
.qf-label{font-family:var(--mono);font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);margin-bottom:3px;}
.qf-value{font-size:13px;color:var(--bone);line-height:1.35;}
.qf-note{font-size:13px;line-height:1.6;color:var(--bone);margin:0 0 13px;}
.checklist{margin-bottom:13px;}
.check-progress{font-family:var(--mono);font-size:11px;color:var(--dim);display:flex;align-items:center;gap:10px;margin-bottom:8px;}
.check-row{display:flex;align-items:flex-start;gap:10px;width:100%;text-align:left;background:none;border:none;border-bottom:1px solid var(--line);padding:9px 0;cursor:pointer;color:var(--bone);font-family:var(--sans);font-size:13px;line-height:1.5;}
.check-row:last-child{border-bottom:none;}
.check-box{flex:0 0 auto;width:20px;height:20px;border-radius:6px;border:1px solid var(--border-warm);display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:11px;color:var(--dim);}
.check-row.done .check-box{background:var(--amber);border-color:var(--amber);color:var(--panel);}
.check-row.done .check-label{color:var(--dim);text-decoration:line-through;}
.lib-fulltext{margin-bottom:13px;}
.lib-fulltext summary{cursor:pointer;font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);margin-bottom:8px;}
.lib-fulltext .lib-text{margin-top:8px;}
.ing-rows{display:flex;flex-direction:column;gap:6px;}
.ing-row{display:flex;gap:6px;align-items:center;}
.ing-row .in.sm{width:64px;flex:0 0 auto;}
.ing-unit{width:72px;flex:0 0 auto;font-family:var(--mono);font-size:11.5px;}
.ing-table{border-collapse:collapse;margin-bottom:13px;}
.ing-table td{padding:3px 0;font-size:12.5px;border-bottom:1px solid var(--line);}
.ing-table td:last-child{border-bottom:none;}
.ing-amt{font-family:var(--mono);color:var(--amber);padding-right:14px;white-space:nowrap;}
.ing-unit-label{font-family:var(--mono);font-size:10px;color:var(--dim);flex:0 0 auto;}
.ing-table th{text-align:left;font-family:var(--mono);font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);font-weight:400;padding-bottom:5px;}
.calc-note.over-limit{color:var(--rust);}

.tabs{display:flex;flex-wrap:wrap;row-gap:8px;gap:4px;margin-top:18px;border-bottom:1px solid var(--line);}
.tab{background:none;border:none;padding:9px 4px;margin-right:18px;color:var(--ink-dim);font-size:13px;cursor:pointer;font-family:var(--sans);border-bottom:2px solid transparent;margin-bottom:-1px;}
.tab:hover{color:var(--ink);}
.tab.on{color:var(--ink);font-weight:600;border-bottom-color:var(--amber);}
.tabs-toggle{margin-left:auto;margin-bottom:8px;}
@media(max-width:640px){.tabs-toggle{margin-left:0;}}
.equip-list{display:flex;flex-direction:column;gap:6px;}
.equip-row{display:flex;align-items:stretch;gap:8px;background:var(--panel);color:var(--bone);border:1px solid var(--line);border-radius:10px;transition:border-color .15s;}
.equip-row:hover{border-color:var(--border-warm);}
.equip-row-main{flex:1;min-width:0;display:flex;align-items:center;gap:12px;background:none;border:none;padding:11px 14px;color:inherit;cursor:pointer;text-align:left;font-family:var(--sans);}
.equip-name{font-size:13px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.equip-note{font-size:11.5px;color:var(--dim);flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.equip-thumb{width:34px;height:34px;border-radius:7px;object-fit:cover;flex:0 0 auto;background:var(--panel2);}
.equip-thumb-empty{border:1px dashed var(--line);}
.equip-qty{display:flex;align-items:center;gap:6px;padding:0 12px;border-left:1px solid var(--line);flex:0 0 auto;}
.equip-side{display:flex;align-items:center;padding:0 12px;border-left:1px solid var(--line);flex:0 0 auto;}
/* Product (same recipe/supplier/product regardless of date - "all the
   Master Mix together") wraps one or more .stock-batch sessions - see
   stockProductKey and the comment above the Stock render loop. A plain
   bottom border rather than a full panel, one step lighter than .sec's
   kind-level header so the hierarchy (kind > product > session) reads
   at a glance. */
.stock-product{margin-bottom:24px;}
.stock-product-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin:16px 0 2px;padding-bottom:6px;border-bottom:1px solid var(--line);flex-wrap:wrap;}
.stock-product-head .equip-name{font-family:var(--serif);font-size:16px;color:var(--ink);white-space:normal;}
.stock-product-head .equip-note{font-family:var(--mono);font-size:10.5px;color:var(--ink-dim);}
.stock-batch{margin-bottom:20px;padding-bottom:2px;}
.stock-batch-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin:14px 0 8px;flex-wrap:wrap;}
/* Compact icon-only Print/Queue button pair, shared by Detail, Tree, and
   Stock's per-batch row (see PrinterIcon/PrinterQueueIcon above SearchBox).
   Grouping them in .pl-icon-row keeps them paired as ONE flex child
   wherever they sit next to other space-between siblings - on
   .stock-batch-head specifically, two ungrouped buttons used to become a
   THIRD sibling alongside the batch-info div, which flexbox then spread
   evenly across the row instead of keeping the pair pinned to the right
   (found by Matt 2026-09-22: "the original print button is getting
   pulled way out to the middle"). Same fix incidentally also shrank the
   buttons themselves, per Matt's request the same day, from full
   text labels down to two 28px icon squares. */
.pl-icon-row{display:flex;gap:6px;flex:0 0 auto;}
.pl-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border-radius:8px;cursor:pointer;flex:0 0 auto;transition:border-color .15s,color .15s;}
/* Print and Queue share one look now - same panel2 chip, same --bone
   icon color - so the pair reads as a matched set (Matt 2026-09-22
   didn't want Queue's icon a different shade from Print's). They're
   told apart by the icon itself (plain printer vs. printer+badge, see
   PrinterQueueIcon above SearchBox), not by button color. */
.pl-icon-btn.pl-trigger,.pl-icon-btn.pl-queue{background:var(--panel2);border:1px solid var(--line);color:var(--bone);}
.pl-icon-btn.pl-trigger:hover,.pl-icon-btn.pl-queue:hover{border-color:var(--amber);color:var(--amber);}
/* The small "+" badge on PrinterQueueIcon - sits over the printer
   icon's bottom-right corner. pl-icon-badge-bg is filled with the
   BUTTON's own background (panel2) so the badge reads as a solid disc
   cut into the printer glyph rather than a ring that lets the icon's
   own strokes show through underneath it. */
.pl-icon-badge-wrap{position:relative;display:inline-flex;}
.pl-icon-badge{position:absolute;bottom:-4px;right:-5px;}
.pl-icon-badge-bg{fill:var(--panel2);}
.stock-batch-head .equip-name{font-family:var(--serif);font-size:15px;color:var(--ink);white-space:normal;}
.stock-batch-head .equip-note{display:block;color:var(--ink-dim);white-space:normal;}
.stock-archive-label{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-dim);margin:12px 0 6px;}
.equip-row.done{opacity:.55;}
.qty-btn{width:22px;height:22px;border-radius:6px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);font-size:14px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;}
.qty-btn:hover{color:var(--amber);border-color:var(--amber);}
.qty-num{font-family:var(--mono);font-size:13px;min-width:1.5em;text-align:center;}
.qty-num.zero{color:var(--rust);}

.calc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin-top:22px;}
.calc-card{background:var(--panel);color:var(--bone);border:1px solid var(--line);border-radius:14px;padding:18px;}
.calc-head{margin-bottom:14px;}
.calc-title{font-family:var(--serif);font-size:19px;}
.calc-sub{font-size:11.5px;color:var(--dim);margin-top:3px;}
.calc-body{display:flex;flex-direction:column;gap:12px;}
.calc-field{display:flex;flex-direction:column;gap:5px;}
.calc-field label{font-family:var(--mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);}
.calc-input-wrap{position:relative;display:flex;align-items:center;}
.calc-input-wrap .in{padding-right:44px;}
.calc-unit{position:absolute;right:11px;font-family:var(--mono);font-size:10.5px;color:var(--dim);pointer-events:none;}
.calc-result{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:3px;animation:pop .2s ease-out;}
.calc-result strong{font-family:var(--mono);font-size:20px;font-weight:400;color:var(--amber);}
.calc-result span{font-size:11.5px;color:var(--dim);}
.calc-result.block{align-items:flex-start;}
.calc-note{font-size:11px;color:var(--dim);line-height:1.55;margin:0;}
.calc-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}

/* screen transitions */
.screen-in{animation:slideIn .42s cubic-bezier(.22,.68,.32,1);}
.screen-back{animation:slideBack .42s cubic-bezier(.22,.68,.32,1);}
@keyframes slideIn{from{opacity:0;transform:translateX(26px) scale(.985)}to{opacity:1;transform:none}}
@keyframes slideBack{from{opacity:0;transform:translateX(-26px) scale(.985)}to{opacity:1;transform:none}}

/* tiles */
.tally{display:flex;align-items:center;gap:9px;}
.tally .num{font-family:var(--mono);font-size:30px;color:var(--amber-ink);}
.tally-l{font-family:var(--mono);font-size:9.5px;line-height:1.2;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.1em;}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(258px,1fr));gap:13px;margin-top:22px;}
.tile{text-align:left;background:var(--panel);color:var(--bone);border:1px solid var(--line);border-radius:14px;padding:16px;cursor:pointer;font-family:var(--sans);transition:border-color .18s,transform .18s,background .18s;}
.tile:hover{border-color:var(--border-warm);background:var(--panel2);transform:translateY(-2px);}
.tile:focus-visible{outline:2px solid var(--amber);outline-offset:2px;}
.tile-name{font-family:var(--serif);font-size:21px;}
.tile-latin{font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin-top:4px;font-style:italic;}
.tile-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:16px;padding-top:11px;border-top:1px solid var(--line);}
.src{font-size:11.5px;color:var(--dim);}
.live-c{font-family:var(--mono);font-size:11px;color:var(--jade);white-space:nowrap;}
.dormant{font-family:var(--mono);font-size:11px;color:var(--dim);white-space:nowrap;}
.spec-note{font-size:12.5px;color:var(--ink-dim);font-style:italic;margin:12px 0 0;max-width:60ch;}
.bar-actions{display:flex;gap:7px;}
.add-tile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;min-height:118px;border-style:dashed;background:none;color:var(--ink);}
.add-tile:hover{border-color:var(--amber);background:rgba(36,24,17,0.06);}
.add-plus{font-size:26px;color:var(--amber-ink);line-height:1;}
.add-label{font-size:12.5px;color:var(--ink-dim);}
.tile-wrap{position:relative;}
.tile-wrap .tile{width:100%;}
.tile-hide-btn{position:absolute;top:8px;right:8px;font-family:var(--mono);font-size:9px;letter-spacing:.08em;text-transform:uppercase;
  background:var(--panel2);border:1px solid var(--line);border-radius:20px;padding:3px 9px;color:var(--dim);cursor:pointer;
  opacity:.55;transition:opacity .15s,color .15s;}
.tile-wrap:hover .tile-hide-btn{opacity:1;}
.tile-hide-btn:hover{color:var(--amber);border-color:var(--amber);}
.new-form{background:var(--panel);color:var(--bone);border:1px solid var(--line);border-radius:14px;padding:18px;margin-top:20px;animation:pop .22s ease-out;}
.nf-title{font-family:var(--serif);font-size:19px;margin-bottom:6px;}
.nf-help{font-size:12px;color:var(--dim);line-height:1.5;margin:0 0 14px;max-width:60ch;}
/* --dim reads fine inside a dark .new-form panel, but is nearly invisible
   sitting straight on the tan page background (too close to --ground) -
   this modifier is for exactly that case, e.g. an empty-state message
   rendered directly on .page rather than inside a form. */
.nf-help.nf-help-page{color:var(--ink-dim);}
/* auto-fill, not auto-fit: auto-fit stretches whatever lands in a
   half-empty trailing row to fill the leftover column tracks, so a form
   whose field count doesn't divide evenly into a row gets one or two
   fields blown up wide for no reason (surfaced when the Stock form's
   field count shifted after adding Weight). auto-fill just leaves that
   space blank instead.
   align-items:start, because grid's default (stretch) forces every field
   in a row to match the tallest one's height - and several field types
   here (plain text .in, .in.sel selects, the .amt-pair wrapper) have
   flex:1 on them for unrelated horizontal-fill reasons, so a stretched
   row makes them balloon vertically to fill it. Only fields like the
   date input (.in.sm, flex:0 0 auto) happened to opt out, which is why
   some fields blew up tall and others didn't. */
.nf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:11px;margin-bottom:14px;align-items:start;}
.nf-field{display:flex;flex-direction:column;gap:5px;}
.nf-field.wide{grid-column:1 / -1;}
/* A field holding two side-by-side inputs (amt-pair) needs more room
   than nf-grid's normal 150px column minimum to fit both placeholders
   ("amount" / "g / lb / oz") without looking cramped. */
.nf-field.amt{min-width:190px;}
.nf-field label{font-family:var(--mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);}
.mono-in{font-family:var(--mono);letter-spacing:.06em;}
.line-strip{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;}
.line-chip{display:inline-flex;align-items:center;gap:8px;background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:5px 8px 5px 12px;}
.line-chip.hidden{opacity:.5;}
.lc-code{font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--amber);}
.lc-name{font-size:12px;color:var(--bone);}
.line-label{font-family:var(--serif);font-size:15px;fill:var(--bone);opacity:.72;}

.bar{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:16px;flex-wrap:wrap;row-gap:10px;}
.eyebrow{font-family:var(--mono);font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--ink-dim);font-style:italic;}
.bar h1{font-family:var(--serif);font-weight:400;font-size:30px;margin:5px 0 0;color:var(--ink);}
.sw{background:var(--panel);border:1px solid var(--line);color:var(--bone);border-radius:20px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:var(--sans);}
.sw:hover{border-color:var(--amber);}
.sw.danger{border-color:var(--rust);color:var(--rust);}
.sw.danger:hover{background:var(--rust);color:var(--bone);}

/* ---------------- HOME ---------------- */
/* --accent is set inline per card/tile (SECTION_ACCENTS, or the computed
   dataAccent for Data) - every rule below just reads var(--accent),
   never hardcodes a tone, so one map in App.jsx controls all of it. */
/* Bigger + centered is a look Matt asked to see, not a settled call -
   easy to dial back to the small left-aligned version if it doesn't
   land once he's actually looked at it. */
.home-logo{display:flex;align-items:center;justify-content:center;gap:12px;font-family:var(--serif);font-size:30px;color:var(--ink);margin-bottom:24px;}
.home-logo .brand-logo{height:60px;}
.home-search{width:300px;max-width:100%;position:relative;display:flex;align-items:center;gap:6px;}
.home-search .in{width:100%;box-sizing:border-box;}
.home-search .search-box{flex:1 1 auto;min-width:0;}
/* Print-queue badge, tan-background variant - .home-search sits on the
   page's tan half (var(--ground)), not inside .side, so it needs the
   ink/ink-dim/amber-ink half of the palette instead of bone/dim/amber. */
.home-search .pq-badge{color:var(--ink);}
.home-search .pq-badge:hover{color:var(--amber-ink);}
.home-search .pq-count{background:var(--amber-ink);color:var(--bone);}
/* Matt's hard limit: no more than ~0.5in (48px) of visible dead space
   inside a box. Every previous pass kept the hero at width:100% and
   tried to fan sparse content out to fill that width - that's what kept
   producing wide gaps (between the breakdown items, in the middle of
   the card, wherever). Dropping width:100% is the actual fix: the card
   now sizes to its own content (icon + stat + breakdown, each gap
   capped well under 48px) and stops there, instead of stretching to the
   page width and leaving whatever's left over as dead space inside the
   button. What used to be "inside the box" is now just page background
   to its right, which isn't a box with a number in it. Restored to
   width:100% only on mobile, where the breakdown is hidden and the
   compact icon+number needs the full phone width to read right. */
.home-top-row{display:flex;align-items:stretch;gap:12px;margin-bottom:24px;}
.home-hero{display:flex;align-items:center;gap:24px;width:fit-content;max-width:100%;flex:0 0 auto;background:var(--panel);color:var(--bone);
  border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:16px;padding:26px 32px;
  cursor:pointer;text-align:left;transition:border-color .15s,transform .15s;}
/* Account/Settings fill the width .home-top-row's flex leaves next to
   the hero - flex:1 so the two split whatever's left, same panel/border
   treatment as the hero so the row reads as one family of cards. */
.home-side-card{flex:1 1 160px;min-width:160px;display:flex;align-items:center;gap:14px;background:var(--panel);color:var(--bone);
  border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:16px;padding:20px 22px;
  cursor:pointer;text-align:left;transition:border-color .15s,transform .15s;}
.home-side-card:hover{transform:translateY(-1px);}
.home-side-icon{flex:0 0 auto;width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;
  background:color-mix(in srgb, var(--accent) 18%, transparent);color:var(--accent);}
.home-side-value{font-family:var(--serif);font-size:17px;color:var(--bone);margin-top:2px;}
.home-hero:hover{transform:translateY(-1px);border-left-color:var(--accent);}
.home-hero-icon{flex:0 0 auto;width:60px;height:60px;border-radius:16px;display:flex;align-items:center;justify-content:center;
  background:color-mix(in srgb, var(--accent) 18%, transparent);color:var(--accent);}
.home-hero-body{min-width:0;flex:0 0 auto;}
.home-hero-stat{font-family:var(--serif);font-size:46px;line-height:1;color:var(--bone);margin-top:6px;}
.home-hero-stat-unit{font-family:var(--sans);font-size:14px;font-weight:400;color:var(--dim);margin-left:8px;}
.home-hero-divider{flex:0 0 auto;width:1px;align-self:stretch;background:var(--line);}
/* Fixed, modest gap between the three counts instead of flex:1 +
   space-evenly, which fanned them out across however much width the
   full-bleed card happened to have - that was the actual source of the
   gap Matt pointed at between "colonizing" and "colonized". */
.home-hero-breakdown{display:flex;gap:28px;}
.home-hero-bd-item{display:flex;flex-direction:column;align-items:center;gap:2px;min-width:44px;}
.home-hero-bd-num{font-family:var(--serif);font-size:26px;line-height:1;color:var(--bone);}
.home-hero-bd-label{font-family:var(--mono);font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);}

/* Secondary sections as a list, not a card grid - CSS Grid's auto-fit
   columns are always equal-width regardless of content (Harvests' long
   line vs. Supplies' short one), so content-hugging boxes in those
   columns produced uneven, "welded together / big gap" spacing no
   matter how the box itself was sized or padded (several rounds of
   that here - see git history). A list has no per-item box to leave
   space empty inside: each row just spans the full list width and sits
   a fixed 1px rule above the next one. */
.home-list{background:var(--panel);color:var(--bone);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:24px;}
.home-list-row{display:flex;align-items:center;gap:16px;width:100%;box-sizing:border-box;background:none;
  border:none;border-left:3px solid var(--accent);border-bottom:1px solid var(--line);
  padding:16px 18px;cursor:pointer;text-align:left;color:inherit;font-family:var(--sans);transition:background .15s;}
.home-list-row:last-child{border-bottom:none;}
.home-list-row:hover{background:var(--panel2);}
.home-list-icon{flex:0 0 auto;width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;
  background:color-mix(in srgb, var(--accent) 16%, transparent);color:var(--accent);}
.home-card-title{font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);}
.home-list-title{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);width:104px;flex:0 0 auto;}
.home-list-stat{font-family:var(--serif);font-size:20px;color:var(--bone);flex:0 0 auto;}
.home-list-sub{font-size:12.5px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0;}
.home-list-chev{flex:0 0 auto;color:var(--dim);font-size:16px;opacity:.6;}

.home-mv{margin-top:8px;}
.home-mv-title{font-family:var(--mono);font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--ink-dim);font-style:italic;margin-bottom:10px;}
/* Restyled to read as the row of tabs that used to live in the sidebar -
   heavier pill (filled panel2, not just an outline), bigger touch target,
   accent fill on hover/press - since this is Home's primary way to jump
   around once .side is hidden here, not a minor utility list anymore. */
.home-mv-list{display:flex;flex-wrap:wrap;gap:10px;}
.home-mv-item{display:flex;align-items:center;gap:10px;background:var(--panel2);border:1px solid var(--line);border-radius:13px;
  padding:11px 18px 11px 12px;cursor:pointer;color:inherit;font-family:var(--sans);text-align:left;transition:border-color .15s,background .15s,transform .15s;}
.home-mv-item:hover{border-color:var(--accent);background:var(--panel);transform:translateY(-1px);}
.home-mv-icon{flex:0 0 auto;width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;
  background:color-mix(in srgb, var(--accent) 20%, transparent);color:var(--accent);}
.home-mv-text{display:flex;flex-direction:column;gap:1px;min-width:0;}
.home-mv-label{font-size:13.5px;color:var(--bone);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px;}
.home-mv-meta{font-size:10.5px;color:var(--dim);}
@media(max-width:600px){
  /* Keep the hero horizontal (icon beside text, not stacked) with tighter
     padding and a smaller icon - stacked+spacious read as a mostly-empty
     bar on a narrow screen even though it's the same content. The
     colonizing/colonized/fruiting breakdown is a desktop-only add-on to
     fill a wide card's width - on a phone the card's already compact
     enough that it'd just be four numbers (the total plus the same three
     again) competing for the same small space, so it's dropped rather
     than squeezed in. Untested on a real phone yet - flag anything that
     still looks off. */
  .home-top-row{flex-direction:column;}
  .home-hero{width:100%;padding:16px 18px;gap:14px;}
  .home-hero-icon{width:44px;height:44px;border-radius:12px;}
  .home-hero-stat{font-size:32px;}
  .home-hero-divider{display:none;}
  .home-hero-breakdown{display:none;}
  .home-side-card{width:100%;box-sizing:border-box;padding:14px 16px;}
  .home-list-title{width:76px;}
  .home-mv-item{padding:9px 14px 9px 10px;}
  .home-mv-label{max-width:160px;}
}

.canvas{position:relative;height:min(70vh,600px);background:radial-gradient(circle at 50% 8%,#2A1D14 0%,#1A120C 66%);
  border:1px solid var(--line);border-radius:16px;overflow:hidden;touch-action:none;cursor:grab;}
.canvas:active{cursor:grabbing;}
.stage{transition:transform .2s ease-out;}
.node{cursor:pointer;transition:transform .55s cubic-bezier(.22,.68,.32,1),opacity .28s ease;}
.node:hover circle:nth-of-type(1){opacity:.34;}
.hypha{fill:none;stroke:var(--line);stroke-linecap:round;transition:stroke .28s ease,opacity .28s ease;}
/* A drawn syringe isn't a transformation - same culture, new vessel - so
   its edge reads as a dotted seam rather than a solid line of descent.
   stroke-linecap has to go back to butt or the dots render as blobs that
   close the gaps back up. */
.hypha.drawn{stroke-dasharray:1.5 5;stroke-linecap:butt;opacity:.8;}
.hypha.lit{stroke:var(--amber);}
.hypha.dim{opacity:.3;}
.node.faded{opacity:.34;}
.pulse{opacity:.1;animation:breathe 3.2s ease-in-out infinite;}
@keyframes breathe{0%,100%{opacity:.06}50%{opacity:.3}}
.n-id{font-family:var(--mono);font-size:11px;fill:var(--bone);}
.n-sub{font-family:var(--sans);font-size:9.5px;fill:var(--dim);}
.hint{position:absolute;left:14px;bottom:12px;font-family:var(--mono);font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim);pointer-events:none;}

/* Species-scoped photo collage, under the tree canvas. A mosaic grid, not
   the Gallery's uniform cropped-square grid or plain column-masonry
   (tried first, but same-width columns still read as a grid) - tiles
   span different row/column counts (see tileSize() above Tree) so pieces
   are genuinely different sizes and pack together, same principle as a
   real photo collage. Costs cropping (object-fit:cover) instead of each
   photo's natural shape, same tradeoff every other photo tile in the app
   already makes. */
.lineage-collage{margin-top:28px;}
.lc-h2{font-family:var(--serif);font-weight:400;font-size:22px;margin:3px 0 16px;color:var(--ink);}
.lc-mosaic{display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:12px;grid-auto-flow:dense;gap:8px;}
.lc-tile{position:relative;padding:0;border-radius:11px;overflow:hidden;border:1px solid var(--line);
  cursor:pointer;background:var(--panel);}
.lc-tile img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .2s;}
.lc-tile:hover img{transform:scale(1.03);}
.lc-tile.sz-sm{grid-column:span 1;grid-row:span 9;}
.lc-tile.sz-md{grid-column:span 1;grid-row:span 13;}
.lc-tile.sz-wide{grid-column:span 2;grid-row:span 9;}
.lc-tile.sz-big{grid-column:span 2;grid-row:span 15;}
.lc-meta{position:absolute;left:0;right:0;bottom:0;padding:7px 9px;background:linear-gradient(transparent,rgba(0,0,0,.75));
  display:flex;justify-content:space-between;gap:8px;font-family:var(--mono);font-size:9.5px;color:var(--bone);}

.back{background:none;border:none;color:var(--ink-dim);font-family:var(--mono);font-size:11.5px;cursor:pointer;padding:0 0 18px;}
.back:hover{color:var(--ink);}
.d-head{display:flex;align-items:center;gap:14px;padding-bottom:16px;border-bottom:1px solid var(--line);}
.d-mark{width:34px;height:34px;border-radius:50%;border:2px solid;display:flex;align-items:center;justify-content:center;flex:0 0 auto;}
.d-mark span{width:13px;height:13px;border-radius:50%;display:block;}
.d-id{font-family:var(--mono);font-size:25px;font-weight:400;margin:0;letter-spacing:.01em;}
.d-sub{font-size:12.5px;color:var(--ink-dim);margin-top:4px;}
.pill{margin-left:auto;flex-shrink:0;font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;border-radius:20px;padding:4px 11px;font-weight:600;}

/* Solid-fill status pills. Was previously referenced by Equipment,
   Suppliers, and Lot cards (className="pill tone-X") with no matching
   rule anywhere - those pills have been rendering colorless the whole
   time, unrelated to the redesign. */
.tone-amber{background:var(--amber);color:var(--panel);}
.tone-jade{background:var(--jade);color:var(--panel);}
.tone-clay{background:var(--clay);color:var(--bone);}
.tone-rust{background:var(--rust);color:var(--bone);}
.tone-slate{background:var(--slate);color:var(--panel);}

/* Success-rate bar charts on the Data tab (by source/vendor/species) - one
   series, one hue (amber, matches .cta/the app's primary accent), thin
   track with rounded ends, direct labels instead of a legend since there's
   only one series per chart. */
.rate-chart{display:flex;flex-direction:column;gap:16px;}
.rate-chart-row{display:flex;flex-direction:column;gap:5px;}
.rate-chart-label{display:flex;justify-content:space-between;align-items:baseline;gap:10px;font-family:var(--sans);font-size:13px;}
.rate-chart-name{color:var(--bone);font-weight:600;}
.rate-chart-stat{color:var(--dim);font-family:var(--mono);font-size:11.5px;white-space:nowrap;}
.rate-chart-stat strong{color:var(--amber);}
.rate-chart-track{position:relative;height:8px;background:var(--panel2);border:1px solid var(--line);border-radius:4px;overflow:hidden;}
.rate-chart-fill{height:100%;background:var(--amber);border-radius:4px;}

.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:2px;margin:14px 0 20px;}
.crumb{background:none;border:none;font-family:var(--mono);font-size:11px;color:var(--ink-dim);cursor:pointer;padding:2px 3px;}
.crumb:hover{color:var(--amber-ink);}
.crumb.here{color:var(--ink);cursor:default;}
.arrow{color:var(--ink-dim);font-size:10px;margin:0 4px;}

.actions{margin-bottom:24px;}
.cta{background:var(--amber);color:var(--panel);border:none;border-radius:10px;padding:11px 20px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:var(--sans);}
.cta:hover{filter:brightness(1.08);}
.picker{display:flex;flex-wrap:wrap;align-items:center;gap:7px;}
.pk-l{font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin-right:4px;}

.cols{display:grid;grid-template-columns:1fr 320px;gap:34px;align-items:start;}
@media(max-width:780px){.cols{grid-template-columns:1fr;gap:8px;}}
.sec{font-family:var(--mono);font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-dim);margin:24px 0 10px;padding-bottom:7px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;}
.edit-btn{background:none;border:none;padding:0 4px;color:var(--ink-dim);font-size:14px;line-height:1;cursor:pointer;transition:color .15s;}
.edit-btn:hover{color:var(--amber-ink);}
.sec-edit{opacity:.6;}
.sec:hover .sec-edit{opacity:1;}
.head-read{flex:1;}
.head-edit{flex:1;display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
.head-edit .in{flex:1 1 150px;font-family:var(--mono);}
/* Bare .amt-pair has no flex-basis of its own on purpose: flex-basis is
   an axis-relative property, and amt-pair gets reused inside two flex
   containers running opposite directions - .head-edit (row) and
   .nf-field (column, in the Stock form). "150px" meant width in the
   row context this was written for, but the same number silently
   became a HEIGHT once reused inside a column container, forcing the
   Stock form's Weight field to be at least 150px tall for no reason.
   Scoped to .head-edit below, where a width preference actually makes
   sense (so amount+unit stay adjacent instead of splitting across a
   wrap boundary); inside .nf-field it just sizes to its content and
   fills the column's width via that container's normal stretch. */
.amt-pair{display:flex;gap:6px;}
.head-edit .amt-pair{flex:1 1 150px;}
/* input.in, not just .in - both amount-pair inputs also carry the .sm
   modifier (for its compact padding/font), and .in.sm{flex:0 0 auto}
   is defined later in this sheet at equal specificity, so plain ".in"
   here was losing that fight and letting the inputs render at native
   browser width instead of splitting the field evenly - that's what
   was still making the Weight boxes look oversized after the row-
   height fix. The extra element-selector bumps this above .in.sm. */
.amt-pair input.in{flex:1 1 60px;min-width:0;}
/* --amber, not --amber-ink, is for dark panels only. This sits on the
   tan --ground, where #D6934A is near-invisible. */
.d-sub.method{color:var(--amber-ink);}
.picker.draw{flex-direction:column;align-items:stretch;gap:9px;}
.draw-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap;}
.draw-row label{font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--card-dim);min-width:74px;}
.draw-row .in{flex:0 1 88px;min-width:0;}
.draw-assign{border-top:1px solid var(--line);padding-top:9px;display:flex;flex-direction:column;gap:7px;}
.in.sel{color-scheme:dark;cursor:pointer;}
.in.ta{width:100%;font-family:var(--sans);line-height:1.55;resize:vertical;}
.field-form{display:flex;flex-direction:column;gap:7px;}
.field-form label{font-family:var(--mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-dim);margin-top:4px;}
.empty-note{opacity:.5;}
.reason-box{margin-top:12px;padding:13px;background:var(--panel);border:1px solid var(--line);border-radius:11px;animation:pop .2s ease-out;}
.rb-title{font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-bottom:9px;}
.fail-note{font-size:12px;margin:10px 0 0;font-family:var(--mono);}

.chips{display:flex;flex-wrap:wrap;gap:6px;}
.chip{background:var(--panel2);border:1px solid var(--line);border-radius:20px;padding:6px 12px;font-size:11.5px;color:var(--dim);cursor:pointer;font-family:var(--sans);transition:color .15s,border-color .15s;}
.chip:hover{color:var(--bone);border-color:var(--border-warm);}
.chip.on{border-color:var(--amber);color:var(--amber);}
.chip.go{color:var(--bone);border-color:var(--border-warm);}

.tbl{width:100%;border-collapse:collapse;font-size:12.5px;}
.tbl th{text-align:left;font-family:var(--mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-dim);font-weight:400;padding-bottom:6px;}
.tbl td{padding:6px 0;border-top:1px solid var(--line);}
.tbl .num{font-family:var(--mono);text-align:right;}
.tbl th:nth-child(3){text-align:right;}
.tbl tr:hover .log-x{opacity:1;}
.row-in{display:flex;gap:7px;margin-top:11px;}
.in{flex:1;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 11px;color:var(--bone);font-size:12.5px;font-family:var(--sans);}
.in:focus{outline:none;border-color:var(--amber);}
.mini{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 13px;color:var(--bone);font-size:12px;cursor:pointer;font-family:var(--sans);}
.mini:hover{border-color:var(--amber);color:var(--amber);}
.be{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-top:13px;padding-top:11px;border-top:1px solid var(--line);font-size:11.5px;color:var(--ink-dim);}
.be strong{font-family:var(--mono);font-size:15px;font-weight:400;}

.facts{display:grid;grid-template-columns:auto 1fr;gap:9px 18px;margin:0;font-size:12.5px;}
.facts dt{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-dim);padding-top:2px;}
.facts dd{margin:0;}
.lnk{background:none;border:none;padding:0;margin-right:9px;color:var(--amber-ink);font-family:var(--mono);font-size:12px;cursor:pointer;}
.lnk:hover{text-decoration:underline;}
.notes{font-size:12.5px;line-height:1.6;color:var(--ink-dim);margin:0;}

.log{list-style:none;padding:0;margin:0;}
.log li{display:flex;gap:11px;padding:8px 0;border-bottom:1px solid var(--line);}
.log li:last-child{border-bottom:none;}
.log-d{font-family:var(--mono);font-size:10.5px;color:var(--ink-dim);flex:0 0 46px;padding-top:2px;}
.log-t{font-size:12.5px;line-height:1.45;flex:1;}
.log-x{background:none;border:none;padding:6px 8px;margin:-6px -4px -6px 0;color:var(--ink-dim);font-size:15px;line-height:1;cursor:pointer;opacity:.65;transition:opacity .15s,color .15s;}
.log li:hover .log-x,.tbl tr:hover .log-x{opacity:1;}
.log-x:hover{color:var(--amber);}
.log-x:focus-visible{opacity:1;outline:2px solid var(--amber);outline-offset:2px;}
.log-photos{display:flex;gap:4px;align-items:center;flex:0 0 auto;}
.log-photo{width:26px;height:26px;border-radius:6px;overflow:hidden;border:1px solid var(--line);padding:0;cursor:pointer;background:var(--panel);flex:0 0 auto;}
.log-photo img{width:100%;height:100%;object-fit:cover;display:block;}
.log-photo-add{width:26px;height:26px;border-radius:6px;border:1px dashed var(--line);background:none;color:var(--ink-dim);cursor:pointer;font-size:15px;line-height:1;flex:0 0 auto;padding:0;}
.log-photo-add:hover{border-color:var(--amber);color:var(--amber);}
.mini.danger{background:var(--panel2);color:var(--rust);border-color:var(--border-warm);margin-left:auto;}
.mini.danger:hover{color:var(--clay);border-color:var(--rust);}
.x-cell{width:34px;text-align:right;padding-left:6px;}
.edit-row{display:flex;gap:6px;align-items:center;width:100%;padding:4px 0;}
.edit-row.wrap{flex-wrap:wrap;}
.in.sm{flex:0 0 auto;width:auto;padding:6px 9px;font-size:11.5px;font-family:var(--mono);color-scheme:dark;}
.mini.ghost{background:var(--panel2);border-color:var(--line);color:var(--dim);}
.mini.ghost:hover{color:var(--bone);border-color:var(--border-warm);}
.log li.editing{padding:2px 0;}

.inv-totals{display:flex;flex-wrap:wrap;gap:22px;margin:20px 0 8px;}
.inv-total{display:flex;flex-direction:column;gap:2px;}
.inv-total strong{font-family:var(--mono);font-size:20px;color:var(--ink);font-weight:600;}
.inv-total span{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-dim);}
.lot-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin-top:16px;}
.lot-card{text-align:left;background:var(--panel);color:var(--bone);border:1px solid var(--line);border-radius:13px;padding:14px;cursor:pointer;font-family:var(--sans);transition:border-color .15s,transform .15s;}
.lot-card:hover{border-color:var(--border-warm);transform:translateY(-1px);}
.lot-card.used{opacity:.55;}
.lot-top{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:9px;}
.lot-sp{font-size:10.5px;color:var(--dim);text-align:right;}
.lot-label{font-family:var(--serif);font-size:15.5px;margin-bottom:8px;}
.lot-amt strong{font-family:var(--mono);font-size:16px;font-weight:400;}
.lot-amt span{font-family:var(--mono);font-size:11px;color:var(--dim);}
.lot-bar{height:3px;background:var(--line);border-radius:2px;margin-top:8px;overflow:hidden;}
.lot-bar-fill{height:100%;background:var(--amber);}
.lot-date{font-family:var(--mono);font-size:10px;color:var(--dim);margin-top:7px;}
.lot-card .pl-icon-row{margin-top:9px;}
.lot-amount-hero{display:flex;gap:26px;margin:18px 0 6px;padding:16px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);}
.lot-amount-hero div{display:flex;flex-direction:column;gap:2px;}
.lot-amount-hero strong{font-family:var(--mono);font-size:22px;font-weight:400;}
.lot-amount-hero span{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-dim);}
.lineage-list{display:flex;flex-direction:column;gap:6px;}
.lnk-row{display:flex;justify-content:space-between;background:var(--panel);color:var(--bone);border:1px solid var(--line);border-radius:9px;padding:9px 12px;cursor:pointer;font-size:12.5px;text-align:left;font-family:var(--sans);}
.lnk-row:hover{border-color:var(--amber);}
.lnk-row-outer{display:flex;align-items:stretch;gap:4px;}
.lnk-row-outer .lnk-row{flex:1;}
.lnk-row-edit{display:flex;align-items:center;gap:6px;background:var(--panel);border:1px solid var(--amber);border-radius:9px;padding:7px 10px;flex-wrap:wrap;}
.lnk-edit-label{font-size:12.5px;font-family:var(--sans);color:var(--bone);margin-right:auto;}
.lnk-amt{font-family:var(--mono);font-size:11px;color:var(--dim);}
.process-rows{display:flex;flex-direction:column;gap:7px;margin-bottom:8px;}
.process-row{display:flex;align-items:center;gap:9px;}
.pr-label{font-size:12.5px;flex:1;}
.pr-cap{font-family:var(--mono);font-size:10.5px;color:var(--dim);}

.tab:disabled,.cta:disabled,.mini:disabled{opacity:.4;cursor:not-allowed;}

.photo-dot{fill:var(--amber);stroke:var(--panel);stroke-width:1;}
.photo-strip-wrap{margin-bottom:22px;}
.photo-strip{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;}
.photo-thumb{flex:0 0 auto;width:64px;height:64px;border-radius:9px;overflow:hidden;border:1px solid var(--line);padding:0;cursor:pointer;background:var(--panel);}
.photo-thumb img{width:100%;height:100%;object-fit:cover;display:block;}
.photo-add{flex:0 0 auto;width:64px;height:64px;border-radius:9px;border:1px dashed var(--line);background:none;color:var(--ink-dim);cursor:pointer;font-size:20px;}
.photo-add:hover{border-color:var(--amber);color:var(--amber);}
.photo-add-form{display:flex;gap:7px;align-items:center;margin-top:9px;flex-wrap:wrap;}
.photo-add-form .in{flex:1 1 160px;}

.lb-scrim{position:fixed;inset:0;background:rgba(20,14,8,.88);z-index:50;display:flex;align-items:center;justify-content:center;padding:24px;animation:pop .18s ease-out;}
.lb-frame{max-width:min(92vw,760px);max-height:88vh;display:flex;flex-direction:column;background:var(--panel);border-radius:14px;overflow:hidden;border:1px solid var(--line);}
.lb-img{max-width:100%;max-height:74vh;object-fit:contain;background:#000;}
.lb-bar{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px 12px;padding:12px 16px;font-size:12px;color:var(--dim);}
.lb-bar>span{flex:1 1 auto;}
.lb-bar div{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;flex:0 1 auto;}
.lb-bar .mini{white-space:nowrap;}
.lb-bar.editing{flex-wrap:wrap;}
.lb-bar.editing .in{flex:1 1 140px;}


@media(prefers-reduced-motion:reduce){.node,.stage,.page{transition:none!important;animation:none!important}.pulse{animation:none!important;opacity:.18}.screen-in,.screen-back{animation:none!important}.tile{transition:none!important}}

/* ---- Print labels ---- */
.pl-wrap{max-width:none;}
.pl-field-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:12px 0;}
.pl-field-row label{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--ink-dim);}
.pl-field-row .nf-help{margin:0;}
.pl-list{display:flex;flex-direction:column;gap:2px;max-height:260px;overflow-y:auto;border:1px solid var(--line);border-radius:10px;padding:6px;margin-bottom:16px;background:var(--panel);}
.pl-item{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:7px;cursor:pointer;font-size:13px;color:var(--bone);}
.pl-item:hover{background:var(--panel2);}
.pl-item input{flex:0 0 auto;}
.pl-item .lc-name{color:var(--dim);font-size:12px;}

.pl-sheets{overflow-x:auto;background:var(--border-warm);padding:24px;border-radius:12px;margin-top:8px;}
.pl-sheet{width:8.5in;height:11in;box-sizing:border-box;background:#fff;margin:0 auto 24px;box-shadow:0 2px 10px rgba(0,0,0,.25);}
.pl-sheet:last-child{margin-bottom:0;}
@media print{
  .root>.mobile-brand,.root .side,.pl-controls{display:none!important;}
  .root{background:none!important;min-height:0!important;overflow:visible!important;}
  .shell{display:block!important;min-height:0!important;}
  .page.pl-wrap{max-width:none!important;margin:0!important;padding:0!important;}
  .pl-sheets{display:block;overflow:visible;background:none;padding:0;border-radius:0;margin:0;}
  .pl-sheet{margin:0;box-shadow:none;page-break-after:always;}
  .pl-sheet:last-child{page-break-after:auto;}
  @page{size:letter;margin:0;}
}
.pl-grid{display:grid;}
.pl-cell{display:flex;flex-direction:row;align-items:center;gap:8px;overflow:hidden;padding:6px 8px;}
.pl-cell.empty{visibility:hidden;}
.pl-qr{width:0.82in;height:0.82in;flex:0 0 auto;}
.pl-qr svg{width:100%;height:100%;display:block;}
.pl-qr-pending{display:flex;align-items:center;justify-content:center;color:var(--muted-warm);font-size:9px;}
.pl-text{display:flex;flex-direction:column;justify-content:center;line-height:1.25;min-width:0;}
.pl-id{font-family:var(--mono);font-size:11px;font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pl-sp{font-size:9px;color:var(--muted-warm);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pl-date{font-size:9px;color:var(--muted-warm);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
`;