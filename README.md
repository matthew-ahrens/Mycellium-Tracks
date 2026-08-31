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

- **Reimagine the logo.** Current glyph/wordmark/badge assets are a
  placeholder set for the prototype - Matt wants a real design pass on the
  logo itself at some point. Not scoped yet (new artwork vs. refining the
  current mark, whether the mycelium-burst glyph concept stays). Once new
  art exists, swapping it in is small - see "Logo + branding" above for
  every spot it touches. **Matt plans to run this as its own dedicated
  chat thread, separate from this one, to keep it focused and use every
  bit of relevant context.** See `claude/sporedesk-logo-design-brief.md`
  in the Gourmet Mushrooms Project - a curated brief pulling together
  current assets/colors/font, the app's overall look, and the
  mobile-first marketability signal from Jordan above, specifically so
  that thread doesn't have to re-derive it from this whole README.

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

## Logo + branding - done (2026-08-31)

All four logo assets are wired in - **note these are placeholder art for
the prototype, not a final brand identity.** Matt wants to revisit/redesign
the actual logo itself later; the plumbing below (favicon, sidebar spot,
loading screens, font) stays regardless of what the artwork ends up being,
since it's just asset swaps once new files exist. Files live in `public/`:
`sporedesk-glyph.png` (bare amber glyph, transparent), `sporedesk-favicon.png`
(glyph on dark square, used as the favicon), `sporedesk-wordmark.png`
(text wordmark - only usable on light backgrounds, see below), and
`sporedesk-badge.png` (circular seal: glyph + wordmark + tagline).

- Favicon: `index.html` now points at `sporedesk-favicon.png`.
- Font: pulled in Google's "Libre Caslon Display" (closest real match to
  the wordmark's bracketed old-style serif) via a link in `index.html`,
  swapped into `--serif` and `AuthGate.jsx`'s `.auth-brand` - old fonts
  kept as fallbacks.
- `AuthGate.jsx` pre-login loading (`session === undefined`): was a bare
  colored div, now shows the wordmark image with a gentle pulse animation.
  Only works here because this screen sits on the light tan background -
  the wordmark's text is dark, so it disappears on dark panels and isn't
  used anywhere else.
- `AuthGate.jsx` sign-in card: circular badge added above the "SporeDesk"
  text, per Matt's call.
- `App.jsx` post-login loading state: "Loading…" text replaced with the
  amber glyph, slow spin + pulse animation.
- Sidebar brand (`App.jsx` `.brand` / `.mobile-brand`): amber glyph icon
  added next to the "SporeDesk" text on both desktop (dark panel) and
  mobile (light header) - same glyph asset works on both.
- Also fixed along the way: a stale `.git/index.lock` from an interrupted
  session that was blocking commits, and a broken local build
  (`npm run build`/`dev` were failing on a missing native rolldown binding
  - fixed with a clean `rm -rf node_modules package-lock.json && npm install`).

Committed (2026-08-31) and pushed.

## Stock tracker - built (2026-08-31)

New `stock` table (10 real tables became 11) plus a fourth tab in Library
(Reference / Stock / Equipment / Suppliers), for sterile-but-uninoculated
stuff: agar plates, LC jars, grain spawn bags, bulk substrate bags/blocks,
AIO bags, other. Two provenance paths per row: `source='made'` links to a
Recipe (`library` row with `kind='recipe'`), `source='bought'` links to a
Supplier plus a free-text product name. Optional species tag (same pattern
as manual lot entry). Quantity with the same +/- stepper Equipment already
has. Status: on_hand / used / contaminated / discarded, set manually.

**The "bring stock in" question got resolved differently than first
scoped.** `items.genetics_id` is required, and stock only has an optional
species tag - not a genetics line - so stock could never replace the
existing genetics-based item creation flow. Instead, stock plugs into it
as an optional step:

- **Tree screen, "Add line" form** (first item for a new genetics
  acquisition): if on-hand stock matches the picked container type, a
  "Made from on-hand stock" dropdown appears.
