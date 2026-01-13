import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as secp256k1 from "@noble/secp256k1";
import type { NostrEvent } from "./types";

// Configure secp256k1 with sha256 for schnorr operations
secp256k1.hashes.sha256 = (msg: Uint8Array) => sha256(msg);
secp256k1.hashes.hmacSha256 = (key: Uint8Array, ...msgs: Uint8Array[]) => {
  const combined = new Uint8Array(msgs.reduce((acc, m) => acc + m.length, 0));
  let offset = 0;
  for (const m of msgs) {
    combined.set(m, offset);
    offset += m.length;
  }
  return hmac(sha256, key, combined);
};

// Serialize event for hashing per NIP-01
function serializeEvent(event: NostrEvent): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

// Compute event ID from event data
export function computeEventId(event: NostrEvent): string {
  const serialized = serializeEvent(event);
  const hash = sha256(new TextEncoder().encode(serialized));
  return bytesToHex(hash);
}

// Verify event ID matches computed hash
export function verifyEventId(event: NostrEvent): boolean {
  const computedId = computeEventId(event);
  return computedId === event.id;
}

// Verify Schnorr signature (BIP340 as required by NIP-01)
export function verifySignature(event: NostrEvent): boolean {
  try {
    const messageHash = sha256(new TextEncoder().encode(serializeEvent(event)));
    const signature = hexToBytes(event.sig);
    const publicKey = hexToBytes(event.pubkey);

    // Use schnorr.verify for BIP340 signatures
    return secp256k1.schnorr.verify(signature, messageHash, publicKey);
  } catch {
    return false;
  }
}

// Convert hex string to Uint8Array
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Validate event structure
export function validateEventStructure(
  event: unknown
): { valid: false; error: string } | { valid: true; event: NostrEvent } {
  if (!event || typeof event !== "object") {
    return { valid: false, error: "invalid: event must be an object" };
  }

  const e = event as Record<string, unknown>;

  // Check id
  if (typeof e.id !== "string" || !/^[a-f0-9]{64}$/.test(e.id)) {
    return {
      valid: false,
      error: "invalid: id must be 64 lowercase hex characters",
    };
  }

  // Check pubkey
  if (typeof e.pubkey !== "string" || !/^[a-f0-9]{64}$/.test(e.pubkey)) {
    return {
      valid: false,
      error: "invalid: pubkey must be 64 lowercase hex characters",
    };
  }

  // Check created_at
  if (typeof e.created_at !== "number" || !Number.isInteger(e.created_at)) {
    return { valid: false, error: "invalid: created_at must be an integer" };
  }

  // Check kind
  if (
    typeof e.kind !== "number" ||
    !Number.isInteger(e.kind) ||
    e.kind < 0 ||
    e.kind > 65535
  ) {
    return {
      valid: false,
      error: "invalid: kind must be an integer between 0 and 65535",
    };
  }

  // Check tags
  if (!Array.isArray(e.tags)) {
    return { valid: false, error: "invalid: tags must be an array" };
  }
  for (const tag of e.tags) {
    if (!Array.isArray(tag)) {
      return { valid: false, error: "invalid: each tag must be an array" };
    }
    for (const item of tag) {
      if (typeof item !== "string") {
        return {
          valid: false,
          error: "invalid: tag elements must be strings",
        };
      }
    }
  }

  // Check content
  if (typeof e.content !== "string") {
    return { valid: false, error: "invalid: content must be a string" };
  }

  // Check sig
  if (typeof e.sig !== "string" || !/^[a-f0-9]{128}$/.test(e.sig)) {
    return {
      valid: false,
      error: "invalid: sig must be 128 lowercase hex characters",
    };
  }

  return { valid: true, event: e as unknown as NostrEvent };
}

// Full event validation
export async function validateEvent(
  event: unknown
): Promise<{ valid: false; error: string } | { valid: true; event: NostrEvent }> {
  // Structure validation
  const structureResult = validateEventStructure(event);
  if (!structureResult.valid) {
    return structureResult;
  }

  const validEvent = structureResult.event;

  // ID verification
  if (!verifyEventId(validEvent)) {
    return { valid: false, error: "invalid: event id does not match content" };
  }

  // Signature verification
  const sigValid = verifySignature(validEvent);
  if (!sigValid) {
    return { valid: false, error: "invalid: signature verification failed" };
  }

  // Timestamp validation (reject events too far in the future)
  const now = Math.floor(Date.now() / 1000);
  const maxFuture = 60 * 15; // 15 minutes
  if (validEvent.created_at > now + maxFuture) {
    return {
      valid: false,
      error: "invalid: event creation date is too far off from the current time",
    };
  }

  return { valid: true, event: validEvent };
}
