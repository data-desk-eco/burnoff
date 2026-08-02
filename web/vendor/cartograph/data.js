// One lazy DuckDB-WASM connection serves Parquet reads, metadata and SQL. DuckDB
// runs in its own worker, so Cartograph needs no data worker or decode library.
const DDB = new URL('../duckdb/', import.meta.url).href;
const DUCKDB_RELEASE = 'v1.5.5-lite.1';
const duckdbAsset = name => `${DDB}${name}?v=${DUCKDB_RELEASE}`;

let files = {}, base, connection;
const metadata = new Map();

// the engine is ~6 MB over the wire, so start it here rather than on the first
// read: it then downloads and compiles while the map loads its own style and
// tiles, instead of after.
export function initData({ files: f = {}, prefetch = [], base: b } = {}) {
    files = f;
    base = b ?? globalThis.location?.href;
    connect().catch(() => {});
    for (const name of prefetch) meta(name).catch(() => {});
}

async function connect() {
    if (!connection) connection = (async () => {
        const d = await import(duckdbAsset('duckdb-browser.mjs'));
        const worker = new Worker(duckdbAsset('duckdb-browser-eh.worker.js'));
        const db = new d.AsyncDuckDB(new d.VoidLogger(), worker);
        await db.instantiate(duckdbAsset('duckdb-eh.wasm'));
        return db.connect();
    })();
    return connection;
}

const quote = value => {
    if (value instanceof Date) value = value.toISOString();
    if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    throw new TypeError(`Unsupported SQL value: ${value}`);
};
const ident = name => `"${String(name).replaceAll('"', '""')}"`;
const url = name => {
    if (Array.isArray(name)) return name.map(url);
    const value = files[name] ?? name;
    if (Array.isArray(value)) return value.map(url);
    return base ? new URL(value, base).href : value;
};
const list = source => Array.isArray(source) ? `[${source.map(quote).join(', ')}]` : quote(source);
export const parquetInput = name => list(url(name));

export async function sql(statement) {
    const result = await (await connect()).query(statement);
    return result.toArray().map(row => Object.fromEntries(result.schema.fields
        .map(field => [field.name, value(row[field.name], field.type)])));
}

const value = (item, type) => {
    if (item == null) return item;
    if (type.typeId === 8) return new Date(Number(item)).toISOString()
        .replace('T00:00:00.000Z', '');
    if (type.typeId === 10) return new Date(Number(item)).toISOString();
    if (type.typeId === 12) return Array.from(item,
        child => value(child, type.children[0].type));
    if (type.typeId === 13) return Object.fromEntries(type.children
        .map(child => [child.name, value(item[child.name], child.type)]));
    return norm(item);
};

export function read(name, { columns, where } = {}) {
    const select = columns?.length ? columns.map(ident).join(', ') : '*';
    const tests = Object.entries(where ?? {}).flatMap(([column, [lo, hi]]) => {
        const col = ident(column);
        return [`${col} IS NOT NULL`, ...(lo == null ? [] : [`${col} >= ${quote(lo)}`]),
            ...(hi == null ? [] : [`${col} <= ${quote(hi)}`])];
    });
    const source = url(name);
    const options = Array.isArray(source) ? ', union_by_name = true' : '';
    return sql(`SELECT ${select} FROM read_parquet(${list(source)}${options})${tests.length ? ` WHERE ${tests.join(' AND ')}` : ''}`);
}

// Keep the former footer shape for consumers that inspect row-group bounds.
// DuckDB reads the Parquet footer and returns one metadata row per column.
export function meta(name) {
    const source = url(name);
    if (!metadata.has(source)) metadata.set(source, sql(`
        SELECT row_group_id, row_group_num_rows, path_in_schema, type,
               stats_min_value, stats_max_value
        FROM parquet_metadata(${quote(source)})
        ORDER BY row_group_id, column_id
    `).then(rows => {
        const groups = [];
        for (const row of rows) {
            const group = groups[row.row_group_id] ??= { num_rows: row.row_group_num_rows, columns: [] };
            group.columns.push({ meta_data: {
                path_in_schema: row.path_in_schema.split(', '),
                statistics: {
                    min_value: stat(row.stats_min_value, row.type),
                    max_value: stat(row.stats_max_value, row.type),
                },
            }});
        }
        return { row_groups: groups };
    }));
    return metadata.get(source);
}

const stat = (value, type) => value == null ? null
    : type === 'BOOLEAN' ? value === 'true'
    : /^(U?INT|HUGEINT|FLOAT|DOUBLE|DECIMAL)/.test(type)
        && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value) ? Number(value)
    : value;

// BigInts become numbers and dates become ISO strings. The function recurses
// through nested lists and structs but preserves typed arrays.
export const norm = value =>
    typeof value === 'bigint' ? Number(value)
    : value instanceof Date ? value.toISOString().replace('T00:00:00.000Z', '')
    : Array.isArray(value) ? value.map(norm)
    : value && typeof value === 'object' && !ArrayBuffer.isView(value)
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, norm(item)]))
    : value;

export function fc(rows, { lat = 'lat', lon = 'lon' } = {}) {
    return { type: 'FeatureCollection', features: rows.map(properties => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [properties[lon], properties[lat]] },
        properties,
    })) };
}
