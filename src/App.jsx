import { supabase } from './supabaseClient'
import { useState, useRef, useEffect, useMemo, useCallback } from "react";

/* ================= DATA ================= */

/* Local date as YYYY-MM-DD. Not toISOString() - that converts to UTC,
   which rolls over to tomorrow's date during your evening. */
const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const TYPES = { spores: "Spores", agar: "Agar", lc: "Liquid culture", grain: "Grain", bulk: "Bulk block", block: "Fruiting block" };
const CODE = { spores: "SP", agar: "AG", lc: "LC", grain: "GR", bulk: "BK", block: "FB" };

const STATUS = {
    colonizing: { label: "Colonizing", tone: "amber", live: true },
    colonized: { label: "Colonized", tone: "jade", live: true },
    fruiting: { label: "Fruiting", tone: "jade", live: true },
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

const TONE = { amber: "#D6934A", jade: "#7FA66A", clay: "#8C3B26", rust: "#A85C35", slate: "#8A7862" };
const FRUITS = ["bulk", "block"];

const days = (iso) => iso ? Math.round((new Date() - new Date(iso + "T12:00:00")) / 86400000) : null;
const fmt = (iso) => iso ? new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "date unknown";

/* ================= LAYOUT ================= */

const GAP_X = 132, GAP_Y = 116;

function layout(items) {
    const kids = (id) => items.filter((i) => i.parent === id);
    const out = {};
    let cur = 0;
    const walk = (n, d) => {
        const ch = kids(n.id);
        let slot;
        if (!ch.length) slot = cur++;
        else { const s = ch.map((c) => walk(c, d + 1)); slot = (s[0] + s[s.length - 1]) / 2; }
        out[n.id] = { x: slot * GAP_X, y: d * GAP_Y, depth: d };
        return slot;
    };
    /* Each root is a separate genetics line. Gap between them so parallel
       trees read as distinct rather than one big tangle. */
    items.filter((i) => !i.parent).forEach((r, n) => {
        if (n > 0) cur += 0.9;
        walk(r, 0);
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
    const [section, setSection] = useState('cultures');
    const [library, setLibrary] = useState([]);
    const [equipment, setEquipment] = useState([]);
    const [suppliers, setSuppliers] = useState([]);
    const [lots, setLots] = useState([]);
    const [lotLinks, setLotLinks] = useState([]);
    const [openLot, setOpenLot] = useState(null);
    const [photos, setPhotos] = useState([]);
    const [photoUrls, setPhotoUrls] = useState({});
    const [items, setItems] = useState([]);
    const [species, setSpecies] = useState([]);
    const [genetics, setGenetics] = useState([]);
    const [nav, setNav] = useState({ level: 'species', speciesId: null, geneticsId: null });
    const [dir, setDir] = useState('fwd');
    const [open, setOpen] = useState(null);
    const [loading, setLoading] = useState(true);

    const go = (next, direction = 'fwd') => { setDir(direction); setNav(next); };

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
            const { data: eq } = await supabase.from('equipment').select('*').order('category').order('name');
            const { data: sup } = await supabase.from('suppliers').select('*').order('name');
            const { data: allLots } = await supabase.from('lots').select('*').order('harvested_on', { nullsFirst: false });
            const { data: links } = await supabase.from('lot_links').select('*');
            const { data: pics } = await supabase.from('photos').select('*').order('created_at');

            if (pics?.length) {
                const { data: signed } = await supabase.storage.from('photos')
                    .createSignedUrls(pics.map((p) => p.storage_path), 21600); // 6 hours
                const urlMap = {};
                (signed ?? []).forEach((s) => { if (s.signedUrl) urlMap[s.path] = s.signedUrl; });
                setPhotoUrls(urlMap);
            }

            setSpecies(sp ?? []);
            setGenetics(gen ?? []);
            setLibrary(lib ?? []);
            setEquipment(eq ?? []);
            setSuppliers(sup ?? []);
            setLots(allLots ?? []);
            setLotLinks(links ?? []);
            setPhotos(pics ?? []);

            setItems(data.map((r) => ({
                id: r.label,
                uid: r.id,
                geneticsId: r.genetics_id,
                parent: data.find((p) => p.id === r.parent_id)?.label ?? null,
                type: r.type,
                status: r.status,
                created: r.created_on,
                where: r.location ?? '',
                substrate: r.substrate ?? '',
                notes: r.notes ?? '',
                dryWeight: r.dry_substrate_g ?? undefined,
                failureReason: r.failure_reason ?? null,
                harvests: (harvests ?? [])
                    .filter((h) => h.source_item_id === r.id)
                    .map((h) => ({ f: h.flush_number, date: h.harvested_on, wet: Number(h.amount_g), lotId: h.id }))
                    .sort((a, b) => a.f - b.f),
                log: (events ?? [])
                    .filter((e) => e.item_id === r.id)
                    .map((e) => ({ id: e.id, date: e.happened_on, body: e.body, kind: e.kind, lotId: e.lot_id }))
                    .sort((a, b) => a.date.localeCompare(b.date)),
            })));
            setLoading(false);
        }
        load();
    }, []);

    if (loading) return <div className="root"><style>{CSS}</style><div className="page">Loading…</div></div>;

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
        }).select('id').single();
        if (lotErr) { console.error(lotErr); alert('Harvest not saved - check console'); return; }

        await supabase.from('items').update({ status: 'fruiting' }).eq('id', item.uid);
        const { data: ev } = await supabase.from('item_events').insert({
            item_id: item.uid, happened_on: today, kind: 'harvest',
            body: `Flush ${flush} - ${grams}g wet`,
            lot_id: lot.id,
        }).select('id').single();

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
        if ('where' in patch) cols.location = patch.where || null;
        if ('substrate' in patch) cols.substrate = patch.substrate || null;
        if ('notes' in patch) cols.notes = patch.notes || null;
        if ('created' in patch) cols.created_on = patch.created || null;
        if ('dryWeight' in patch) cols.dry_substrate_g = patch.dryWeight ?? null;

        const { error } = await supabase.from('items').update(cols).eq('id', item.uid);
        if (error) { console.error(error); alert('Could not save - check console'); return; }

        setItems((p) => p.map((i) => {
            if (i.id === label) return { ...i, ...patch };
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

        const { error } = await supabase.from('genetics').update(cols).eq('id', genId);
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setGenetics((p) => p.map((g) => (g.id === genId ? { ...g, ...cols } : g)));
    };

    const saveSpeciesFields = async (speciesId, patch) => {
        const cols = {
            common_name: patch.common_name.trim(),
            latin_name: patch.latin_name?.trim() || null,
            fruiting_temp: patch.fruiting_temp?.trim() || null,
            humidity: patch.humidity?.trim() || null,
            fae: patch.fae?.trim() || null,
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

    const addLibrary = async (fields) => {
        const { data, error } = await supabase.from('library').insert({
            species_id: fields.species_id || null,
            title: fields.title.trim(),
            kind: fields.kind,
            url: fields.url?.trim() || null,
            body: fields.body?.trim() || null,
            category: fields.category?.trim() || null,
            yield_amount: fields.yield_amount === '' || fields.yield_amount == null ? null : Number(fields.yield_amount),
            yield_unit: fields.yield_unit || null,
            ingredients: fields.ingredients?.length ? fields.ingredients : null,
        }).select('*').single();
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setLibrary((p) => [...p, data]);
    };

    const editLibrary = async (entryId, fields) => {
        const cols = {
            species_id: fields.species_id || null,
            title: fields.title.trim(),
            kind: fields.kind,
            url: fields.url?.trim() || null,
            body: fields.body?.trim() || null,
            category: fields.category?.trim() || null,
            yield_amount: fields.yield_amount === '' || fields.yield_amount == null ? null : Number(fields.yield_amount),
            yield_unit: fields.yield_unit || null,
            ingredients: fields.ingredients?.length ? fields.ingredients : null,
        };
        const { error } = await supabase.from('library').update(cols).eq('id', entryId);
        if (error) { console.error(error); alert('Could not save - check console'); return; }
        setLibrary((p) => p.map((e) => (e.id === entryId ? { ...e, ...cols } : e)));
    };

    const deleteLibrary = async (entryId) => {
        const { error } = await supabase.from('library').delete().eq('id', entryId);
        if (error) { console.error(error); alert('Could not delete - check console'); return; }
        setLibrary((p) => p.filter((e) => e.id !== entryId));
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

    /* Upload goes straight from the browser to Supabase Storage, then a row
       tracks where it lives. It can attach to an item, to equipment, or to
       nothing at all - a plain gallery photo isn't required to be about
       anything. */
    const addPhoto = async (file, { itemId, equipmentId, eventId, caption } = {}) => {
        const today = todayISO();
        const ext = file.name.split('.').pop() || 'jpg';
        const folder = itemId || equipmentId || 'general';
        const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

        const { error: upErr } = await supabase.storage.from('photos').upload(path, file);
        if (upErr) { console.error(upErr); alert('Upload failed - check console'); return; }

        const { data, error } = await supabase.from('photos').insert({
            item_id: itemId || null, equipment_id: equipmentId || null,
            event_id: eventId || null, storage_path: path,
            caption: caption?.trim() || null, taken_on: today,
        }).select('*').single();
        if (error) { console.error(error); alert('Could not save - check console'); return; }

        const { data: signed } = await supabase.storage.from('photos').createSignedUrl(path, 21600);
        if (signed?.signedUrl) setPhotoUrls((p) => ({ ...p, [path]: signed.signedUrl }));

        setPhotos((p) => [...p, data]);
    };

    const deletePhoto = async (photo) => {
        await supabase.storage.from('photos').remove([photo.storage_path]);
        const { error } = await supabase.from('photos').delete().eq('id', photo.id);
        if (error) { console.error(error); alert('Could not delete - check console'); return; }
        setPhotos((p) => p.filter((x) => x.id !== photo.id));
    };

    /* Bucket is private now, so photos need signed, time-limited URLs
       rather than a plain public link. Keyed by storage path so every
       photoUrl(path) call site stays unchanged. */
    const photoUrl = (path) => photoUrls[path] ?? '';

    const addSpecies = async (fields) => {
        const { data, error } = await supabase.from('species').insert({
            common_name: fields.common_name.trim(),
            latin_name: fields.latin_name?.trim() || null,
            fruiting_temp: fields.fruiting_temp?.trim() || null,
            humidity: fields.humidity?.trim() || null,
            fae: fields.fae?.trim() || null,
            notes: fields.notes?.trim() || null,
        }).select('*').single();
        if (error) { console.error(error); alert('Could not add species - check console'); return; }
        setSpecies((p) => [...p, data].sort((a, b) => a.common_name.localeCompare(b.common_name)));
        return data;
    };

    /* A genetics line always starts with one physical container - the first
       thing that actually sat on a shelf. Source lives on the line itself. */
    const addGenetics = async (speciesId, fields, firstType) => {
        const today = todayISO();
        const code = fields.code.trim().toUpperCase();

        const { data: gen, error } = await supabase.from('genetics').insert({
            species_id: speciesId,
            name: fields.name.trim(),
            code,
            source: fields.source?.trim() || null,
            acquired_on: fields.acquired || null,
            notes: fields.notes?.trim() || null,
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

    const addChild = async (parentLabel, type) => {
        const today = todayISO();
        const parent = items.find((i) => i.id === parentLabel);
        const code = genetics.find((g) => g.id === parent.geneticsId)?.code ?? 'X';
        const n = items.filter((i) => i.geneticsId === parent.geneticsId && i.type === type).length + 1;
        const label = `${code}-${CODE[type]}${n}`;

        const { data, error } = await supabase.from('items').insert({
            genetics_id: parent.geneticsId,
            parent_id: parent.uid,
            label, type, status: 'colonizing', created_on: today,
        }).select('id').single();

        if (error) { console.error(error); alert('Could not create item - check console'); return; }

        const { data: ev } = await supabase.from('item_events').insert({
            item_id: data.id, happened_on: today, kind: 'note',
            body: `Inoculated from ${parentLabel}`,
        }).select('id').single();

        setItems((p) => [...p, {
            id: label, uid: data.id, geneticsId: parent.geneticsId,
            parent: parentLabel, type, created: today, status: 'colonizing',
            where: '', substrate: '', notes: '', harvests: [],
            dryWeight: undefined,
            log: [{ id: ev?.id, date: today, body: `Inoculated from ${parentLabel}`, kind: 'note' }],
        }]);
        setOpen(label);
    };

    const sp = species.find((s) => s.id === nav.speciesId);
    const lines = genetics.filter((g) => g.species_id === nav.speciesId);
    const lineIds = lines.map((g) => g.id);
    const mine = items.filter((i) => lineIds.includes(i.geneticsId));
    const openItem = items.find((i) => i.id === open);
    const openCulture = genetics.find((g) => g.id === openItem?.geneticsId);

    let screen, key;
    if (section === 'library' || section === 'recipes') {
        key = section;
        screen = <Library entries={library.filter((e) => (section === 'recipes') === (e.kind === 'recipe'))}
            species={species} mode={section} equipment={equipment} suppliers={suppliers}
            onAdd={addLibrary} onEdit={editLibrary} onDelete={deleteLibrary}
            onAddEquip={addEquipment} onEditEquip={editEquipment} onDeleteEquip={deleteEquipment}
            onAddSupplier={addSupplier} onEditSupplier={editSupplier} onDeleteSupplier={deleteSupplier}
            photos={photos} photoUrl={photoUrl} onAddPhoto={addPhoto} onDeletePhoto={deletePhoto}
            onBumpEquipQty={bumpEquipmentQty} />;
    } else if (section === 'inventory') {
        key = openLot ? 'lot-' + openLot : 'inventory';
        screen = openLot
            ? <LotDetail lots={lots} lotLinks={lotLinks} lotId={openLot} items={items} genetics={genetics} species={species}
                remaining={lotRemaining} onBack={() => setOpenLot(null)} onOpen={setOpenLot}
                onProcess={processLot} onLoss={logLoss} onSave={saveLotFields} onDelete={deleteLot} />
            : <Inventory lots={lots} lotLinks={lotLinks} items={items} genetics={genetics} species={species}
                remaining={lotRemaining} onOpen={setOpenLot} onAddManual={addManualLot} />;
    } else if (section === 'gallery') {
        key = 'gallery';
        screen = <Gallery photos={photos} items={items} genetics={genetics} species={species} equipment={equipment}
            photoUrl={photoUrl} onDelete={deletePhoto} onAddPhoto={addPhoto}
            onOpenItem={(label) => { setSection('cultures'); setOpen(label); }} />;
    } else if (section === 'calculators') {
        key = 'calculators';
        screen = <Calculators />;
    } else if (open) {
        key = 'detail-' + open;
        screen = <Detail items={mine} id={open} culture={openCulture}
            onBack={() => { setDir('back'); setOpen(null); }}
            onOpen={setOpen} addChild={addChild} saveStatus={saveStatus}
            saveNote={saveNote} saveHarvest={saveHarvest} deleteEvent={deleteEvent} deleteHarvest={deleteHarvest}
            editEvent={editEvent} editHarvest={editHarvest} saveItemFields={saveItemFields}
            deleteItem={deleteItem} reparentItem={reparentItem}
            photos={photos} photoUrl={photoUrl} addPhoto={addPhoto} deletePhoto={deletePhoto} />;
    } else if (nav.level === 'tree') {
        key = 'tree-' + nav.speciesId;
        screen = <Tree items={mine} lines={lines} species={sp} onOpen={setOpen} photos={photos}
            onAddLine={(fields, firstType) => addGenetics(nav.speciesId, fields, firstType)}
            onEditLine={saveGeneticsFields} onEditSpecies={saveSpeciesFields} onToggleHidden={toggleSpeciesHidden}
            onBack={() => go({ level: 'species', speciesId: null }, 'back')} />;
    } else {
        key = 'species';
        screen = <SpeciesGrid species={species} genetics={genetics} items={items}
            onAdd={addSpecies} onToggleHidden={toggleSpeciesHidden}
            onOpen={(id) => go({ level: 'tree', speciesId: id })} />;
    }

    const NAV = [
        ['cultures', 'Cultures', 'M4 14c3-6 6-8 8-8s5 2 8 8'],
        ['inventory', 'Inventory', 'M3 7h18v12H3zM3 7l2-3h14l2 3'],
        ['gallery', 'Gallery', 'M4 4h16v16H4zM4 15l4-4 3 3 5-5 4 4M9 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'],
        ['library', 'Library', 'M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z'],
        ['recipes', 'Recipes', 'M7 3v8a3 3 0 0 0 6 0V3M10 11v10M17 3c-1.5 2-2 4-2 6s.5 3 2 3v9'],
        ['calculators', 'Calculators', 'M5 3h14v18H5zM8 7h8M8 11h2M12 11h2M16 11h.01M8 15h2M12 15h2M16 15h.01'],
    ];

    return (
        <div className="root">
            <style>{CSS}</style>
            <div className="mobile-brand">SporeDesk</div>
            <div className="shell">
                <nav className="side">
                    <div className="brand">SporeDesk</div>
                    {NAV.map(([k, label, d]) => (
                        <button key={k} className={`nav-item ${section === k ? 'on' : ''}`}
                            onClick={() => { setSection(k); setOpen(null); setOpenLot(null); setDir('fwd'); }}>
                            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
                            <span>{label}</span>
                        </button>
                    ))}
                </nav>
                <main className="main">
                    <div key={key} className={dir === 'fwd' ? 'screen-in' : 'screen-back'}>{screen}</div>
                </main>
            </div>
        </div>
    );
}

/* ---------------- CALCULATORS ---------------- */

const DRY_YIELD = {
    'Blue Oyster': 8.9, 'Chestnut': 10, 'Lion\'s Mane': 7, 'Shiitake': 11,
    'Enoki': 6, 'Panellus stipticus': 8, 'Cordyceps militaris': 15, 'Reishi': 12,
};

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
            <p className="calc-note">Default 1.65 mL/g is the cordyceps flat-bag ratio from your notes. Change it for other teks.</p>
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

function DryYield() {
    const [wet, setWet] = useState('');
    const [sp, setSp] = useState('Blue Oyster');
    const w = n(wet);
    const pct = DRY_YIELD[sp] ?? 10;
    const dry = w ? w * (pct / 100) : null;

    return (
        <CalcCard title="Dry yield estimate" sub="Roughly what a wet harvest will weigh once dried">
            <NumField label="Wet harvest weight" value={wet} onChange={setWet} placeholder="e.g. 300" unit="g" />
            <div className="calc-field">
                <label>Species</label>
                <select className="in sel" value={sp} onChange={(e) => setSp(e.target.value)}>
                    {Object.keys(DRY_YIELD).map((s) => <option key={s} value={s}>{s} (~{DRY_YIELD[s]}%)</option>)}
                </select>
            </div>
            {dry && (
                <div className="calc-result">
                    <strong>~{dry.toFixed(0)} g dry</strong>
                    <span>at ~{pct}% typical for {sp}</span>
                </div>
            )}
            <p className="calc-note">
                Blue Oyster's 8.9% is your own measured figure. The rest are species-typical estimates until
                you weigh a real wet-to-dry run for each - worth doing once per species.
            </p>
        </CalcCard>
    );
}

/* Lives inside an expanded recipe card. Owns its own target-amount state,
   defaulting to the recipe's stored batch size - scales every ingredient
   live as you type or tap a multiplier, no separate calculator needed. */
function RecipeIngredients({ recipe }) {
    const [target, setTarget] = useState(recipe.yield_amount != null ? String(recipe.yield_amount) : '');
    const t = n(target);
    const factor = recipe.yield_amount && t ? t / recipe.yield_amount : null;

    return (
        <div className="recipe-scale">
            {recipe.yield_amount != null && (
                <div className="rs-row">
                    <span className="rs-label">Batch size</span>
                    <input className="in sm" inputMode="decimal" value={target}
                        onChange={(e) => setTarget(e.target.value)} />
                    <span className="rs-unit">{recipe.yield_unit}</span>
                    <div className="chips">
                        {[0.5, 2, 3, 5].map((m) => (
                            <button key={m} className="chip"
                                onClick={() => setTarget(String(recipe.yield_amount * m))}>×{m}</button>
                        ))}
                    </div>
                </div>
            )}
            <table className="ing-table">
                <tbody>
                    {recipe.ingredients.map((row, i) => {
                        const amt = n(row.amount);
                        const scaled = amt != null && factor ? amt * factor : amt;
                        return (
                            <tr key={i}>
                                <td className="ing-amt">
                                    {scaled != null ? (scaled % 1 === 0 ? scaled : scaled.toFixed(2)) : row.amount}{row.unit}
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

/* Straight mass/volume conversions are exact. Grain-by-volume is not a real
   unit - it's mass divided by an approximate density, so it's kept separate
   and clearly labeled as approximate rather than folded into the same table. */
const MASS = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
const VOLUME = { mL: 1, L: 1000, tsp: 4.92892, tbsp: 14.7868, cup: 236.588, 'fl oz': 29.5735 };
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

function Calculators() {
    return (
        <div className="page">
            <div className="bar">
                <div>
                    <div className="eyebrow">Numbers you'd otherwise do in your head</div>
                    <h1>Calculators</h1>
                </div>
            </div>
            <div className="calc-grid">
                <SpawnRatio />
                <Hydration />
                <BECalc />
                <DryYield />
                <UnitConverter />
                <GrainVolume />
            </div>
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

function LotCard({ lot, rem, sp, onOpen }) {
    const pct = lot.amount_g ? (rem / lot.amount_g) * 100 : 0;
    const used = rem <= LOT_EPS;
    return (
        <button className={`lot-card ${used ? 'used' : ''}`} onClick={() => onOpen(lot.id)}>
            <div className="lot-top">
                <span className={`pill tone-${used ? 'slate' : 'amber'}`}>{LOT_FORMS[lot.form] ?? lot.form}</span>
                <span className="lot-sp">{sp.length ? sp.join(' + ') : 'unknown origin'}</span>
            </div>
            <div className="lot-label">{lot.label || 'Untitled lot'}</div>
            <div className="lot-amt">
                <strong>{rem % 1 === 0 ? rem : rem.toFixed(1)} g</strong>
                <span> / {lot.amount_g} g</span>
            </div>
            {!used && <div className="lot-bar"><div className="lot-bar-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>}
            {lot.harvested_on && <div className="lot-date">{fmt(lot.harvested_on)}</div>}
        </button>
    );
}

function Inventory({ lots, lotLinks, items, genetics, species, remaining, onOpen, onAddManual }) {
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
                    <h1>Inventory</h1>
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
                                {species.map((s) => <option key={s.id} value={s.id}>{s.common_name}</option>)}
                            </select></div>
                        <div className="nf-field"><label>Date (optional)</label>
                            <input className="in" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
                        <div className="nf-field wide"><label>Notes</label>
                            <textarea className="in ta" rows="2" value={f.notes} placeholder="why there's no clean trail, if worth remembering"
                                onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
                    </div>
                    <div className="edit-row">
                        <button className="mini" onClick={() => {
                            const amt = n(f.amount);
                            if (!f.label.trim() || !amt) return;
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
                        onOpen={onOpen} />
                ))}
            </div>
        </div>
    );
}

/* ---------------- LOT DETAIL ---------------- */

function LotDetail({ lots, lotLinks, lotId, items, genetics, species, remaining, onBack, onOpen, onProcess, onLoss, onSave, onDelete }) {
    const lot = lots.find((l) => l.id === lotId);
    const [editing, setEditing] = useState(false);
    const [f, setF] = useState({});
    const [processing, setProcessing] = useState(false);
    const [losing, setLosing] = useState(false);
    const [lossAmt, setLossAmt] = useState('');
    const [lossReason, setLossReason] = useState('');

    if (!lot) return <div className="page"><button className="back" onClick={onBack}>← Inventory</button></div>;

    const rem = remaining(lotId);
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
                        <input className="in sm" type="date" value={f.harvested_on ?? ''} onChange={(e) => setF({ ...f, harvested_on: e.target.value })} />
                        <button className="mini" onClick={() => {
                            onSave(lotId, { label: f.label.trim(), form: f.form, harvested_on: f.harvested_on || null });
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
                        <div className="d-sub">{LOT_FORMS[lot.form] ?? lot.form} · {sp.length ? sp.join(' + ') : 'unknown origin'}{lot.harvested_on ? ` · ${fmt(lot.harvested_on)}` : ''}</div>
                    </div>
                )}
                {!editing && (
                    <button className="edit-btn" title="Edit"
                        onClick={() => { setF({ label: lot.label ?? '', form: lot.form, harvested_on: lot.harvested_on ?? '' }); setEditing(true); }}>✎</button>
                )}
            </div>

            <div className="lot-amount-hero">
                <div><strong>{rem % 1 === 0 ? rem : rem.toFixed(1)} g</strong><span>remaining</span></div>
                <div><strong>{lot.amount_g} g</strong><span>started with</span></div>
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
                                    All ({rem % 1 === 0 ? rem : rem.toFixed(1)}g)
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
                                    if (g > rem + LOT_EPS) { alert(`Only ${rem % 1 === 0 ? rem : rem.toFixed(1)}g remaining.`); return; }
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
                                return pl ? (
                                    <button key={k.id} className="lnk-row" onClick={() => onOpen(pl.id)}>
                                        <span>{pl.label}</span><span className="lnk-amt">{k.amount_taken_g}g used</span>
                                    </button>
                                ) : null;
                            })}
                        </div>
                    ) : <p className="notes empty-note">This is an original harvest - nothing feeds into it.</p>}

                    <Sec title="Went into" />
                    {children.length ? (
                        <div className="lineage-list">
                            {children.map((k) => {
                                const cl = lots.find((l) => l.id === k.child_lot_id);
                                return cl ? (
                                    <button key={k.id} className="lnk-row" onClick={() => onOpen(cl.id)}>
                                        <span>{cl.label}</span><span className="lnk-amt">took {k.amount_taken_g}g</span>
                                    </button>
                                ) : null;
                            })}
                        </div>
                    ) : <p className="notes empty-note">Nothing made from this yet.</p>}
                </div>

                <div>
                    <Sec title="Notes" />
                    {lot.notes
                        ? <p className="notes">{lot.notes.split('\n').map((line, n2) => <span key={n2}>{line}<br /></span>)}</p>
                        : <p className="notes empty-note">No notes.</p>}
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
                            <span className="pr-cap">/ {cap.toFixed(1)}g avail</span>
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

function SupplierTab({ suppliers, onAdd, onEdit, onDelete }) {
    const blank = { name: '', category: '', rating: 'unproven', notes: '', website: '' };
    const [form, setForm] = useState(null);
    const [f, setF] = useState(blank);

    const submit = () => {
        if (!f.name.trim()) return;
        if (form === 'new') onAdd(f); else onEdit(form, f);
        setForm(null); setF(blank);
    };

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
                <p className="nf-help" style={{ marginTop: 18 }}>No suppliers logged yet.</p>
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

function EquipmentTab({ equipment, onAdd, onEdit, onDelete, photos, photoUrl, onAddPhoto, onDeletePhoto, onBumpQty }) {
    const blank = { name: '', category: '', status: 'active', quantity: '', notes: '' };
    const [form, setForm] = useState(null);
    const [f, setF] = useState(blank);

    const submit = () => {
        if (!f.name.trim()) return;
        if (form === 'new') onAdd(f); else onEdit(form, f);
        setForm(null); setF(blank);
    };

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
                            photoUrl={photoUrl} onAdd={onAddPhoto} onDelete={onDeletePhoto} label="Photo (optional)" />
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
                                            ? <img className="equip-thumb" src={photoUrl(thumb.storage_path)} alt="" />
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
                <p className="nf-help" style={{ marginTop: 18 }}>No equipment listed yet.</p>
            )}
        </>
    );
}

function Library({ entries, species, mode, equipment, suppliers, onAdd, onEdit, onDelete, onAddEquip, onEditEquip, onDeleteEquip, onAddSupplier, onEditSupplier, onDeleteSupplier, photos, photoUrl, onAddPhoto, onDeletePhoto, onBumpEquipQty }) {
    const recipes = mode === 'recipes';
    const [tab, setTab] = useState('entries');
    const blank = { title: '', kind: recipes ? 'recipe' : 'note', url: '', body: '', species_id: '',
        category: '', yield_amount: '', yield_unit: 'mL', ingredients: [] };
    const [form, setForm] = useState(null);   // null | 'new' | entry id
    const [f, setF] = useState(blank);
    const [openId, setOpenId] = useState(null);

    /* Every ingredient name already used anywhere in Recipes, so typing one
       in offers the browser's native autocomplete instead of retyping it
       fresh - and keeps spelling consistent across recipes over time. */
    const knownIngredients = [...new Set(
        entries.flatMap((e) => e.ingredients?.map((row) => row.name?.trim()).filter(Boolean) ?? [])
    )].sort();

    const submit = () => {
        if (!f.title.trim()) return;
        if (form === 'new') onAdd({ ...f, kind: recipes ? 'recipe' : f.kind });
        else onEdit(form, { ...f, kind: recipes ? 'recipe' : f.kind });
        setForm(null); setF(blank);
    };

    /* Card rendering, shared between the flat Reference list and the
       grouped-by-category Recipes view. */
    const renderLibCard = (e) => {
        const sp = species.find((s) => s.id === e.species_id);
        const isOpen = openId === e.id;
        return (
            <div key={e.id} className={`lib-card ${isOpen ? 'open' : ''}`}>
                <button className="lib-head" onClick={() => setOpenId(isOpen ? null : e.id)}>
                    <div>
                        <div className="lib-title">{e.title}</div>
                        <div className="lib-meta">
                            {!recipes && <span className="lib-kind">{KINDS[e.kind] ?? e.kind}</span>}
                            {recipes && e.yield_amount && <span className="lib-kind">makes {e.yield_amount}{e.yield_unit}</span>}
                            {sp && <span className="lib-sp">{sp.common_name}</span>}
                        </div>
                    </div>
                    <span className="lib-chev">{isOpen ? '−' : '+'}</span>
                </button>
                {isOpen && (
                    <div className="lib-body">
                        {e.url && <a className="lib-link" href={e.url} target="_blank" rel="noreferrer">{e.url}</a>}
                        {recipes && e.ingredients?.length > 0 && <RecipeIngredients recipe={e} />}
                        {e.body && <pre className="lib-text">{e.body}</pre>}
                        {!e.url && !e.body && !(e.ingredients?.length) && <p className="notes empty-note">No content saved.</p>}
                        <button className="mini ghost" onClick={() => {
                            setF({
                                title: e.title, kind: e.kind, url: e.url ?? '', body: e.body ?? '', species_id: e.species_id ?? '',
                                category: e.category ?? '', yield_amount: e.yield_amount ?? '', yield_unit: e.yield_unit ?? 'mL',
                                ingredients: e.ingredients ?? [],
                            });
                            setForm(e.id);
                        }}>Edit</button>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="page">
            <div className="bar">
                <div>
                    <div className="eyebrow">{recipes ? 'Mixes you make again and again' : 'Reference you want at the bench'}</div>
                    <h1>{recipes ? 'Recipes' : 'Library'}</h1>
                </div>
                {form === null && tab === 'entries' && (
                    <button className="sw" onClick={() => { setF(blank); setForm('new'); }}>
                        + {recipes ? 'Add recipe' : 'Add entry'}
                    </button>
                )}
            </div>

            {!recipes && (
                <div className="tabs">
                    <button className={`tab ${tab === 'entries' ? 'on' : ''}`} onClick={() => { setTab('entries'); setForm(null); }}>Reference</button>
                    <button className={`tab ${tab === 'equipment' ? 'on' : ''}`} onClick={() => { setTab('equipment'); setForm(null); }}>Equipment</button>
                    <button className={`tab ${tab === 'suppliers' ? 'on' : ''}`} onClick={() => { setTab('suppliers'); setForm(null); }}>Suppliers</button>
                </div>
            )}

            {tab === 'equipment' && !recipes ? (
                <EquipmentTab equipment={equipment} onAdd={onAddEquip} onEdit={onEditEquip} onDelete={onDeleteEquip}
                    photos={photos} photoUrl={photoUrl} onAddPhoto={onAddPhoto} onDeletePhoto={onDeletePhoto}
                    onBumpQty={onBumpEquipQty} />
            ) : tab === 'suppliers' && !recipes ? (
                <SupplierTab suppliers={suppliers} onAdd={onAddSupplier} onEdit={onEditSupplier} onDelete={onDeleteSupplier} />
            ) : (
            <>

            {form !== null && (
                <div className="new-form">
                    <div className="nf-title">{form === 'new' ? 'New' : 'Edit'} {recipes ? 'recipe' : 'entry'}</div>
                    <div className="nf-grid">
                        <div className="nf-field wide"><label>Title</label>
                            <input className="in" autoFocus value={f.title}
                                placeholder={recipes ? 'Homemade MEA - 8 oz jar' : 'Dual extraction sheet'}
                                onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
                        {!recipes && (
                            <div className="nf-field"><label>Kind</label>
                                <select className="in sel" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
                                    {Object.keys(KINDS).filter((k) => k !== 'recipe').map((k) => <option key={k} value={k}>{KINDS[k]}</option>)}
                                </select></div>
                        )}
                        <div className="nf-field"><label>Species (optional)</label>
                            <select className="in sel" value={f.species_id} onChange={(e) => setF({ ...f, species_id: e.target.value })}>
                                <option value="">— applies to everything —</option>
                                {species.map((s) => <option key={s.id} value={s.id}>{s.common_name}</option>)}
                            </select></div>
                        <div className="nf-field wide"><label>Link (optional)</label>
                            <input className="in" value={f.url} placeholder="https://…"
                                onChange={(e) => setF({ ...f, url: e.target.value })} /></div>

                        {recipes ? (
                            <>
                                <div className="nf-field"><label>Category</label>
                                    <select className="in sel" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
                                        <option value="">— pick one —</option>
                                        {RECIPE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                                    </select></div>
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

            {entries.length === 0 && form === null && (
                <p className="nf-help" style={{ marginTop: 18 }}>
                    Nothing here yet. {recipes
                        ? 'Your agar and LC media recipes are the obvious first two.'
                        : 'Paste in the text from your printed sheets - casing layer, dual extraction, spore prints - so they are searchable and on your phone.'}
                </p>
            )}

            <div className="lib-list">
                {recipes ? (
                    Object.entries(
                        entries.reduce((groups, e) => {
                            const cat = e.category || 'Uncategorized';
                            (groups[cat] ||= []).push(e);
                            return groups;
                        }, {})
                    )
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([cat, group]) => (
                        <div key={cat}>
                            <div className="sec" style={{ marginTop: 18 }}><span>{cat}</span></div>
                            <div className="lib-list" style={{ marginTop: 0 }}>
                                {[...group].sort((a, b) => a.title.localeCompare(b.title)).map((e) => renderLibCard(e))}
                            </div>
                        </div>
                    ))
                ) : (
                    entries.map((e) => renderLibCard(e))
                )}
            </div>
            </>
            )}
        </div>
    );
}

/* ---------------- SPECIES GRID ---------------- */

function SpeciesGrid({ species, genetics, items, onOpen, onAdd, onToggleHidden }) {
    const live = items.filter((i) => STATUS[i.status].live).length;
    const [adding, setAdding] = useState(false);
    const [showHidden, setShowHidden] = useState(false);
    const [f, setF] = useState({ common_name: "", latin_name: "", fruiting_temp: "", humidity: "", fae: "", notes: "" });
    const hiddenCount = species.filter((s) => s.hidden).length;
    const visible = showHidden ? species : species.filter((s) => !s.hidden);

    const submit = async () => {
        if (!f.common_name.trim()) return;
        await onAdd(f);
        setF({ common_name: "", latin_name: "", fruiting_temp: "", humidity: "", fae: "", notes: "" });
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

function Tree({ items, lines, species, onOpen, onBack, onAddLine, onEditLine, onEditSpecies, onToggleHidden, photos }) {
    const [view, setView] = useState({ x: 0, y: 0, k: 1 });
    const [hover, setHover] = useState(null);
    const [addingLine, setAddingLine] = useState(false);
    const [editLineId, setEditLineId] = useState(null);
    const [editSp, setEditSp] = useState(false);
    const [lf, setLf] = useState({});
    const [sf, setSf] = useState({});
    const [nf, setNf] = useState({ name: "", code: "", source: "", acquired: "", notes: "", firstType: "lc" });
    const box = useRef(null), ptrs = useRef(new Map()), pinch = useRef(null), moved = useRef(false);
    const pos = useMemo(() => layout(items), [items]);

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

    const onWheel = (e) => {
        e.preventDefault();
        const r = box.current.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        setView((v) => {
            const k = Math.min(2.6, Math.max(0.25, v.k * (e.deltaY < 0 ? 1.12 : 0.893)));
            return { k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) };
        });
    };
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
                            fae: species?.fae ?? "", notes: species?.notes ?? "",
                        });
                        setEditSp(true);
                    }}>✎ Species</button>
                    <button className="sw" onClick={() => setAddingLine(true)}>+ Add line</button>
                    <button className="sw" onClick={fit}>Fit</button>
                    <button className="sw" onClick={() => onToggleHidden(species.id, !species.hidden)}>
                        {species?.hidden ? 'Unhide' : 'Hide'}
                    </button>
                </div>
            </div>
            {species?.hidden && <p className="spec-note">Hidden from the species list - visible here until you unhide it.</p>}

            <div className="line-strip">
                {lines.map((g) => (
                    <span key={g.id} className="line-chip">
                        <span className="lc-code">{g.code}</span>
                        <span className="lc-name">{g.name}</span>
                        <button className="edit-btn" title="Edit this line" onClick={() => {
                            setLf({ name: g.name, code: g.code, source: g.source ?? "", acquired_on: g.acquired_on ?? "", notes: g.notes ?? "" });
                            setEditLineId(g.id);
                        }}>✎</button>
                    </span>
                ))}
            </div>

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
                        <div className="nf-field wide"><label>Notes</label>
                            <textarea className="in ta" rows="3" value={sf.notes} onChange={(e) => setSf({ ...sf, notes: e.target.value })} /></div>
                    </div>
                    <div className="edit-row">
                        <button className="mini" onClick={() => {
                            if (!sf.common_name.trim()) return;
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
                        <div className="nf-field wide"><label>Source</label>
                            <input className="in" value={lf.source} onChange={(e) => setLf({ ...lf, source: e.target.value })} /></div>
                        <div className="nf-field wide"><label>Notes</label>
                            <textarea className="in ta" rows="3" value={lf.notes}
                                onChange={(e) => setLf({ ...lf, notes: e.target.value })} /></div>
                    </div>
                    <div className="edit-row">
                        <button className="mini" onClick={() => {
                            if (!lf.name.trim() || !lf.code.trim()) return;
                            onEditLine(editLineId, lf); setEditLineId(null);
                        }}>Save</button>
                        <button className="mini ghost" onClick={() => setEditLineId(null)}>Cancel</button>
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
                        <div className="nf-field wide">
                            <label>Source</label>
                            <input className="in" value={nf.source} placeholder="Commercial LC — Out-Grow"
                                onChange={(e) => setNf({ ...nf, source: e.target.value })} />
                        </div>
                        <div className="nf-field wide">
                            <label>First container — what actually arrived or got made</label>
                            <select className="in sel" value={nf.firstType}
                                onChange={(e) => setNf({ ...nf, firstType: e.target.value })}>
                                {Object.keys(TYPES).map((t) => <option key={t} value={t}>{TYPES[t]}</option>)}
                            </select>
                        </div>
                        <div className="nf-field wide">
                            <label>Notes on this line</label>
                            <textarea className="in ta" rows="3" value={nf.notes}
                                placeholder="How it performs, quirks, anything about the genetics itself."
                                onChange={(e) => setNf({ ...nf, notes: e.target.value })} />
                        </div>
                    </div>
                    <div className="edit-row">
                        <button className="mini" onClick={async () => {
                            if (!nf.name.trim() || !nf.code.trim()) return;
                            await onAddLine(nf, nf.firstType);
                            setNf({ name: "", code: "", source: "", acquired: "", notes: "", firstType: "lc" });
                            setAddingLine(false);
                        }}>Add line</button>
                        <button className="mini ghost" onClick={() => setAddingLine(false)}>Cancel</button>
                    </div>
                </div>
            )}

            <div className="canvas" ref={box} onWheel={onWheel} onPointerDown={onDown}>
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
                                className={`hypha ${litChain.includes(i.id) && litChain.includes(i.parent) ? "lit" : hover ? "dim" : ""}`}
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
                                    <text y={r + 30} className="n-sub" textAnchor="middle">{TYPES[i.type]}{days(i.created) !== null ? ` · d${days(i.created)}` : ""}</text>
                                </g>
                            );
                        })}
                    </g>
                </svg>
                <div className="hint">drag to pan · scroll or pinch to zoom · tap a node</div>
            </div>
        </div>
    );
}

/* ---------------- DETAIL PAGE ---------------- */

function Detail({ items, id, culture, onBack, onOpen, addChild, saveStatus, saveNote, saveHarvest, deleteEvent, deleteHarvest, editEvent, editHarvest, saveItemFields, deleteItem, reparentItem, photos, photoUrl, addPhoto, deletePhoto }) {
    const it = items.find((i) => i.id === id);
    const [picking, setPicking] = useState(false);
    const [note, setNote] = useState("");
    const [wet, setWet] = useState("");
    const [editing, setEditing] = useState(null);   // event id or lot id
    const [draft, setDraft] = useState({ date: "", body: "", wet: "" });
    const [editHead, setEditHead] = useState(false);
    const [editFacts, setEditFacts] = useState(false);
    const [editNotes, setEditNotes] = useState(false);
    const [f, setF] = useState({});                 // field drafts

    const kids = items.filter((i) => i.parent === id);

    /* Everything below this item. Excluded from the parent dropdown so an
       item can't be reparented under its own descendant and orphan a loop. */
    const descendants = (() => {
        const out = [];
        const walk = (lbl) => items.filter((i) => i.parent === lbl).forEach((c) => { out.push(c.id); walk(c.id); });
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
        if (STATUS[s].needsReason) { setPendingStatus(s); setReason(""); return; }
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
                        <select className="in sel" value={f.type ?? it.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
                            {Object.keys(TYPES).map((t) => <option key={t} value={t}>{TYPES[t]}</option>)}
                        </select>
                        <input className="in sm" type="date" value={f.created ?? ""} onChange={(e) => setF({ ...f, created: e.target.value })} />
                        <select className="in sel" value={f.parent ?? ""} onChange={(e) => setF({ ...f, parent: e.target.value })}>
                            <option value="">— no parent (start of the line) —</option>
                            {items.filter((c) => c.id !== id && !descendants.includes(c.id))
                                .map((c) => <option key={c.id} value={c.id}>came from {c.id}</option>)}
                        </select>
                        <button className="mini" onClick={() => {
                            const patch = {};
                            if (f.id?.trim() && f.id.trim() !== it.id) patch.id = f.id.trim();
                            if (f.type && f.type !== it.type) patch.type = f.type;
                            if ((f.created || null) !== it.created) patch.created = f.created || null;
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
                        <div className="d-sub">{TYPES[it.type]} · started {fmt(it.created)}{days(it.created) !== null ? ` · day ${days(it.created)}` : ""}</div>
                    </div>
                )}
                {!editHead && (
                    <>
                        <button className="edit-btn" title="Edit label, type, start date"
                            onClick={() => { setF({ id: it.id, type: it.type, created: it.created ?? "", parent: it.parent ?? "" }); setEditHead(true); }}>✎</button>
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
                photoUrl={photoUrl} onAdd={addPhoto} onDelete={deletePhoto} />

            <div className="actions">
                {!picking ? (
                    <button className="cta" onClick={() => setPicking(true)}>Inoculate from this</button>
                ) : (
                    <div className="picker">
                        <span className="pk-l">Into what?</span>
                        {["agar", "lc", "grain", "bulk", "block"].map((t) => (
                            <button key={t} className="chip go" onClick={() => { addChild(id, t); setPicking(false); }}>{TYPES[t]}</button>
                        ))}
                        <button className="chip" onClick={() => setPicking(false)}>Cancel</button>
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
                                                <td>{fmt(h.date)}</td>
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

                    <Sec title="Details" onEdit={editFacts ? null : () => {
                        setF({ where: it.where ?? "", substrate: it.substrate ?? "", dryWeight: it.dryWeight ?? "" });
                        setEditFacts(true);
                    }} />
                    {editFacts ? (
                        <div className="field-form">
                            <label>Where</label>
                            <input className="in" value={f.where} onChange={(e) => setF({ ...f, where: e.target.value })} />
                            <label>Substrate</label>
                            <input className="in" value={f.substrate} onChange={(e) => setF({ ...f, substrate: e.target.value })} />
                            <label>Dry substrate (g)</label>
                            <input className="in" inputMode="decimal" value={f.dryWeight}
                                onChange={(e) => setF({ ...f, dryWeight: e.target.value })} placeholder="for BE math" />
                            <div className="edit-row">
                                <button className="mini" onClick={() => {
                                    const dw = f.dryWeight === "" ? null : parseFloat(f.dryWeight);
                                    saveItemFields(id, {
                                        where: f.where.trim(),
                                        substrate: f.substrate.trim(),
                                        dryWeight: Number.isNaN(dw) ? null : dw,
                                    });
                                    setEditFacts(false);
                                }}>Save</button>
                                <button className="mini ghost" onClick={() => setEditFacts(false)}>Cancel</button>
                            </div>
                        </div>
                    ) : (
                    <dl className="facts">
                        <dt>Where</dt><dd>{it.where || "—"}</dd>
                        <dt>Substrate</dt><dd>{it.substrate || "—"}</dd>
                        <dt>Came from</dt><dd>{it.parent ? <button className="lnk" onClick={() => onOpen(it.parent)}>{it.parent}</button> : "origin of this line"}</dd>
                        <dt>Produced</dt>
                        <dd>{kids.length ? kids.map((k) => <button key={k.id} className="lnk" onClick={() => onOpen(k.id)}>{k.id}</button>) : "nothing yet"}</dd>
                    </dl>
                    )}

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
                                <span className="log-d">{fmt(l.date)}</span>
                                <span className="log-t">{l.body}</span>
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

const Sec = ({ title, onEdit }) => (
    <div className="sec">
        <span>{title}</span>
        {onEdit && <button className="edit-btn sec-edit" title={`Edit ${title.toLowerCase()}`} onClick={onEdit}>✎</button>}
    </div>
);

/* ---------------- PHOTOS ---------------- */

function Lightbox({ photo, url, onClose, onDelete }) {
    return (
        <div className="lb-scrim" onClick={onClose}>
            <div className="lb-frame" onClick={(e) => e.stopPropagation()}>
                <img src={url} alt={photo.caption ?? ''} className="lb-img" />
                <div className="lb-bar">
                    <span>{photo.taken_on ? fmt(photo.taken_on) : ''}{photo.caption ? ' · ' + photo.caption : ''}</span>
                    <div>
                        <button className="mini danger" onClick={() => { if (confirm('Delete this photo?')) { onDelete(photo); onClose(); } }}>Delete</button>
                        <button className="mini ghost" onClick={onClose}>Close</button>
                    </div>
                </div>
            </div>
        </div>
    );
}

/* Sits on the item page, the equipment edit form, or the Gallery itself.
   `attach` carries whatever this strip's photos should be tagged with -
   { itemId } or { equipmentId } or {} for a plain unattached gallery shot.
   Deliberately no `capture` attribute on the file input - that forces
   mobile browsers straight into the camera and hides the "choose from
   library" option, which is exactly what's needed to backlog old photos. */
function PhotoStrip({ attach = {}, photos, photoUrl, onAdd, onDelete, label }) {
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
                        <img src={photoUrl(p.storage_path)} alt={p.caption ?? ''} />
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
            {lightbox && <Lightbox photo={lightbox} url={photoUrl(lightbox.storage_path)} onClose={() => setLightbox(null)} onDelete={onDelete} />}
        </div>
    );
}

/* ---------------- GALLERY ---------------- */

function Gallery({ photos, items, genetics, species, equipment, photoUrl, onDelete, onOpenItem, onAddPhoto }) {
    const [speciesFilter, setSpeciesFilter] = useState('all');
    const [lightbox, setLightbox] = useState(null);

    const withMeta = photos.map((p) => {
        const item = items.find((i) => i.uid === p.item_id);
        const gen = genetics.find((g) => g.id === item?.geneticsId);
        const sp = species.find((s) => s.id === gen?.species_id);
        const eq = equipment.find((e) => e.id === p.equipment_id);
        return { photo: p, item, sp, eq };
    });

    const visible = withMeta
        .filter((x) => speciesFilter === 'all' || x.sp?.id === speciesFilter)
        .sort((a, b) => (b.photo.taken_on ?? '').localeCompare(a.photo.taken_on ?? ''));

    return (
        <div className="page">
            <div className="bar">
                <div>
                    <div className="eyebrow">Every photo, across every culture</div>
                    <h1>Gallery</h1>
                </div>
                <select className="in sel" style={{ width: 'auto' }} value={speciesFilter} onChange={(e) => setSpeciesFilter(e.target.value)}>
                    <option value="all">All species</option>
                    {species.map((s) => <option key={s.id} value={s.id}>{s.common_name}</option>)}
                </select>
            </div>

            <PhotoStrip attach={{}} photos={[]} photoUrl={photoUrl} onAdd={onAddPhoto} onDelete={onDelete}
                label="Add a photo not tied to anything in particular" />

            {visible.length === 0 && (
                <p className="nf-help" style={{ marginTop: 18 }}>
                    No photos yet - add one from any item's page, from equipment, or right above, and it shows up here too.
                </p>
            )}

            <div className="gallery-grid">
                {visible.map(({ photo, item, sp, eq }) => (
                    <button key={photo.id} className="gallery-tile" onClick={() => setLightbox({ photo, item, eq })}>
                        <img src={photoUrl(photo.storage_path)} alt={photo.caption ?? ''} />
                        <div className="gallery-meta">
                            <span>{item?.id ?? eq?.name ?? 'General'}</span>
                            <span className="gallery-sp">{sp?.common_name ?? ''}</span>
                        </div>
                    </button>
                ))}
            </div>

            {lightbox && (
                <div className="lb-scrim" onClick={() => setLightbox(null)}>
                    <div className="lb-frame" onClick={(e) => e.stopPropagation()}>
                        <img src={photoUrl(lightbox.photo.storage_path)} alt={lightbox.photo.caption ?? ''} className="lb-img" />
                        <div className="lb-bar">
                            <span>{lightbox.photo.taken_on ? fmt(lightbox.photo.taken_on) : ''}{lightbox.photo.caption ? ' · ' + lightbox.photo.caption : ''}</span>
                            <div>
                                {lightbox.item && <button className="mini ghost" onClick={() => onOpenItem(lightbox.item.id)}>Open {lightbox.item.id}</button>}
                                <button className="mini danger" onClick={() => { if (confirm('Delete this photo?')) { onDelete(lightbox.photo); setLightbox(null); } }}>Delete</button>
                                <button className="mini ghost" onClick={() => setLightbox(null)}>Close</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

/* ================= STYLE ================= */

const CSS = `
.root{
  --ground:#B3966B;--panel:#241811;--panel2:#2F2216;--line:#4A3826;--bone:#EDE3D0;--dim:#A6927A;--amber:#D6934A;
  --jade:#7FA66A;--clay:#8C3B26;--rust:#A85C35;--slate:#8A7862;
  --ink:#2B2013;--ink-dim:#5E4C36;--border-warm:#5C4630;--muted-warm:#7A6552;
  --serif:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;
  --mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,'Segoe UI',sans-serif;
  background:var(--ground);color:var(--ink);font-family:var(--sans);min-height:100vh;-webkit-font-smoothing:antialiased;
  overflow-x:hidden;max-width:100vw;
}
.root *{box-sizing:border-box;}
.page{max-width:1080px;margin:0 auto;padding:22px 20px 60px;}

.shell{display:flex;min-height:100vh;}
.side{flex:0 0 186px;background:var(--panel);border-right:1px solid var(--line);padding:22px 12px;display:flex;flex-direction:column;gap:3px;position:sticky;top:0;height:100vh;}
.brand{font-family:var(--serif);font-size:19px;padding:0 10px 18px;color:var(--bone);}
.nav-item{display:flex;align-items:center;gap:10px;background:none;border:none;border-radius:9px;padding:9px 10px;color:var(--dim);font-size:13px;cursor:pointer;font-family:var(--sans);text-align:left;transition:background .15s,color .15s;}
.nav-item:hover{background:var(--panel2);color:var(--bone);}
.nav-item.on{background:var(--panel2);color:var(--amber);}
.main{flex:1;min-width:0;}
.mobile-brand{display:none;}
@media(max-width:760px){
  .shell{flex-direction:column;}
  .side{flex:none;height:auto;position:static;flex-direction:row;overflow-x:auto;border-right:none;border-bottom:1px solid var(--line);padding:10px;}
  .brand{display:none;}
  .mobile-brand{display:block;font-family:var(--serif);font-size:18px;color:var(--ink);padding:14px 16px 6px;}
  .nav-item span{display:none;}
  .nav-item{padding:10px 14px;}
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
.lib-link{display:block;font-family:var(--mono);font-size:11.5px;color:var(--amber);word-break:break-all;margin-bottom:11px;}
.lib-text{font-family:var(--sans);font-size:13px;line-height:1.6;white-space:pre-wrap;margin:0 0 13px;color:var(--bone);}
.ing-rows{display:flex;flex-direction:column;gap:6px;}
.ing-row{display:flex;gap:6px;align-items:center;}
.ing-row .in.sm{width:64px;flex:0 0 auto;}
.ing-unit{width:72px;flex:0 0 auto;font-family:var(--mono);font-size:11.5px;}
.ing-table{border-collapse:collapse;margin-bottom:13px;}
.ing-table td{padding:3px 0;font-size:12.5px;border-bottom:1px solid var(--line);}
.ing-table td:last-child{border-bottom:none;}
.ing-amt{font-family:var(--mono);color:var(--amber);padding-right:14px;white-space:nowrap;}

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
.tally .num{font-family:var(--mono);font-size:30px;color:var(--amber);}
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
.add-plus{font-size:26px;color:var(--amber);line-height:1;}
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
.nf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:11px;margin-bottom:14px;}
.nf-field{display:flex;flex-direction:column;gap:5px;}
.nf-field.wide{grid-column:1 / -1;}
.nf-field label{font-family:var(--mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);}
.mono-in{font-family:var(--mono);letter-spacing:.06em;}
.line-strip{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;}
.line-chip{display:inline-flex;align-items:center;gap:8px;background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:5px 8px 5px 12px;}
.lc-code{font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--amber);}
.lc-name{font-size:12px;color:var(--bone);}
.line-label{font-family:var(--serif);font-size:15px;fill:var(--bone);opacity:.72;}

.bar{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:16px;flex-wrap:wrap;row-gap:10px;}
.eyebrow{font-family:var(--mono);font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--ink-dim);font-style:italic;}
.bar h1{font-family:var(--serif);font-weight:400;font-size:30px;margin:5px 0 0;color:var(--ink);}
.sw{background:var(--panel);border:1px solid var(--line);color:var(--bone);border-radius:20px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:var(--sans);}
.sw:hover{border-color:var(--amber);}

.canvas{position:relative;height:min(70vh,600px);background:radial-gradient(circle at 50% 8%,#2A1D14 0%,#1A120C 66%);
  border:1px solid var(--line);border-radius:16px;overflow:hidden;touch-action:none;cursor:grab;}
.canvas:active{cursor:grabbing;}
.stage{transition:transform .2s ease-out;}
.node{cursor:pointer;transition:transform .55s cubic-bezier(.22,.68,.32,1),opacity .28s ease;}
.node:hover circle:nth-of-type(1){opacity:.34;}
.hypha{fill:none;stroke:var(--line);stroke-linecap:round;transition:stroke .28s ease,opacity .28s ease;}
.hypha.lit{stroke:var(--amber);}
.hypha.dim{opacity:.3;}
.node.faded{opacity:.34;}
.pulse{opacity:.1;animation:breathe 3.2s ease-in-out infinite;}
@keyframes breathe{0%,100%{opacity:.06}50%{opacity:.3}}
.n-id{font-family:var(--mono);font-size:11px;fill:var(--bone);}
.n-sub{font-family:var(--sans);font-size:9.5px;fill:var(--dim);}
.hint{position:absolute;left:14px;bottom:12px;font-family:var(--mono);font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim);pointer-events:none;}

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

.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:2px;margin:14px 0 20px;}
.crumb{background:none;border:none;font-family:var(--mono);font-size:11px;color:var(--ink-dim);cursor:pointer;padding:2px 3px;}
.crumb:hover{color:var(--amber);}
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
.edit-btn:hover{color:var(--amber);}
.sec-edit{opacity:.6;}
.sec:hover .sec-edit{opacity:1;}
.head-read{flex:1;}
.head-edit{flex:1;display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
.head-edit .in{flex:1 1 150px;font-family:var(--mono);}
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
.lnk{background:none;border:none;padding:0;margin-right:9px;color:var(--amber);font-family:var(--mono);font-size:12px;cursor:pointer;}
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
.lot-amount-hero{display:flex;gap:26px;margin:18px 0 6px;padding:16px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);}
.lot-amount-hero div{display:flex;flex-direction:column;gap:2px;}
.lot-amount-hero strong{font-family:var(--mono);font-size:22px;font-weight:400;}
.lot-amount-hero span{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-dim);}
.lineage-list{display:flex;flex-direction:column;gap:6px;}
.lnk-row{display:flex;justify-content:space-between;background:var(--panel);color:var(--bone);border:1px solid var(--line);border-radius:9px;padding:9px 12px;cursor:pointer;font-size:12.5px;text-align:left;font-family:var(--sans);}
.lnk-row:hover{border-color:var(--amber);}
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
.lb-bar{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;font-size:12px;color:var(--dim);}
.lb-bar div{display:flex;gap:8px;}

.gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:18px;}
.gallery-tile{position:relative;aspect-ratio:1;border-radius:11px;overflow:hidden;border:1px solid var(--line);padding:0;cursor:pointer;background:var(--panel);}
.gallery-tile img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .2s;}
.gallery-tile:hover img{transform:scale(1.04);}
.gallery-meta{position:absolute;left:0;right:0;bottom:0;padding:7px 9px;background:linear-gradient(transparent,rgba(0,0,0,.75));display:flex;justify-content:space-between;font-family:var(--mono);font-size:9.5px;color:var(--bone);}
.gallery-sp{color:var(--amber);}

@media(prefers-reduced-motion:reduce){.node,.stage,.page{transition:none!important;animation:none!important}.pulse{animation:none!important;opacity:.18}.screen-in,.screen-back{animation:none!important}.tile{transition:none!important}}
`;