- **Item detail, "Inoculate from this"** (subsequent items): picking a
  type now shows on-hand matches for that type as a second row of chips -
  pick one, or "Not from stock" for the original one-tap behavior. If
  nothing's on hand for that type, it behaves exactly as before, no
  extra step.

Either way, picking a stock row calls a shared `consumeStock()`: quantity
-1, and auto-flips to `used` if that hits zero. No forward link is stored
from the item back to which stock row made it (would need a many-to-many
shape like `lot_links`, not a single column, since quantity>1 rows get
used up over several separate inoculations) - out of scope for this pass.

Committed (2026-08-31).

## Mobile-first layout pass - built (2026-08-31)

Matt asked to "play with the layout" with an eye toward eventually going
native, while away from the keyboard - so this was done unattended, on
best judgment, and is meant to be reviewed rather than treated as final.
**Assumption made:** "going native" most likely means either wrapping this
same React app in something like Capacitor/Electron later, or at minimum
making it installable as a home-screen PWA - not a from-scratch native
rewrite. Nothing here commits to that path; it's groundwork that's useful
either way and doesn't block a different decision later (see the
"Native desktop app..." note further down, which is still open).

Changes, all CSS/markup-only - no data model or logic touched:

- **Mobile nav is now a fixed bottom tab bar instead of a horizontal
  scrolling strip at the top.** This is the actual native-readiness change
  here - bottom tab bars are the standard mobile-app nav convention
  (thumb reach, all tabs visible at once, no scrolling to find
  Calculators). Icons now show a small label underneath again, since
  there's no scrolling to save space for anymore. Desktop sidebar is
  untouched.
- **Safe-area support** (`env(safe-area-inset-*)`) on the bottom bar, the
  mobile header, and page edges, plus `viewport-fit=cover` in
  `index.html` - so content won't sit under a notch or a home-indicator
  bar if this ever runs inside a native wrapper or full-screen PWA. Inert
  in a normal browser tab.
- **`public/manifest.json` added** (name, theme/background colors, start
  URL, standalone display) plus manifest link, `theme-color` meta, and
  `apple-touch-icon`/`apple-mobile-web-app-*` tags in `index.html` - makes
  "Add to Home Screen" behave like a real app (own icon, no browser
  chrome) on both iOS and Android today, without needing any native
  toolchain. **Using `sporedesk-badge.png` as the manifest icon for now
  since it's the only square-ish asset large enough (300×300) - it's the
  circular badge with the tagline text, which will look cluttered at
  small home-screen sizes. Swap in a proper 512×512 icon (ideally just
  the bare glyph, no text) when the logo redesign happens.**
- Small tap-feel polish: removed the gray tap-highlight flash and the
  ~300ms tap delay on buttons (`touch-action:manipulation`,
  `-webkit-tap-highlight-color:transparent`), `overscroll-behavior-y` set
  so pull-past-the-top doesn't trigger a browser refresh gesture on
  mobile.
- Tab title changed from "mycelium" to "SporeDesk" in `index.html` - was
  still the old working name, everything else has been SporeDesk since
  the logo pass.

Verified: lint clean, `npm run build` succeeds. Not committed to git yet -
left for Matt to review on his phone/desktop before that happens, since
this was unattended layout work and the bottom-bar height/spacing is the
kind of thing that's worth eyeballing on a real device first.

**Still open, not done here:** no decision made on Capacitor vs. Electron
vs. staying a browser/PWA-only app - that's the bigger "Native desktop
app..." question logged further down and still needs its own
conversation. This pass only makes the current web app behave better if
installed as-is; it doesn't set up any native build pipeline.

## Bugfixes since the layout pass (2026-08-31)

- **Mobile bottom nav was covering the whole screen.** The mobile
  override set `bottom:0` but never cleared the `top:0` inherited from
  the desktop sticky-sidebar rule for the same `.side` selector - with
  both set on a `position:fixed` element, the browser stretches it to
  fill the entire viewport height instead of hugging the bottom, so each
  nav icon became its own full-height blank column covering the app.
  Fixed with an explicit `top:auto`. Committed and pushed
  (`34ff03c`) - confirm it looks right on a real phone next.
