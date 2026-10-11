// Test double for `sdk/db`: the schema DSL and query builder from
// docs/tgcloud-sdk.md, implemented over node:sqlite.
//
// It exists so the bot's real modules can be imported and exercised in tests —
// same imports, same SQL semantics, real rows. It covers the subset this project
// uses, and deliberately throws on anything outside it rather than quietly
// returning something plausible.

import { DatabaseSync } from 'node:sqlite';

let handle = new DatabaseSync(':memory:');

export function __reset() {
  try { handle.close(); } catch { /* already closed */ }
  handle = new DatabaseSync(':memory:');
}

// ----------------------------------------------------------------- schema DSL

const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function column(type, nameOrOpts, maybeOpts) {
  const name = typeof nameOrOpts === 'string' ? nameOrOpts : null;
  const opts = (typeof nameOrOpts === 'string' ? maybeOpts : nameOrOpts) ?? {};
  const col = {
    __col: true,
    type,
    name,
    key: null,
    table: null,
    $mode: opts.mode ?? null,
    $notNull: false,
    $pk: false,
    $auto: false,
    $unique: false,
    $default: undefined,
    $defaultSql: null,
    $deprecated: false,
  };
  col.primaryKey = (o = {}) => { col.$pk = true; col.$auto = !!o.autoIncrement; return col; };
  col.notNull = () => { col.$notNull = true; return col; };
  col.unique = () => { col.$unique = true; return col; };
  col.default = (v) => {
    if (v && v.__sql) col.$defaultSql = v;
    else col.$default = v;
    return col;
  };
  col.generatedAlwaysAs = () => col;
  col.constraint = () => col;
  col.deprecated = () => { col.$deprecated = true; return col; };
  col.references = () => {
    throw new Error('foreign keys are not supported by the platform');
  };
  return col;
}

export const text = (n, o) => column('TEXT', n, o);
export const integer = (n, o) => column('INTEGER', n, o);
export const real = (n, o) => column('REAL', n, o);
export const float = real;
export const numeric = (n, o) => column('NUMERIC', n, o);
export const blob = (n, o) => column('BLOB', n, { ...(o ?? {}), mode: 'bytes' });
export const boolean = (n, o) => column('INTEGER', n, { ...(o ?? {}), mode: 'boolean' });
export const json = (n, o) => column('TEXT', n, { ...(o ?? {}), mode: 'json' });

export function table(name, cols, extras) {
  const t = {};
  const columns = [];
  for (const [key, col] of Object.entries(cols)) {
    col.key = key;
    col.name = col.name ?? snake(key);
    col.table = name;
    t[key] = col;
    columns.push(col);
  }
  Object.defineProperty(t, '$name', { value: name });
  Object.defineProperty(t, '$columns', { value: columns });
  Object.defineProperty(t, '$extras', { value: typeof extras === 'function' ? extras(t) : {} });
  return t;
}

export const index = (name) => makeIndex(name, false);
export const uniqueIndex = (name) => makeIndex(name, true);
function makeIndex(name, unique) {
  const idx = { __index: true, name, unique, cols: [], whereSql: null };
  idx.on = (...cols) => { idx.cols = cols; return idx; };
  idx.where = (s) => { idx.whereSql = s; return idx; };
  return idx;
}
export const check = (name, expr) => ({ __check: true, name, expr });
export const unique = (name) => makeIndex(name, true);
export const primaryKey = (o) => ({ __pk: true, columns: o.columns });
export const foreignKey = () => {
  throw new Error('foreign keys are not supported by the platform');
};

