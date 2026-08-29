# Mycelium (SporeDesk)

Lineage and inventory tracker for mushroom cultivation. Deployed at
mycellium-tracks.vercel.app, gated behind sign-in.

## Data model

Three layers:

- **Cultures** — descending tree, one parent per item.
  `species` -> `genetics` (one per acquisition) -> `items` (physical containers)
- **Inventory** — merging/splitting graph. Everything enters as a wet harvest.
  `lots` + `lot_links` (many parents, many children)
- **Library** — reference, equipment, suppliers, recipes. Flat, no relation
  to the cultivation graph.
- **Photos** — attach to an item, to equipment, or to nothing (plain
  gallery upload). Private Supabase Storage bucket, signed URLs.

Rules settled so far:

- New container = new node. Same container aging = status change.
- A genetics record is one traceable acquisition. Two purchases from the
  same vendor are two records, because the genetics can't be verified.
- Splitting/merging a lot leaves the parent's ID intact and decrements its
  remaining amount (derived, never stored). Children record how much they
  took via `lot_links`.
- Notes go where the fact lives: strain behaviour on the genetics line,
  container specifics on the item, species-wide parameters on the species.
- Contamination and failure are separate statuses, each requiring a reason,
  so contamination rate stays a real number.
- Single-user app. RLS policies check "is someone logged in," not per-row
  ownership — correct for one person, would need `user_id` columns if this
  ever supported more than one grower.

## Built

**Cultures** — species grid -> parallel-tree screen -> item detail. Full
CRUD: add/edit species, add/edit genetics lines, add/edit/delete/reparent
items, inoculate-from. Status includes contamination/failure with required
reason (preset chips + free text). History entries and harvest rows are
fully editable and deletable in place. BE% calculated live. Mycelial
top-down tree, pan/zoom, hover lights ancestry back to origin.

**Inventory** — every logged harvest becomes a wet lot automatically.
Process (transform/merge/split are one action), write-off (eaten/given
away/sampled/lost, not framed as a mistake), manual lot entry for material
with no clean paper trail (optional species tag since there's no source
item to trace it through), full lineage view (made-from / went-into).

**Library** — Reference (your instruction sheets, general + Cordyceps
tagged), Equipment (category-grouped, status, optional quantity with a
tap +/- stepper, optional photo), Suppliers (rated, sorted by trust),
Recipes (separate section, feeds the recipe scaler).

**Photos** — upload from item pages, equipment, or standalone via Gallery.
Species filter in Gallery. Native camera-or-library chooser (no forced
camera jump). Signed URLs, 6hr expiry, private bucket.

**Calculators** — spawn ratio (either direction), hydration, BE, dry yield
estimate, recipe scaler (reads a saved recipe's amounts directly), unit
converter, grain weight<->volume (flagged approximate).

**Auth + security** — email/password sign-in, no self-serve sign-up. RLS on
all 10 tables and the storage bucket. Deployed on Vercel, connected to
GitHub for auto-deploy on push.

**Mobile** — works end to end on phone (tested on iPhone/Chrome). Sidebar
collapses to a horizontal icon strip with its own brand header. Fixed:
tab-row wrap, header-bar wrap, equipment row text truncation (was pushing
the status pill off-screen), global overflow-x safety net.

## Known gaps

- **No delete for genetics or species.** Items have delete (with child
  reparenting); genetics and species don't. Only real gap in "every
  create/edit/delete works" — SQL still required to remove one.
- **Hover-lit lineage path has no touch equivalent.** Works on desktop,
  invisible on phone since hover doesn't exist there.
- **Photos can't attach to a specific history entry yet.** Schema supports
  it (`event_id` column, `addPhoto` accepts it) but no UI exposes an event
  picker — photos land on the item generally, not a specific log line.
- **No photo thumbnail on species/genetics tiles** — only item pages,
  equipment rows, and Gallery show images.
- **Harvest event <-> lot links are matched by text** in one older code
  path (see `deleteHarvest`), not a stored key, for entries created before
  the `lot_id` column existed. New harvests are properly linked.
- **Logging a harvest always sets item status to `fruiting`.** Fine when
  harvesting live, needs a manual status fix after back-filling history on
  an already-retired item. Known, low-priority — workaround is one tap.

## Not started

- **QR labels.** Auth and deployment are done, so the remaining blocker is
  real URL routing per item (`/item/BO-GR1` instead of React state nav).
  Once that exists, QR generation itself is small — a library and an hour.
- **Search** across items/lots/library — fine at current scale, won't stay
  fine.
- **Recipe scaler** only parses lines shaped like "175 mL water" — a
  differently-formatted saved recipe won't scale.

## Running it

```
npm run dev
```

Needs `.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
(same values as the Vercel project's environment variables).
