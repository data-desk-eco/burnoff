"""Command-line interface for Sentinel-2 flare detection."""

import json
import sys
from datetime import date, datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

import click

from .detect import detect, search_stac, DetectionResult


def parse_date(s: str) -> date:
    """Parse date from string (YYYY-MM-DD or YYYY)."""
    if len(s) == 4:
        return date(int(s), 1, 1)
    return datetime.strptime(s, "%Y-%m-%d").date()


def year_bounds(year: int) -> tuple[date, date]:
    """Get start and end dates for a year."""
    return date(year, 1, 1), date(year, 12, 31)


@click.group()
@click.version_option()
def main():
    """Sentinel-2 SWIR thermal anomaly detection.

    Detects flares and other high-temperature sources using Sentinel-2's
    shortwave infrared bands (B11/B12). Uses Element84's Earth Search
    STAC API to access cloud-optimized imagery.

    \b
    Examples:
        burnoff detect --lat -12.51 --lon 130.92 --year 2025
        burnoff detect --lat -12.51 --lon 130.92 --start 2025-01-01 --end 2025-06-30
        burnoff bulk terminals.json --output detections.json --year 2025
        burnoff search --lat -12.51 --lon 130.92 --year 2025
    """
    pass


@main.command()
@click.option("--lat", type=float, required=True, help="Latitude (WGS84)")
@click.option("--lon", type=float, required=True, help="Longitude (WGS84)")
@click.option("--year", type=int, help="Year to analyze (shorthand for full year)")
@click.option("--start", help="Start date (YYYY-MM-DD)")
@click.option("--end", help="End date (YYYY-MM-DD)")
@click.option("--buffer", default=3000, help="Buffer around point in meters (default: 3000)")
@click.option("--cloud", default=30, help="Max cloud cover percentage (default: 30)")
@click.option("--workers", default=8, help="Parallel workers (default: 8)")
@click.option("--b11", default=0.3, help="B11 (SWIR1) threshold (default: 0.3)")
@click.option("--b12", default=0.5, help="B12 (SWIR2) threshold (default: 0.5)")
@click.option("--min-peak", default=0.8, help="Minimum peak B12 intensity (default: 0.8)")
@click.option("-o", "--output", type=click.Path(), help="Output JSON file (default: stdout)")
@click.option("-q", "--quiet", is_flag=True, help="Suppress progress output")
def detect_cmd(lat, lon, year, start, end, buffer, cloud, workers, b11, b12, min_peak, output, quiet):
    """Detect thermal anomalies at a single location.

    \b
    Uses Sentinel-2 SWIR bands to identify high-temperature sources:
    - B12 (SWIR2, 2190nm): Primary thermal indicator
    - B11 (SWIR1, 1610nm): Confirmation band

    Detection occurs where both bands exceed their thresholds.
    """
    # Resolve date range
    if year:
        start_date, end_date = year_bounds(year)
    elif start and end:
        start_date, end_date = parse_date(start), parse_date(end)
    else:
        raise click.UsageError("Specify --year or both --start and --end")

    if not quiet:
        click.echo(f"Searching {lat:.4f}, {lon:.4f} from {start_date} to {end_date}", err=True)

    def progress(current, total):
        if not quiet:
            click.echo(f"\rProcessing {current}/{total} images", nl=False, err=True)

    result = detect(
        lat=lat,
        lon=lon,
        start_date=start_date,
        end_date=end_date,
        max_cloud=cloud,
        buffer_m=buffer,
        workers=workers,
        b11_threshold=b11,
        b12_threshold=b12,
        min_peak_b12=min_peak,
        progress_callback=progress,
    )

    if not quiet:
        click.echo("", err=True)  # newline after progress
        rate = f"{result.detection_rate:.1%}" if result.detection_rate else "N/A"
        click.echo(
            f"Found {result.images_with_detection} detections in "
            f"{result.images_searched} images ({rate})",
            err=True,
        )

    output_data = result.to_dict()

    if output:
        Path(output).write_text(json.dumps(output_data, indent=2))
        if not quiet:
            click.echo(f"Saved to {output}", err=True)
    else:
        click.echo(json.dumps(output_data, indent=2))


