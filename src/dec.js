// Exact decimal helpers (BigInt based) mirroring the Python Decimal operations used by arcus.py.
export function parse(x) {
  let s = typeof x === 'number' ? numToStr(x) : String(x).trim();
  let neg = false;
  if (s[0] === '-' || s[0] === '+') { neg = s[0] === '-'; s = s.slice(1); }
  let exp = 0;
  const e = s.search(/[eE]/);
  if (e >= 0) { exp = parseInt(s.slice(e + 1), 10); s = s.slice(0, e); }
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') throw new Error('bad decimal: ' + x);
  const [ip, fp = ''] = s.split('.');
  let n = BigInt((ip || '0') + fp);
  let scale = fp.length - exp;
  if (scale < 0) { n *= 10n ** BigInt(-scale); scale = 0; }
  return { n: neg ? -n : n, s: scale };
}
function numToStr(x) {
  if (!Number.isFinite(x)) throw new Error('bad number');
  return String(x); // shortest round-trip repr, same digits as Python repr/str(float)
}
const p10 = (k) => 10n ** BigInt(k);
function align(a, b) {
  const s = Math.max(a.s, b.s);
  return [a.n * p10(s - a.s), b.n * p10(s - b.s), s];
}
export function toStr(d) {
  const neg = d.n < 0n;
  let digits = (neg ? -d.n : d.n).toString();
  if (d.s > 0) {
    digits = digits.padStart(d.s + 1, '0');
    digits = digits.slice(0, -d.s) + '.' + digits.slice(-d.s);
  }
  return (neg ? '-' : '') + digits;
}
export function normalize(x) {
  let s = toStr(parse(x));
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}
function divRound(num, den, mode) { // integer division with rounding mode, den > 0
  let q = num / den; const r = num % den;
  if (r === 0n) return q;
  if (mode === 'floor') return num < 0n ? q - 1n : q;
  if (mode === 'ceil') return num > 0n ? q + 1n : q;
  // half-even (Python Decimal default for to_integral_value)
  const twice = 2n * (r < 0n ? -r : r);
  const dir = num < 0n ? -1n : 1n;
  if (twice > den) return q + dir;
  if (twice < den) return q;
  return (q % 2n === 0n) ? q : q + dir;
}
// count of `unit` in value, rounded (BigInt)
export function units(value, unit, mode = 'exact') {
  const [a, b] = align(parse(value), parse(unit));
  if (b <= 0n) throw new Error('unit must be > 0');
  if (mode === 'exact') {
    if (a % b !== 0n) throw new Error(`${value} is not a multiple of ${unit}`);
    return a / b;
  }
  return divRound(a, b, mode);
}
// Python: (Decimal(v)/Decimal(tick)).to_integral_value(rounding) * Decimal(tick)  -> string with tick's scale
export function snap(value, tick, mode) {
  const k = units(value, tick, mode);
  const t = parse(tick);
  return toStr({ n: k * t.n, s: t.s });
}
export function mul(a, b) { const x = parse(a), y = parse(b); return toStr({ n: x.n * y.n, s: x.s + y.s }); }
export function add(a, b) { const [x, y, s] = align(parse(a), parse(b)); return toStr({ n: x + y, s }); }
export function sub(a, b) { const [x, y, s] = align(parse(a), parse(b)); return toStr({ n: x - y, s }); }
export function cmp(a, b) { const [x, y] = align(parse(a), parse(b)); return x < y ? -1 : x > y ? 1 : 0; }
