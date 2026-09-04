# Changelog / decision history

Historical record for SporeDesk (Mycelium). `README.md` is the current-state
doc read by default - this file is the backstory: what broke, why, and
what got considered and set aside. Only pull this up when a task actually
needs the history (e.g. "didn't we already try this," "why is it built
this way"). Newest at the bottom.

## 2026-08-30 and earlier

- Visual redesign: cold dark grays -> warm tan/dark-panel reishi-lacquer
  theme (see README "Visual design" for current values). Found and fixed a
  pre-existing bug along the way: Equipment/Suppliers/Lot card pills
  referenced `tone-*` CSS classes that were never defined, rendering
  colorless.
- Notes logged from this period, still open: unused-sterile-media-log idea,
  species/strain quick-add templates, tiered pricing idea, and the big
  "native app + site + subscription" question - all carried forward into
  README's Backlog section, not repeated here.

## 2026-08-31 - Logo + branding

Wired in placeholder glyph/favicon/wordmark/badge assets across favicon,
`AuthGate.jsx` loading/sign-in screens, `App.jsx` loading state and
sidebar brand, plus a Google Font swap (Libre Caslon Display). Along the
way: fixed a stale `.git/index.lock` blocking commits, and a broken local
build from a missing native rolldown binding (fixed via clean
`node_modules` reinstall). Committed and pushed.

## 2026-08-31 - Stock tracker built

New `stock` table + tab in Library for sterile-but-uninoculated inventory.
Two provenance paths (`source='made'` links a Recipe, `source='bought'`
links a Supplier). Plugs into Cultures as an optional "made from on-hand
stock" step rather than replacing the genetics-based item flow (stock only
has an optional species tag, not a genetics line, so it couldn't replace
`items.genetics_id`). `consumeStock()` decrements quantity and
auto-flips to `used` at zero. No forward link stored from item back to the
stock row it came from (would need a many-to-many shape) - out of scope.

## 2026-08-31 - Mobile-first layout pass

Built unattended (Matt away from keyboard), CSS/markup-only. Bottom tab
bar nav replacing the horizontal scroll strip, safe-area insets,
`manifest.json` + meta tags for "Add to Home Screen" PWA behavior, tap-feel
polish (no gray flash/300ms delay), tab title fixed to "SporeDesk". Bug
found right after: mobile bottom nav was covering the whole screen because
the mobile override set `bottom:0` but never cleared the desktop
`top:0` - both set on `position:fixed` stretches to fill the viewport.
Fixed with explicit `top:auto`. Also fixed: `suppliers.website` column was
missing from the DB despite the form always having a website field.

## 2026-08-31 - Nav reorganized

"Recipes" (really just `library` filtered to `kind='recipe'`) had its own
top-level button while its sibling "Reference" was buried three clicks
deep; "Library" had become a catch-all. Regrouped into **Supplies** (Stock,
Equipment, Suppliers) and **Reference** (Reference docs + Recipes as two
tabs). Considered and set aside: renaming "Inventory" to "Harvests" to stop
it reading as a Stock synonym - real naming collision, but too disruptive
given how embedded "Inventory" already is in the code/docs.

## 2026-08-31 - Native Windows desktop app scaffolded

Went with Electron over Tauri (pure npm/JS, no extra install, ~250MB
unpacked). Added `electron/main.cjs`, app icons, and
`electron:dev`/`electron:pack`/`electron:build` npm scripts. Not
code-signed - SmartScreen "unknown publisher" warning is expected.
Confirmed working end-to-end on Matt's real PC (both dev window and the
NSIS installer). Committed (`9dca493`).

Bugs hit and fixed during this rollout:
- **Blank tan screen on launch.** Vite emits absolute asset paths
  (`/assets/...`), which 404 under Electron's `file://` protocol. Fixed
  with `base: './'` in `vite.config.js`.
- **Broken logo thumbnails.** Same root cause, different code path -
  hardcoded `src="/sporedesk-glyph.png"` etc. in JSX and raw paths in
  `index.html` aren't touched by Vite's bundler rewriting. Fixed via
  Vite's `import.meta.env.BASE_URL` (JSX) and `%BASE_URL%` (index.html)
  escape hatches.
- **Cross-platform install corruption.** Both the Linux sandbox and Matt's
  Windows PC mount the same project folder - running `npm install` or any
  build from the Linux side silently swaps native binary deps (electron,
  rolldown) to the wrong platform and breaks the Windows side. Hit twice
  (electron binary, then rolldown). **Rule since:** all
  install/build/run for this repo happens on Matt's PC only; code edits
  (Read/Edit) are fine from either side.

## 2026-09-02 - Bugfixes and small changes

- Logging/editing/deleting a flush updated Supabase's `lots` table
  correctly but not the local `lots` state, so Inventory didn't reflect it
  until a refresh - `saveHarvest`/`editHarvest`/`deleteHarvest` were
  missing the `setLots` call every other lot-mutating function already had.
