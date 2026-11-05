# Method

## Sentinel-2 (day)

**Data:** Sentinel-2 L1C (baseline N0400 or later)

**Clouds:**

- Use the L1C product's own cloud mask (opaque cloud and cirrus)
- Skip any 6.4 km cell that is more than 75% cloudy

**Background:**

- The median B12 of the cell's pixels below 0.30, no lower than 0.15

**Pixel:**

- B12 > 0.30 and B12 > 3× the background
- B11 > 0.20
- B11 > B8A, or the pixel is saturated

**Group of touching pixels:**

- Must be 80 px or smaller
- Peak B12 must be ≥ 0.50
- If > 30 px, peak must be ≥ 0.70
- If 1 px only, peak must be ≥ 0.65
- Peak must be ≥ 1.15× the group mean (unless the mean is saturated)
- Sunlight test: the peak's rise in B8A over its surroundings must be less
  than 0.1× its rise in B12
- Hot core (pixels joined to the peak and above half the peak or 0.50,
  whichever is higher) must be 100 px or smaller

**Site:**

- Detections within 40 m are merged, closest first
- Two detections from the same date more than 30 m apart are never merged
  (two flares lit at once)
- No minimum number of dates

## Sentinel-3 (night)

**Data:** Sentinel-3 SLSTR L1B (RBT), night passes only (sun zenith ≥ 90°).
Method follows Caseiro et al. (2018, 2020)

**Clouds:**

- Clouds do not remove detections; the clear share is only recorded

**Threshold for each band:**

- Start at the most common value in the image
- Count up to the first gap with no pixels; above that is "hot"

**Pixel:**

- S5 (1.61 µm) above its threshold

**Hotspot (touching pixels, diagonals included):**

- Confirmed if S6 (2.25 µm) is hot under it, or failing that, S7 or F1
  (3.7 µm) within 2 pixels

**Temperature and heat:**

- Background is the median of a 2-pixel ring around the hotspot
- Temperature comes from the ratio of S5 to S6 above the background
  (Planck's law), with no atmospheric correction
- Dropped if outside 500–5000 K (saturated hotspots are kept, with no
  temperature)
- Radiant heat (MW) is derived from the temperature and S6

**Location:**

- The mean of the pixel positions, weighted by heat
- The server corrects a known geolocation offset for each satellite and
  swath position (median error ~200 m)

**Site:**

- Hotspots within 750 m are merged, closest first
- Two hotspots from the same pass are never merged
- No minimum number of nights
