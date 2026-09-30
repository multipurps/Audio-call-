import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

// In-memory Supabase query double: all writes execute synchronously at await,
// including conditional updates, so concurrent claim tests exercise the CAS.
export function database(seed = {}) {
  const tables = structuredClone(seed);
  return { tables, from(table) {
    tables[table] ||= [];
    let mode = 'select', values, one = false, cap = Infinity, ordering;
    const filters = [];
    const q = {
      select() { return q; },
      insert(value) { mode = 'insert'; values = value; return q; },
      update(value) { mode = 'update'; values = value; return q; },
      delete() { mode = 'delete'; return q; },
      eq(key, value) { filters.push((r) => r[key] === value); return q; },
      neq(key, value) { filters.push((r) => r[key] !== value); return q; },
      gt(key, value) { filters.push((r) => r[key] > value); return q; },
      is(key, value) {
        // Postgres `IS NULL` matches both NULL and absent columns; the
        // in-memory rows use undefined for absent, so compare loosely for null.
        if (value === null) { filters.push((r) => r[key] == null); return q; }
        return q.eq(key, value);
      },
      not(key, op, value) { return q.neq(key, value); },
      in(key, values) { filters.push((r) => values.includes(r[key])); return q; },
      order(key, options) { ordering = { key, ...options }; return q; },
      limit(value) { cap = value; return q; },
      single() { one = true; return q; },
      maybeSingle() { one = true; return q; },
      then(ok, fail) {
        try {
          let rows = tables[table].filter((r) => filters.every((f) => f(r)));
          if (mode === 'insert') {
            rows = (Array.isArray(values) ? values : [values]).map((value) => ({
              id: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
              ...(table === 'call_plans' ? { status: 'pending', expires_at: new Date(Date.now() + 86400000).toISOString() } : {}),
              ...(table === 'chat_sessions' ? { archived: false } : {}), ...value,
            }));
            tables[table].push(...rows);
          }
          if (mode === 'update') rows.forEach((r) => Object.assign(r, values));
          if (mode === 'delete') tables[table] = tables[table].filter((r) => !rows.includes(r));
          if (ordering) rows.sort((a, b) => String(a[ordering.key]).localeCompare(String(b[ordering.key])) * (ordering.ascending === false ? -1 : 1));
          rows = rows.slice(0, cap);
          return Promise.resolve({ data: structuredClone(one ? rows[0] || null : rows), error: null }).then(ok, fail);
        } catch (err) { return Promise.reject(err).then(ok, fail); }
      },
    };
    return q;
  } };
}

export async function loadApi(file, db, fetcher, extraEnv = {}) {
  const context = vm.createContext({ console, URLSearchParams, Buffer, Date, Map, Set, AbortSignal,
    FormData, Blob,
    fetch: fetcher, process: { env: { OPENAI_API_KEY: 'test-only', TWILIO_ACCOUNT_SID: 'test-only',
      TWILIO_AUTH_TOKEN: 'test-only', TWILIO_FROM_NUMBER: '+14155550000', PUBLIC_APP_URL: 'https://example.test', ...extraEnv } },
  });
  const cache = new Map();
  const builtins = new Map();
  async function loadBuiltin(specifier) {
    if (builtins.has(specifier)) return builtins.get(specifier);
    const ns = await import(specifier);
    const keys = Object.keys(ns);
    const module = new vm.SyntheticModule(keys, function () {
      for (const key of keys) this.setExport(key, ns[key]);
    }, { context, identifier: specifier });
    builtins.set(specifier, module);
    return module;
  }
  async function load(path) {
    if (cache.has(path)) return cache.get(path);
    let module;
    if (path.endsWith('/supabaseAdmin.js')) {
      module = new vm.SyntheticModule(['getServiceClient', 'getAuthedUserId'], function () {
        this.setExport('getServiceClient', () => db);
        this.setExport('getAuthedUserId', async (req) => req.headers?.authorization === 'Bearer test' ? 'user-1' : null);
      }, { context });
    } else {
      module = new vm.SourceTextModule(await readFile(path, 'utf8'), { context, identifier: path });
    }
    cache.set(path, module);
    await module.link((specifier) => {
      if (specifier.startsWith('node:') || (!specifier.startsWith('.') && !specifier.startsWith('/'))) {
        return loadBuiltin(specifier);
      }
      return load(resolve(dirname(path), specifier));
    });
    return module;
  }
  const module = await load(resolve(file));
  await module.evaluate();
  return module.namespace;
}

export function response() {
  return { code: 200, data: null, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
}
export async function request(handler, action, body = {}, { method = 'POST', auth = true, query = {} } = {}) {
  const res = response();
  await handler({ method, headers: { authorization: auth ? 'Bearer test' : '' }, query: { action, ...query }, body }, res);
  return res;
}
