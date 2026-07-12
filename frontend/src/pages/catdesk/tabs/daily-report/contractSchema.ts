export type ExactObject = Record<string, unknown>;

export class ContractSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractSchemaError';
  }
}

export function assertExactObject(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  path: string
): ExactObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractSchemaError(`${path} must be an object`);
  }
  const result = value as ExactObject;
  const missing = requiredKeys.filter(key => !Object.prototype.hasOwnProperty.call(result, key));
  if (missing.length) {
    throw new ContractSchemaError(`${path} is missing required fields: ${missing.join(', ')}`);
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const unknown = Object.keys(result).filter(key => !allowed.has(key));
  if (unknown.length) {
    throw new ContractSchemaError(`${path} contains unknown fields: ${unknown.join(', ')}`);
  }
  return result;
}

export function strictString(
  value: unknown,
  path: string,
  options: { min?: number; max?: number } = {}
): string {
  const min = options.min ?? 1;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new ContractSchemaError(`${path} must be a string with length ${min}..${max}`);
  }
  return value;
}

export function strictOptionalString(
  value: unknown,
  path: string,
  options: { min?: number; max?: number } = {}
): string | undefined {
  return value === undefined ? undefined : strictString(value, path, options);
}

export function strictNumber(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; integer?: boolean } = {}
): number {
  const min = options.min ?? Number.NEGATIVE_INFINITY;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (options.integer && !Number.isInteger(value))
  ) {
    throw new ContractSchemaError(`${path} must be a finite number in ${min}..${max}`);
  }
  return value;
}

export function strictBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ContractSchemaError(`${path} must be boolean`);
  }
  return value;
}

export function strictArray<T = unknown>(
  value: unknown,
  path: string,
  options: { min?: number; max?: number } = {}
): T[] {
  const min = options.min ?? 0;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new ContractSchemaError(`${path} must be an array with length ${min}..${max}`);
  }
  return value as T[];
}

export function strictStringArray(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; itemMax?: number } = {}
): string[] {
  const values = strictArray(value, path, options);
  return values.map((item, index) =>
    strictString(item, `${path}[${index}]`, { max: options.itemMax })
  );
}

export function strictUuidV4(value: unknown, path: string): string {
  const parsed = strictString(value, path);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) {
    throw new ContractSchemaError(`${path} must be UUIDv4`);
  }
  return parsed;
}

export function strictSha256(value: unknown, path: string): string {
  const parsed = strictString(value, path, { min: 64, max: 64 });
  if (!/^[0-9a-f]{64}$/.test(parsed)) {
    throw new ContractSchemaError(`${path} must be lowercase SHA-256`);
  }
  return parsed;
}

export function strictIso8601(value: unknown, path: string): string {
  const parsed = strictString(value, path);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(parsed) ||
    !Number.isFinite(Date.parse(parsed))
  ) {
    throw new ContractSchemaError(`${path} must be timezone-bearing ISO8601`);
  }
  return parsed;
}

export function strictSemVer(value: unknown, path: string): string {
  const parsed = strictString(value, path);
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(parsed)) {
    throw new ContractSchemaError(`${path} must be SemVer`);
  }
  return parsed;
}

export function jcsCanonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ContractSchemaError('JCS rejects non-finite numbers');
    if (Object.is(value, -0)) return '0';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcsCanonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const source = value as ExactObject;
    return `{${Object.keys(source)
      .filter(key => source[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${jcsCanonicalize(source[key])}`)
      .join(',')}}`;
  }
  throw new ContractSchemaError(`JCS rejects ${typeof value}`);
}

export function sha256Text(input: string): string {
  const encoded = unescape(encodeURIComponent(input));
  const bytes = new Uint8Array(encoded.length);
  for (let index = 0; index < encoded.length; index += 1) {
    bytes[index] = encoded.charCodeAt(index);
  }
  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(bytes);
  message[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(message.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  const rotateRight = (value: number, count: number) => (value >>> count) | (value << (32 - count));

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15];
      const b = words[index - 2];
      const sigma0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const sigma1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return Array.from(hash, value => value.toString(16).padStart(8, '0')).join('');
}
