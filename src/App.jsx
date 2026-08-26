import { supabase } from './supabaseClient'
import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";

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

const TONE = { amber: "#E0A244", jade: "#5FB894", clay: "#C1614F", rust: "#9A6B45", slate: "#5B6773" };
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

            setSpecies(sp ?? []);
            setGenetics(gen ?? []);

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
    if (open) {
        key = 'detail-' + open;
        screen = <Detail items={mine} id={open} culture={openCulture} species={sp}
            onBack={() => { setDir('back'); setOpen(null); }}
            onOpen={setOpen} update={update} addChild={addChild} saveStatus={saveStatus}
            saveNote={saveNote} saveHarvest={saveHarvest} deleteEvent={deleteEvent} deleteHarvest={deleteHarvest}
            editEvent={editEvent} editHarvest={editHarvest} saveItemFields={saveItemFields} />;
    } else if (nav.level === 'tree') {
        key = 'tree-' + nav.speciesId;
        screen = <Tree items={mine} lines={lines} species={sp} onOpen={setOpen}
            onAddLine={(fields, firstType) => addGenetics(nav.speciesId, fields, firstType)}
            onEditLine={saveGeneticsFields} onEditSpecies={saveSpeciesFields}
            onBack={() => go({ level: 'species', speciesId: null }, 'back')} />;
    } else {
        key = 'species';
        screen = <SpeciesGrid species={species} genetics={genetics} items={items}
            onAdd={addSpecies}
            onOpen={(id) => go({ level: 'tree', speciesId: id })} />;
    }

    return (
        <div className="root">
            <style>{CSS}</style>
            <div key={key} className={dir === 'fwd' ? 'screen-in' : 'screen-back'}>{screen}</div>
        </div>
    );
}

/* ---------------- MINI BRANCH GLYPH ---------------- */

function MiniTree({ nodes }) {
    const W = 74, H = 38, pad = 7;
    if (!nodes.length) return <svg width={W} height={H} />;
    const maxD = Math.max(1, ...nodes.map((n) => n.depth));
    const step = (W - pad * 2) / Math.max(1, maxD);
    const byDepth = {};
    nodes.forEach((n) => { (byDepth[n.depth] ||= []).push(n); });
    const pos = {};
    nodes.forEach((n) => {
        const row = byDepth[n.depth];
        const i = row.indexOf(n);
        const y = row.length === 1 ? H / 2 : pad + ((H - pad * 2) * i) / (row.length - 1);
        pos[n.item.id] = { x: pad + n.depth * step, y };
    });
    return (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
            {nodes.map((n) => {
                const p = n.item.parent && pos[n.item.parent];
                if (!p) return null;
                const c = pos[n.item.id];
                return <path key={'e' + n.item.id} className="mini-edge"
                    d={`M${p.x} ${p.y} C ${(p.x + c.x) / 2} ${p.y}, ${(p.x + c.x) / 2} ${c.y}, ${c.x} ${c.y}`} />;
            })}
            {nodes.map((n) => {
                const c = pos[n.item.id];
                const live = STATUS[n.item.status].live;
                return <circle key={n.item.id} cx={c.x} cy={c.y} r={live ? 3.2 : 2.3}
                    fill={TONE[STATUS[n.item.status].tone]} opacity={live ? 1 : .55} />;
            })}
        </svg>
    );
}

function branchOf(items, geneticsId) {
    const mine = items.filter((i) => i.geneticsId === geneticsId);
    const kids = (id) => mine.filter((i) => i.parent === id);
    const walk = (n, d) => [{ item: n, depth: d }, ...kids(n.id).flatMap((k) => walk(k, d + 1))];
    return mine.filter((i) => !i.parent).flatMap((r) => walk(r, 0));
}

/* ---------------- SPECIES GRID ---------------- */

