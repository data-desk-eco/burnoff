// UTM <-> WGS84 (Transverse Mercator, WGS84 ellipsoid)
// Zero dependencies. Works in both main thread and Web Workers.

const a   = 6378137.0;
const f   = 1 / 298.257223563;
const e2  = 2 * f - f * f;
const ep2 = e2 / (1 - e2);
const k0  = 0.9996;
const e1  = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));

const M1 = 1 - e2/4 - 3*e2*e2/64 - 5*e2*e2*e2/256;
const M2 = 3*e2/8 + 3*e2*e2/32 + 45*e2*e2*e2/1024;
const M3 = 15*e2*e2/256 + 45*e2*e2*e2/1024;
const M4 = 35*e2*e2*e2/3072;

function centralMeridianRad(zone) {
    return ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
}

function meridionalArc(phi) {
    return a * (M1*phi - M2*Math.sin(2*phi) + M3*Math.sin(4*phi) - M4*Math.sin(6*phi));
}

// [lon, lat] degrees -> [easting, northing]
export function wgs84ToUtm(lon, lat, zone, isNorth) {
    const rad = Math.PI / 180;
    const phi = lat * rad;
    const lambda0 = centralMeridianRad(zone);
    const dlambda = lon * rad - lambda0;

    const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi), tanPhi = Math.tan(phi);
    const N = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
    const T = tanPhi * tanPhi;
    const C = ep2 * cosPhi * cosPhi;
    const A = cosPhi * dlambda;
    const M = meridionalArc(phi);

    const A2 = A*A, A3 = A2*A, A4 = A2*A2, A5 = A4*A, A6 = A4*A2;

    const easting = k0 * N * (
        A + (1 - T + C) * A3/6
        + (5 - 18*T + T*T + 72*C - 58*ep2) * A5/120
    ) + 500000;

    let northing = k0 * (
        M + N * tanPhi * (
            A2/2
            + (5 - T + 9*C + 4*C*C) * A4/24
            + (61 - 58*T + T*T + 600*C - 330*ep2) * A6/720
        )
    );

    if (!isNorth) northing += 10000000;

    return [easting, northing];
}

// [easting, northing] -> [lon, lat] degrees
export function utmToWgs84(easting, northing, zone, isNorth) {
    const x = easting - 500000;
    const y = isNorth ? northing : northing - 10000000;

    const M = y / k0;
    const mu = M / (a * M1);

    const phi1 = mu
        + (3*e1/2 - 27*e1*e1*e1/32) * Math.sin(2*mu)
        + (21*e1*e1/16 - 55*e1*e1*e1*e1/32) * Math.sin(4*mu)
        + (151*e1*e1*e1/96) * Math.sin(6*mu)
        + (1097*e1*e1*e1*e1/512) * Math.sin(8*mu);

    const sinPhi1 = Math.sin(phi1), cosPhi1 = Math.cos(phi1), tanPhi1 = Math.tan(phi1);
    const es = e2 * sinPhi1 * sinPhi1;
    const N1 = a / Math.sqrt(1 - es);
    const T1 = tanPhi1 * tanPhi1;
    const C1 = ep2 * cosPhi1 * cosPhi1;
    const R1 = a * (1 - e2) / Math.pow(1 - es, 1.5);
    const D = x / (N1 * k0);

    const D2 = D*D, D3 = D2*D, D4 = D2*D2, D5 = D4*D, D6 = D4*D2;

    const lat = phi1 - (N1 * tanPhi1 / R1) * (
        D2/2
        - (5 + 3*T1 + 10*C1 - 4*C1*C1 - 9*ep2) * D4/24
        + (61 + 90*T1 + 298*C1 + 45*T1*T1 - 252*ep2 - 3*C1*C1) * D6/720
    );

    const lon = (
        D - (1 + 2*T1 + C1) * D3/6
        + (5 - 2*C1 + 28*T1 - 3*C1*C1 + 8*ep2 + 24*T1*T1) * D5/120
    ) / cosPhi1;

    const lambda0 = centralMeridianRad(zone);

    return [
        (lambda0 + lon) * 180 / Math.PI,
        lat * 180 / Math.PI
    ];
}

export function utmParams(epsg) {
    return { zone: epsg % 100, isNorth: epsg < 32700 };
}

export function metersToDegreesLat(m) {
    return m / 110540;
}

export function metersToDegreesLon(m, lat) {
    return m / (111320 * Math.cos(lat * Math.PI / 180));
}
