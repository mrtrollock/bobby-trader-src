// Python-compatible json.dumps(obj, separators=(",", ":"), sort_keys=True) (ensure_ascii=True), with BigInt support.
export function pyJson(v, sort = true) {
  if (v === null || v === undefined) return 'null';
  const t = typeof v;
  if (t === 'bigint') return v.toString();
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number');
    if (!Number.isInteger(v)) throw new Error('float in canonical JSON not allowed: ' + v);
    if (!Number.isSafeInteger(v)) throw new Error('unsafe integer, use BigInt: ' + v);
    return String(v);
  }
  if (t === 'string') return pyStr(v);
  if (Array.isArray(v)) return '[' + v.map((x) => pyJson(x, sort)).join(',') + ']';
  if (t === 'object') {
    let keys = Object.keys(v).filter((k) => v[k] !== undefined);
    if (sort) keys = keys.sort();
    return '{' + keys.map((k) => pyStr(k) + ':' + pyJson(v[k], sort)).join(',') + '}';
  }
  throw new Error('unsupported type ' + t);
}
function pyStr(s) {
  return JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