function SpeciesGrid({ species, genetics, items, onOpen, onAdd }) {
    const live = items.filter((i) => STATUS[i.status].live).length;
    const [adding, setAdding] = useState(false);
    const [f, setF] = useState({ common_name: "", latin_name: "", fruiting_temp: "", humidity: "", fae: "", notes: "" });

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
                <div className="tally"><span className="num">{live}</span><span className="tally-l">live<br />items</span></div>
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
                {species.map((s) => {
                    const lines = genetics.filter((g) => g.species_id === s.id);
                    const ids = lines.map((g) => g.id);
                    const mine = items.filter((i) => ids.includes(i.geneticsId));
                    const liveN = mine.filter((i) => STATUS[i.status].live).length;
                    return (
                        <button key={s.id} className="tile" onClick={() => onOpen(s.id)}>
                            <div className="tile-name">{s.common_name}</div>
                            <div className="tile-latin">{s.latin_name}</div>
                            <div className="tile-foot">
                                <span className="src">{lines.length} {lines.length === 1 ? 'line' : 'lines'}</span>
                                <span className={liveN ? 'live-c' : 'dormant'}>{liveN ? `${liveN} live` : 'dormant'}</span>
                            </div>
                        </button>
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

/* ---------------- GENETICS GRID ---------------- */

function GeneticsGrid({ species, genetics, items, onOpen, onBack }) {
    return (
        <div className="page">
            <button className="back" onClick={onBack}>← Species</button>
            <div className="bar">
                <div>
                    <div className="eyebrow">{species?.latin_name}</div>
                    <h1>{species?.common_name}</h1>
                </div>
            </div>

            {species?.notes && <p className="spec-note">{species.notes}</p>}

            <div className="grid">
                {genetics.map((g) => {
                    const nodes = branchOf(items, g.id);
                    const liveN = nodes.filter((n) => STATUS[n.item.status].live).length;
                    return (
                        <button key={g.id} className="tile" onClick={() => onOpen(g.id)}>
                            <div className="tile-top">
                                <div>
                                    <div className="tile-name">{g.name}</div>
                                    <div className="tile-latin">{g.code}</div>
                                </div>
                                <MiniTree nodes={nodes} />
                            </div>
                            <div className="tile-foot">
                                <span className="src">{g.source}</span>
                                <span className={liveN ? 'live-c' : 'dormant'}>{liveN ? `${liveN} live` : 'dormant'}</span>
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

/* ---------------- TREE ---------------- */

function Tree({ items, lines, species, onOpen, onBack, onAddLine, onEditLine, onEditSpecies }) {
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
                </div>
            </div>

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
                            return (
                                <g key={i.id} className={`node ${hover && !litChain.includes(i.id) ? "faded" : ""}`}
                                    style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
                                    onMouseEnter={() => setHover(i.id)}
                                    onMouseLeave={() => setHover(null)}
                                    onClick={() => { if (!moved.current) onOpen(i.id); }}>
                                    {st.live && <circle r={r + 6} fill={tone} className="pulse" />}
                                    <circle r={r} fill="#111720" stroke={tone} strokeWidth="1.9" />
                                    {st.tone !== "slate" && <circle r={r * 0.42} fill={tone} />}
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

function Detail({ items, id, culture, species, onBack, onOpen, update, addChild, saveStatus, saveNote, saveHarvest, deleteEvent, deleteHarvest, editEvent, editHarvest, saveItemFields }) {
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
                        <button className="mini" onClick={() => {
                            const patch = {};
                            if (f.id?.trim() && f.id.trim() !== it.id) patch.id = f.id.trim();
                            if (f.type && f.type !== it.type) patch.type = f.type;
                            if ((f.created || null) !== it.created) patch.created = f.created || null;
                            if (Object.keys(patch).length) saveItemFields(id, patch);
                            setEditHead(false);
                        }}>Save</button>
                        <button className="mini ghost" onClick={() => setEditHead(false)}>Cancel</button>
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
                            onClick={() => { setF({ id: it.id, type: it.type, created: it.created ?? "" }); setEditHead(true); }}>✎</button>
                        <span className="pill" style={{ color: tone, borderColor: tone }}>{st.label}</span>
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

            <div className="actions">
                {!picking ? (
                    <button className="cta" onClick={() => setPicking(true)}>Inoculate from this</button>
                ) : (
                    <div className="picker">
                        <span className="pk-l">Into what?</span>
                        {["agar", "lc", "grain", "bulk"].map((t) => (
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

/* ================= STYLE ================= */

const CSS = `
.root{
  --ground:#0E1216;--panel:#161B21;--panel2:#1C232B;--line:#2A333C;--bone:#E9E4D9;--dim:#8D97A1;--amber:#E0A244;
  --serif:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;
  --mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,'Segoe UI',sans-serif;
  background:var(--ground);color:var(--bone);font-family:var(--sans);min-height:100vh;-webkit-font-smoothing:antialiased;
}
.root *{box-sizing:border-box;}
.page{max-width:1080px;margin:0 auto;padding:22px 20px 60px;}

/* screen transitions */
.screen-in{animation:slideIn .42s cubic-bezier(.22,.68,.32,1);}
.screen-back{animation:slideBack .42s cubic-bezier(.22,.68,.32,1);}
@keyframes slideIn{from{opacity:0;transform:translateX(26px) scale(.985)}to{opacity:1;transform:none}}
@keyframes slideBack{from{opacity:0;transform:translateX(-26px) scale(.985)}to{opacity:1;transform:none}}

/* tiles */
.tally{display:flex;align-items:center;gap:9px;}
.tally .num{font-family:var(--mono);font-size:30px;color:var(--amber);}
.tally-l{font-family:var(--mono);font-size:9.5px;line-height:1.2;color:var(--dim);text-transform:uppercase;letter-spacing:.1em;}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(258px,1fr));gap:13px;margin-top:22px;}
.tile{text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;color:inherit;cursor:pointer;font-family:var(--sans);transition:border-color .18s,transform .18s,background .18s;}
.tile:hover{border-color:#3E4A55;background:var(--panel2);transform:translateY(-2px);}
.tile:focus-visible{outline:2px solid var(--amber);outline-offset:2px;}
.tile-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;}
.tile-name{font-family:var(--serif);font-size:21px;}
.tile-latin{font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin-top:4px;font-style:italic;}
.tile-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:16px;padding-top:11px;border-top:1px solid var(--line);}
.src{font-size:11.5px;color:var(--dim);}
.live-c{font-family:var(--mono);font-size:11px;color:var(--jade);white-space:nowrap;}
.dormant{font-family:var(--mono);font-size:11px;color:#4E5963;white-space:nowrap;}
.mini-edge{fill:none;stroke:#3A454F;stroke-width:1;}
.spec-note{font-size:12.5px;color:var(--dim);font-style:italic;margin:12px 0 0;max-width:60ch;}
.bar-actions{display:flex;gap:7px;}
.add-tile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;min-height:118px;border-style:dashed;background:none;}
.add-tile:hover{border-color:var(--amber);background:var(--panel);}
.add-plus{font-size:26px;color:var(--amber);line-height:1;}
.add-label{font-size:12.5px;color:var(--dim);}
.new-form{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-top:20px;animation:pop .22s ease-out;}
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
.lc-name{font-size:12px;color:var(--dim);}
.line-label{font-family:var(--serif);font-size:15px;fill:var(--bone);opacity:.72;}

.bar{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:16px;}
.eyebrow{font-family:var(--mono);font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--dim);font-style:italic;}
.bar h1{font-family:var(--serif);font-weight:400;font-size:30px;margin:5px 0 0;}
.sw{background:var(--panel);border:1px solid var(--line);color:var(--dim);border-radius:20px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:var(--sans);}
.sw:hover{color:var(--bone);border-color:#3E4A55;}

.canvas{position:relative;height:min(70vh,600px);background:radial-gradient(circle at 50% 8%,#151C24 0%,#0E1216 66%);
  border:1px solid var(--line);border-radius:16px;overflow:hidden;touch-action:none;cursor:grab;}
.canvas:active{cursor:grabbing;}
.stage{transition:transform .2s ease-out;}
.node{cursor:pointer;transition:transform .55s cubic-bezier(.22,.68,.32,1),opacity .28s ease;}
.node:hover circle:nth-of-type(1){opacity:.34;}
.hypha{fill:none;stroke:#3B4650;stroke-linecap:round;transition:stroke .28s ease,opacity .28s ease;}
.hypha.lit{stroke:#C9954A;}
.hypha.dim{opacity:.3;}
.node.faded{opacity:.34;}
.pulse{opacity:.1;animation:breathe 3.2s ease-in-out infinite;}
@keyframes breathe{0%,100%{opacity:.06}50%{opacity:.3}}
.n-id{font-family:var(--mono);font-size:11px;fill:var(--bone);}
.n-sub{font-family:var(--sans);font-size:9.5px;fill:var(--dim);}
.hint{position:absolute;left:14px;bottom:12px;font-family:var(--mono);font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:#4E5963;pointer-events:none;}

.back{background:none;border:none;color:var(--dim);font-family:var(--mono);font-size:11.5px;cursor:pointer;padding:0 0 18px;}
.back:hover{color:var(--bone);}
.d-head{display:flex;align-items:center;gap:14px;padding-bottom:16px;border-bottom:1px solid var(--line);}
.d-mark{width:34px;height:34px;border-radius:50%;border:2px solid;display:flex;align-items:center;justify-content:center;flex:0 0 auto;}
.d-mark span{width:13px;height:13px;border-radius:50%;display:block;}
.d-id{font-family:var(--mono);font-size:25px;font-weight:400;margin:0;letter-spacing:.01em;}
.d-sub{font-size:12.5px;color:var(--dim);margin-top:4px;}
.pill{margin-left:auto;font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;border:1px solid;border-radius:20px;padding:3px 10px;}

.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:2px;margin:14px 0 20px;}
.crumb{background:none;border:none;font-family:var(--mono);font-size:11px;color:var(--dim);cursor:pointer;padding:2px 3px;}
.crumb:hover{color:var(--amber);}
.crumb.here{color:var(--bone);cursor:default;}
.arrow{color:#3E4A55;font-size:10px;margin:0 4px;}

.actions{margin-bottom:24px;}
.cta{background:var(--amber);color:#141922;border:none;border-radius:10px;padding:11px 20px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:var(--sans);}
.cta:hover{filter:brightness(1.08);}
.picker{display:flex;flex-wrap:wrap;align-items:center;gap:7px;}
.pk-l{font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-right:4px;}

.cols{display:grid;grid-template-columns:1fr 320px;gap:34px;align-items:start;}
@media(max-width:780px){.cols{grid-template-columns:1fr;gap:8px;}}
.sec{font-family:var(--mono);font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin:24px 0 10px;padding-bottom:7px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;}
.edit-btn{background:none;border:none;padding:0 4px;color:#4E5963;font-size:14px;line-height:1;cursor:pointer;transition:color .15s;}
.edit-btn:hover{color:var(--amber);}
.sec-edit{opacity:.6;}
.sec:hover .sec-edit{opacity:1;}
.head-read{flex:1;}
.head-edit{flex:1;display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
.head-edit .in{flex:1 1 150px;font-family:var(--mono);}
.in.sel{color-scheme:dark;cursor:pointer;}
.in.ta{width:100%;font-family:var(--sans);line-height:1.55;resize:vertical;}
.field-form{display:flex;flex-direction:column;gap:7px;}
.field-form label{font-family:var(--mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin-top:4px;}
.empty-note{opacity:.5;}
.reason-box{margin-top:12px;padding:13px;background:var(--panel);border:1px solid var(--line);border-radius:11px;animation:pop .2s ease-out;}
.rb-title{font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-bottom:9px;}
.fail-note{font-size:12px;margin:10px 0 0;font-family:var(--mono);}

.chips{display:flex;flex-wrap:wrap;gap:6px;}
.chip{background:var(--panel2);border:1px solid var(--line);border-radius:20px;padding:6px 12px;font-size:11.5px;color:var(--dim);cursor:pointer;font-family:var(--sans);transition:color .15s,border-color .15s;}
.chip:hover{color:var(--bone);border-color:#3E4A55;}
.chip.on{border-color:var(--amber);color:var(--amber);}
.chip.go{color:var(--bone);border-color:#3E4A55;}

.tbl{width:100%;border-collapse:collapse;font-size:12.5px;}
.tbl th{text-align:left;font-family:var(--mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);font-weight:400;padding-bottom:6px;}
.tbl td{padding:6px 0;border-top:1px solid var(--line);}
.tbl .num{font-family:var(--mono);text-align:right;}
.tbl th:nth-child(3){text-align:right;}
.x-cell{width:22px;text-align:right;padding-left:6px;}
.tbl tr:hover .log-x{opacity:1;}
.row-in{display:flex;gap:7px;margin-top:11px;}
.in{flex:1;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 11px;color:var(--bone);font-size:12.5px;font-family:var(--sans);}
.in:focus{outline:none;border-color:var(--amber);}
.mini{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 13px;color:var(--bone);font-size:12px;cursor:pointer;font-family:var(--sans);}
.mini:hover{border-color:var(--amber);color:var(--amber);}
.be{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-top:13px;padding-top:11px;border-top:1px solid var(--line);font-size:11.5px;color:var(--dim);}
.be strong{font-family:var(--mono);font-size:15px;font-weight:400;}

.facts{display:grid;grid-template-columns:auto 1fr;gap:9px 18px;margin:0;font-size:12.5px;}
.facts dt{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);padding-top:2px;}
.facts dd{margin:0;}
.lnk{background:none;border:none;padding:0;margin-right:9px;color:var(--amber);font-family:var(--mono);font-size:12px;cursor:pointer;}
.lnk:hover{text-decoration:underline;}
.notes{font-size:12.5px;line-height:1.6;color:var(--dim);margin:0;}

.log{list-style:none;padding:0;margin:0;}
.log li{display:flex;gap:11px;padding:8px 0;border-bottom:1px solid var(--line);}
.log li:last-child{border-bottom:none;}
.log-d{font-family:var(--mono);font-size:10.5px;color:var(--dim);flex:0 0 46px;padding-top:2px;}
.log-t{font-size:12.5px;line-height:1.45;flex:1;}
.log-x{background:none;border:none;padding:6px 8px;margin:-6px -4px -6px 0;color:#48535D;font-size:15px;line-height:1;cursor:pointer;opacity:.65;transition:opacity .15s,color .15s;}
.log li:hover .log-x,.tbl tr:hover .log-x{opacity:1;}
.log-x:hover{color:var(--amber);}
.log-x:focus-visible{opacity:1;outline:2px solid var(--amber);outline-offset:2px;}
.mini.danger{background:none;color:#A0524A;border-color:#3A2A2A;margin-left:auto;}
.mini.danger:hover{color:#D4705F;border-color:#5A3733;}
.x-cell{width:34px;text-align:right;padding-left:6px;}
.edit-row{display:flex;gap:6px;align-items:center;width:100%;padding:4px 0;}
.edit-row.wrap{flex-wrap:wrap;}
.in.sm{flex:0 0 auto;width:auto;padding:6px 9px;font-size:11.5px;font-family:var(--mono);color-scheme:dark;}
.mini.ghost{background:none;color:var(--dim);}
.mini.ghost:hover{color:var(--bone);border-color:var(--line);}
.log li.editing{padding:2px 0;}
@media(prefers-reduced-motion:reduce){.node,.stage,.page{transition:none!important;animation:none!important}.pulse{animation:none!important;opacity:.18}.screen-in,.screen-back{animation:none!important}.tile{transition:none!important}}
`;