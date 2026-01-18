// Nostr event structure per NIP-01
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

// Filter for REQ subscriptions per NIP-01
export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  // Single-letter tag filters like #e, #p, #d, #i, #v
  [key: `#${string}`]: string[] | undefined;
}

// Subscription tracking
export interface Subscription {
  id: string;
  filters: NostrFilter[];
}

// Changes subscription options
export interface ChangesSubOptions {
  since?: number;
  kinds?: number[];
  authors?: string[];
}

// Changes subscription tracking
export interface ChangesSubscription {
  id: string;
  options: ChangesSubOptions;
}

// Client connection state
export interface ClientState {
  subscriptions: Map<string, Subscription>;
  changesSubscriptions: Map<string, ChangesSubscription>;
}

// Message types from client to relay
export type ClientMessage =
  | ["EVENT", NostrEvent]
  | ["REQ", string, ...NostrFilter[]]
  | ["CLOSE", string];

// Changes feed types
export interface ChangeEntry {
  seq: number;
  event: NostrEvent;
}

export interface ChangesResult {
  changes: ChangeEntry[];
  lastSeq: number;
}

// Message types from relay to client
export type RelayMessage =
  | ["EVENT", string, NostrEvent]
  | ["OK", string, boolean, string]
  | ["EOSE", string]
  | ["CLOSED", string, string]
  | ["NOTICE", string]
  | ["CHANGES", ChangesResult]
  | ["LASTSEQ", number]
  | ["CHANGES_EVENT", string, ChangeEntry]
  | ["CHANGES_EOSE", string, { lastSeq: number }];

// Event kind ranges per NIP-01 and NIP-DB
export const KIND_RANGES = {
  REGULAR_LOW: { min: 1, max: 2 },
  REGULAR_MID: { min: 4, max: 44 },
  REGULAR_HIGH: { min: 1000, max: 9999 },
  REPLACEABLE: { min: 10000, max: 19999 },
  REPLACEABLE_SPECIAL: [0, 3],
  EPHEMERAL: { min: 20000, max: 29999 },
  ADDRESSABLE: { min: 30000, max: 39999 },
  SYNCABLE: { min: 40000, max: 49999 },
  PURGE: 49999,
} as const;

export function isRegularKind(kind: number): boolean {
  return (
    kind === 1 ||
    kind === 2 ||
    (kind >= 4 && kind < 45) ||
    (kind >= 1000 && kind < 10000)
  );
}

export function isReplaceableKind(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

export function isEphemeralKind(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

export function isAddressableKind(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

export function isSyncableKind(kind: number): boolean {
  return kind >= 40000 && kind < 50000;
}

export function isPurgeKind(kind: number): boolean {
  return kind === KIND_RANGES.PURGE;
}
