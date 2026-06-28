// Environment-aware GeoTIFF loader:
// - Browser: vendored UMD (no npm dependency)
// - Node.js: npm geotiff package (supports HTTP range requests natively)
let GeoTIFF;
if (typeof process !== 'undefined' && process.versions?.node) {
    GeoTIFF = await import('geotiff');
} else {
    await import('./geotiff.js'); // executes UMD script, sets self.GeoTIFF
    GeoTIFF = self.GeoTIFF;
}
export { GeoTIFF };
