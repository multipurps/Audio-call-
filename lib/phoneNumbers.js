// No region guessing: normalize formatting, require an international number.
export function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  const number = value.trim().replace(/[\s().-]/g, '').replace(/^00/, '+');
  return /^\+[1-9]\d{6,14}$/.test(number) ? number : null;
}
