# Burnoff Detection Cache API

Cloudflare Worker + D1 for caching client-detected flares.

## Setup

```bash
# Install wrangler if needed
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Create D1 database
wrangler d1 create burnoff-cache

# Copy the database_id from the output and update wrangler.toml

# Apply schema
wrangler d1 execute burnoff-cache --file=schema.sql

# Deploy worker
wrangler deploy
```

## Configuration

After creating the D1 database, update `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "burnoff-cache"
database_id = "your-actual-database-id"
```

## Endpoints

### POST /scan-complete

Submit scan results for a tile.

```json
{
  "tile_id": "30UXA",
  "date": "2024-01-15",
  "image_hash": "abc123...",
  "epsg": 32630,
  "cog_url": "https://...",
  "detections": [
    { "lon": 51.489, "lat": 25.919, "max_b12": 1.663, "pixels": 7 }
  ]
}
```

### GET /detections

Query cached detections.

```
/detections?bbox=51,25,52,26&min_consensus=2
```

### GET /tiles

Query which tiles have been scanned.

```
/tiles?after=2024-01-01
```

## Spam Prevention

1. **Rate limiting**: 30 requests per minute per IP
2. **Image hash**: SHA-256 of B12 raster proves imagery was fetched
3. **Consensus**: Detections gain credibility when multiple clients confirm
4. **Geofencing**: Could add validation that detections are near known LNG sites

## Local Development

```bash
wrangler dev
```
