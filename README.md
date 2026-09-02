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

- **"Add a note" input on an item's history occasionally won't accept
  typing** - reported once on an enoki item (EN-BK1, colonizing), resolved
  itself before it could be diagnosed (no console access at the time, item
  data looked normal in Supabase - no malformed log entries found). Not
  reproduced. If it happens again: note the exact item, and whether
  characters appear-then-vanish vs. never appear at all, and whether it's
  the web app or the installed desktop app - that'll actually narrow it
  down instead of guessing blind again.
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

## Native Windows desktop app - scaffolded (2026-08-31)

Matt's ready to try this as an actual installed PC app instead of a
browser tab. Went with **Electron** over Tauri (asked first) - pure
npm/JS, nothing new to install on the PC itself, at the cost of a
bigger install size (~250MB unpacked) since it ships its own Chromium +
Node. Same app, same code, same Supabase backend - this just wraps it
in a native window. The web version at mycellium-tracks.vercel.app is
untouched and keeps working exactly as before; this is additive.

What's new:

- **`electron/main.cjs`** - the whole native shell. One `BrowserWindow`,
  1280x860, loads the Vite dev server in dev or `dist/index.html` once
  built. `.cjs` on purpose so it's plain CommonJS regardless of this
  package's `"type":"module"`. Menu bar auto-hidden (Alt reveals it) -
  this app doesn't need File/Edit/View clutter.
- **`build/icon.ico` + `build/icon.png`** - generated from the existing
  bare glyph asset (not the badge - same reasoning as the PWA icon
  earlier: no tagline text to go illegible at taskbar size). Placeholder
  like every other logo asset right now - swap when the logo redesign
  happens.
- **New npm scripts:**
  - `npm run electron:dev` - starts the Vite dev server and opens it in
    a real window (auto-launches DevTools detached, since this is a dev
    build). Live-reloads same as the browser did.
  - `npm run electron:pack` - builds an **unpacked** app folder
    (`release/win-unpacked/SporeDesk.exe`) - fast, good for a quick "does
    it actually launch" check without waiting on installer packaging.
  - `npm run electron:build` - the real one: builds a proper Windows
    installer (`release/SporeDesk Setup <version>.exe`) via
    electron-builder + NSIS.
  - `"build"` key in `package.json` holds the electron-builder config
    (appId is a placeholder guess - `com.mattahrens.sporedesk` - fine to
    change anytime, doesn't affect anything visible).

**Run this on the actual Windows PC, not from a Claude session** - I
did this scaffolding through a sandboxed Linux VM that has no display
server, so I can't see or launch a real window from here no matter
what. What I *did* verify from there: `electron:pack` (the unpacked
build) completes successfully and produces a real, valid
`SporeDesk.exe` - the config, icon, and packaging pipeline are sound.
The full NSIS installer step additionally wants Wine when cross-built
from Linux, which isn't worth installing just for a sandbox - that step
runs natively with zero issues on real Windows, which is where it needs
to happen anyway. So: first real test is `npm install` then
`npm run electron:dev` in a terminal on the PC itself.

**Known non-issue:** the installer isn't code-signed (no certificate
set up), so Windows SmartScreen will likely flag it as "unknown
publisher" on first run - expected for a personal/unsigned build, not a
bug. Only worth fixing if this ever goes further than Matt's own
machine.

**Confirmed working (2026-08-31):** `npm run electron:dev` opens SporeDesk
in a real native window on Matt's PC. One real snag along the way worth
remembering - the very first `npm install` had been run from the Linux
sandbox this scaffolding was built in, which left Linux-shaped binaries
(a Linux `electron`, not `electron.exe`) sitting in `node_modules` -
`npm install` alone doesn't necessarily clean that up since it mostly
reuses what's already there. Fix was `Remove-Item -Recurse -Force
node_modules` then a fresh `npm install` run **from Windows**. Shouldn't
recur now that node_modules is Windows-native, but worth knowing if
node_modules ever gets touched from a non-Windows shell again.

**Confirmed working (2026-08-31):** `npm run electron:build` also works
on Matt's PC - produces the real `SporeDesk Setup <version>.exe`
installer, not just the dev-mode window. Both halves of the native app
path (dev + installer) are now verified end to end on real Windows,
not just cross-built from the sandbox.

Committed (`9dca493`) and pushed.

### Bugfix: installed app opened to a blank tan screen

Installer ran fine, created shortcuts fine, app launched - but showed
nothing except the plain background color. Cause: Vite emits asset
links as absolute paths (`/assets/index-x.js`), which resolve fine when
served from a real web origin but break under Electron's `file://`
protocol - an absolute path there resolves from the filesystem root,
not next to `index.html`, so the bundled JS/CSS 404s silently and React
never mounts. The tan screen was literally the `BrowserWindow`'s own
native background color (set in `main.cjs`) showing through an
otherwise-empty page. Dev mode never hit this because that loads from
`http://localhost:5173`, a real origin.