/** Create tables and indexes for the given schema exports. */
export function __createTables(tables) {
  for (const t of tables) {
    const defs = t.$columns.filter((c) => !c.$deprecated).map((c) => {
      let d = `"${c.name}" ${c.type}`;
      if (c.$pk) d += c.$auto ? ' PRIMARY KEY AUTOINCREMENT' : ' PRIMARY KEY';
      if (c.$notNull) d += ' NOT NULL';
      if (c.$unique) d += ' UNIQUE';
      if (c.$defaultSql) d += ` DEFAULT ${compile(c.$defaultSql).text}`;
      else if (c.$default !== undefined) d += ` DEFAULT ${sqlLiteral(toSqlValue(c.$default, c))}`;
      return d;
    });
    handle.exec(`CREATE TABLE IF NOT EXISTS "${t.$name}" (${defs.join(', ')})`);

    for (const extra of Object.values(t.$extras ?? {})) {
      if (!extra?.__index || !extra.cols.length) continue;
      const cols = extra.cols.map((c) => (c.__col ? `"${c.name}"` : compile(c).text)).join(', ');
      const where = extra.whereSql ? ` WHERE ${compile(extra.whereSql).text}` : '';
      handle.exec(
        `CREATE ${extra.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${extra.name}" ` +
        `ON "${t.$name}" (${cols})${where}`
      );
    }
  }
}

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

// --------------------------------------------------------------- value coding

