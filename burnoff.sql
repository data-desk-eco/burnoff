-- burnoff's macros, defined on load; spatial must be loaded to use them.

-- every L1C scene over a lon/lat geometry's bounds from t0 to t1 (today), with the box to
-- read in the scene's UTM metres: its MGRS 100 km square (west and north
-- edges sx, sy), widened by 2 km and rounded out to the tile's 6.4 km
-- background cells, so no flare of a pass is found twice. each search
-- spans the days that should half fill a 1000-scene page; a full page
-- fails the query rather than lose scenes
create or replace macro s2_days(g) as
greatest(1, floor(830 / ((ST_XMax(g) - ST_XMin(g)) * 1.11
                         * cos(radians((ST_YMin(g) + ST_YMax(g)) / 2)) + 2)
                       / ((ST_YMax(g) - ST_YMin(g)) * 1.11 + 2)))::int;

create or replace macro s2_scenes(g, t0, t1 := current_date,
                                  source := 'auto')
as table
select id, datetime, cloud,
       if(coalesce(nullif(source, 'auto'), s2_source()) = 'gcp',
          'https://storage.googleapis.com/gcp-public-data-sentinel-2/tiles/'
          || t[1:2] || '/' || t[3] || '/' || t[4:5] || '/' || safe, b12) b12,
       crs, sx, sy,
       greatest(ST_XMin(x), pb[1] + floor((sx - 2e3 - pb[1]) / 6400) * 6400)
         xmin,
       greatest(ST_YMin(x), pb[4] - ceil((pb[4] - sy + 1.02e5) / 6400) * 6400)
         ymin,
       least(ST_XMax(x), pb[1] + ceil((sx + 1.02e5 - pb[1]) / 6400) * 6400)
         xmax,
       least(ST_YMax(x), pb[4] - floor((pb[4] - sy - 2e3) / 6400) * 6400) ymax
from (
-- eodata's href is L1C/yyyy/mm/dd/<safe>/..., gcp's tiles/zz/b/sq/<safe>/...
select *, round(pb[1], -5) sx, round(pb[4], -5) sy,
       string_split(id, '_')[6][2:] t,
       array_to_string(string_split(b12, '/')[10:], '/') safe
from (
  select f ->> '$.id' id,
         (f ->> '$.properties.datetime')::timestamp datetime,
         (f ->> '$.properties.eo:cloud_cover')::double cloud,
         f ->> '$.assets.B12.href' b12,
         f ->> '$.assets.B12.proj:code' crs,
         (f -> '$.assets.B12.proj:bbox')::double[] pb,
         ST_Extent(ST_Transform(ST_Envelope(g), 'EPSG:4326',
                                f ->> '$.assets.B12.proj:code',
                                always_xy := true)) x
  from (select unnest((j -> '$.features')::json[]) f, j from (
    select s2_get(unnest(list_transform(
      generate_series(t0::date, t1::date, to_days(s2_days(g))),
      lambda m: 'https://stac.dataspace.copernicus.eu/v1/search'
        || '?collections=sentinel-2-l1c&limit=1000'
        || '&bbox=' || ST_XMin(g) || ',' || ST_YMin(g) || ','
        || ST_XMax(g) || ',' || ST_YMax(g)
        || '&datetime=' || strftime(m, '%Y-%m-%d') || 'T00:00:00Z/'
        || strftime(least(m + to_days(s2_days(g) - 1), t1::date),
                    '%Y-%m-%d') || 'T23:59:59Z'
        || '&fields=id,properties.datetime,properties.eo:cloud_cover,'
        || 'assets.B12.href,assets.B12.proj:code,assets.B12.proj:bbox')))::json
      j))
  where if(list_contains(list_transform((j -> '$.links')::json[],
                                        lambda l: l ->> 'rel'), 'next'),
           error('a catalogue search came back full: ask for less'), true)))
where least(xmax, sx + 1e5) > greatest(xmin, sx)
  and least(ymax, sy) > greatest(ymin, sy - 1e5);

-- the flares in a lon/lat geometry from t0 to t1 (today), one row each
create or replace macro s2_flares(g, t0, t1 := current_date, max_cloud := 100,
                                  source := 'auto', thresholds := '')
as table
select id scene, datetime, ST_X(p) lon, ST_Y(p) lat, clear, max_b12,
       avg_b12, peak_b11, ratio, peakedness, pixels, radiance, saturated
from (
  select *, ST_Transform(ST_Point(x, y), crs, 'EPSG:4326',
                         always_xy := true) p
  from (select id, datetime, crs, sx, sy, r.clear,
               unnest(r.flares, recursive := true)
        from (select *, s2_detect(b12, xmin, ymin, xmax, ymax, thresholds) r
              from s2_scenes(g, t0, t1 := t1, source := source)
              where cloud <= max_cloud)))
where x >= sx and x < sx + 1e5 and y > sy - 1e5 and y <= sy
  and ST_Intersects(g, p);