Fix: added `base: './'` to `vite.config.js` so asset links are relative
instead. Doesn't affect the Vercel deploy - that's served from the
domain root either way, so relative and absolute paths resolve
identically there.

**Lesson for future sessions: don't run `npm install` or `npm run
build`/`electron:build` for this repo from a Linux sandbox once
node_modules has been set up on Matt's real Windows PC.** Both machines
mount the same physical folder, so a build/install from one side
silently swaps native-binary optional dependencies (electron's binary,
rolldown's native binding, etc.) to the wrong platform's version and
breaks the other side - happened once with electron itself (see
"Confirmed working" above, fixed by a clean Windows-side reinstall) and
again with `vite build`'s rolldown binding while verifying this exact
fix. Once this project has a native-app path, all install/build/run
verification for it needs to happen on Matt's PC directly, not through
this session's Linux shell - code edits (Read/Edit on individual files)
are still fine from either side.

### Bugfix: logos showed as broken/placeholder thumbnails in the installed app

Same bug class as the blank tan screen above, but for a different code
path. The `base: './'` fix only covers assets Vite's bundler rewrites
itself (the JS/CSS it builds via `import`). The logo images were
referenced with hardcoded absolute string paths - `src="/sporedesk-glyph.png"`
etc. directly in JSX, and `href="/sporedesk-favicon.png"` etc. in
`index.html` - which Vite explicitly does not touch. Those still
resolved from the filesystem root under `file://` and 404'd, showing
the browser's broken-image placeholder.

Fix:
- In JSX (`App.jsx` x3, `AuthGate.jsx` x2): changed to
  `` src={`${import.meta.env.BASE_URL}sporedesk-glyph.png`} `` style
  template literals - Vite's documented escape hatch for hardcoded
  `public/` asset paths in code.
- In `index.html` (favicon, apple-touch-icon, manifest link): changed
  to the literal `%BASE_URL%` placeholder token - Vite's documented
  escape hatch for raw attributes in `index.html`, which also aren't
  auto-rewritten.
- Left `public/manifest.json`'s own paths (`start_url`, icon `src`)
  untouched - that file is only consumed by real browsers for PWA
  install (Vercel deploy), never by Electron, and its root-absolute
  paths are correct there.