- A lot's "remaining" vs. "started with" weight used inconsistent
  rounding, making remaining look bigger than the original on an untouched
  lot. Added a shared `fmtG()` helper (1 decimal normally, 2 for
  extract-form lots) applied everywhere a lot weight displays.
- "Bulk block" renamed to "Monotub" in the item type list - label-only,
  underlying `bulk` key untouched.
- Logo images were "fixed" on 08-31 but Matt kept testing an old install -
  `electron:build` only produces a new installer file, it doesn't
  re-install it. Verified the actual `.asar` contents this time to confirm
  the fix was real. **Lesson: a fresh `dist/` folder isn't proof the
  installed app changed - confirm the new installer was actually run.**
  Added an F12 dev-tools toggle to the packaged app so this kind of thing
  is debuggable without a rebuild next time.
- Sidebar background ran out during scroll: `.root` had `overflow-x:hidden`
  with no `overflow-y` set, which per the CSS Overflow spec silently
  promotes the other axis to `auto` too, breaking `position:sticky`.
  Fixed via `overflow-x:clip`, which is exempt from that promotion rule.

## 2026-09-02 - QR label printing built

Print/scan-to-item labels via a `?item=<label>` query param read on app
load. QR via the `qrcode` npm package, SVG output, error-correction level
`Q`. Layout targets Avery-5160-style 3x10 address labels (replaced an
earlier version built against a square Avery 22805 label that was never
actually printed against). "Start at label #" field to resume a partial
sheet; selecting more than 30 items spans multiple printed pages. Confirmed
working on a real printed sheet (Canon TS9120), no margin nudging needed.

Fixes since launch:
- QR codes encoded a dead `localhost` link when printed while `npm run
  dev` was running - `APP_URL`'s fallback only excluded `file://`, not
  `localhost`/LAN addresses. Fixed with a proper public-hostname check.
- Start date added as a third line on the label.
- Print screen got "stuck" when navigating away via the sidebar - it was
  an override with priority over normal nav state that nothing cleared.
  Sidebar buttons now clear it.
- Mobile printing (iPhone/Safari) sent the QR off the label edge and
  printed a spurious blank second page. Root cause: iOS Safari doesn't
  reliably honor a webpage's `@page` CSS on print - confirmed via
  research, not something fixable from this page's CSS. A real fix would
  mean generating an actual PDF (iOS honors a PDF's page box correctly);
  decided not worth building since desktop/native printing is already
  dead-on accurate. Print-label buttons hidden on mobile (<760px) instead.

## 2026-09-03/04 - Elephant Gate crash + prevention

Elephant Gate (species) crashed both web and native app on open -
`RangeError: Maximum call stack size exceeded` in the tree-layout code.
Root cause chain: an old item's `type` field ("spores") didn't match its
label prefix ("LC1"), so `addChild`'s label generator - which counted
existing items by `type` to pick the next number - undercounted and
produced a colliding label ("EG-LC1") for a genuinely new item. Two items
sharing a label created a parent/child cycle, and both `layout()` and
`Detail`'s `descendants` walk recursed infinitely over it.

Fixed at three levels:
1. **Data:** renamed the actual duplicate (the older item, which was really
   spores) to a correct, non-colliding label.
2. **Prevention:** `addChild` now checks real label uniqueness in a loop
   instead of trusting a type-based count.
3. **Defense in depth:** added cycle guards (a `seen` Set) to both
   `layout()`'s walk and `Detail`'s `descendants` walk, so a duplicate
   label can never cause an infinite loop again even if one slips through.

## 2026-09-03 - Recipe library data cleanup

Direct Supabase edits, no code change. Added a new "Supplemented Hardwood
Substrate (80/20 Oak + Bran)" recipe from Matt's own guide PDF. Properly
structured the existing "Masters Mix" recipe (category + ingredient rows +
yield, previously incomplete). Confirmed the existing manure-based recipe
("The Nutrient Booster") already had correct category/ingredients/yield -
no action needed there.

## 2026-09-04 - Doc resync + README split

`claude/sporedesk-app-context.md` (the claude.ai Project doc) had drifted
multiple sessions behind this README - resynced to match. Then split this
README itself: moved all the above history/root-cause narrative here, into
`CHANGELOG.md`, and trimmed README.md down to current-state-only. Reason:
the full narrative version was ~40KB and got read into context on most
tasks, which is expensive for information that's only occasionally
relevant.

## 2026-09-04 - Search and the lineage photo collage built

Both items that had been sitting in the backlog since 2026-09-03. Global
**Search** - straightforward, client-side, one pass since everything's
already in state (see the Built section for what it covers).

The **species photo collage** took two passes. First built as column
masonry (same-width columns, height varies with each photo's own aspect
ratio, no cropping) - confirmed against a side-by-side mockup that this
still reads as gridded with similar-shaped phone photos, since width
never varies. Rebuilt as a real mosaic grid: tiles span different row/
column counts on a dense-packed CSS grid, sized by a deterministic hash
of the photo's id (weighted toward small, so a handful of bigger tiles
stand out) so a given photo's size stays stable across reloads instead of
reshuffling. Trades natural aspect ratio for cropping - same tradeoff
every other photo tile in the app already makes.

