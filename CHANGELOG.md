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

## 2026-09-06 - Stock recipe filter, photo bug fixes

- **Stock form**: the Recipe dropdown now narrows to recipes matching the
  selected Kind's category (agar->Agar media, lc->LC media, grain->Grain
  spawn, bulk/block->Bulk substrate, other->Other) instead of listing
  every recipe in the library. Switching kind clears a picked recipe that
  no longer fits.
- **Photos, two real gaps from the 2026-09-05 usability audit**:
  - `photos.event_id` existed in the schema and `addPhoto()` already took
    an `eventId`, but nothing ever called it with one - dead weight.
    Each History log entry now has its own inline photo attach/view
    (new `EventPhotos` component), so a picture can be tied to the
    specific note it's about instead of dumped into the item's general
    photo strip.
  - Caption and taken-on date were write-once at upload - `Lightbox` only
    had a Delete button. It now supports inline editing of both, backed
    by a new `editPhoto()`.
  - Along the way: Gallery and Tree each had their own hand-rolled copy
    of the lightbox markup instead of using the shared `Lightbox`
    component, so neither would've picked up editing without unifying
    them first. Both now render the shared component (with an `extra`
    slot for their "Open <item>" button), cutting ~50 lines of
    duplicated markup.

## 2026-09-06 - Harvest lots are fully editable

- LotDetail's edit form only let you fix label/form/date - amount_g,
  species_id, and notes were write-once at creation. Amount and species
  are now in the header edit form (shrinking amount below what's already
  been processed out or logged as lost is blocked with an explanation
  rather than going negative), and Notes got a real edit-in-place field
  matching the item Detail page's pattern instead of being permanently
  read-only.

## 2026-09-06 - Genetics lines can be hidden or safely deleted

- Genetics (culture lines) previously had no removal path at all - no
  hidden flag like species have, no delete. Added both:
  - Hide/Unhide, same pattern as species - the safe default, no data
    touched. Hidden lines stay visible in the line strip (dimmed,
    labeled) rather than disappearing.
  - A real Delete, but only offered when the line has zero containers
    under it. `genetics_id` on `items` is `ON DELETE CASCADE`, so
    deleting a line with cultures under it would silently wipe their
    whole history (events, photos, harvests) too - blocked outright
    with an explanation instead.
  - Delete isn't an immediate confirm() - it starts a 5-second
    countdown with an Undo button, and only actually fires if the
    countdown runs out untouched. Leaving the page mid-countdown
    cancels it as well.
- Migration: `genetics.hidden` boolean, default false.

## 2026-09-06 - Forms no longer fail silently on blank fields

Species, Genetics (Tree's edit-line and add-line forms), Tree's
edit-species form, Supplier, Equipment, Reference/Recipe, and the
Inventory add-lot form all just no-op'd on Save when a required field
was empty - clicking Save looked like a broken button. Each now alerts
with what's actually missing instead of doing nothing.

## 2026-09-06 - Calculators no longer leak personal dev data

- DryYield's species list was a hardcoded object disconnected from the
  real `species` table, and its copy referenced "your own measured
  figure" / "your notes" as if every user already had Matt's specific
  data. Moved dry-yield % onto `species.dry_yield_pct` (new column,
  editable from the Species edit form like the other cultivation
  facts) - the calculator now pulls the real species list and shows a
  species' own logged figure when there is one, falling back to a
  clearly-labeled general 10% average instead of a fabricated
  species-specific number when there isn't. Kept Blue Oyster's real
  8.9% (genuinely measured data) as the only pre-populated value;
  left every other species blank rather than carrying forward
  unsourced "typical" numbers as if they were now verified.
- Hydration's "1.65 mL/g ... from your notes" line was accurate
  (verified earlier this session against North Spore's published
  Cordyceps jar tek) but phrased at Matt specifically - reworded to
  cite the source instead.
- Migration: `species.dry_yield_pct` numeric, nullable.

## 2026-09-06 - Un-consuming a stock unit no longer leaves a stale "became X" link

- Editing a stock unit's status away from `used` (undoing an accidental
  consume, or just recategorizing it) left `consumed_into_item_id`
  pointing at the item it had been turned into, so the unit could still
  show "became <item>" even after being flipped back to on hand. Now
  clearing the status away from `used` also clears that link.

