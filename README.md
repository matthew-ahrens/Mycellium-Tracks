# SporeDesk (repo: mycelium) - current state

**Start here in a fresh thread.** Current state only, not history. This
file is the single source of truth for current state - reachable in the
SporeDesk claude.ai Project through the connected GitHub repo, no
separate uploaded copy. Open work and decisions: `ROADMAP.md` (same
repo, same sync). History: the repo's
`CHANGELOG.md` (load only when backstory matters). The Supabase DB
(`pbjgelklvlbzarasjcwt`) is always more current than any doc - check it
directly. Code: `E:\Projects\mycelium` - `src/App.jsx` (~7,800 lines,
every screen is a component in it) plus `src/AuthGate.jsx` (auth),
`src/photoProcessing.js` (upload-time resize/metadata strip) and
`src/photoUrls.js` (cached signed URLs).
Updated 2026-09-25.

Lineage and inventory tracker for mushroom cultivation. Live at
app.sporedesk.com (marketing site at sporedesk.com is a separate repo,
`E:\Projects\sporedesk-site`). mycellium-tracks.vercel.app must keep
working - printed QR labels encode it. Same code
ships as the web app, a home-screen PWA, and an Electron Windows app, all
on one Supabase backend.

## Data model

- **Cultures** - tree, one parent per item: `species` -> `genetics` (one per
  acquisition) -> `items` (physical containers), history in `item_events`.
- **Harvests** - merge/split graph: `lots` + `lot_links`. Every harvest
  becomes a wet lot.
- **Library** - `library` (recipes + reference notes, species tags via
  `library_species`, `general` flag), `stock`, `equipment`, `suppliers`.
- **Photos** - private bucket, RLS is `owner = auth.uid()` on
  `storage.objects` (a service-role upload leaves `owner` NULL and
  silently breaks signed URLs - fix by hand via SQL if that ever
  happens again, see `scripts/backfill-photos.mjs`). Every upload is
  three files - thumb (~480px), display (~2048px), original (metadata
  stripped to capture date + orientation) - tracked as `storage_path`/
  `thumb_path`/`display_path` on `photos`. Signed URLs are 7-day,
  cached client-side (`src/photoUrls.js`) instead of re-signed per
  load. Attach to an item, equipment, a history event, or nothing.