- **`suppliers.website` column didn't exist.** The Suppliers form has
  always had a website field (input, save, the link on the card), but
  the `suppliers` table in Supabase never actually got that column -
  saving a link failed with a schema-cache 400. Added
  `website text` to the table directly; no code change needed.

## Nav reorganized: Library/Recipes -> Supplies/Reference (2026-08-31)

Matt's read on "something feels off" about the nav, confirmed by
walking the code: **Recipes** was never its own thing - same
`library` table, same component, just filtered to `kind='recipe'` -
but it got its own top-level nav button while its sibling, **Reference**
(the same table, everything else), was buried three clicks deep inside
a screen literally called "Library." And "Library" itself had drifted
into a catch-all holding Reference, Stock, Equipment, and Suppliers -
four things with no shared identity beyond "didn't fit anywhere else."
Meanwhile "stuff I have on hand" was scattered across three unrelated
spots: Inventory (top-level), Stock and Equipment (buried sub-tabs of
"Library").

Regrouped into two nav items that each actually share a noun:

- **Supplies** - Stock, Equipment, Suppliers. "What do I have, or where
  do I get it." New standalone `Supplies` component - each sub-tab was
  already a self-contained component with its own add/edit form, so
  this is just a tab switcher, no shared form state.
- **Reference** - Reference docs + Recipes, now two tabs on one screen
  instead of Recipes being pulled out on its own. New `ReferenceSection`
  component (the old `Library` component, renamed and simplified - the
  old `mode` prop and parent-side entry filtering are gone; it now takes
  the full `library` array and filters internally based on which of its
  own two tabs is active).

Nav order unchanged (still Cultures, Inventory, Gallery, then this pair,
then Calculators) - only the names and what's grouped under them
changed. Verified: lint clean, `npm run build` succeeds. Not committed
yet - same as the layout pass, worth a look on a real device/session
before it's locked in.

**Considered and set aside for now:** renaming "Inventory" (harvested
lots) to something like "Harvests" to stop it sounding like a synonym
for "Stock" (sterile media) now that Stock sits one tab over under
Supplies. Real naming collision, but "Inventory" is used everywhere in
the code and docs already, so it's a bigger, more disruptive change -
logged as optional, not done.

## From today's notes (2026-08-31) - not yet addressed

- **Mobile feedback from Jordan - reframed as a marketability signal, not
  just a bug list.** Matt talked to Jordan about this beyond the original
  look; Jordan's take is that IF this ever goes public/sellable (see the
  native-app/subscription note below), mobile users would be the primary
  target audience, not a secondary platform desktop gets built for first.
  That's a real input for prioritization, not yet acted on - no specific
  mobile bugs from Jordan are logged (none given beyond the general
  steer). Directly relevant to the logo redesign below and to how
  "Not started" items get prioritized generally, since it argues for
  mobile-first rather than mobile-adequate. Some mobile work already
  happened previously (see "Mobile" under Built, above); this is a
  strategic note on top of that, not a report of something broken.
- **On-hand sterile stock tracker - built, see its own section above.**
- **Raw ingredient inventory, possibly with brand/product tracking.**
  Recipes currently use free-text ingredient names (autocomplete only, no
  real ingredient record, no on-hand quantity). Idea: track what raw
  ingredients Matt actually has on hand (grain, gypsum, agar powder,
  vermiculite, etc.), which would mean turning those names into real
  records. Second layer Matt floated: track specific *brand/product* per
  ingredient (e.g. a particular brand of hardwood pellets) so it's
  possible to look back and say "brand X outperformed brand Y" - tying
  ingredient choice back to results (contamination rate, BE%, yield -
  already tracked per genetics/item). Matt is genuinely undecided whether
  this is worth the complexity ("that might be doing too much lol") -
  logged so it isn't lost, not scoped, not started. Connects to the
  sterile-stock idea above (ingredients -> recipes -> made-or-bought
  stock -> cultivation item) but explicitly not committed to doing all of
  it at once.
