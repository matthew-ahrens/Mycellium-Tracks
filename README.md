# Mycelium

Lineage and inventory tracker for mushroom cultivation.

## Data model

Three layers:

- **Cultures** — descending tree, one parent per item.
  `species` -> `genetics` (one per acquisition) -> `items` (physical containers)
- **Inventory** — merging/splitting graph. Everything enters as a wet harvest.
  `lots` + `lot_links` (many parents, many children)
- **Library** — static reference. Sheets, links, videos.

Rules settled so far:

- New container = new node. Same container aging = status change.
- A genetics record is one traceable acquisition. Two purchases from the same
  vendor are two records, because the genetics can't be verified.
- Splitting a lot leaves the parent's ID intact and decrements its remaining
  amount. Children record how much they took.

## Built

- Species grid -> tree screen (parallel trees, one per genetics line)
- Mycelial top-down lineage tree, pan/zoom, hover lights ancestry
- Item detail page: status, history, harvests, BE%
- Screen transitions (slide fwd/back)
- Reads from Supabase
- Writes: status, notes, harvests, inoculate-from
- Delete on history entries and flush rows
- Item labels use the genetics `code` prefix, numbered per line

### Known weak spots
- Harvest history lines are matched to their lot **by text**, not by a key.
  Deleting a flush whose note has extra text (e.g. seeded flush 3) takes that
  text with it. Real fix: store `lot_id` on `item_events`.
- Flush numbering uses max+1, so deleting a middle flush leaves a gap.
  Intentional — duplicates would be worse.
- `GeneticsGrid` component is unused after the parallel-tree change.

## TODO

### Goal: run the whole thing from the phone
Every create/edit/delete has to be possible in-app. No SQL editor, no desktop
required. This is the bar for "done" on CRUD.

- **Edit history entries in place** — date and text. Logging a day late is
  normal, and delete-and-retype re-stamps today's date, which is the bug.
  Same for flush rows (date + weight).
- Add species, add genetics, add root item (item with no parent)
- Edit any field on any record (location, substrate, dry weight, dates, notes)
- Delete: items, genetics, species — with confirm
- Mobile layout pass — tree canvas, detail page, forms all need touch sizing
- Lineage highlight has no mobile equivalent (hover doesn't exist on touch)

### Photos
- Thumbnail per genetics and/or per item
- Photos attached to history entries, so growth is a visual timeline
- Camera capture direct from phone, not just file upload
- Supabase Storage bucket + a `photos` table or a column on `item_events`

### Other
- Logging a harvest always sets status to `fruiting`. Correct when harvesting
  live, wrong when back-filling history on a retired block.
- Inventory: lots, merge, split, transform (wet -> dried -> powder -> extract)
- Library section (reference sheets, links, videos, per species)
- RLS + auth before this is deployed anywhere (required for phone access)

## Running it

```
npm run dev
```

Needs `.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
