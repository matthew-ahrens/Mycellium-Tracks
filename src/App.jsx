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
    contaminated: { label: "Contaminated", tone: "clay" },
    consumed: { label: "Consumed", tone: "slate" },
    retired: { label: "Retired", tone: "slate" },
};

const TONE = { amber: "#E0A244", jade: "#5FB894", clay: "#C1614F", slate: "#5B6773" };
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
                harvests: (harvests ?? [])
                    .filter((h) => h.source_item_id === r.id)
                    .map((h) => ({ f: h.flush_number, date: h.harvested_on, wet: Number(h.amount_g), lotId: h.id }))
                    .sort((a, b) => a.f - b.f),
                log: (events ?? [])
                    .filter((e) => e.item_id === r.id)
                    .map((e) => [e.happened_on, e.body, e.id])
                    .sort((a, b) => a[0].localeCompare(b[0])),
            })));
            setLoading(false);
        }
        load();
    }, []);

    if (loading) return <div className="root"><style>{CSS}</style><div className="page">Loading…</div></div>;

    const update = (id, fn) => setItems((p) => p.map((i) => (i.id === id ? fn(i) : i)));

    const saveStatus = async (label, status) => {
        const today = todayISO();
        const { data, error } = await supabase
            .from('items')
            .update({ status })
            .eq('label', label)
            .select('id')
            .single();

        if (error) { console.error(error); alert('Save failed - check console'); return; }

        const { data: ev } = await supabase.from('item_events').insert({
            item_id: data.id,
            happened_on: today,
            kind: 'status',
            body: STATUS[status].label,
        }).select('id').single();

        update(label, (i) => ({ ...i, status, log: [...i.log, [today, STATUS[status].label, ev?.id]] }));
    };

    const saveNote = async (label, text) => {
        const today = todayISO();
        const item = items.find((i) => i.id === label);
        const { data: ev, error } = await supabase.from('item_events').insert({
            item_id: item.uid, happened_on: today, kind: 'note', body: text,
        }).select('id').single();
        if (error) { console.error(error); alert('Note not saved - check console'); return; }
        update(label, (i) => ({ ...i, log: [...i.log, [today, text, ev.id]] }));
    };

    const deleteEvent = async (label, eventId) => {
        const { error } = await supabase.from('item_events').delete().eq('id', eventId);
        if (error) { console.error(error); alert('Could not delete - check console'); return; }
        update(label, (i) => ({ ...i, log: i.log.filter((l) => l[2] !== eventId) }));
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
        }).select('id').single();

        update(label, (i) => ({
            ...i,
            status: 'fruiting',
            harvests: [...i.harvests, { f: flush, date: today, wet: grams, lotId: lot.id }],
            log: [...i.log, [today, `Flush ${flush} - ${grams}g wet`, ev?.id]],
        }));
    };

    const deleteHarvest = async (label, harvest) => {
        const item = items.find((i) => i.id === label);

        const { error } = await supabase.from('lots').delete().eq('id', harvest.lotId);
        if (error) { console.error(error); alert('Could not delete - check console'); return; }

        /* The matching history line lives in a different table, so find it
           by its text. Imperfect - a hand-edited entry won't match. */
        const { data: gone } = await supabase.from('item_events').delete()
            .eq('item_id', item.uid).eq('kind', 'harvest')
            .like('body', `Flush ${harvest.f} -%`).select('id');

        const goneIds = (gone ?? []).map((g) => g.id);
        update(label, (i) => ({
            ...i,
            harvests: i.harvests.filter((h) => h.lotId !== harvest.lotId),
            log: i.log.filter((l) => !goneIds.includes(l[2])),
        }));
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

        await supabase.from('item_events').insert({
            item_id: data.id, happened_on: today, kind: 'note',
            body: `Inoculated from ${parentLabel}`,
        });

        setItems((p) => [...p, {
            id: label, uid: data.id, geneticsId: parent.geneticsId,
            parent: parentLabel, type, created: today, status: 'colonizing',
            where: '', substrate: '', notes: '', harvests: [],
            dryWeight: undefined,
            log: [[today, `Inoculated from ${parentLabel}`]],
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
            saveNote={saveNote} saveHarvest={saveHarvest} deleteEvent={deleteEvent} deleteHarvest={deleteHarvest} />;
    } else if (nav.level === 'tree') {
        key = 'tree-' + nav.speciesId;
        screen = <Tree items={mine} lines={lines} species={sp} onOpen={setOpen}
            onBack={() => go({ level: 'species', speciesId: null }, 'back')} />;
    } else {
        key = 'species';
        screen = <SpeciesGrid species={species} genetics={genetics} items={items}
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

function SpeciesGrid({ species, genetics, items, onOpen }) {
    const live = items.filter((i) => STATUS[i.status].live).length;
    return (
        <div className="page">
            <div className="bar">
                <div>
                    <div className="eyebrow">Cultures on the shelf</div>
                    <h1>Species</h1>
                </div>
                <div className="tally"><span className="num">{live}</span><span className="tally-l">live<br />items</span></div>
            </div>

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

function Tree({ items, lines, species, onOpen, onBack }) {
    const [view, setView] = useState({ x: 0, y: 0, k: 1 });
    const [hover, setHover] = useState(null);
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
                <button className="sw" onClick={fit}>Fit</button>
            </div>

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

function Detail({ items, id, culture, species, onBack, onOpen, update, addChild, saveStatus, saveNote, saveHarvest, deleteEvent, deleteHarvest }) {
    const it = items.find((i) => i.id === id);
    const [picking, setPicking] = useState(false);
    const [note, setNote] = useState("");
    const [wet, setWet] = useState("");

    const kids = items.filter((i) => i.parent === id);
    const chain = [];
    { let c = it; while (c) { chain.unshift(c); c = items.find((i) => i.id === c.parent); } }

    const st = STATUS[it.status], tone = TONE[st.tone];
    const totalWet = it.harvests.reduce((s, h) => s + h.wet, 0);
    const be = it.dryWeight && totalWet ? ((totalWet / it.dryWeight) * 100).toFixed(1) : null;

    const setStatus = (s) => saveStatus(id, s);
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
                <div>
                    <h1 className="d-id">{it.id}</h1>
                    <div className="d-sub">{TYPES[it.type]} · started {fmt(it.created)}{days(it.created) !== null ? ` · day ${days(it.created)}` : ""}</div>
                </div>
                <span className="pill" style={{ color: tone, borderColor: tone }}>{st.label}</span>
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

                    {FRUITS.includes(it.type) && (
                        <>
                            <Sec title="Harvests" />
                            {it.harvests.length > 0 && (
                                <table className="tbl">
                                    <thead><tr><th>Flush</th><th>Date</th><th>Wet</th><th></th></tr></thead>
                                    <tbody>
                                        {it.harvests.map((h) => (
                                            <tr key={h.lotId ?? h.f}>
                                                <td>{h.f}</td>
                                                <td>{fmt(h.date)}</td>
                                                <td className="num">{h.wet} g</td>
                                                <td className="x-cell">
                                                    {h.lotId && (
                                                        <button className="log-x" title="Delete this flush"
                                                            onClick={() => { if (confirm(`Delete flush ${h.f} (${h.wet}g)? This removes the inventory lot too.`)) deleteHarvest(id, h); }}>×</button>
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
                        <dt>Where</dt><dd>{it.where || "—"}</dd>
                        <dt>Substrate</dt><dd>{it.substrate || "—"}</dd>
                        <dt>Came from</dt><dd>{it.parent ? <button className="lnk" onClick={() => onOpen(it.parent)}>{it.parent}</button> : "origin of this line"}</dd>
                        <dt>Produced</dt>
                        <dd>{kids.length ? kids.map((k) => <button key={k.id} className="lnk" onClick={() => onOpen(k.id)}>{k.id}</button>) : "nothing yet"}</dd>
                    </dl>

                    {it.notes && <><Sec title="Notes" /><p className="notes">{it.notes}</p></>}
                </div>

                <div>
                    <Sec title="History" />
                    <ul className="log">
                        {[...it.log].reverse().map(([d, t, evId], n) => (
                            <li key={evId ?? n}>
                                <span className="log-d">{fmt(d)}</span>
                                <span className="log-t">{t}</span>
                                {evId && (
                                    <button className="log-x" title="Delete this entry"
                                        onClick={() => { if (confirm(`Delete "${t}"?`)) deleteEvent(id, evId); }}>×</button>
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

const Sec = ({ title }) => <div className="sec">{title}</div>;

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
.sec{font-family:var(--mono);font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin:24px 0 10px;padding-bottom:7px;border-bottom:1px solid var(--line);}

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
.log-x{background:none;border:none;padding:0 2px;color:#3E4A55;font-size:16px;line-height:1;cursor:pointer;opacity:0;transition:opacity .15s,color .15s;}
.log li:hover .log-x{opacity:1;}
.log-x:hover{color:var(--clay,#C1614F);}
.log-x:focus-visible{opacity:1;outline:2px solid var(--amber);outline-offset:2px;}
@media(prefers-reduced-motion:reduce){.node,.stage,.page{transition:none!important;animation:none!important}.pulse{animation:none!important;opacity:.18}.screen-in,.screen-back{animation:none!important}.tile{transition:none!important}}
`;