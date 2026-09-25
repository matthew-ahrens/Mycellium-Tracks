# SporeDesk roadmap

Everything still open for SporeDesk - beta launch work, app backlog,
brainstorms, business questions - plus a one-line index of what's
shipped. Full history of shipped work lives in this repo's
`CHANGELOG.md`, not here. Reachable in the SporeDesk claude.ai Project
through the connected GitHub repo, no separate uploaded copy.

Status: 🔲 not started · 🔧 in progress · ✅ decided/done. Current-state
app description is `README.md`. Shipped work gets one line here; the
full writeup goes in `CHANGELOG.md`. Verify against the code/DB before
building - both move faster than this doc.

## 1. Beta - what's left before launch

The plan: recruit through social posts linking to sporedesk.com (maybe
dedicated SporeDesk profiles), working with FB mushroom-group admins.
Target more than 30 testers. Each gets a full private account, free
through a fixed end date, in exchange for feedback.

- ✅ **Beta start/end dates** - decided 2026-09-25. Cohort 1 opens
  October 26, 2026 at 12pm, capped at 50 testers, 90-day window (runs
  to roughly late January 2027). Cohort 2 tentatively ~30 days later
  (around November 25, 2026), triggered by cohort 1 reaching 30
  testers, capped so total stays at 100 max, same 90-day window (to
  roughly late February 2027). Site copy for cohort 2: date only, no
  cap numbers, phrased conditionally (e.g. "opens the week of
  November 25 - pending tester demand") so a miss on the trigger
  doesn't leave a false date live. A possible cohort 3 exists only as
  a contingency if a real surge hits - not on the site, not committed,
  purely a later marketing call if it happens. Drives the Beta page,
  the "free through" copy, and checkpoints 2-3.
- 🔲 **Social media presence / tester recruitment** - not started as of
  2026-09-25. This is the actual bottleneck for hitting Oct 26, not the
  code - needs profiles built and FB mushroom-group admin outreach
  started essentially immediately to leave enough runway. Cold, no ad
  spend, so expect a trust-building lag before applications come in,
  not an instant response.
- 🔧 **ToS + privacy policy** - drafted and live 2026-09-22 and linked
  from the app (Account page Legal card + a required "18+ and agree"
  checkbox at sign-up, `e358f54`) at sporedesk.com/terms and /privacy
  (source: `sporedesk-site/src/pages/terms.astro`, `privacy.astro`).
  First-person, plain language; Matt as an individual, Tennessee law,
  email-only contact (no home address; revisit with LLC + registered
  agent). Decisions baked in: accounts carry over past beta, manual
  deletion within 30 days via support@, no selling/ads, data released
  only on legal compulsion with notice where allowed, neutral "follow
  your local laws" + "no illegal use" (psilocybin not named), $50
  liability floor. Still open: lawyer review before charging money
  (~$1,000-2,000, see costs); build the marketing-email opt-in before
  sending any marketing email (the policy promises it); usage-analytics
  section still says "may record" until analytics exists; the
  photo-metadata line should be tightened now that location/EXIF is
  actually stripped on upload (was "may record," now a fact - see photo
  fix below).
- 🔧 **Marketing site at sporedesk.com** (scope change 2026-09-22 -
  replaced the old "minimal one-screen landing page"). Built 2026-09-22
  and live at sporedesk.com (also sporedesk-site.vercel.app). Astro,
  repo `E:\Projects\sporedesk-site` / GitHub matthew-ahrens/sporedesk-site
  (private), Vercel project sporedesk-site, auto-deploys on push.
  Cream-led design sharing the app palette. Done: home (hero + 6
  feature cards with app screenshots + closing Join-the-beta section),
  Beta page with application form, full branding (see below).
  Applications go to Supabase `beta_applications` (insert-only RLS,
  unique on `lower(email)`, review via status/review_notes in the
  dashboard); `?ref=<tag>` on any page is carried to the form via
  sessionStorage, so give each post its own tag. Beta dates are
  `COHORT_1_OPENS`/`COHORT_1_OPENS_ISO` constants at the top of `beta.astro`.
  Terms (/terms) and Privacy (/privacy) live 2026-09-22 as
  plain-language drafts (see ToS item). ✅ Cohort 1 date + countdown wired in 2026-09-25
  (`COHORT_1_OPENS`/`COHORT_1_OPENS_ISO` in `beta.astro`, replacing the
  old `BETA_END`/`ENROLL_CLOSES` placeholders; new `Countdown.astro`
  component, Field Notebook styling, no dependencies, counts down to
  the Oct 26 noon-Central open). Cohort 2 mention added the same day,
  phrased conditionally per the plan above (date only, no cap numbers,
  no countdown - just a line noting it may open the week of Nov 25
  depending on demand). Still to do: applicant confirmation email
  (needs Resend), About Me page (new, 2026-09-24 - Matt as a person,
  why he's building this).
  Aside, low-priority: local `node_modules` for `sporedesk-site` can't
  run `npm run build`/`astro check` in a Claude cloud session (missing
  native `rolldown` binding) - doesn't affect Vercel, which builds
  clean. Matt doesn't check builds locally (goes straight to prod), so
  fix later with `rm -rf node_modules package-lock.json && npm install`
  once real users are actually on the site and a local check-before-
  push loop is worth having. v1 pages: feature-showcase home;
  Beta page (how it works, tester commitments, 7/45/90 checkpoints,
  dates); ToS/privacy; sign-up CTA handing off to app.sporedesk.com.
  Copy says "free through [end date]," never "3 months free."
- ✅ **Website branding to match the app** - done 2026-09-24/25
  (`d9fb52f`, `83c0dca`). Kit header logo in the nav, full-color plate
  halo behind the hero phone, plate-anchored closing CTA section, tiny
  mark in the footer, favicon set + apple-touch-icon + Open
  Graph/Twitter card with the kit's og-image, IBM Plex Mono on the
  eyebrow labels. Hero phone screenshot replaced with a fresh branded
  one 2026-09-25 (`3f19c4f`). The 6 feature-card shots are cropped to
  content only (no logo visible), so they don't need re-shooting.
- ✅ **Domains wired** 2026-09-22: sporedesk.com → sporedesk-site,
  www → 308 to apex, app.sporedesk.com → mycellium-tracks, all live with
  SSL. Porkbun DNS: A @ 76.76.21.21, CNAME www/app → cname.vercel-dns.com;
  parking ALIAS/wildcard CNAME and URL forwarding removed; Porkbun
  email-forwarding MX/SPF kept until Zoho.
  https://app.sporedesk.com/** added to Supabase Auth Redirect URLs
  (Matt, 2026-09-22); Site URL left as-is for now.
- ✅ **App moves to app.sporedesk.com** (see above) - Porkbun DNS
  record (free), apex -> marketing project, app -> existing app
  project. mycellium-tracks.vercel.app must keep resolving (printed QR
  labels encode it) - the alias should stay on the project
  automatically, verify after. Add the new URLs to Supabase Auth >
  Redirect URLs or confirmation/reset links break.
- 🔧 **Email.** ✅ Zoho done 2026-09-22: Mail Lite 5 GB, 1 user, $12/yr;
  mailbox support@sporedesk.com; Porkbun DNS now has Zoho MX (mx/mx2/mx3),
  SPF `v=spf1 include:zohomail.com ~all` (Porkbun forwarding MX/SPF
  removed), DKIM zmail._domainkey, DMARC `_dmarc p=none` with rua to
  support@. Tested both directions; Gmail shows SPF/DKIM/DMARC pass.
  ✅ Resend done 2026-09-25: account created (GitHub SSO). Domain added as
  `send.sporedesk.com`, not the apex - keeps Resend's SPF/DKIM off the
  root domain entirely so nothing has to be merged with Zoho's existing
  records. Resend's newer "Forge" DNS shape showed up: SPF via two CNAMEs
  (`rsend.send`/`send.send` -> `*.forge.rmta.net`) instead of a raw
  TXT+MX, plus a DKIM TXT (`resend._domainkey.send`). Added to Porkbun
  manually - the Resend and Porkbun claude.ai connectors were both
  connected, but the Porkbun one kept rejecting valid-looking keys (not a
  balance issue, DNS record writes are free; root cause not found, went
  manual instead of burning more time on it). API key `SupaBase` created
  scoped to sending-only, restricted to this domain (not full access).
  Supabase custom SMTP configured (Auth > Emails, not Project Settings -
  easy to confuse with the Pro-gated Custom Domains feature, which is
  unrelated): host smtp.resend.com, port 465, sender `SporeDesk
  <noreply@send.sporedesk.com>`. Confirmed: Supabase's default-sender
  restriction to org-member addresses applies on every plan as of their
  Sept 2024 policy change - not a rate limit, an outright block on
  external recipients - so custom SMTP was mandatory before enrollment
  opens, not optional. DNS verified and a real password-reset tested clean
  2026-09-25 (Matt) - delivered, correct sender, no spam-folder issue.
  Inbox: Zoho Mail Lite (~$12/yr, support@ as a free alias; beat Porkbun
  $36/yr and Google Workspace ~$84/yr). Kept separate from support@ so a
  signup burst can't get that inbox flagged. Unblocks branded auth emails
  (§3), which now also cover feedback-checkpoint reminders, not just
  confirm/reset (Matt, 2026-09-24).
- 🔲 **Enrollment**: fixed cohort, ~2-week window, then a waitlist
  (waitlist doubles as the hard-launch marketing list). Close it by
  rotating the `app_config` code to a long random string - never NULL,
  deleted, or empty. `enforce_beta_code()` only raises when the stored
  code is NOT NULL, and `check_beta_code` would match an empty input
  against `''`. Optional hardening: make the trigger fail closed on
  NULL.
- ✅ **Photo egress/loading fix** - shipped 2026-09-24 (flagged by Matt
  2026-09-22, was blocking beta - Supabase Storage egress had hit 5.76
  GB against the 5 GB free cap, Fair Use enforcement starts Oct 24).
  Confirmed cause: full 2-4 MB originals loaded into small grid tiles,
  plus signed URLs re-signed on every load defeating the browser cache
  (Storage was 99.7% of egress). Fix: every upload now produces three
  files - thumb (~480px, q0.80, grids/mosaic/strips/equipment), display
  (~2048px, q0.85, the lightbox), and the original (kept, only fetched
  via a "Full size" button in the lightbox - deliberately no
  resize/cleanup control in the main UI). Metadata stripped on every
  upload (camera can't be told apart from library picks) down to just
  capture date + orientation - originals cleaned losslessly by
  stripping JPEG APP segments, not re-encoded; `taken_on` now comes
  from the photo's own EXIF date instead of the upload day. Signed URLs
  are 7-day and cached in localStorage instead of re-signed every load.
  Existing 62 photos + the avatar backfilled via
  `scripts/backfill-photos.mjs` (one-time, PC-only, dry-run by default,
  needs a local `SUPABASE_SECRET_KEY` in `.env.local` - never
  committed); also corrected `taken_on` on 7 photos where a batch
  upload had dated them by upload day instead of capture day.
  Follow-up bug, same day: the backfill's admin-key uploads left the
  new thumb/display/avatar files with `owner = NULL` on
  `storage.objects`, which silently failed every signed-URL request
  under the bucket's `owner = auth.uid()` RLS (mosaic/tree showed empty
  tiles) - fixed by SQL, script now documents the gotcha. Caveat:
  keeping full originals will push past the 1 GB free storage cap once
  the beta cohort is uploading - Pro (100 GB, $25/mo) becomes necessary
  around then, already reflected in the cost table below. Still open:
  tighten the privacy policy's photo-metadata line from "may record" to
  state plainly that location/EXIF is stripped (see ToS item above).
- 🔲 **Support link** in the app from day one (Account page and/or
  sidebar), plus on the site and in the welcome email.
- 🔲 **Feedback form.** Ratings + multiple choice + open text.
  Checkpoint 1 (onboarding) = 7 days after each tester's own
  `auth.users.created_at` - covers sign-up experience, setup
  difficulty, what would make setup easier, plus how-to/support info.
  Checkpoints 2 and 3 = fixed calendar dates, beta day 45 and day 90.
  Hard gate on checkpoint days with 3 "ask again later" snoozes of 6
  hours each, stated plainly on the gate. One-time popup 3 days before
  each checkpoint previewing what's coming. Reminder emails for these
  are now part of the branded-auth-email scope (§3).
- 🔧 **Passive usage analytics** - first-party events table in
  Supabase, no third-party vendor. Partly exists: `usage_events` +
  `logUsage()` already record record-opens (powers Home's "most
  visited"); check what's logged before building the rest. Track:
  section/tab navigation, return frequency, platform
  (PWA/Electron/browser), automatic JS error logging, action completion
  (stock/equipment/supplier/recipe added, culture started, harvest
  logged), form abandonment, create-then-delete within ~30 min (a "read
  their feedback" flag, not a verdict). Not tracked: per-recipe usage,
  click-by-click. Disclose in ToS. Needs: schema + call-site list.
  (Sentry raised 2026-09-25 as an alternative for the error-logging
  piece only - not decided; it's a third party, so weigh against the
  no-vendor stance.)
- ✅ **Tester Data/Stats tab** - correction 2026-09-25: this is built
  and functional in the app today (DataTab + `itemOutcome()`), not an
  open item. Needs a cleanup/polish pass but works - not a beta
  blocker. v1 covers: success/fail hero stat, contamination vs. other
  failure, by source, colonization speed vs. species' `colonize_time`,
  live status board, failure-reason tally, activity heatmap. Held back
  as "not enough data yet" placeholders: yield by species,
  flush/time-to-harvest trends, by-supplier.
- 🔲 **Admin analytics digest** (correctly-scoped version of what was
  mislabeled above until 2026-09-25) - a daily automated email to Matt
  rolling up app performance and feature usage, for his own
  research/product decisions, not customer-facing. Genuinely still
  needed pre-beta - can't retroactively generate clean data once
  testers are already in and using the app. Matt's estimate: ~1-2
  days. Builds on the existing `usage_events` table/`logUsage()` (see
  Passive usage analytics below) - reporting layer is what's missing,
  not data capture.
- 🔲 **Seeded starter content** for new accounts. Library/reference
  seeding waits on Matt's content audit (style + contradiction check -
  the 2026-09-20 reformat may have covered most of it). Equipment/supplier
  starter templates: list not drafted. Needs a copy-at-signup
  mechanism. Overlaps with the "example species" idea in §2.

## 2. Beta - settled context

- Privacy stance: RLS isolates testers from each other; Matt can still
  see data as DB owner - say so plainly. No client-side encryption this
  round.
- Access control: one shared beta code; revoke individuals by banning
  the account in the Supabase dashboard. No in-app admin UI.
- Iterate continuously, no feature freeze; keep a visible "what's new"
  note so checkpoints can test whether fixes helped.
- Leaked-password protection off - Pro plan only. Revisit near hard
  launch.

Costs (checked 2026-09-22, base prices, overages extra, domain renewal
approximate):

| Stage | Monthly | What's in it |
|---|---|---|
| Lean beta | ~$2 (~$24/yr) | Supabase free, Vercel Hobby, Resend free, Zoho, domain |
| Big-cohort beta | ~$47 | + Supabase Pro $25 (photos past the 1 GB free cap), Resend Pro $20 during enrollment |
| Hard launch | ~$67 (~$804/yr) | + Vercel Pro $20/seat (Hobby is non-commercial only); Resend may drop back to free |

One-time legal cost (checked 2026-09-22), not in the monthly numbers
above: plan is Claude drafts ToS + Privacy Policy now, a lawyer reviews
before SporeDesk ever charges money. Flat-fee example (Terms.Law):
$1,000 to review one document, $1,500 for both together, $2,750 for a
full drafted package, $300 for a single written consult (useful for
the psilocybin question). Hourly attorney rates typically run
~$300-400/hr. Budget roughly $1,000-2,000 once, before hard launch.

Baseline 2026-09-18 (one user): 13 MB DB, 128 MB photos. Photo storage
is the first free-tier limit likely to bite - see the photo fix caveat
in §1.

## 3. App backlog - open

- 🔲 **Delete account** - UI exists, action inert. Needs a server-side
  Edge Function (`auth.admin.deleteUser` needs the service-role key)
  and a decision on what happens to the user's rows (all data tables
  are `ON DELETE RESTRICT` from `auth.users`). **Stale comment, found
  2026-09-25**: the card's explanatory text in `App.jsx` still says
  "there's only one account in the whole app right now and no
  self-serve sign-up" as the reason it's inert - no longer true since
  multi-tenant RLS + beta-code sign-up shipped 2026-09-17 (`ad98d1d`).
  Harmless (button's still correctly disabled/inert either way), just
  misleading if read later. Reword next time this file's open - real
  reason is simply that the delete logic itself isn't built yet.
- 🔲 **Erase all content** - UI exists, action inert. Needs Matt's call
  on scope (grow data only, or equipment/suppliers too) and a careful
  tested pass.
- 🔲 **Branded auth + reminder emails** (confirmation, password reset,
  feedback-checkpoint reminders - scope widened 2026-09-24) - unblocked
  2026-09-25, custom SMTP live (§1). Matt's ask 2026-09-25: pretty up all
  the automated emails with real branding and proper wording, not left as
  plain text - a design pass (logo, colors, HTML template), not just a
  copy pass. Confirmation copy drafted: subject "Confirm your SporeDesk
  account," body opens "Thanks for signing up for SporeDesk beta" - but
  that's plain-text/unbranded too, so it still needs the design treatment.
  Reset and reminder copy not drafted at all yet.
- 🔲 **Mobile label printing** - all printing is hidden under 760px
  (iOS Safari ignores `@page`). Options: share-to-print, server-side
  PDF, or steer to desktop.
- 🔲 **Home button** (Matt, 2026-09-24) - right now the only way back
  to Home is tapping the logo; add a dedicated Home button too
  (nav/sidebar or mobile top bar).
- 🔲 **Mobile bottom nav redesign** (Matt, 2026-09-24) - replace the
  fixed bottom tab bar with an expandable "fan" to free up screen
  space. Must keep clear of iOS's own bottom-edge swipe-up gesture
  zone. Needs its own design pass - not just a CSS swap, changes the
  whole mobile nav model (`.side`/`.nav-item` in `App.jsx`).
- 🔲 **Stock naming automation** - Matt wants adding stock "more
  automated," not sure how. Check it's not just the existing
  `label_prefix` auto-numbering first; needs a conversation.
- 🔲 **Label design pass** - prettier, maybe a mini logo, color option.
- ✅ **Loading screen** - done with the 2026-09-25 branding pass: App
  loading is the spinning plate (`sporedesk-plate-256.webp`), AuthGate
  loading is the full stacked lockup (plate + wordmark + tagline).
- 🔲 **Example/demo content** - a sample species with a populated tree
  for new users. Reconcile with seeded content (§1).
- 🔲 **Supply tracking**, likely Pro tier - costs, UPC scanning,
  low-stock alerts, templates.
- 🔲 **Library/recipe content on the website**, downloadable into the
  app (promoted from brainstorm 2026-09-24 - Matt's in, but post-beta,
  once the site is more than a beta-marketing page). Users pick which
  reference content gets pulled into their own app library. Overlaps
  with seeded starter content (§1) and the sharing/visibility
  brainstorm (§4) - design once, together, after beta feedback is in.
- 🔲 **Loose ideas, undecided**: species-specific background texture
  behind the tree canvas (procedural SVG is the sane scope); an
  unused-sterile-media log distinct from Stock; raw ingredient
  inventory with brand tracking tied back to results (unsure it's
  worth the complexity).
- 🔲 **Log & outdoor bed tracking model** - reference docs exist in
  library; tracking isn't designed. Logs/beds are long-lived,
  uncontrolled, fruit for years; sawdust and plug spawn need their own
  types (don't lump into Grain). Matt can't test this himself. Needs
  its own design conversation before any code.

## 4. Brainstorms - not scoped

- **User-facing AI connector** (for app users, not dev work). Read &
  summarize first: active grows, stock on hand, recent harvests,
  supplier/brand lookups, reference/species questions.
  Outside-knowledge fallback allowed but must say so and cite. One
  write: offer to save a useful fallback answer to the Library, only
  after a yes. Reuse DataTab's computed rollups instead of re-deriving.
  Hidden items are permanently invisible with no override, cascading
  species -> genetics -> items and species -> tagged library rows
  (`hidden` exists only on species and genetics). Unblocked now that
  isolation is verified. Still needs: tool list/API shape, hosting
  feasibility and cost.
- **Sharing & community.** Library row visibility tiers
  (private/shared/default); copy-on-download, not live-linked;
  author-only editing; comments on shared references, with a
  "suggestion" comment kind (author copies changes in manually). A full
  Social tab (feed, photos, moderation) is a separate, later initiative
  - and public user content changes the legal question in §5. Public
  website browse/download of shared references (see §3's promoted
  library/recipe item - overlaps directly). The Account page's
  Visibility toggle is a placeholder for this.

## 5. Business & launch questions

- 🔲 **Cohort size / attrition** - what share of beta testers typically
  finish and give usable feedback? (Target is now 30+.)
- 🔲 **Pricing** - one-time vs. subscription (leaning subscription),
  free vs. paid tier limits. Also replaces the beta code as the sign-up
  gate at hard launch.
- 🔲 **Longer-term hosting** - self-hosted cost comparison, when worth
  it.
- 🔲 **Legal exposure** - psilocybin tracked in-app; seizure risk if
  self-hosted; ToS stating data only released if legally compelled;
  cost of a lawyer-written ToS. Public social content would change this
  question.
- 🔲 **Business structure** - LLC/licensing if it launches.
- 🔲 **App store costs.**
- 🔲 **Sponsorships/affiliates** - prefer outbound links over handling
  payments in-app.

Parked 2026-09-22 (raised, not decided):

- Website analytics - Google Analytics vs. Vercel's cookieless
  analytics; weigh against the no-third-party stance.
- Marketing email consent - separate opt-in at signup, stored per user,
  unsubscribe handling (CAN-SPAM).
- Live listening sessions / video calls with testers (free Google Meet:
  1:1 up to 24h, groups 60 min).
- Tester data carrying over to hard launch - probably a non-issue on
  the same Supabase project; confirm.
- Account management on the website once money's involved.

## 6. Deferred - not this beta

- Client-side encrypted cloud tier (no data recovery if the key's
  lost; breaks server-side search/filtering).
- Local-only, phone-only "private" app - different architecture, its
  own project.
- Per-recipe usage tracking.
- Cost/profitability tracking per batch - possible Pro feature.
- In-app admin UI.

## 7. Shipped - index (details in repo CHANGELOG.md)

- 2026-09-06 - usability audit fixes: hidden species out of pickers,
  search opens matched row, species/genetics delete with 5s undo,
  checklist persistence, reason prefill, lot_links edit/delete, stock
  validation, DryYield real data, photo-to-event linking, editable lots
- 2026-09-06/07 - recipe sync to corrected guide PDFs + seal-after-sterilize
  fix (data)
- 2026-09-11 - log & outdoor bed reference docs (data)
- 2026-09-13 - stock weight (`7ba139f`, `34247c6`), merged item Details
  + dropped Where (`d9e28dc`), stock species removed (`a1d7c8b`),
  in-place stock edit (`d91c62d`), kind filter + dropdown filters
  (`3585d00`), stock form sizing (`d8fa3a1` - `.amt-pair` flex-basis is
  axis-relative), species templates (`ddc49e7`)
- 2026-09-16 - stock auto-labels (`750c30b`), Data tab hidden-genetics
  leak (`9c82adb`), Account & Settings v1, Units (`ad959d9`,
  `dd969ee`), editable cheat-sheet cards (`6b620ad`)
- 2026-09-17 - nav 8->5 (`30e6a11`), tab renames (`287ff28`), search
  dropdown fixes (`4947ead` et al.), multi-tenant RLS + beta-code
  sign-up (`ad98d1d`)
- 2026-09-18 - password rules (`2c2fc03`), email-confirm flow
  (`5da68cf`), forgot password (`38a25a1`), sign out (`3cd9a18`),
  second-account isolation test passed, select/deselect all
  (`b4c9ca9`), Data tab outcome rules + Stored status (`41ae84c`,
  `5f61f51`)
- 2026-09-20 - recipe library overhaul: 1.5lb grain bags, new 3-way
  blend, unified template, DME/casing fixes (data)
- 2026-09-22 - print queue (`e405230`, `74c258d`, `5ada522`,
  `2efbb15`), lot labels + weight (`c4d8f88`, `6f12efd`), print help
  contrast (`0598e37`), stock grouped by product (`fdc10d4`), wheel
  zoom (`9caa6fb` - React `onWheel` is passive), date format applied
  (`befd1de`), refresh keeps current page (`44b1f40`), mobile print
  icons re-hidden (`c5792b6` - compound selector beats source order)
- 2026-09-22 - Terms/Privacy drafted + live at sporedesk.com, linked
  in-app with an 18+/agree checkbox at sign-up (`e358f54`); marketing
  site built and live at sporedesk.com (Astro); domains wired
  (sporedesk.com, app.sporedesk.com); Zoho Mail Lite set up
  (support@sporedesk.com, SPF/DKIM/DMARC passing)
- 2026-09-23 - final app brand kit wired in (`8b54d1c`) - real
  logo/wordmark/icon kit replacing all placeholder art app-side, new
  favicons/PWA icons/manifest, Windows build icon, IBM Plex Mono added.
  (Its in-app SVG references were replaced by the 09-25 sizing pass.)
- 2026-09-24 - photo egress/loading fix: three-size uploads
  (thumb/display/original), metadata stripped to date+orientation,
  EXIF capture date used for `taken_on`, 7-day cached signed URLs,
  lightbox "Full size" on demand; existing 62 photos + avatar
  backfilled; follow-up storage-owner RLS bug (backfill's service-role
  uploads left `owner = NULL`, silently blocking signed URLs) found and
  fixed same day
- 2026-09-25 - Home on phones: duplicate logo/search hidden, side cards
  no longer stretch, tablet-width overflow fixed (`94645db`);
  Account/Settings moved to the bottom of Home on phones, desktop
  unchanged (`5adb8cd`); new hero screenshot on the site (`3f19c4f`)
- 2026-09-24/25 - marketing site branding (`d9fb52f`, `83c0dca`):
  header logo, plate hero halo, closing CTA, favicons/OG; app branding
  sizing pass (`2bec39b`): ~13 MB of kit SVGs swapped for ~190 KB of
  WebP, header logo in sidebar/mobile/Home, cream stacked lockup on
  AuthGate cards (fixed low-contrast reishi text on dark)

Gotchas worth remembering: dark-panel colors (bone/dim/amber) vanish on
the tan ground and vice versa - use the mirrored ink set. Never
build/install from Linux (see README). Direct SQL inserts must set
`user_id`. Uploading to the photos bucket as service-role leaves
`owner` NULL, silently breaking that file's signed URLs under RLS - fix
with SQL, matching the file to `photos.user_id`/`profiles.id`. Never
reference the brand kit's plate/lockup SVGs in the app or site - they
wrap multi-MB embedded PNGs (plate master is 8 MB); resize from the kit
PNGs to WebP instead. Resetting the Claude desktop app in Windows
Settings wipes `claude_desktop_config.json` - Desktop Commander (and
any other local tools) disappear until re-added. A Cowork session
reaching this repo through the device bridge (not a local Claude Code
session) runs in its own sandboxed shell with no access to the PC's
normal GitHub credentials - `git push` fails with "could not read
Username" until a repo-scoped credential is set up. Fixed 2026-09-25:
a fine-grained PAT (Contents: Read and write, scoped to Mycellium-
Tracks and sporedesk-site) stored via `credential.helper store` at
`.git/credentials` inside each repo's own `.git` folder on the real
disk - survives across sessions since it's not in the ephemeral
sandbox home. Matt's token expires 2026-10-25; pushes will fail again
after that until it's regenerated.