@main.command()
@click.argument("input_file", type=click.Path(exists=True))
@click.option("-o", "--output", type=click.Path(), required=True, help="Output JSON file")
@click.option("--year", type=int, default=2025, help="Year to analyze (default: 2025)")
@click.option("--start", help="Start date (YYYY-MM-DD, overrides --year)")
@click.option("--end", help="End date (YYYY-MM-DD, overrides --year)")
@click.option("--workers", default=6, help="Parallel terminals (default: 6)")
@click.option("--image-workers", default=8, help="Parallel images per terminal (default: 8)")
@click.option("--cloud", default=30, help="Max cloud cover percentage (default: 30)")
@click.option("--buffer", default=3000, help="Buffer around point in meters (default: 3000)")
@click.option("--min-peak", default=0.8, help="Minimum peak B12 intensity (default: 0.8)")
@click.option("--resume/--no-resume", default=True, help="Skip already-processed locations (default: resume)")
@click.option("-q", "--quiet", is_flag=True, help="Suppress progress output")
def bulk(input_file, output, year, start, end, workers, image_workers, cloud, buffer, min_peak, resume, quiet):
    """Process multiple locations from a JSON file.

    \b
    INPUT_FILE should be a JSON array of objects with at minimum:
        [{"lat": -12.51, "lon": 130.92}, ...]

    Optional fields: id, name (will be preserved in output)

    \b
    Example:
        burnoff bulk terminals.json -o detections.json --year 2025

    Automatically resumes from previous run if output file exists.
    Use --no-resume to reprocess all locations.
    """
    # Load input
    with open(input_file) as f:
        locations = json.load(f)

    if not isinstance(locations, list):
        raise click.UsageError("Input file must contain a JSON array")

    # Resolve date range
    if start and end:
        start_date, end_date = parse_date(start), parse_date(end)
    else:
        start_date, end_date = year_bounds(year)

    output_path = Path(output)

    # Load existing results for resume
    existing_results = []
    processed_keys = set()
    if resume and output_path.exists():
        try:
            existing_results = json.loads(output_path.read_text())
            for r in existing_results:
                # Use lat/lon as key (rounded to avoid float issues)
                key = (round(r["lat"], 5), round(r["lon"], 5))
                processed_keys.add(key)
            if not quiet:
                click.echo(f"Resuming: {len(processed_keys)} locations already processed", err=True)
        except (json.JSONDecodeError, KeyError):
            existing_results = []

    # Filter to unprocessed locations
    to_process = []
    for loc in locations:
        key = (round(loc["lat"], 5), round(loc["lon"], 5))
        if key not in processed_keys:
            to_process.append(loc)

    if not to_process:
        if not quiet:
            click.echo("All locations already processed", err=True)
        return

    if not quiet:
        click.echo(
            f"Processing {len(to_process)}/{len(locations)} locations for {start_date} to {end_date}",
            err=True,
        )

    def process_location(loc: dict) -> dict:
        lat, lon = loc["lat"], loc["lon"]
        result = detect(
            lat=lat,
            lon=lon,
            start_date=start_date,
            end_date=end_date,
            max_cloud=cloud,
            buffer_m=buffer,
            workers=image_workers,
            min_peak_b12=min_peak,
        )

        out = result.to_dict()
        # Preserve extra fields from input
        for key in ("id", "name", "type"):
            if key in loc:
                out[key] = loc[key]
        return out

    results = list(existing_results)  # Start with existing
    completed = 0

    def save_results():
        """Save current results to file."""
        sorted_results = sorted(results, key=lambda r: (r.get("id") or 0, r.get("name", "")))
        output_path.write_text(json.dumps(sorted_results, indent=2))

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(process_location, loc): loc for loc in to_process}

        for future in as_completed(futures):
            completed += 1
            loc = futures[future]
            try:
                result = future.result()
                results.append(result)

                if not quiet:
                    name = loc.get("name", f"{loc['lat']:.2f},{loc['lon']:.2f}")
                    det = result["detections"]
                    imgs = result["images"]
                    rate = f"{result['detection_rate']:.0%}" if result["detection_rate"] else "N/A"
                    click.echo(f"[{completed}/{len(to_process)}] {name}: {det}/{imgs} ({rate})", err=True)
            except Exception as e:
                if not quiet:
                    name = loc.get("name", f"{loc['lat']:.2f},{loc['lon']:.2f}")
                    click.echo(f"[{completed}/{len(to_process)}] {name}: ERROR - {e}", err=True)

            # Save incrementally every 5 results
            if completed % 5 == 0:
                save_results()

    save_results()
    if not quiet:
        click.echo(f"Saved {len(results)} results to {output}", err=True)


@main.command()
@click.option("--lat", type=float, required=True, help="Latitude (WGS84)")
@click.option("--lon", type=float, required=True, help="Longitude (WGS84)")
@click.option("--year", type=int, help="Year to search")
@click.option("--start", help="Start date (YYYY-MM-DD)")
@click.option("--end", help="End date (YYYY-MM-DD)")
@click.option("--cloud", default=30, help="Max cloud cover percentage (default: 30)")
def search(lat, lon, year, start, end, cloud):
    """Search for available Sentinel-2 images at a location.

    Useful for checking data availability before running detection.
    """
    if year:
        start_date, end_date = year_bounds(year)
    elif start and end:
        start_date, end_date = parse_date(start), parse_date(end)
    else:
        raise click.UsageError("Specify --year or both --start and --end")

    click.echo(f"Searching {lat:.4f}, {lon:.4f} from {start_date} to {end_date}", err=True)

    items = search_stac(lat, lon, start_date, end_date, cloud)

    click.echo(f"Found {len(items)} images", err=True)

    for item in sorted(items, key=lambda x: x["properties"]["datetime"]):
        dt = item["properties"]["datetime"][:10]
        cloud_pct = item["properties"].get("eo:cloud_cover", "?")
        click.echo(f"  {dt}  cloud: {cloud_pct:.0f}%  id: {item['id']}")


if __name__ == "__main__":
    main()
