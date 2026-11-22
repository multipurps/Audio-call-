// No region guessing: normalize formatting, require an international number.
export function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  const number = value.trim().replace(/[\s().-]/g, '').replace(/^00/, '+');
  return /^\+[1-9]\d{6,14}$/.test(number) ? number : null;
}

// Two ways of writing the same number: identical digits, or one is the other without its country code.
export function sameNumber(a, b) {
  const x = String(a || '').replace(/\D/g, '').replace(/^0+/, '');
  const y = String(b || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 9 && long.endsWith(short);
}
