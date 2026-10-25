-- burnoff at query time: search CDSE's catalogue and detect, in one query.
-- the extension runs this file on load, so after `load burnoff`:
--   from s2_flares_in(-104.2, 31.6, -103.2, 32.6, '2025-05-01', '2025-05-31');
-- eodata hrefs need eodata credentials (AWS_ACCESS_KEY_ID etc.); away from
-- cloudferro, href := 'gcp' reads google's public mirror of the same files.
load spatial;
-- the catalogue answers a search with a GET only, no HEAD and no ranges,
-- and a burst of searches with 429s that say to wait two seconds
set force_download = true;
set http_retries = 8;
set http_retry_wait_ms = 2000;
set http_retry_backoff = 1.5;
-- s2_flares holds its caller while burnoff's own workers run the rows. with
-- more duckdb threads, the client thread may poll for the result on a core
-- of its own, about a fifth of the cpu on four cores
set threads = 1;

-- every L1C scene over a lon/lat box between two dates, with the box in the
-- scene's own UTM metres. tiles of one zone share a pixel grid and overlap
-- by 9.8 km, so each scene keeps only what falls in its MGRS 100 km square,
-- whose west and north edges are sx and sy, and no flare of a pass is found
-- twice. the box is clipped to the square widened by 2 km and rounded out to
-- the tile's 6.4 km background cells: a flare in the square then has the
-- cells and the components that a whole-tile run gives it.
--
-- the catalogue gives at most 1000 scenes a search, and fewer searches are
-- faster, as it answers a burst with 429s. a search covers 830 / t days for
-- a box over about t tiles, which is a page half full at three satellites,
-- two orbits a tile and every tile at once. a full page fails the query
-- rather than lose scenes
create or replace macro s2_days(w, s, e, n) as
greatest(1, floor(830 / ((e - w) * 1.11 * cos(radians((s + n) / 2)) + 2)
                       / ((n - s) * 1.11 + 2)))::int;

create or replace macro s2_scenes(w, s, e, n, t0, t1, href := 'eodata')
as table
select id, datetime, cloud, b12, crs, sx, sy,
       greatest(ST_XMin(x), pb[1] + floor((sx - 2e3 - pb[1]) / 6400) * 6400)
         xmin,
       greatest(ST_YMin(x), pb[4] - ceil((pb[4] - sy + 1.02e5) / 6400) * 6400)
         ymin,
       least(ST_XMax(x), pb[1] + ceil((sx + 1.02e5 - pb[1]) / 6400) * 6400)
         xmax,
       least(ST_YMax(x), pb[4] - floor((pb[4] - sy - 2e3) / 6400) * 6400) ymax
from (
select *, round(pb[1], -5) sx, round(pb[4], -5) sy
from (
  select f ->> '$.id' id,
         (f ->> '$.properties.datetime')::timestamp datetime,
         (f ->> '$.properties.eo:cloud_cover')::double cloud,
         if(href = 'gcp', regexp_replace(f ->> '$.assets.B12.href',
           '^s3://eodata/Sentinel-2/MSI/L1C/\d+/\d+/\d+/'
           || '(S2\w+_T(\d\d)(\w)(\w\w)_\w+\.SAFE)/',
           'https://storage.googleapis.com/gcp-public-data-sentinel-2/tiles/'
           || '\2/\3/\4/\1/'), f ->> '$.assets.B12.href') b12,
         f ->> '$.assets.B12.proj:code' crs,
         (f -> '$.assets.B12.proj:bbox')::double[] pb,
         ST_Extent(ST_Transform(ST_MakeEnvelope(w, s, e, n), 'EPSG:4326',
                                f ->> '$.assets.B12.proj:code',
                                always_xy := true)) x
  from (select unnest(features) f, links from read_json(
    list_transform(
      generate_series(t0::date, t1::date, to_days(s2_days(w, s, e, n))),
      lambda m: 'https://stac.dataspace.copernicus.eu/v1/search'
        || '?collections=sentinel-2-l1c&limit=1000'
        || '&bbox=' || w || ',' || s || ',' || e || ',' || n
        || '&datetime=' || strftime(m, '%Y-%m-%d') || 'T00:00:00Z/'
        || strftime(least(m + to_days(s2_days(w, s, e, n) - 1), t1::date),
                    '%Y-%m-%d') || 'T23:59:59Z'
        || '&fields=id,properties.datetime,properties.eo:cloud_cover,'
        || 'assets.B12.href,assets.B12.proj:code,assets.B12.proj:bbox'),
    format = 'unstructured', columns = {features: 'json[]', links: 'json[]'}))
  where if(list_contains(list_transform(links, lambda l: l ->> 'rel'),
                         'next'),
           error('a catalogue search came back full: ask for less'), true)))
where least(xmax, sx + 1e5) > greatest(xmin, sx)
  and least(ymax, sy) > greatest(ymin, sy - 1e5);

-- the flares in a lon/lat box between two dates, one row each
create or replace macro s2_flares_in(w, s, e, n, t0, t1, max_cloud := 100,
                                     href := 'eodata', thresholds := '')
as table
select id scene, datetime, ST_X(p) lon, ST_Y(p) lat, clear, max_b12,
       avg_b12, peak_b11, ratio, peakedness, pixels, radiance, saturated
from (
  select *, ST_Transform(ST_Point(x, y), crs, 'EPSG:4326',
                         always_xy := true) p
  from (select id, datetime, crs, sx, sy, r.clear,
               unnest(r.flares, recursive := true)
        from (select *, s2_flares(b12, xmin, ymin, xmax, ymax, thresholds) r
              from s2_scenes(w, s, e, n, t0, t1, href := href)
              where cloud <= max_cloud)))
where x >= sx and x < sx + 1e5 and y > sy - 1e5 and y <= sy
  and ST_X(p) between w and e and ST_Y(p) between s and n;
