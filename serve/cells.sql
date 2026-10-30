-- a cell's 640 m squares as the store keeps them: their obscured shares in
-- the cell's 10 × 10 grid order from its north-west, to 0.001, null where
-- there is no square (off the image), and the whole null where the grid is
-- full at the cell's one share (most cells, clear or overcast). squares
-- sit on the tile's own origin (ox, oy), a few tens of metres off the
-- 100 km square's (sx, sy) that numbers the cells
CREATE MACRO origin(x, sx) AS x - 320 - 640 * round((x - 320 - sx) / 640);
CREATE MACRO gx(ox, sx, i, k) AS
  ox + 320 + 640 * (ceil((sx + 6400 * i - ox - 320) / 640) + k % 10);
CREATE MACRO gy(oy, sy, j, k) AS
  oy - 320 - 640 * (ceil((oy - 320 - sy + 6400 * j) / 640) + k // 10);
CREATE MACRO packed(q, ox, oy, sx, sy, i, j) AS
  if(len(q) = 100 AND list_min(list_transform(q, lambda z: z.cloud))
                    = list_max(list_transform(q, lambda z: z.cloud)), NULL,
     to_json(list_transform(range(100), lambda k: round(list_filter(q,
       lambda z: z.x = gx(ox, sx, i, k) AND z.y = gy(oy, sy, j, k))[1].cloud,
       3)))::VARCHAR);
CREATE MACRO unpacked(t, ox, oy, sx, sy, i, j, c) AS list_filter(
  list_transform(range(100), lambda k: {x: gx(ox, sx, i, k),
    y: gy(oy, sy, j, k),
    cloud: if(t IS NULL, c, from_json(t, '["DOUBLE"]')[k + 1])}),
  lambda z: z.cloud IS NOT NULL);
