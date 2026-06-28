import { GeoTIFF } from './vendor/geotiff-esm.js';
import { wgs84ToUtm, utmParams } from './geo.js';

// Block tiling geometry. 256-px blocks, read with a 10-px halo so a flare on a block
// edge is fully seen in at least one block; canonical-block dedup (floor(peak/SIZE))
// picks the owner. SIZE must match the s2-flares core — the wasm returns peak pixel
// coords the worker floors by it to assign block ownership.
export const BLOCK_SIZE = 256;
export const BLOCK_OVERLAP = 10;

// Open a COG and return image handle + metadata
export async function openCOG(url) {
    const tiff = await GeoTIFF.fromUrl(url, { allowFullFile: false });
    const image = await tiff.getImage();
    const [minX, minY, maxX, maxY] = image.getBoundingBox();
    return {
        image,
        bbox: [minX, minY, maxX, maxY],
        width: image.getWidth(),
        height: image.getHeight(),
        resX: (maxX - minX) / image.getWidth(),
        resY: (maxY - minY) / image.getHeight(),
    };
}

// Read a window from a COG image, returns typed array
export async function readWindow(image, windowArr) {
    const [x0, y0, x1, y1] = windowArr;
    if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
    const rasters = await image.readRasters({ window: windowArr });
    return rasters[0];
}

// Enumerate blocks overlapping a bbox (in image pixel coordinates)
export function enumerateBlocks(imgMeta, bbox, epsg) {
    const { width: imgWidth, height: imgHeight, bbox: imgBbox, resX, resY } = imgMeta;
    const [imgMinX, imgMinY, imgMaxX, imgMaxY] = imgBbox;

    const { zone, isNorth } = utmParams(epsg);
    const sw = wgs84ToUtm(bbox[0], bbox[1], zone, isNorth);
    const ne = wgs84ToUtm(bbox[2], bbox[3], zone, isNorth);

    const px0 = Math.max(0, Math.floor((Math.max(sw[0], imgMinX) - imgMinX) / resX));
    const py0 = Math.max(0, Math.floor((imgMaxY - Math.min(ne[1], imgMaxY)) / resY));
    const px1 = Math.min(imgWidth, Math.ceil((Math.min(ne[0], imgMaxX) - imgMinX) / resX));
    const py1 = Math.min(imgHeight, Math.ceil((imgMaxY - Math.max(sw[1], imgMinY)) / resY));

    if (px1 <= px0 || py1 <= py0) return [];

    const blockRow0 = Math.floor(py0 / BLOCK_SIZE);
    const blockRow1 = Math.ceil(py1 / BLOCK_SIZE);
    const blockCol0 = Math.floor(px0 / BLOCK_SIZE);
    const blockCol1 = Math.ceil(px1 / BLOCK_SIZE);

    const blocks = [];
    for (let br = blockRow0; br < blockRow1; br++) {
        for (let bc = blockCol0; bc < blockCol1; bc++) {
            const x0 = Math.max(0, bc * BLOCK_SIZE - BLOCK_OVERLAP);
            const y0 = Math.max(0, br * BLOCK_SIZE - BLOCK_OVERLAP);
            const x1 = Math.min(imgWidth, (bc + 1) * BLOCK_SIZE + BLOCK_OVERLAP);
            const y1 = Math.min(imgHeight, (br + 1) * BLOCK_SIZE + BLOCK_OVERLAP);
            blocks.push({ br, bc, window: [x0, y0, x1, y1] });
        }
    }
    return blocks;
}