## 2026-09-06 - Stock's add/edit form now requires real identifying info

- You could save a stock unit with no recipe, no supplier, and no
  product name - a row that only ever displays as its generic kind
  label (e.g. just "Agar plate") with nothing to tell it apart from
  every other unlabeled unit of that kind. Saving now blocks with an
  alert until a made-in-house unit has a recipe picked, or a bought
  unit has a supplier or product name.

## 2026-09-06 - lot_links now editable and deletable

- A mis-entered amount on a process/blend link (`lot_links`) had no fix
  short of deleting the whole derived lot it fed into. Both the "Made
  from" and "Went into" lineage rows on a lot's detail page now have an
  inline edit (pencil -> amount field, capped against what the source
  lot actually has free across its other links) and a Delete for just
  that link - which frees the amount back onto the source lot without
  touching the lot it fed, since that lot's own amount_g was entered
  independently at process time and was never derived from this number.

## 2026-09-06 - Failure/contamination reason no longer wipes on re-edit

- Re-clicking the status chip an item was already at (e.g. to fix a
  typo in the contamination reason, or add more detail) reset the
  reason box to blank instead of starting from what was already
  there - easy to lose the original note. Only a genuine status
  change now starts the box blank; re-clicking the current status
  prefills it.

## 2026-09-06 - Recipe checklist progress now persists

- `StepChecklist`'s checked steps lived only in local component state, so
  progress reset to 0 every time the card collapsed (it unmounts on
  close) or you left the Reference/Recipes tab entirely. Moved the
  checked step indices onto the library row itself instead, so progress
  survives collapsing the card, switching tabs, a reload, or even
  picking the app back up on another device.
- Migration: `library.checklist_checked` jsonb, default `[]`.

## 2026-09-06 - Species can now be really deleted, not just hidden

- Every other entity in the app now has some form of real delete
  (genetics lines got this 2026-09-06); species was still hide-only.
  Added a "Delete species" button to Tree's species toolbar, blocked
  outright when culture lines exist under it (`genetics.species_id` is
  `ON DELETE RESTRICT` - the DB would refuse anyway, but this surfaces
  a clear message instead of a raw FK error) or when any library
  entries are tagged to it (`library.species_id` is `ON DELETE
  CASCADE`, so deleting would silently take those rows with it).
  A species with neither gets the same 5s undo-timer delete already
  used for genetics.

## 2026-09-06 - Search: Equipment/Supplier/Stock hits open the matched row

- Clicking a search hit for equipment, a supplier, or a stock unit just
  switched to the Supplies tab and left you to scroll and find it -
  item/lot/library hits already jumped straight to the record. Added a
  `suppliesOpenId` hint (same one-shot lifecycle as the existing
  `suppliesTab` one) so whichever tab mounts opens straight into
  editing the matched row instead.
- Bonus: the `?stock=<uuid>` QR deep link for a not-yet-consumed unit
  had the same gap (landed on the Stock tab generically) and now uses
  the same mechanism to land on the exact unit.

## 2026-09-06 - Hidden species no longer leak into assignment dropdowns

- Hiding a species didn't actually get it out of the way - it still
  showed up in every picker that assigns a species to something new:
  Inventory's manual-lot form and LotDetail's edit form, Stock's
  species field, and Reference/Recipe's species field (both the
  entry-level one and the per-ingredient one in a capsule blend). Only
  the Reference filter chips and the DryYield calculator (fixed
  earlier today) respected `hidden` before this.
- New shared `visibleSpeciesFor(species, currentId)` filters hidden
  species out of the option list but keeps whatever's already selected
  visible even if it's since been hidden, so opening something already
  tagged to a since-hidden species shows the real saved value instead
  of going blank. Left Gallery's species filter alone on purpose -
  that one's for browsing existing photos, where filtering by a
  species you've since hidden is still exactly what you'd want.
- This was the last item on the 2026-09-05 usability audit list.