function toSqlValue(value, col) {
  const mode = col?.$mode ?? null;
  if (value === undefined || value === null) return null;
  if (mode === 'timestamp') return Math.floor(new Date(value).getTime() / 1000);
  if (mode === 'timestamp_ms') return new Date(value).getTime();
  if (mode === 'json') return JSON.stringify(value);
  if (mode === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function fromSqlValue(value, col) {
  const mode = col?.$mode ?? null;
  if (value === null || value === undefined) return null;
  if (mode === 'timestamp') return new Date(value * 1000);
  if (mode === 'timestamp_ms') return new Date(value);
  if (mode === 'json') {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (mode === 'boolean') return !!value;
  return value;
}

// ------------------------------------------------------------------- compiler

export function sql(strings, ...values) {
  return { __sql: true, strings: Array.from(strings), values };
}
sql.raw = (s) => ({ __sql: true, strings: [String(s)], values: [] });

function walk(node, params, col = null) {
  if (node === null || node === undefined) return 'NULL';
  if (node.__sql) {
    let out = '';
    node.strings.forEach((s, i) => {
      out += s;
      if (i < node.values.length) out += walk(node.values[i], params);
    });
    return out;
  }
  if (node.__col) return `"${node.table}"."${node.name}"`;
  if (node.__expr) return node.build(params);
  if (node.__order) return `${walk(node.col, params)} ${node.dir}`;
  params.push(toSqlValue(node, col));
  return '?';
}

function compile(node) {
  const params = [];
  const text = walk(node, params);
  return { text, params };
}

const expr = (build) => ({ __expr: true, build });
const binary = (op) => (left, right) =>
  expr((p) => `${walk(left, p)} ${op} ${walk(right, p, left?.__col ? left : null)}`);

export const eq = binary('=');
export const ne = binary('<>');
export const gt = binary('>');
export const gte = binary('>=');
export const lt = binary('<');
export const lte = binary('<=');
export const like = binary('LIKE');
export const notLike = binary('NOT LIKE');

export const isNull = (c) => expr((p) => `${walk(c, p)} IS NULL`);
export const isNotNull = (c) => expr((p) => `${walk(c, p)} IS NOT NULL`);
export const not = (c) => expr((p) => `NOT (${walk(c, p)})`);

const combine = (op) => (...conds) => {
  const parts = conds.filter(Boolean);
  if (!parts.length) return expr(() => '1=1');
  return expr((p) => `(${parts.map((c) => walk(c, p)).join(` ${op} `)})`);
};
export const and = combine('AND');
export const or = combine('OR');

export const between = (c, a, b) =>
  expr((p) => `${walk(c, p)} BETWEEN ${walk(a, p, c)} AND ${walk(b, p, c)}`);
export const notBetween = (c, a, b) =>
  expr((p) => `${walk(c, p)} NOT BETWEEN ${walk(a, p, c)} AND ${walk(b, p, c)}`);
export const inArray = (c, arr) =>
  expr((p) => (arr.length
    ? `${walk(c, p)} IN (${arr.map((v) => walk(v, p, c)).join(', ')})`
    : '1=0'));
export const notInArray = (c, arr) =>
  expr((p) => (arr.length
    ? `${walk(c, p)} NOT IN (${arr.map((v) => walk(v, p, c)).join(', ')})`
    : '1=1'));

export const count = (c) => expr((p) => (c ? `count(${walk(c, p)})` : 'count(*)'));
export const sum = (c) => expr((p) => `sum(${walk(c, p)})`);
export const avg = (c) => expr((p) => `avg(${walk(c, p)})`);
export const min = (c) => expr((p) => `min(${walk(c, p)})`);
export const max = (c) => expr((p) => `max(${walk(c, p)})`);

export const asc = (col) => ({ __order: true, col, dir: 'ASC' });
export const desc = (col) => ({ __order: true, col, dir: 'DESC' });

// -------------------------------------------------------------------- queries

function run(text, params) {
  const stmt = handle.prepare(text);
  return stmt.run(...params);
}

function allRows(text, params) {
  return handle.prepare(text).all(...params).map((r) => ({ ...r }));
}

class Select {
  constructor(projection) {
    this.projection = projection ?? null;
    this.table = null;
    this.conds = [];
    this.orders = [];
    this.groups = [];
    this.havingCond = null;
    this.limitN = null;
    this.offsetN = null;
    this.isDistinct = false;
  }

  from(t) { this.table = t; return this; }
  where(...c) { this.conds.push(...c.filter(Boolean)); return this; }
  orderBy(...o) { this.orders.push(...o); return this; }
  groupBy(...g) { this.groups.push(...g); return this; }
  having(c) { this.havingCond = c; return this; }
  limit(n) { this.limitN = n; return this; }
  offset(n) { this.offsetN = n; return this; }
  distinct() { this.isDistinct = true; return this; }

  build() {
    const params = [];
    let selectList;
    const converters = [];
    if (this.projection) {
      selectList = Object.entries(this.projection).map(([alias, node]) => {
        converters.push([alias, node?.__col ? node : null]);
        return `${walk(node, params)} AS "${alias}"`;
      }).join(', ');
    } else {
      selectList = this.table.$columns.filter((c) => !c.$deprecated).map((c) => {
        converters.push([c.key, c]);
        return `"${c.table}"."${c.name}" AS "${c.key}"`;
      }).join(', ');
    }

    let text = `SELECT ${this.isDistinct ? 'DISTINCT ' : ''}${selectList} FROM "${this.table.$name}"`;
    if (this.conds.length) text += ` WHERE ${walk(and(...this.conds), params)}`;
    if (this.groups.length) text += ` GROUP BY ${this.groups.map((g) => walk(g, params)).join(', ')}`;
    if (this.havingCond) text += ` HAVING ${walk(this.havingCond, params)}`;
    if (this.orders.length) text += ` ORDER BY ${this.orders.map((o) => walk(o, params)).join(', ')}`;
    if (this.limitN != null) text += ` LIMIT ${Number(this.limitN)}`;
    if (this.offsetN != null) text += ` OFFSET ${Number(this.offsetN)}`;
    return { text, params, converters };
  }

  async all() {
    const { text, params, converters } = this.build();
    return allRows(text, params).map((row) => convertRow(row, converters));
  }

  async get() {
    const rows = await this.limit(this.limitN ?? 1).all();
    return rows[0] ?? null;
  }

  async values() {
    const { text, params } = this.build();
    return handle.prepare(text).all(...params).map((r) => Object.values(r));
  }

  then(resolve, reject) { return this.all().then(resolve, reject); }
}

function convertRow(row, converters) {
  const out = {};
  for (const [key, col] of converters) out[key] = fromSqlValue(row[key], col);
  return out;
}

class Insert {
  constructor(t) { this.table = t; this.rows = []; this.returningProjection = undefined; }

  values(v) { this.rows = Array.isArray(v) ? v : [v]; return this; }

  returning(projection) { this.returningProjection = projection ?? null; return this; }

  async run() {
    const results = [];
    let affected = 0;
    let lastId = 0;

    for (const row of this.rows) {
      const cols = Object.keys(row).filter((k) => this.table[k]);
      const params = cols.map((k) => toSqlValue(row[k], this.table[k]));
      const names = cols.map((k) => `"${this.table[k].name}"`).join(', ');
      const holes = cols.map(() => '?').join(', ');

      let text = `INSERT INTO "${this.table.$name}" (${names}) VALUES (${holes})`;
      let converters = null;
      if (this.returningProjection !== undefined) {
        if (this.returningProjection === null) {
          converters = this.table.$columns.filter((c) => !c.$deprecated).map((c) => [c.key, c]);
          text += ` RETURNING ${converters.map(([key, c]) => `"${c.name}" AS "${key}"`).join(', ')}`;
        } else {
          const ps = [];
          converters = Object.entries(this.returningProjection).map(([alias, node]) => [alias, node?.__col ? node : null]);
          text += ` RETURNING ${Object.entries(this.returningProjection)
            .map(([alias, node]) => `${walk(node, ps)} AS "${alias}"`).join(', ')}`;
          params.push(...ps);
        }
        results.push(...allRows(text, params).map((r) => convertRow(r, converters)));
        affected += 1;
      } else {
        const res = run(text, params);
        affected += Number(res.changes ?? 0);
        lastId = Number(res.lastInsertRowid ?? 0);
      }
    }

    if (this.returningProjection !== undefined) return results;
    return { rowsAffected: affected, lastInsertRowid: lastId, rows: [] };
  }

  onConflictDoNothing() { this.conflict = 'nothing'; return this; }
  onConflictDoUpdate() { this.conflict = 'update'; return this; }

  then(resolve, reject) { return this.run().then(resolve, reject); }
}

class Update {
  constructor(t) { this.table = t; this.patch = null; this.conds = []; }
  set(patch) { this.patch = patch; return this; }
  where(...c) { this.conds.push(...c.filter(Boolean)); return this; }

  async run() {
    if (!this.patch) throw new Error('update() requires .set()');
    const params = [];
    const sets = Object.keys(this.patch)
      .filter((k) => this.table[k])
      .map((k) => {
        params.push(toSqlValue(this.patch[k], this.table[k]));
        return `"${this.table[k].name}" = ?`;
      });
    if (!sets.length) return { rowsAffected: 0, lastInsertRowid: 0, rows: [] };
    let text = `UPDATE "${this.table.$name}" SET ${sets.join(', ')}`;
    if (this.conds.length) text += ` WHERE ${walk(and(...this.conds), params)}`;
    const res = run(text, params);
    return { rowsAffected: Number(res.changes ?? 0), lastInsertRowid: 0, rows: [] };
  }

  then(resolve, reject) { return this.run().then(resolve, reject); }
}

class Delete {
  constructor(t) { this.table = t; this.conds = []; }
  where(...c) { this.conds.push(...c.filter(Boolean)); return this; }
  async run() {
    const params = [];
    let text = `DELETE FROM "${this.table.$name}"`;
    if (this.conds.length) text += ` WHERE ${walk(and(...this.conds), params)}`;
    const res = run(text, params);
    return { rowsAffected: Number(res.changes ?? 0), lastInsertRowid: 0, rows: [] };
  }
  then(resolve, reject) { return this.run().then(resolve, reject); }
}

function rawArgs(query, params) {
  if (query?.__sql) return compile(query);
  const named = {};
  for (const [k, v] of Object.entries(params ?? {})) named[k.replace(/^:/, '')] = toSqlValue(v);
  return { text: query, params: [named] };
}

export const db = {
  select: (projection) => new Select(projection),
  insert: (t) => new Insert(t),
  update: (t) => new Update(t),
  delete: (t) => new Delete(t),

  async $count(t, where) {
    const params = [];
    let text = `SELECT count(*) AS c FROM "${t.$name}"`;
    if (where) text += ` WHERE ${walk(where, params)}`;
    return Number(handle.prepare(text).get(...params).c);
  },

  async run(query, params) {
    const a = rawArgs(query, params);
    const res = handle.prepare(a.text).run(...a.params);
    return { rowsAffected: Number(res.changes ?? 0), lastInsertRowid: Number(res.lastInsertRowid ?? 0), rows: [] };
  },
  async all(query, params) {
    const a = rawArgs(query, params);
    return handle.prepare(a.text).all(...a.params).map((r) => ({ ...r }));
  },
  async get(query, params) {
    const a = rawArgs(query, params);
    return handle.prepare(a.text).get(...a.params) ?? null;
  },
  async values(query, params) {
    const a = rawArgs(query, params);
    return handle.prepare(a.text).all(...a.params).map((r) => Object.values(r));
  },
};

export default db;