## 2026-09-04 - Stock tracked as individually numbered units

Matt wanted to track specific agar plates/LC jars/etc. through their
lifetime - which exact plate came from which batch, and which culture it
became - not just an aggregate "6 on hand" count. Every `stock` row is
now one physical unit instead of an aggregate quantity: its own optional
label (e.g. "LC10"), its own status (on hand/used/contaminated/
discarded), and once consumed, a direct link to which item it became via
`consumed_into_item_id` - a column that was already sitting in the table,
unused, seemingly anticipating exactly this. "Add stock" still logs a
whole batch at once (how many, from what recipe/supplier, when); batches
are grouped for display purely by shared metadata (`stockBatchKey`), no
stored batch id. `consumeStock()` simplified from a decrement-and-maybe-
flip-to-used into a direct status flip + item link, since there's no
longer a shared count to manage.

The "made from on-hand stock" pickers (Tree's Add line form, Detail's
Inoculate from this) now list individual on-hand units by their own
label, so picking one selects the exact physical container.

While in there, Matt asked a follow-up that turned into the same build:
if a QR label gets printed for a stock unit while it's still just stock,
could the same sticker keep working once that unit becomes a culture?
Answer was yes, and not hard - `PrintLabels` was generalized to print
either items (`?item=<label>`) or stock units (`?stock=<id>`), and a new
`?stock=` deep link resolves through `consumed_into_item_id`: while a
unit is on hand it opens Supplies/Stock, and once consumed it follows
straight through to the resulting item. Print once, no reprint needed
when the jar graduates into the lineage tree.

Migration: added `stock.label` (text, nullable). Backfilled the one
existing aggregate stock row (4x LC media, on hand, notes said
"LC09-LC13" - one already used elsewhere before this session, hence 4 not
5) into four individually labeled units matching what's physically
written on the jars: LC10, LC11, LC12, LC13.

## 2026-09-04 - Recipes made default, Reference tab made interactive

Recipes flipped to the default/first Supplies-Reference sub-tab (was
Reference) - Matt uses it noticeably more day to day.

Reference itself was "just a book" - a flat list of collapsible text
blocks. Rebuilt around three things, plus a Masters Mix recipe that
turned out to be missing from Recipes despite a similar note already
existing under Reference:

- **Species cheat sheet.** Added four columns to `species`
  (`colonize_temp`, `colonize_time`, `pin_to_harvest`, `substrate_note`)
  alongside the existing `fruiting_temp`/`humidity`/`fae`/`notes`, editable
  from the same Species edit form already in Cultures. Populated for all
  eight active gourmet species from a species-reference doc Matt had in
  the project, cross-checked against real grow guides rather than
  transcribed blind - the doc's Cordyceps colonize range (68-77F) turned
  out to conflict with Matt's own already-correct species note (65F
  ideal, hard 68-69F ceiling, Calcarisporium cordycipiticola risk above
  that) and with the North Spore/Padilla-Brown tek it's actually sourced
  from - used the correct number, not the doc's. Also flagged (not
  silently trusted): shiitake's fruiting temp is strain-dependent enough
  that a single number is misleading - named strains run anywhere from
  ~40-60F to 70-85F.
- **Checklists.** Added a `library.steps` jsonb column (array of step
  strings) and populated it for the procedural notes that benefit most
  mid-production: casing layer guide, cordyceps flat bag tek, dual
  extraction, and the two grain/substrate bag guides. Rendered as
  tap-to-check rows with a progress count; the original full text stays
  available under a collapsed "Full notes" toggle so nothing was thrown
  away.
- **Species filter chips** narrow both the cheat sheet and the how-to
  list to one species.

`renderLibCard` had been a plain closure called during render
(`entries.map((e) => renderLibCard(e))`), which meant it couldn't hold
its own hook state - converted to a real `LibCard` component so each
checklist gets independent per-card state.

Also revisited the Classic CVG bulk substrate "Good for" note added
2026-09-03 after Matt pushed back - his own research kept turning up
Agaricus/dung-lovers and psilocybin as CVG's real fit, not Lion's Mane.
Checked five independent grow guides instead of the one (North Spore's
own CVG product blog) the original note leaned on: verdict is genuinely
split in the community for wood-lovers, but dung-loving/Agaricus is the
one thing every source agrees on - and that's not a species Matt
currently grows. Rewrote the note honestly: Blue Oyster is the
defensible use for the CVG already on hand, Lion's Mane/Reishi/Chestnut/
Shiitake are better off on a hardwood-based recipe (Masters Mix or
Supplemented Hardwood), and there may not be a great home for 10lbs of
CVG in the current species lineup at all.