## 2026-09-07 - Vessel forms, drawing syringes, and how a culture started

Started as "LC just says liquid culture and that could mean anything,"
and split into three separate axes once the conflation got picked apart.

**Rejected first**: adding `slant` and `syringe` as `items.type` values.
A syringe drawn off a jar is still liquid culture - same material, new
container - and a syringe that wasn't `type='lc'` would have broken every
"inoculate from LC" path in the app. Became `items.form` instead (a
vessel *within* a type), which made `slant` fall out for free as the agar
equivalent rather than needing its own case. Don't re-propose the type
version.

**Also rejected**: modelling syringe volume as real accounting. Matt
loses significant volume harvesting a jar into syringes, so any
decrement/rollup math would be wrong on the first use. `items.amount` is
a recorded note only - hand-edited after a spill or an overdraw - and is
deliberately not wired into `lots`/`lot_links`.

**`drawSyringes` is not a loop over `addChild`, on purpose.** Two real
bugs were designed out rather than debugged: React state hasn't flushed
between successive `addChild` calls, so every syringe in a batch would
have generated the same label; and `reparentItem` looks its new parent up
in `items`, where a just-created syringe doesn't exist yet, so it would
have silently written `parent_id: null`. One function, one state update,
reparenting by uid.

**Mid-tree insertion.** Matt flagged that syringes already used up on
grain exist in the log with no node - the grain hangs straight off the
jar. So drawing has to be able to insert a syringe *between* a jar and
its existing children, not just create leaves. Asked whether a batch
always came off one syringe; answer was "it's gotta be built for nonsense
that I or future users will do," so it's a per-child dropdown (stays on
the jar / moves to syringe N) rather than checkboxes. Already-drawn
syringes are filtered out of that list (a syringe never hangs under a
syringe), and the whole section hides when the jar has no non-syringe
children - it only appears when there's something to actually move.

**`items.method` came from clicking around mid-session**: the lion's mane
agar plate hangs straight off a fruiting block, and nothing recorded
whether it was a clone from a fruit or tissue off the block's mycelium -
two things with very different success rates, previously recoverable only
from free-text notes. Third axis, keyed on the *parent's* type since
that's what determines which methods are possible. Every list ends in
`other` + free text so the vocabulary didn't have to be exhaustive to
ship.

**Contrast bug class, found the same way.** The amber used for the new
method line was invisible - `--amber` on the tan `--ground`. The audit
that followed found four more, and a rule: the palette has two mirrored
halves (`bone`/`dim`/`amber` for dark panels, `ink`/`ink-dim`/`amber-ink`
for the tan ground) and using one in the other's context doesn't look
broken, it looks *absent*. That's how the entire "Filter by species"
control on the Reference screen went unnoticed - Matt had never seen it.
Fixed `.sp-chips-label`, `.sp-chip:hover`, `.sp-chip.on`, `.crumb:hover`,
`.edit-btn:hover`. Rule now written into README's Visual design section.
Also: `.hypha.drawn` has to reset `stroke-linecap` to `butt`, or the
inherited `round` renders each dash as a blob that closes the gaps and
reads as a solid line.

Schema added but with no UI yet, all logged in README: `items.source` /
`items.supplier_id` (made vs bought, backfilled), `stock.amount` /
`stock.amount_unit` (per-unit, NOT recipe `yield_amount` - that's a batch
for agar), `lots.badge_dismissed_at` / `suppliers.badge_dismissed_at`.
The badge went through a full redesign before any code: started as
yellow-incomplete + green-new with a precedence rule, ended as one badge
after Matt pointed out that things you make on purpose don't need
flagging. Briefly added to `items`, then dropped - species-screen
creations are intentional; only side-created records (harvests, quick-added
suppliers) get it.


## 2026-09-10 to 2026-09-22 - backfilled from the Project backlog

Everything below was originally logged as "Done" entries in the claude.ai
Project's `sporedesk-backlog.md` and never made it into this file. Moved
here 2026-09-22 when the Project docs were consolidated, so the history
lives in one place. Entries a few days apart that were logged with dates
after 2026-09-22 were typos and are filed under 2026-09-22.

