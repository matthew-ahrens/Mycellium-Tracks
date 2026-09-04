# Mycelium (SporeDesk)

**Start here (fresh session / Claude Code):** this file is current-state
only - what the app does and how it's built, right now. It is NOT a
changelog. For history, past bugs, and how a decision got made, see
`CHANGELOG.md` - don't read that file by default, only pull it up if a task
needs the backstory. The app is `src/App.jsx` (one big file, ~3200+ lines -
every screen is a component in there) plus `src/AuthGate.jsx` (login).
Supabase project id `pbjgelklvlbzarasjcwt` holds the schema - check it
directly rather than assuming from this file, since the DB is always more
current than any doc. Everything below is real and current as of
2026-09-04 unless marked otherwise.

Lineage and inventory tracker for mushroom cultivation. Deployed at
mycellium-tracks.vercel.app, gated behind sign-in. Also ships as a native
Windows desktop app (Electron) and is installable as a home-screen PWA on
mobile - same code, same Supabase backend for all three.

## Data model

Three layers:

- **Cultures** — descending tree, one parent per item.
  `species` -> `genetics` (one per acquisition) -> `items` (physical containers)
- **Inventory** — merging/splitting graph. Everything enters as a wet harvest.
  `lots` + `lot_links` (many parents, many children)
- **Library** — reference, stock, equipment, suppliers, recipes. Flat, no
  relation to the cultivation graph.
- **Photos** — attach to an item, to equipment, or to nothing (plain
  gallery upload). Private Supabase Storage bucket, signed URLs.

Rules:

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
- Item labels double as the app's client-side id, matched by string
  equality (not a stable UID) - **when adding items or fixing data by
  hand, labels must stay unique per genetics line.** `addChild` enforces
  this in code; direct SQL edits don't get that check for free.
- Single-user app. RLS policies check "is someone logged in," not per-row
  ownership — correct for one person, would need `user_id` columns if this
  ever supported more than one grower.

## Built

**Cultures** — species grid -> parallel-tree screen -> item detail. Full
CRUD: add/edit species, add/edit genetics lines, add/edit/delete/reparent
items, inoculate-from (including "inoculate from on-hand stock," see
Supplies below). Species can be hidden from the main grid without deleting
history. Status includes contamination/failure with required reason
(preset chips + free text). History entries and harvest rows fully
editable/deletable in place. BE% calculated live. Mycelial top-down tree,
pan/zoom, hover lights ancestry back to origin.

**Inventory** — every logged harvest becomes a wet lot automatically.
Process (transform/merge/split are one action), write-off (eaten/given
away/sampled/lost), manual lot entry for material with no clean paper
trail, full lineage view (made-from / went-into).

