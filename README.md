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

- Mycelial top-down lineage tree, pan/zoom, hover lights ancestry
- Item detail page: status, history, harvests, BE%
- Reads from Supabase
- Writes: status, notes, harvests, inoculate-from

## TODO

- Delete button on history log entries (misclicks)
- Logging a harvest always sets status to `fruiting`. Correct when harvesting
  live, wrong when back-filling history on a retired block. Needs a way to
  log a past harvest without changing current status.
- New item labels are hardcoded to the `BO-` prefix. Should come from the
  genetics record's `code`.
- Home screen: genetics tiles grouped by species
- Add genetics / add root item (item with no parent)
- Editable fields on detail page (location, substrate, dry weight, dates)
- Inventory: lots, merge, split, transform (wet -> dried -> powder -> extract)
- Library section
- Lineage highlight has no mobile equivalent (hover doesn't exist on touch)
- RLS + auth before this is deployed anywhere

## Running it

```
npm run dev
```

Needs `.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
