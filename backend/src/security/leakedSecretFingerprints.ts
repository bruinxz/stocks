import { createHash } from 'crypto';

/**
 * SHA-256 fingerprints of credentials or defaults that have appeared in
 * repository history, plus the retired production endpoint literal. The
 * plaintext values must never be reintroduced merely to implement a deny-list.
 */
export const KNOWN_LEAKED_SECRET_FINGERPRINTS: ReadonlySet<string> = new Set([
  '0d356ede0ba49981912e357d2b5ef4a870a721fd186a5b0881e7425f08b68e13',
  '24334c4276e9bdb5c3e9f01b272925f1fa35fb3bd0192d8e216cc41d84f1f1b3',
  '38870238ba0a8baaccffce8a66e37898416a021797e7e6b568af7d8d4fa3cd10',
  '4040195caad6708831380b7034070efcf099872d312ced898cd20c3ada472213',
  '55d857c4e5b55b11c204b06c9214fb7ff490204057c59bb62bb28573e45b50ab',
  '8353afcd57311fdf88c93955049cd6f6dd0da2805ac6bb4c7b39463dd754ea03',
  'b0689b947a131ddf404d10fca73b5977ca91e8c5c7af3330f33cc9bcf3d8e492',
]);

export function secretFingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function isKnownLeakedSecret(
  value: string,
  fingerprints: ReadonlySet<string> = KNOWN_LEAKED_SECRET_FINGERPRINTS
): boolean {
  return fingerprints.has(secretFingerprint(value.trim()));
}