## 2026-09-11 - Log & outdoor bed reference docs (data only)

Added `Log Cultivation Reference` and `Outdoor Bed Cultivation Reference`
straight to `library` (kind=note, general=true) - species suitability,
prep, inoculation, regional timing, lifespan, troubleshooting, sourced
from Cornell Small Farms/Ohio State Extension/North Spore/Field & Forest.
How logs/beds get *tracked* is still undesigned (see roadmap).

## 2026-09-13 - Stock and item form cleanup

- **Stock weight field** (`7ba139f`): `stock.amount`/`amount_unit` existed
  with no UI. Added an optional Weight pair (same `amt-pair` pattern as
  Items). Add applies one weight across the whole batch; Edit fixes one unit.
- **Weight shown in the species-screen stock pickers** (`34247c6`): "Made
  from on-hand stock" and "Inoculate from this" now show e.g.
  "LC10 · 1360 g". A species-wide weight rollup was considered and dropped.
- **Merged item header facts into Details, dropped "Where"** (`d9e28dc`):
  one edit point (the header pencil, now also covering Substrate/Dry
  substrate), all facts listed together under Details. `items.location`
  column left in place - hiding UI is reversible, dropping a column isn't.
- **Removed Species from Stock** (`a1d7c8b`): stock is uninoculated by
  definition and the pickers never filtered on it. Bought pre-inoculated
  spawn gets a new genetics line instead. `stock.species_id` column kept.
- **Stock edit expands in place** (`d91c62d`): the shared edit form now
  renders inline under the row being edited instead of at the top of the
  tab. Scroll-into-view kept only for search/QR deep links.
- **Kind filter on Stock; Reference chips -> dropdowns** (`3585d00`).
  Category and Species went from multi-select chips to single-select
  dropdowns - a small deliberate capability trade for less clutter. The
  entry form's own tag pickers stayed as chips (they need multi-select).
- **Stock edit form sizing - six passes** (`8497498`, `b3b4972`, `833a515`,
  `6ff4057`, `d8fa3a1`, `d91c62d`). Real root causes: CSS Grid's default
  `align-items:stretch` made every field match the tallest (fixed with
  `align-items:start` on `.nf-grid`), and **`.amt-pair`'s `flex:1 1 150px`
  was written for a row-direction parent (`.head-edit`) - inside a
  column-direction `.nf-field` the same flex-basis means 150px *height*.**
  Flex-basis is axis-relative. Scoped the rule to `.head-edit .amt-pair`.
  These classes are shared by every add/edit form in the app.
- **Species quick-add templates** (`ddc49e7`): 12 species (Blue/Pink/Yellow/
  King Oyster, Lion's Mane, Chestnut, Shiitake, Reishi, Turkey Tail,
  Maitake, Cordyceps militaris, Enoki), one per species not per strain,
  every number from 2+ published grow guides. `dry_yield_pct` left blank
  on purpose: published "yield" numbers are BE (fresh yield / dry
  substrate), but this field is dried weight as % of fresh harvest - a
  different metric. Reishi and Cordyceps have no honest single
  pin-to-harvest number, so that field is blank and explained in notes.

## 2026-09-16 - Stock auto-labels, Data tab leak, Account & Settings v1, Units

- **Stock auto-numbered labels** (`750c30b`): new `STOCK_KIND_TAG`
  (PLT/JAR/GRN/TUB/BLK/CAK/AIO/MSC) deliberately different from genetics'
  codes (SP/AG/LC/GR/BK/FB/NC), so `TUB-MM03` can't be mistaken for
  `BO1-LC3`. New `label_prefix` on `library` and `suppliers`, asked for once
  the first time a recipe/supplier is used. `nextStockLabels()` scans for
  the highest existing number and counts up - no stored counter, same
  self-healing approach as `addChild`. A typed Labels value always wins.
  Bought stock with only a product name (no supplier) stays manual.
- **Data tab hidden-genetics leak** (`9c82adb`): `visibleItems` only checked
  the species' `hidden` flag, so a hidden genetics line still counted in
  every rollup. Added `geneticsFor()` and exclude on either.
