# Mycelium (SporeDesk)

**Start here (fresh session / Claude Code):** this file is the source of
truth for everything decided so far - read this whole file before touching
code. The actual app is `src/App.jsx` (one big file, ~3200 lines - every
screen is a component in there) plus `src/AuthGate.jsx` (login). Supabase
project id `pbjgelklvlbzarasjcwt` holds the schema; check it directly
rather than assuming from this file, since the DB is always more current
than any doc. Everything below is real and current as of 2026-08-30 unless
marked otherwise.

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
items, inoculate-from. Species can be hidden from the main grid (a small
button on each tile, plus a "Show hidden (n)" reveal toggle) - useful for
species you're not actively running without deleting the history. Status
includes contamination/failure with required
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
Recipes (structured ingredient rows — amount/unit/name, not free text —
with a live batch-size scaler right on the card: type a target or tap a
×2/×3/×5 chip and every ingredient recomputes in place. Ingredient names
autocomplete from ones already used elsewhere, via a native datalist).
Recipe library also covers agar media, LC media, grain spawn, bulk
substrate, casing mixes, and nutrient broth — populated with real recipes,
not just the original handful.

**Capsule blends** — a distinct recipe category with its own math, since
a capsule's per-dose amount is fixed regardless of batch size (unlike
lab media, which scales linearly). Each ingredient is a species picked
from the real species list plus a dose in mg/capsule, not free text.
Batch size is capsule count, with an optional spillage buffer %. The
open card shows total mg/capsule against a 500mg 00-capsule reference,
and a live table of how much of each species to actually weigh out for
N capsules. Switching a recipe's category to/from "Capsule blend" clears
ingredient rows, since the two shapes ({amount,unit,name} vs
{species_id,mg}) aren't compatible with each other.

**Photos** — upload from item pages, equipment, or standalone via Gallery.
Species filter in Gallery. Native camera-or-library chooser (no forced
camera jump). Signed URLs, 6hr expiry, private bucket.

**Calculators** — spawn ratio (either direction), hydration, BE, dry yield
estimate, unit converter, grain weight<->volume (flagged approximate).

**Auth + security** — email/password sign-in, no self-serve sign-up. RLS on
all 10 tables and the storage bucket. Deployed on Vercel, connected to
GitHub for auto-deploy on push.

**Mobile** — works end to end on phone (tested on iPhone/Chrome). Sidebar
collapses to a horizontal icon strip with its own brand header. Fixed:
tab-row wrap, header-bar wrap, equipment row text truncation (was pushing
the status pill off-screen), global overflow-x safety net.

## Visual redesign — applied

Was cold dark grays; is now warm tan/dark-panel with a reishi-lacquer signature
accent. Live in `App.jsx`'s `.root` CSS variables and `AuthGate.jsx`. Values:

```
page bg:      #B3966B      page text:     #2B2013 (headings), #5E4C36 (dim)
card panel:   #241811      card panel2:   #2F2216      card line: #4A3826
card text:    #EDE3D0      card dim:      #A6927A
amber:        #D6934A      jade (olive):  #7FA66A      slate: #8A7862
reishi (wordmark): #6B2717   reishi (status pill fill): #8C3B26
```

Status pills fixed to solid-fill (were outlined text, unreadable once the
page stopped being near-black). Along the way, found and fixed a real
pre-existing bug unrelated to the redesign: Equipment, Suppliers, and Lot
card pills referenced `tone-*` CSS classes that had never actually been
defined anywhere — those pills were rendering colorless. Now defined
(`.tone-amber` / `.tone-jade` / `.tone-clay` / `.tone-rust` / `.tone-slate`).

## Big design ideas — logged, not scoped

- **Species-specific background texture behind the lineage tree canvas** -
  a subtle pattern hinting at that species' actual cap, sitting low-opacity
  behind the tree so each species' page has a distinct visual signature.
  Chestnut's scaly cap, lion's mane's icicle spines, reishi's concentric
  zonation, oyster staying a plain smooth field. Two very different scopes
  depending on how literal:
  - **Tractable**: simple procedural/generative SVG patterns per species,
    keyed to one or two characteristics (dot scatter, vertical lines,
    concentric rings) rather than literal imagery. Real but bounded -
    roughly an evening of pattern work.
  - **Full version**: actual illustrated or generated cap-surface artwork
    per species, plus getting it to sit correctly behind a pan/zoomable
    canvas without becoming noise or a performance problem. A genuinely
    different, much larger project - closer to commissioning real art
    nine times over than a styling pass.
  Worth deciding which scope before starting, rather than drifting from
  "simple pattern" into "full illustration" mid-build.

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

## From today's notes (2026-08-30) - not yet addressed

- **Unused sterile media log.** Somewhere to track agar plates / LC jars
  that are made and sitting ready, but not yet inoculated into anything -
  tagged to which recipe made them. Distinct from `items` (which are
  inoculated cultures in the lineage tree) and `lots` (harvested material).
  Real, well-scoped feature, not yet designed.
- **Species/strain templates for fast setup.** A quick-add path for common
  species (e.g. "Lion's Mane" with sensible defaults pre-filled) instead of
  the full add-species form every time. Explicitly framed around a future
  public version of the app, where this would save new growers real time.
- **Tiered pricing idea** (mentioned alongside the templates note): a
  simpler free/basic tier for newer growers, a paid tier unlocking the
  full advanced toolset. Business-model note, not a build task - logged so
  it isn't lost, nothing to design yet.
- **Native desktop app + customer-facing website + eventual App Store
  distribution, subscription-based.** The big one. Not a feature request -
  a question of whether the whole foundation should change. Right now this
  is one person's data with no user separation at all (see "Single-user
  app" under Rules, above); a real multi-customer product needs actual
  per-user data isolation, which is a different database design, not a
  setting to flip. Flagged as needing its own dedicated conversation before
  any code gets written toward it - that conversation hasn't happened yet.

## Running it

```
npm run dev
```

Needs `.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
(same values as the Vercel project's environment variables).

## In progress - interrupted, not finished

- **Logo assets not yet wired in.** Three logo files exist in the Claude
  Project's file panel (claude.ai, not on this PC): `SporeDesk_LogoApp_icon_1.png`
  (transparent background, just the branching-burst glyph - for the
  loading screen and anywhere it needs to sit on the app's own background),
  `SporeDesk_LogoApp_icon_2.png` (same glyph, self-contained dark square
  background - for the favicon, which needs to be complete on its own),
  and `SporeDesk_Logo_words_only.png` (a wordmark in a different serif
  than the in-app one - use with judgment, may not match). **Before the
  next session can wire these in, download all three from the Project
  files panel and drop them into `E:\Projects\mycelium\public\`** - a
  fresh Code session has no access to Claude's project file storage, only
  to this PC. Then: reference the favicon PNG from `index.html`, and use
  the transparent glyph in `AuthGate.jsx` / the loading states in `App.jsx`.
- **Loading screens need real content.** Two spots currently show nothing
  useful: `AuthGate.jsx`'s pre-login session check (`session === undefined`)
  is a bare colored div with no content at all, and `App.jsx`'s post-login
  data-fetch state just shows plain text "Loading…". Matt wants the logo
  plus some light animation in both, not just plain text - not started.