Verified via `eslint` only (no native bindings, safe from this
session's Linux sandbox). Not verified by an actual build/install from
here - per the rule below, Matt needs to run `npm run electron:build`
on his PC and reinstall to confirm the logos render.

Not committed yet (the `vite.config.js` fix).

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

## Bugfixes and small changes (2026-09-02)

- **Logging/editing/deleting a flush didn't update Inventory until a
  page refresh.** `saveHarvest`, `editHarvest`, and `deleteHarvest` all
  write to the `lots` table in Supabase correctly, but only
  `saveHarvest` updated the local `items` state (for the item's own
  history) - none of the three ever called `setLots`, so the local
  `lots` array (what Inventory actually renders from) silently drifted
  out of sync with the database. Data was never lost, it just didn't
  show up live. Fixed by adding the matching `setLots` call to all
  three, matching the pattern every other lot-mutating function
  (`processLot`, `logLoss`, `saveLotFields`, `addManualLot`,
  `deleteLot`) already used.
- **A lot's "remaining" and "started with" weights were rounded
  differently, making remaining look bigger than the original** (e.g.
  "33.2 g / 33.18 g" on a chestnut lot with nothing taken from it yet).
  `rem` was always rounded to 1 decimal; `lot.amount_g` was shown raw,
  unrounded. Added a shared `fmtG(n, form)` helper - 1 decimal normally,
  2 for `extract`-form lots since that's the one case where a tenth of
  a gram actually matters - and applied it everywhere a lot's weight
  displays (Inventory cards, lot detail, quick-fill buttons, the
  "only Xg remaining" alert, blend/process source amounts). The
  underlying stored numbers were never wrong, this was display-only.
- **"Bulk block" renamed to "Monotub"** in the item type list
  (spores/agar/LC/grain/**Monotub**/Fruiting block). Matt's read on the
  terminology: it isn't a "block" until it colonizes and holds its own
  shape - the loose-substrate-in-a-tub stage is just spawn-to-bulk,
  tracked here as the monotub it's fruiting in. Label-only change, the
  underlying `bulk` key and all existing data are untouched.
- **Logo images fixed for real, second time.** The earlier fix (see
  "Bugfix: logos showed as broken/placeholder thumbnails" above) was
  correct in the source code the whole time - what was actually stale
  was the *installed app*. `npm run electron:build` only produces a new
  installer file in `release/`; it does not update what's already
  installed on the machine. Matt was rebuilding but not re-running the
  new `SporeDesk Setup 0.0.0.exe` each time, so he kept testing the old
  broken install. Verified directly this time by inspecting the built
  `.asar` (`npx asar list release/win-unpacked/resources/app.asar`) -
  the PNGs are present at `dist/sporedesk-*.png` right next to
  `dist/index.html`, and both the HTML and compiled JS reference them
  with the correct relative `./` paths. **Lesson: a fresh `dist/`
  folder is not proof the installed app changed - always confirm the
  new installer was actually run.**
- **Added an F12 dev tools toggle to the packaged Electron app**
  (`electron/main.cjs`, `before-input-event` listener). Dev tools only
  auto-opened in `electron:dev` before this; the installed build had no
  way to see console/network errors at all, which made the logo bug
  above much harder to diagnose than it needed to be. Press F12 in the
  installed app any time something needs debugging.
- **Sidebar background ran out partway down during scroll** (worst on
  trackpad/inertial scrolling). Root cause: `.root` set `overflow-x:hidden`
  without setting `overflow-y`, and per the CSS Overflow spec, setting
  only one axis to a non-`visible` value silently promotes the other
  axis to `auto` too - so `.root` quietly became its own scroll
  container instead of the page itself, which broke the sidebar's
  `position:sticky` + `height:100vh`. Fixed by switching to
  `overflow-x:clip`, which is exempt from that promotion rule, so the
  page scrolls normally again.

## QR label printing - built (2026-09-02)

Print small QR stickers for physical containers (jars, bags, tubs) -
scanning one opens the app straight to that item, on a phone or the
desktop app. Entry points: a "Print label" button on an item's own
detail page (single item, prints as you go), and a "Print labels"
button on a species page (every item under that species, all lines,
for knocking out a backlog in one go). Both open the same picker/print
screen with checkboxes, so either path can add or remove items before
printing.

**How it works:**
- **Real routing, finally.** The blocker noted under "Not started" a
  while back - `/item/BO-GR1` instead of pure React state nav - is
  solved, just via a query param instead of a path: `?item=EN-BK1`.
  Read once on load (`App()`'s data-loading effect) and used to jump
  straight to that item if present. This is read-only for now - the URL
  bar doesn't update as you navigate normally in-app, it only matters
  for a link landing on the page fresh. `APP_URL` falls back to the
  known production URL if the app somehow isn't running from `http(s)`
  (i.e. the installed desktop app's `file://`), so a label printed from
  the desktop app still encodes a link a phone can actually open.
- **QR generation** via the `qrcode` npm package (`QRCode.toString`,
  SVG output, `errorCorrectionLevel: 'Q'` - roughly 25% damage
  tolerance, picked deliberately since these end up on jars and tubs in
  a humid, misted grow space). **Matt needs to run `npm install` on his
  PC before this will build** - added to `package.json` from this
  session, never installed (see the hard rule on `npm install` from a
  Linux sandbox - this had to be added blind, not run here).
- **Print layout targets standard 3-across x 10-down address labels**
  (Avery 5160 and its many compatible equivalents - 2.625" x 1" each,
  30 per sheet) - Matt found a pack of these already in his cabinet, so
  this replaced an earlier version built against Avery 22805 (a square
  1.5" label, never actually printed against). Unlike 22805, the 5160
  spec is extremely well-documented and cross-checked against multiple
  sources: 0.5" top margin, 0.1875" left margin, 0.125" gap between
  columns, 0" gap between rows (labels touch vertically) - all four
  still exposed as editable fields on the print screen in case this
  specific printer needs a small nudge, but they shouldn't need much.
  Cell layout is QR-left, text-right (id + species name) to fit the
  wide-short label shape, rather than the stacked layout the square
  version used.
- **"Start at label #"** field lets a partially-used sheet resume where
  it left off instead of wasting the labels already used - directly
  from Matt's "wouldn't wanna use a full sheet of stickers for one
  sticker at a time" concern.
- Selecting more items than fit on one sheet (30) automatically spans
  multiple sheets, each its own printed page (`page-break-after`).

**Not done / worth knowing:**
- Never tested against a real printed sheet yet. The 5160 spec is
  well-documented (two independent sources agreed on label size, sheet
  layout, and margins to within a few hundredths of an inch) so it
  should be close, but "should be" isn't "confirmed" - print one test
  page before committing a whole sheet.
- The URL-routing piece only reads on load; it doesn't rewrite the
  address bar as you click around normally. Fine for what QR labels
  need, but if "shareable link to whatever I'm looking at" ever becomes
  a real want, that's the next layer on top of this, not a redo.