- **Account + Settings pages** (overlays, like Detail/PrintLabels). Desktop
  icons pinned at the bottom of the sidebar; mobile puts them in the top
  header to keep the tab bar clear. New `profiles` table (display name,
  avatar preset/url, visibility, default_section, units_pref, date_format),
  RLS own-row only, auto-created by a trigger on signup. The security
  advisor flagged the trigger function as a callable public RPC - revoked
  execute from anon/authenticated. Real: display name, avatar (6 procedural
  presets + upload to `photos/avatars/`), password change, default landing
  tab. Placeholders: Visibility, Shared references, AI connector,
  Notifications, ToS/Privacy links. Delete account and Erase all content
  have real type-to-confirm UI but inert actions (see roadmap). Version
  bumped `0.0.0` -> `0.1.0`.
- **Units Metric/Imperial/Adaptive** (`ad959d9`): reuses Calculators'
  `MASS`/`VOLUME` tables (+`qt`). `normalizeUnit`/`displayAmount`/
  `fmtAmount` with a tolerant alias map for real historical drift (`LBS`,
  `cc`, `mL`, the literal `;bs` typo) - unrecognized units display
  unconverted rather than guessed. New `UnitSelect` dropdown replaces free
  text in Stock, Item header, and Draw Syringes (default `cc` -> `mL`).
  Adaptive = "show exactly as recorded"; the originally brainstormed
  per-field last-used-unit memory was skipped as unneeded complexity.
- **Units follow-up** (`dd969ee`): species cheat-sheet temps get a `(°C)`
  appended under Metric via regex (`displayTempText()`), stored text
  untouched - tested against every real row first. Known quirk: Wood Ear's
  colonize_temp already had a manual "(30C)" so it shows twice. Also fixed
  the Recipe batch-size input ignoring the Units setting (new
  `convertUnits()`, converts back to native unit before scaling). Grams-only
  columns (`dry_substrate_g`, lot amounts) intentionally left alone.
- **Cheat-sheet cards editable from Library** (`6b620ad`): same field set
  and same `saveSpeciesFields` as Tree's Edit species - no duplicate logic.

## 2026-09-17 - Nav 8 -> 5, tab renames, search dropdown, multi-tenancy

- **Nav rebalance** (`30e6a11`): one shared `NAV` array drives both the
  desktop sidebar and mobile bar, so simplifying one simplified both.
  Gallery removed entirely (checked first: all 49 photos were tagged to an
  item or equipment, nothing orphaned). Calculators folded into Reference
  as a Library/Calculators toggle (`embedded` prop). Search moved out of
  the nav into a persistent live-dropdown `SearchBox` (sidebar on desktop,
  second header row on mobile), same match logic and destinations.
- **Renames** (`287ff28`): Cultures -> Cultivation, Inventory -> Harvests
  (first considered and rejected 2026-08-31), Reference -> Library (the
  page h1 already said Library). Only Harvests got a new icon (basket).
  Internal section keys unchanged, so `profiles.default_section` and every
  `setSection()` still work.