- **Account** - `profiles` (display name, avatar, default tab, units, date
  format), `app_config` (beta code), `usage_events` (first-party usage log;
  powers Home's "most visited").
- **Beta applications** - `beta_applications`, written by the marketing
  site's form (insert-only RLS), reviewed in the Supabase dashboard.

Rules:
- New container = new node; same container aging = status change.
- Two purchases from one vendor = two genetics records.
- Lot remaining amounts are derived, never stored.
- Notes live where the fact lives: strain on genetics, container on item,
  species-wide on species.
- Contamination and failure are separate statuses, each needs a reason.
- **Item labels are the client-side id** (string match) - keep them unique
  per genetics line when editing by hand; `addChild` only guards the UI.
- **Multi-tenant**: every user-owned table and the photos bucket has
  `user_id` + `user_id = auth.uid()` RLS (`ad98d1d`). Direct SQL inserts
  must set `user_id` or the rows are invisible. All data tables are
  `ON DELETE RESTRICT` from `auth.users`.
- **`items.amount`/`amount_unit` is a recorded note, never a calculation.**
  Nothing decrements or rolls up; hand-edit it after a spill or overdraw.
  Don't wire it into `lots`/`lot_links`.
- **Item provenance** (`items.source` made/bought + `items.supplier_id`) is
  about the *culture*, not the container: bought agar/AIO/Master's Mix that
  Matt inoculated himself is still `made`. Bought *media* is `stock`'s job.

## Items: type, form, method

- **`type`** is what it is (agar, lc, grain, bulk, block, cake, spores...).
- **`form`** is the vessel *within* a type: `lc` = jar/syringe, `agar` =
  plate/slant. A drawn syringe is still `type='lc'`, so every "inoculate
  from LC" path keeps working. Labels key off form (`FORM_CODE`/`codeFor`),
  so a syringe reads `BO-SY1`. Making these `type` values was tried and
  rejected - see CHANGELOG before re-proposing.
- **Draw syringes** on an LC jar creates N syringe children in one shot.
  **The jar survives** (keeps its status, can be drawn from again; retiring
  is manual). Syringes inherit `colonized` if the jar is, else
  `colonizing`. Can also insert a syringe between the jar and its existing
  children. `drawSyringes` is deliberately not a loop over `addChild` (see
  CHANGELOG). Syringe edges render dotted (`.hypha.drawn`).
- **`method`** is how it was started, stored on the child. Options key off
  the *parent's* type (`METHODS`/`methodsFor`): block/monotub -> fruit
  clone / block tissue; agar -> wedge transfer; lc -> inoculation; grain ->
  grain transfer; spores -> germination; no parent -> purchased / spore
  print. Every list ends in `other` + `method_note`. Syringes get none.

## Screens (nav: Cultivation, Harvests, Supplies, Library, Data)

- **Cultivation** - species grid -> pan/zoom lineage tree (hover lights
  ancestry) -> item detail. Full CRUD, inoculate-from (including from a
  specific stock unit), hide/delete species and genetics (delete blocked if
  anything depends on it, 5s undo), status with required reason (prefilled
  on re-edit), editable history and flushes, live BE%, lineage photo mosaic
  under the tree. Species quick-add templates for 12 common species.
- **Harvests** - lots from harvests, process/merge/split/write-off, lineage
  view with editable `lot_links`, editable amount/species/notes.
- **Supplies** - **Stock**: one row per physical unit (plate/jar/bag), own
  label (auto-numbered `KIND-CODE##` from `STOCK_KIND_TAG` + the recipe's or
  supplier's `label_prefix`), status, weight, link to the item it became
  (`consumed_into_item_id`); grouped by kind -> product -> dated session.
  Made (recipe, filtered by kind) or bought (supplier or product name).
  **Equipment** (category, status, quantity, photo) and **Suppliers**
  (rated, website).
- **Library** - one filterable feed of recipes, reference notes, and
  species cheat-sheet cards (Type/Category/Species dropdowns). Recipes have
  a live batch scaler; procedural notes render as tap-to-check checklists
  saved on the row (`library.steps`/`checklist_checked`). Cheat-sheet cards
  read/edit the species row directly. Calculators live here too (spawn
  ratio, hydration, BE, dry yield from `species.dry_yield_pct` or a labeled
  10% average, unit and grain conversions). Capsule blends have their own
  per-capsule math.
- **Data** - success/fail via `itemOutcome()` (type-aware rules),
  live counts, contamination/failure breakdown from full log history,
  colonization speed, storage by species (`Stored` status).
- **Search** - live dropdown (sidebar/header), client-side over loaded
  state, jumps straight to the matched record.
- **Account / Settings** - overlays. Real: name, avatar, password, sign
  out, default tab, units (Metric/Imperial/Adaptive), date format (all
  dates go through `fmt()`), Terms/Privacy links (open sporedesk.com).
  Placeholders: visibility, shared refs, AI connector, notifications.
  Delete account and Erase all content: UI only, inert.
- **Page state** - section/nav/open item/open lot survive a same-tab
  refresh via sessionStorage; a new tab lands on the default tab. Deep
  links and the logo still win. The print queue clears on refresh on
  purpose.
- **QR labels** - items (`?item=`), stock (`?stock=`, follows through to
  the item once consumed), lots (`?lot=`, leads with remaining weight).
  Avery 5160 3x10 sheets, error correction `Q`, start-at-label,
  cross-screen print queue. **Desktop only** - hidden under 760px (iOS
  ignores print CSS) via compound `.pl-icon-btn.pl-trigger/.pl-queue`
  selectors so later CSS can't un-hide them.

## Auth

Email/password, self-serve sign-up gated by one shared beta code in
`app_config` (`check_beta_code()` pre-check + `enforce_beta_code()` trigger
backstop - **close enrollment by rotating the code, never blanking it**;
the trigger lets everything through when the code is NULL). Email
confirmation ON, forgot-password flow, 8-char+number+special rule.
Sign-up requires a checkbox: 18+ and agrees to the Terms/Privacy Policy
(links to sporedesk.com - the site is the single copy of both).
Confirmation/reset links need the app URL in Supabase Auth > Redirect
URLs. Vercel auto-deploys on push to GitHub.

## Platforms

Mobile: bottom tab bar, safe-area aware, installable PWA. Windows:
Electron (`npm run electron:dev` / `electron:pack` / `electron:build` ->
`release/SporeDesk Setup <version>.exe`), unsigned so SmartScreen warns.
**Only install/build/run from Matt's Windows PC, never a Linux shell** -
shared folder, wrong-OS installs corrupt native deps. Code edits from
either side are fine.

## Visual design

Warm tan page, dark panels, reishi-lacquer accent. Tokens in `App.jsx`
`.root` and `AuthGate.jsx`.

```
page bg:      #B3966B      page text:     #2B2013 (headings), #5E4C36 (dim)
card panel:   #241811      card panel2:   #2F2216      card line: #4A3826
card text:    #EDE3D0      card dim:      #A6927A
amber:        #D6934A      jade (olive):  #7FA66A      slate: #8A7862
reishi (wordmark): #6B2717   reishi (status pill fill): #8C3B26
```

**Two mirrored palettes, not interchangeable:** `bone`/`dim`/`amber` for
anything on a dark panel, `ink`/`ink-dim`/`amber-ink` for anything on the
tan ground. A chip or button with its own `background:var(--panel)` takes
the *dark* half even on the tan page. Amber as a border is fine on either.
Getting it wrong doesn't look broken, it looks invisible. Help text on the
tan page uses `nf-help-page`. Brand serif: Libre Caslon Display.

**Brand assets** (kit added `8b54d1c`, 2026-09-23; sizing pass 2026-09-25).
In-app logos are WebP files resized from the kit's PNGs. Don't reference the
kit's plate or lockup SVGs directly: they embed multi-MB PNGs and filters
(`sporedesk-plate-master.svg` is 8 MB). `public/sporedesk-header-logo-dark.webp`
is the sidebar brand, `-light.webp` the mobile top bar and Home's logo;
`sporedesk-lockup-stacked-dark.webp` is the AuthGate card logo
(signin/confirm/reset/check-email) and the Settings version footer, `-light`
the AuthGate loading screen; `sporedesk-plate-256.webp` the App loading
spinner. Favicons/PWA icons/manifest (`public/favicon*`,
`apple-touch-icon.png`, `icon-192/512/maskable-512.png`, `og-image.png`) and
the Windows build icon (`build/icon.ico`/`.png`) come straight from the kit.
Full kit (app store icons, print, social) lives in `New Branded Material/`
and as `SporeDesk-Brand-Guide.pdf` in the SporeDesk claude.ai Project. Brand serif
Libre Caslon Display; UI mono IBM Plex Mono (Google Fonts). The marketing
site (`sporedesk-site`) uses the same kit.

## Schema with no UI yet

- **`lots.badge_dismissed_at` / `suppliers.badge_dismissed_at`** - one
  "this record has holes" badge, only on records side-created from another
  screen (a harvest logged from Cultivation, a supplier quick-added from a
  picker). Self-clears when filled; the tap is an "I know" override. Not
  on `items` on purpose. Open: which fields count as holes.
- `items.location` (old "Where") and `stock.species_id` - UI removed
  2026-09-13, columns kept.

## Known gaps

- Hover-lit lineage has no touch equivalent.
- No photo thumbnails on species/genetics tiles.
- `deleteHarvest` matches old pre-`lot_id` harvests by text.
- Logging a harvest always sets status to `fruiting` - fix by hand after
  back-filling history on a retired item.

## Running it

`npm run dev` with `.env.local` holding `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` (same as the Vercel env vars). PC only.
