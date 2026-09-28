export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Strips control characters and bidi overrides that can be used to spoof names.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const UNSAFE_CHARS_KEEP_NEWLINES = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

export function text(value, field, { min = 1, max, multiline = false }) {
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  const cleaned = value.replace(multiline ? UNSAFE_CHARS_KEEP_NEWLINES : UNSAFE_CHARS, '').trim();
  if (cleaned.length < min || cleaned.length > max) {
    throw new HttpError(400, `${field} must be ${min}-${max} characters`);
  }
  return cleaned;
}

export function username(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(value)) {
    throw new HttpError(400, 'Username must be 3-32 characters: letters, numbers, _ . -');
  }
  return value;
}

export function password(value, field = 'Password') {
  if (typeof value !== 'string' || value.length < 10 || value.length > 200) {
    throw new HttpError(400, `${field} must be 10-200 characters`);
  }
  return value;
}

export function id(value, field = 'id') {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/.test(value)) {
    throw new HttpError(404, `Unknown ${field}`);
  }
  return value;
}

export function inviteCode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,32}$/.test(value)) {
    throw new HttpError(404, 'Invite not found or expired');
  }
  return value;
}

export function optionalInt(value, field, { min, max }) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${field} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

export function oneOf(value, field, options) {
  if (!options.includes(value)) throw new HttpError(400, `${field} must be one of: ${options.join(', ')}`);
  return value;
}