- **Search dropdown fixes** (`e7bc542`, `892dee6`, `35bc9cb`, `4947ead`):
  fixed 380px flyout instead of inheriting the 186px sidebar width; set
  `color:var(--bone)` on the dropdown (`.lib-title` inherits color and was
  picking up the light-page default on a dark panel); all five search
  handlers now close Account/Settings first (those overlays render ahead of
  `section`); `onOpenItem` now points `nav` at the item's species first -
  a stale `nav.speciesId` left Detail with an item list missing the target
  and crashed the render (same bug fixed on Supplies' item-open handler).
  Groups capped at 5 with "Show N more" (reset via render-time state
  adjustment, since setState in an effect trips
  `react-hooks/set-state-in-effect`). Themed scrollbar. Mobile touch-scroll
  hardening: `touch-action:pan-y`, `overscroll-behavior:contain`, `70dvh`,
  `-webkit-overflow-scrolling:touch` - not verified on a real device then.
- **Multi-tenancy + beta-code sign-up** (`ad98d1d`, live same day): no table
  had an owner column and RLS only checked "is someone logged in." Added
  `user_id` + owner-scoped RLS (`user_id = auth.uid()`, qual and
  with_check) to species, genetics, items, item_events, lots, lot_links,
  library, library_species, equipment, suppliers, photos, stock, plus the
  `photos` Storage bucket. Backfilled to Matt's account. Database branching
  needs a paid plan, so it went straight to production via nullable column
  -> backfill -> verify -> NOT NULL -> policy swap -> re-verify. Sign-up:
  one shared code in `app_config`, `check_beta_code()` RPC for the friendly
  error, `enforce_beta_code()` BEFORE INSERT trigger on `auth.users` as
  the backstop (fires before the profiles trigger, so no orphan rows). If
  the trigger is what rejects, Supabase shows a generic error instead of
  "Invalid beta code." **Gotcha found 2026-09-22:** the trigger only raises
  when the stored code is NOT NULL - blanking/deleting the code opens
  sign-ups. Close enrollment by rotating to a random string.

## 2026-09-18 - Sign-up hardening, isolation test, Data tab outcome rules

- **Password rules** (`2c2fc03`): confirm-password field; 8 chars + number
  + special char enforced client-side before `signUp()` (sign-in minLength
  left at 6 so Matt's older password still works); in-house
  weak/fair/good/strong meter, no zxcvbn dependency.
- **"Email not confirmed" after sign-up** (`5da68cf`): the project had
  Confirm-email ON at Supabase's default all along - the code comment
  claiming no verification was wrong. Sign-up now shows a "check your
  email" screen when `signUp()` returns no session, and passes
  `emailRedirectTo: window.location.origin` so the link target is
  deterministic; supabase-js picks up the session from the URL. Only works
  if the app URL is in Auth > URL Configuration > Redirect URLs - add
  sporedesk.com / app.sporedesk.com there when the domain moves.
- **Forgot password** (`38a25a1`): `resetPasswordForEmail()`, doesn't
  reveal whether the email exists. The `PASSWORD_RECOVERY` event forces a
  set-new-password screen - otherwise the recovery session drops the user
  straight into the app without ever setting one.
- **Sign out** (`3cd9a18`): there was none - testing had all been in
  incognito. Card on the Account page; AuthGate's listener does the rest.
- **Real second-account isolation test**: live account created through the
  real sign-up flow, a throwaway row in every owned table, confirmed
  invisible from Matt's account and scoped to the test `user_id` in the DB.
  Every data table uses `ON DELETE RESTRICT` from `auth.users`, so deleting
  a user with real data fails loudly rather than cascading.
- **Leaked-password protection left off** - Pro plan only.
- **Print Labels select all / deselect all** (`b4c9ca9`) with a live
  "N of M selected" count.
- **Data tab outcome rules + Stored status** (`41ae84c`, `5f61f51`): retired
  silently overrode contamination. New `itemOutcome()` is the single source
  of truth: fruiting substrate (monotub/block/cake) succeeds only if it
  logged a flush, fails when terminal with zero flushes; LC is judged by its
  children (any success = success, all failed = fail); grain/agar/spores
  succeed if they inoculated something. New `Stored` status for fridge
  LC/spores - not "colonizing," not forced to resolve. New "In storage, by
  species" section. The failure-reason breakdown now scans log history
  instead of the live `failureReason` column, which blanked on any later
  status change. Cake added to `FRUITS` (Matt: "the cake is just the
  substrate of the cordyceps world"), which also gave cake real flush UI.
- **Hosting cost first pass**: 13 MB DB, 128 MB photos, 105 items on one
  user; photo storage is the first free-tier limit likely to bite.

## 2026-09-20 - Recipe library overhaul (data only)

- Grain bags resized to Matt's real 1.5lb practice: Rye 410g, Millet 340g,
  Milo/Sorghum 400g dry -> ~680g finished. Rye/Millet blend reframed as two
  1.5lb bags. New Rye/Millet/Sorghum blend (300g each), flagged untested.
  Whole Oats / Whole White Millet (jar/NSNS) untouched.
- Every recipe reformatted to "What it is / Best for / Watch-outs".
- Accuracy fixes: "LME" -> DME everywhere (measured in grams, it's the
  powder); Vermiculite and Coir Casing Layer's body and steps described two
  different methods at two scales - rewritten as one equal-parts recipe;
  two title/ingredient typos. Library at 40 rows.

## 2026-09-22 - Print queue, lot labels, stock grouping, date format, wheel zoom

- **Batch print queue** (`74c258d`, `5ada522`, `2efbb15`): "+ Queue" next to
  Print on Detail, Tree, and Stock batches adds to an in-memory
  `printQueue` (items + stock, deduped). Printer badge with a live count
  next to Search, hidden when empty, opens a queue print screen. Printing
  clears only what was checked and printed, so unchecked rows survive a
  partial run. Desktop-only, same as all printing. Follow-ups: the extra
  button made `.stock-batch-head`'s `space-between` spread three children
  and push Print to the middle - Print+Queue now always sit in one
  `.pl-icon-row` wrapper. Both became 28px icon-only buttons; the Queue
  icon is the Print icon with a "+" badge, both in `--bone` on `--panel2`
  (a transparent background with a `--dim` icon was nearly invisible on
  tan).
- **Harvest/lot labels** (`c4d8f88`): Print/Queue on `LotCard` and
  `LotDetail`, new `?lot=<uuid>` deep link, third `lot` kind in the queue.
  `LotCard` changed from `<button>` to `<div role="button" tabIndex={0}>`
  to avoid button-in-button; the icons call `stopPropagation()`. Lot labels
  lead with remaining weight (`lotRemaining()`/`fmtG`) so it survives
  ellipsis truncation (`6f12efd`).
- **Print screen help text unreadable** (`0598e37`): `--dim` on the tan page.
  All four `.nf-help` spans in `.pl-controls` got the existing
  `nf-help-page` modifier. Same palette rule as the contrast-bug entry
  above: dark-panel colors vanish on tan and vice versa.
- **Stock grouped by product, not by date** (`fdc10d4`): `stockBatchKey`
  baked the made-on date into identity, so Master Mix sessions on different
  days split apart. New `stockProductKey` (same fields minus date) groups
  them under one product header inside each kind; each dated session still
  renders underneath with its own Print/Queue.
- **Tree wheel-zoom also scrolled the page** (`9caa6fb`): React's `onWheel`
  is attached as a *passive* listener, so `preventDefault()` inside it is
  silently ignored. Now a native `addEventListener('wheel', ...,
  { passive: false })` in a `useEffect`, with cleanup.
- **Date format setting actually applied** (`befd1de`): every date goes
  through `fmt()` (10 call sites, the only `toLocaleDateString`). A
  module-level variable was rejected - ESLint's `react-hooks/globals`
  flags mutating it during render, and syncing via an effect leaves a stale
  render. `dateFormat` is computed once in `App()` and threaded as a prop,
  same pattern as `unitsPref`. Dates now render numeric with year.
- **Refresh keeps the current page** (`44b1f40`): the mount effect always
  re-applied `profile.default_section`, and nothing tracked what was open.
  `section`/`nav`/`open`/`openLot` now round-trip through sessionStorage
  (one write-back effect, restored via lazy `useState` initializers so the
  first render is already right). Session-scoped on purpose: a new tab
  still lands on the default tab. Deep links and the logo still win. The
  print queue still clears on refresh, per Matt - it's for one sitting.
- **Print icons reappearing on mobile** (`c5792b6`): the icon redesign added
  an unconditional `.pl-icon-btn{display:inline-flex}` later in the
  stylesheet, which beat the mobile hide rule on source order at equal
  specificity. Hide rule now uses compound `.pl-icon-btn.pl-trigger` /
  `.pl-icon-btn.pl-queue` (0-2-0) so appending CSS can't undo it.
- Project docs consolidated 2026-09-22: README.md is mirrored as
  `claude/sporedesk-app-context.md`; open work lives in
  `claude/sporedesk-roadmap.md`; this file holds the history.
