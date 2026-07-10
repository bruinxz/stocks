import type { Score } from "./types";

export function generateScoringId(): string {
  return globalThis.crypto.randomUUID();
}

export async function computeSnapshotHash(
  score: Omit<Score, "scoring_id" | "snapshot_hash">,
): Promise<string> {
  const canonical = jcsCanonicalizeJson(score);
  return sha256Hex(canonical);
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await globalThis.crypto.subtle.digest(
    "SHA-256",
    data,
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function jcsCanonicalizeJson(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "boolean") return obj.toString();
  if (typeof obj === "number") return jcsCanonicalNumber(obj);
  if (typeof obj === "string") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(jcsCanonicalizeJson).join(",") + "]";
  }
  if (typeof obj === "object") {
    const keys = Object.keys(
      obj as Record<string, unknown>,
    ).sort();
    const entries = keys
      .filter(
        (k) =>
          (obj as Record<string, unknown>)[k] !== undefined,
      )
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          jcsCanonicalizeJson(
            (obj as Record<string, unknown>)[k],
          ),
      );
    return "{" + entries.join(",") + "}";
  }
  throw new Error(`Unsupported JCS type: ${typeof obj}`);
}

function jcsCanonicalNumber(n: number): string {
  if (Object.is(n, -0)) return "0";
  if (!Number.isFinite(n))
    throw new Error("JCS does not support Infinity or NaN");
  return JSON.stringify(n);
}
