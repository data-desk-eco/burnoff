# Handover: the live map on the service

The next job is to power aerial's live S2 search with burnoff's service,
so that `web/flaring/live.js` becomes a thin client and the browser's own
detector is a lazy fallback.

## Where things stand

- **burnoff** (`web-map`, `eba95b1`): `serve/` is the service on the jump
  host. Read `AGENTS.md` for its parts. `src/burnoff.c` gives each
  hotspot's pixels (`px`) and signs only `s3://` reads with eodata's key.
- **aerial** (`burnoff-live`, `0195014`): live sites of 100 m named by
  their first detection, a card's history read by the service 90 days at a
  time (`history()` in `live.js`), and the view search still in the
  browser (the worker pool, the sweeps and the site reads).
- Neither branch is pushed. Both are ready to merge into main.
- The API stays at `https://dev.datadesk.eco/burnoff/hotspots`.

On the jump host:

- `/data/burnoff/store.db`: the sqlite store (`serve/schema.sql`).
- `burnoff-index` (daily) was backfilling eodata's listings to 2022 at
  about 3 s a day. Requests find no scenes before the backfill's reach:
  `sqlite3 /data/burnoff/store.db "SELECT min(day) FROM days"`.
- `burnoff-bulk` (nice 19) reads whole tiles about the archive's sites, 30
  days at a time back to 2022.
- `burnoff-export` (hourly) writes `data-desk/burnoff/{observations,
  detections}` to the public archive, a file a partition. The tables are
  not yet in the archive's `index.json`.
- Logs: `journalctl -t burnoff-<unit>`. Failures go to
  `data-desk-failed@`. Deploy with `serve/deploy.sh`. It is idempotent.

Measured on the shared 4-core jump host, with bulk running: a 10 km box
over 90 days takes 2–8 s new and about 0.4 s held. The store costs about
40 KB a scene, and the full scene index about 2.5 GB.

## The plan

1. **A sites mode in `serve/`** (`&f=sites`). After `hotspots.sql`, a SQL
   step groups the bbox's hotspots into sites, the detections within 100 m
   of the first, keyed `live:<lat>,<lon>@<tile>_<date>` as aerial keys
   them. It gives each site its looks: for every scene over the site, the
   cloud of the 640 m square under it (`unpacked()` in `cells.sql`, the
   square whose centre is nearest). The output is one feature a site: its
   point, `looks` as `[[date, cloud], …]`, its detections with their
   pixels, and counts. Check it against `live.js`'s own sites for one view
   before aerial uses it.
2. **Block requests in aerial.** Request fixed 0.1° blocks over the view at
   `LIVE_ZOOM` and closer: the last 30 days first, then the rest of the
   window. Keep blocks in memory and IndexedDB. Merge sites within 100 m
   across block edges (`near()`). Keep the drawing rules in the browser:
   lit on `LIT` dates, the b12 floor, the summer rule and persistence.
3. **Remove the old search.** The sweeps, the ground squares, the site
   reads, the ranking and the scene listing go. `live.js` should drop from
   about 680 lines to about 150.
4. **Lazy fallback.** Start the burnoff workers only when the service
   fails. A normal page load then loads none of the detector (about 78 KB
   gzipped, and four wasm compiles and WebGPU devices).
5. **Cards** use the sites request for the site's small bbox, which
   replaces `history()`.

One decision is open: the live layer searches 180 days (`DAYS`). Keeping
90 days, the card's first window, would halve the cost of a new area. A
full z12 view over 180 days that the store does not hold is thousands of
scene-cells, about 30–90 s on 4 cores. The recent 30 days come back in a
few seconds.

## Constraints

- Keep it minimal: SQL over the extension, sqlite for the store, shell
  for orchestration, systemd for scheduling. Do not add a daemon, a
  database server or DuckLake.
- Keep it in the EU: Copernicus data on CloudFerro, and no Google
  listing in the service.
- Keep it exact and idempotent. A cell is stored only from a read that
  succeeded, in one transaction with its hotspots, under the detector's
  digest. A read takes a cell's margin, so a cell's hotspots do not depend
  on the box that read it. Do not trade these away for speed.

## Lessons from this session

- `sqlite_query` (through sqlite's own indexes) answers in milliseconds.
  DuckDB's scan of an attached sqlite table reads the whole table.
  `sqlite_query` types an empty answer's columns as text, so cast them.
- DuckDB's sqlite extension fails at once on a locked database. Write to a
  scratch sqlite file and merge it with the `sqlite3` CLI and `.timeout`.
- The 640 m squares sit on the tile's own origin, which is often tens of
  metres off the 100 km grid. Hotspots do not depend on it, because a read
  keeps a whole cell's margin, but the squares do (`origin()` in
  `cells.sql`).
- CDSE's STAC search takes 4–6 s. An eodata day listing takes 3 s and is
  indexed once.
- `when`, `unpack` and `pack` are reserved words in DuckDB 1.5. A lambda
  variable named like a column (`v`) resolves to the column.
- The extension's macros need `LOAD spatial` first. Its error is "could
  not register".
- `pkill -f <path>` over ssh can match the ssh command itself. Use
  `pkill -x`.