**Supplies** (Stock, Equipment, Suppliers - "what do I have, or where do I
get it"):
- **Stock** — sterile-but-uninoculated inventory: agar plates, LC jars,
  grain spawn bags, bulk substrate bags/blocks, AIO bags. Each row is
  either `source='made'` (linked to a Recipe) or `source='bought'` (linked
  to a Supplier). Optional species tag. Quantity stepper. Feeds into
  Cultures as "made from on-hand stock" when starting or continuing a
  line, auto-decrementing on use.
- **Equipment** — category-grouped, status, optional quantity stepper,
  optional photo.
- **Suppliers** — rated, sorted by trust, optional website link.

**Reference** (Reference docs + Recipes, two tabs on one screen):
- **Reference** — your instruction sheets, general + Cordyceps tagged.
- **Recipes** — structured ingredient rows (amount/unit/name) with a live
  batch-size scaler (type a target or tap ×2/×3/×5, every ingredient
  recomputes). Ingredient names autocomplete from ones already used.
  Covers agar media, LC media, grain spawn, bulk substrate (incl. Masters
  Mix, Supplemented Hardwood, and a manure-based recipe), casing mixes,
  and nutrient broth.

**Capsule blends** — its own recipe category/math, since a capsule's
per-dose amount is fixed regardless of batch size. Each ingredient is a
species from the real species list plus a dose in mg/capsule. Batch size
is capsule count, optional spillage buffer %. Shows total mg/capsule
against a 500mg 00-capsule reference and a live weigh-out table.

**Photos** — upload from item pages, equipment, or standalone via Gallery.
Species filter in Gallery. Native camera-or-library chooser. Signed URLs,
6hr expiry, private bucket.

**Calculators** — spawn ratio (either direction), hydration, BE, dry yield
estimate, unit converter, grain weight<->volume (flagged approximate).

**QR label printing** — "Print label" (single item, on item detail) and
"Print labels" (whole species, all lines) both open the same
picker/print screen. Encodes `?item=<label>` links (read on app load, jumps
straight to that item) using the deployed production URL so a code always
resolves on any device, never a local dev URL. Layout targets standard
Avery-5160-style 3x10 address labels (2.625"x1", margins editable on the
print screen), with a "start at label #" field to resume a partial sheet.
QR error-correction level `Q` (~25% damage tolerance) for humid grow-space
durability. **Desktop/native app only** - hidden on mobile (<760px) since
iOS Safari doesn't reliably honor print CSS; see CHANGELOG for why.

**Auth + security** — email/password sign-in, no self-serve sign-up. RLS on
all tables and the storage bucket. Deployed on Vercel, connected to GitHub
for auto-deploy on push.

**Mobile** — bottom tab-bar nav (thumb reach, no scrolling), safe-area
support, installable as a home-screen PWA (own icon, no browser chrome) on
iOS/Android. Print-label buttons hidden here (see above).

**Native Windows desktop app** — Electron wrapper around the same web app.
`npm run electron:dev` (dev window, live reload), `npm run electron:pack`
(fast unpacked build for a smoke test), `npm run electron:build` (real NSIS
installer at `release/SporeDesk Setup <version>.exe`). Not code-signed, so
SmartScreen flags it as unknown publisher on first run - expected, not a
bug. **Only build/install/run this from Matt's actual Windows PC, never
from a Linux shell** - both machines can mount the same folder, and a
build/install from the wrong OS silently corrupts native binary deps
(electron, rolldown) for the other side. Code edits (Read/Edit on
individual files) are fine from either side; running `npm install` or any
build/dev command is not.

## Visual design

Warm tan/dark-panel with a reishi-lacquer accent. Live in `App.jsx`'s
`.root` CSS variables and `AuthGate.jsx`.

```
page bg:      #B3966B      page text:     #2B2013 (headings), #5E4C36 (dim)
card panel:   #241811      card panel2:   #2F2216      card line: #4A3826
card text:    #EDE3D0      card dim:      #A6927A
amber:        #D6934A      jade (olive):  #7FA66A      slate: #8A7862
reishi (wordmark): #6B2717   reishi (status pill fill): #8C3B26
```

Logo assets (glyph/favicon/wordmark/badge) are placeholder art for the
prototype - a real design pass is planned as its own dedicated chat
thread later (see `claude/sporedesk-logo-design-brief.md` in the Gourmet
Mushrooms Project).

## Known gaps

- No delete for genetics or species (items have it, with child
  reparenting). Only real gap in "every create/edit/delete works" - SQL
  still required to remove one.
- Hover-lit lineage path has no touch equivalent (desktop-only).
- Photos can't attach to a specific history entry yet - schema supports it
  (`event_id` column) but no UI exposes an event picker.
- No photo thumbnail on species/genetics tiles - only item pages,
  equipment rows, and Gallery show images.
- Harvest event <-> lot links are matched by text in one older code path
  (`deleteHarvest`), for entries created before the `lot_id` column
  existed. New harvests are properly linked.
- Logging a harvest always sets item status to `fruiting` - fine live,
  needs a manual status fix after back-filling history on a retired item.

## Backlog (not started, not scoped)

- **Global search** across items/lots/library. Tractable client-side since
  everything's already loaded into state on login, no pagination.
- **Species-scoped photo collage** — a non-grid gallery view scoped to one
  species' whole lineage (not the flat Gallery it has today).
  *(Search vs. collage - which to build first is still an open decision as
  of 2026-09-04.)*
- **Species-specific background texture** behind the lineage tree canvas,
  hinting at that species' real cap surface. Simple procedural SVG pattern
  is the tractable scope; literal illustrated artwork per species is a
  much bigger, separate project - decide scope before starting.
- **Unused sterile media log** distinct from Stock - track agar
  plates/LC jars made and sitting ready but not yet inoculated into
  anything, tagged to the recipe that made them.
- **Species/strain quick-add templates** (e.g. "Lion's Mane" with sensible
  defaults) instead of the full add-species form - framed around a future
  public version of the app.
- **Raw ingredient inventory**, possibly with brand/product tracking, so
  recipe ingredients become real on-hand records instead of free text -
  and potentially tying a specific brand back to results (contamination
  rate, BE%, yield). Genuinely undecided if this is worth the complexity.
- **Reimagine the logo** — see Visual design above. Its own dedicated
  chat thread, not this one.
- **Bigger, unscoped question:** native app + customer-facing site +
  App Store distribution, subscription-based. Not a feature - this is
  currently one person's data with no user separation at all (see
  "Single-user app" under Rules); a real multi-customer product needs
  actual per-user data isolation. Needs its own dedicated conversation
  before any code gets written toward it.
- Tiered pricing (free/basic vs. paid) - business-model note only, logged
  so it isn't lost, nothing to design.

## Running it

```
npm run dev
```

Needs `.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
(same values as the Vercel project's environment variables).

---

Full history of how each of the above got built, every bug and its root
cause, and decisions that were considered and set aside lives in
`CHANGELOG.md`. Load it only when a task actually needs that context.
