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
