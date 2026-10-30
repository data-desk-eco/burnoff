# Handover: the live map on the service

The live map's search now runs on the service.

- **burnoff** (`web-map`): `&f=sites` (`serve/sites.sql`). A point's tile
  is its own UTM zone's tile where eodata lists it, else a neighbouring
  zone's tile (Yamal LNG is in 42WXE, and 43WCV does not exist). Bulk's
  duckdb stops while a request runs (`hotspots.cgi`).
- **aerial** (`burnoff-live`): `web/flaring/live.js` is a client of the
  service. It requests 0.1° blocks: the last 30 days in 10-day windows,
  then back to 180 days a month at a time, newest first. The older
  windows wait for the view's recent ones. The browser detector
  (`fallback.js`) loads only when a request fails twice.

## Open items

- `burnoff-bulk` logged a segmentation fault in duckdb at 14:35 on
  2026-10-30, on the cell near -102.633, 48.311. Find it with
  `journalctl -t burnoff-bulk`.
- The scene index reaches back to 2025-04-29. The backfill to 2022
  continues each day.
- Compare the service's sites with the old browser search for one view.
  This comparison was not done.
- Progress moves one window at a time. For finer steps, the service must
  stream its answer scene by scene.
- A request that is killed with SIGKILL leaves bulk stopped until the
  next request ends.
- The tables `data-desk/burnoff/{observations,detections}` are not yet in
  the archive's `index.json`.
- Deploy only when no one is using the map: `deploy.sh` restarts
  fcgiwrap and stops the requests that are running.
