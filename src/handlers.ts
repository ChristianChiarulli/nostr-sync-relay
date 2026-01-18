import type { ServerWebSocket } from "bun";
import type {
  NostrEvent,
  NostrFilter,
  ClientState,
  Subscription,
  ChangesSubscription,
  ChangesSubOptions,
  RelayMessage,
} from "./types";
import { isPurgeKind, KIND_RANGES } from "./types";
import { validateEvent } from "./validation";
import { validateFilter, matchesFilters } from "./filters";
import { storeEvent, queryEvents, queryChanges, getLastSeq, purgeDocument } from "./db";

// Map of all connected clients
export const clients = new Map<ServerWebSocket<ClientState>, ClientState>();

// Send a message to a client
function send(ws: ServerWebSocket<ClientState>, message: RelayMessage): void {
  ws.send(JSON.stringify(message));
}

// Check if an event matches changes subscription options
function matchesChangesOptions(event: NostrEvent, options: ChangesSubOptions): boolean {
  if (options.kinds && options.kinds.length > 0) {
    if (!options.kinds.includes(event.kind)) return false;
  }
  if (options.authors && options.authors.length > 0) {
    if (!options.authors.includes(event.pubkey)) return false;
  }
  return true;
}

// Broadcast an event to all clients with matching subscriptions
function broadcast(
  event: NostrEvent,
  seq: number,
  excludeWs?: ServerWebSocket<ClientState>
): void {
  for (const [ws, state] of clients) {
    if (ws === excludeWs) continue;

    // Broadcast to regular subscriptions
    for (const [subId, subscription] of state.subscriptions) {
      if (matchesFilters(event, subscription.filters)) {
        send(ws, ["EVENT", subId, event]);
        break; // Only send once per client even if multiple subs match
      }
    }

    // Broadcast to changes subscriptions
    for (const [subId, changesSub] of state.changesSubscriptions) {
      if (matchesChangesOptions(event, changesSub.options)) {
        send(ws, ["CHANGES_EVENT", subId, { seq, event }]);
      }
    }
  }
}

// Helper to get tag value
function getTagValue(event: NostrEvent, tagName: string): string | null {
  const tag = event.tags.find((t) => t[0] === tagName);
  return tag?.[1] ?? null;
}

// Handle EVENT message
export async function handleEvent(
  ws: ServerWebSocket<ClientState>,
  event: unknown
): Promise<void> {
  const validation = await validateEvent(event);

  if (!validation.valid) {
    send(ws, [
      "OK",
      (event as { id?: string })?.id ?? "",
      false,
      validation.error,
    ]);
    return;
  }

  const validEvent = validation.event;

  // Handle purge events (kind 49999)
  if (isPurgeKind(validEvent.kind)) {
    const docId = getTagValue(validEvent, "d");
    const kindStr = getTagValue(validEvent, "k");

    if (!docId || !kindStr) {
      send(ws, ["OK", validEvent.id, false, "invalid: purge event must have d and k tags"]);
      return;
    }

    const targetKind = parseInt(kindStr, 10);
    if (isNaN(targetKind) || targetKind < KIND_RANGES.SYNCABLE.min || targetKind >= KIND_RANGES.PURGE) {
      send(ws, ["OK", validEvent.id, false, "invalid: k tag must be a valid syncable kind"]);
      return;
    }

    // Purge the document (delete all revisions)
    const purgeResult = purgeDocument(validEvent.pubkey, targetKind, docId);
    console.log(`Purged document: pubkey=${validEvent.pubkey.slice(0, 8)}... kind=${targetKind} d=${docId} (${purgeResult.deletedCount} events deleted)`);

    // Store the purge event itself (so it replicates)
    const result = storeEvent(validEvent);
    send(ws, ["OK", validEvent.id, result.success, result.message]);

    // Broadcast the purge event to subscribers
    if (result.success && result.seq !== undefined) {
      broadcast(validEvent, result.seq);

      const state = clients.get(ws);
      if (state) {
        for (const [subId, subscription] of state.subscriptions) {
          if (matchesFilters(validEvent, subscription.filters)) {
            send(ws, ["EVENT", subId, validEvent]);
            break;
          }
        }
        for (const [subId, changesSub] of state.changesSubscriptions) {
          if (matchesChangesOptions(validEvent, changesSub.options)) {
            send(ws, ["CHANGES_EVENT", subId, { seq: result.seq, event: validEvent }]);
          }
        }
      }
    }
    return;
  }

  const result = storeEvent(validEvent);

  send(ws, ["OK", validEvent.id, result.success, result.message]);

  // Broadcast to other clients with matching subscriptions
  if (result.success && result.seq !== undefined) {
    broadcast(validEvent, result.seq);

    // Also check if this event matches any subscriptions on the sender
    const state = clients.get(ws);
    if (state) {
      for (const [subId, subscription] of state.subscriptions) {
        if (matchesFilters(validEvent, subscription.filters)) {
          send(ws, ["EVENT", subId, validEvent]);
          break;
        }
      }
      // Also send to sender's changes subscriptions
      for (const [subId, changesSub] of state.changesSubscriptions) {
        if (matchesChangesOptions(validEvent, changesSub.options)) {
          send(ws, ["CHANGES_EVENT", subId, { seq: result.seq, event: validEvent }]);
        }
      }
    }
  }
}

// Handle REQ message
export function handleReq(
  ws: ServerWebSocket<ClientState>,
  subscriptionId: string,
  filters: unknown[]
): void {
  const state = clients.get(ws);
  if (!state) return;

  // Validate subscription ID
  if (
    typeof subscriptionId !== "string" ||
    subscriptionId.length === 0 ||
    subscriptionId.length > 64
  ) {
    send(ws, [
      "CLOSED",
      subscriptionId,
      "invalid: subscription id must be 1-64 characters",
    ]);
    return;
  }

  // Validate all filters
  const validatedFilters: NostrFilter[] = [];
  for (const filter of filters) {
    const result = validateFilter(filter);
    if (!result.valid) {
      send(ws, ["CLOSED", subscriptionId, `invalid: ${result.error}`]);
      return;
    }
    validatedFilters.push(result.filter);
  }

  if (validatedFilters.length === 0) {
    send(ws, [
      "CLOSED",
      subscriptionId,
      "invalid: at least one filter required",
    ]);
    return;
  }

  // Store subscription (replacing if same ID exists)
  const subscription: Subscription = {
    id: subscriptionId,
    filters: validatedFilters,
  };
  state.subscriptions.set(subscriptionId, subscription);

  // Query for matching events
  const events = queryEvents(validatedFilters);

  // Send matching events
  for (const event of events) {
    send(ws, ["EVENT", subscriptionId, event]);
  }

  // Send EOSE
  send(ws, ["EOSE", subscriptionId]);
}

// Handle CLOSE message
export function handleClose(
  ws: ServerWebSocket<ClientState>,
  subscriptionId: string
): void {
  const state = clients.get(ws);
  if (!state) return;

  if (typeof subscriptionId !== "string") {
    return;
  }

  state.subscriptions.delete(subscriptionId);
}

// Handle CHANGES message - CouchDB-like changes feed
// Format: ["CHANGES", { since?: number, limit?: number, kinds?: number[], authors?: string[] }]
// Response: ["CHANGES", { changes: [{ seq, event }...], lastSeq }]
export function handleChanges(
  ws: ServerWebSocket<ClientState>,
  options: unknown
): void {
  // Parse options
  const opts = (options && typeof options === "object" ? options : {}) as {
    since?: number;
    limit?: number;
    kinds?: number[];
    authors?: string[];
  };

  const sinceSeq = typeof opts.since === "number" ? opts.since : 0;
  const limit = typeof opts.limit === "number" ? opts.limit : undefined;
  const kinds = Array.isArray(opts.kinds) ? opts.kinds : undefined;
  const authors = Array.isArray(opts.authors) ? opts.authors : undefined;

  const result = queryChanges(sinceSeq, { limit, kinds, authors });

  send(ws, ["CHANGES", result]);
}

// Handle LASTSEQ message - get current sequence number
// Format: ["LASTSEQ"]
// Response: ["LASTSEQ", number]
export function handleLastSeq(ws: ServerWebSocket<ClientState>): void {
  const lastSeq = getLastSeq();
  send(ws, ["LASTSEQ", lastSeq]);
}

// Handle CHANGES_SUB message - subscribe to continuous changes feed
// Format: ["CHANGES_SUB", "<sub_id>", { since?: number, kinds?: number[], authors?: string[] }]
// Response: streams CHANGES_EVENT for each matching change, then CHANGES_EOSE when caught up
export function handleChangesSub(
  ws: ServerWebSocket<ClientState>,
  subscriptionId: string,
  options: unknown
): void {
  const state = clients.get(ws);
  if (!state) return;

  // Validate subscription ID
  if (
    typeof subscriptionId !== "string" ||
    subscriptionId.length === 0 ||
    subscriptionId.length > 64
  ) {
    send(ws, ["NOTICE", "error: subscription id must be 1-64 characters"]);
    return;
  }

  // Parse options
  const opts = (options && typeof options === "object" ? options : {}) as {
    since?: number;
    kinds?: number[];
    authors?: string[];
  };

  const sinceSeq = typeof opts.since === "number" ? opts.since : 0;
  const kinds = Array.isArray(opts.kinds) ? opts.kinds : undefined;
  const authors = Array.isArray(opts.authors) ? opts.authors : undefined;

  // Store subscription
  const subscription: ChangesSubscription = {
    id: subscriptionId,
    options: { since: sinceSeq, kinds, authors },
  };
  state.changesSubscriptions.set(subscriptionId, subscription);

  // Send all existing changes since the specified sequence
  const result = queryChanges(sinceSeq, { kinds, authors });
  for (const change of result.changes) {
    send(ws, ["CHANGES_EVENT", subscriptionId, change]);
  }

  // Send EOSE to indicate we're now live
  send(ws, ["CHANGES_EOSE", subscriptionId, { lastSeq: result.lastSeq }]);
}

// Handle CHANGES_UNSUB message - unsubscribe from continuous changes feed
// Format: ["CHANGES_UNSUB", "<sub_id>"]
export function handleChangesUnsub(
  ws: ServerWebSocket<ClientState>,
  subscriptionId: string
): void {
  const state = clients.get(ws);
  if (!state) return;

  if (typeof subscriptionId !== "string") {
    return;
  }

  state.changesSubscriptions.delete(subscriptionId);
}

// Handle incoming message from client
export async function handleMessage(
  ws: ServerWebSocket<ClientState>,
  message: string
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    send(ws, ["NOTICE", "error: invalid JSON"]);
    return;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    send(ws, ["NOTICE", "error: message must be a non-empty array"]);
    return;
  }

  const messageType = parsed[0];

  switch (messageType) {
    case "EVENT":
      if (parsed.length !== 2) {
        send(ws, ["NOTICE", "error: EVENT message must have exactly 2 elements"]);
        return;
      }
      await handleEvent(ws, parsed[1]);
      break;

    case "REQ":
      if (parsed.length < 3) {
        send(ws, [
          "NOTICE",
          "error: REQ message must have subscription ID and at least one filter",
        ]);
        return;
      }
      handleReq(ws, parsed[1] as string, parsed.slice(2));
      break;

    case "CLOSE":
      if (parsed.length !== 2) {
        send(ws, [
          "NOTICE",
          "error: CLOSE message must have exactly 2 elements",
        ]);
        return;
      }
      handleClose(ws, parsed[1] as string);
      break;

    case "CHANGES":
      handleChanges(ws, parsed[1]);
      break;

    case "LASTSEQ":
      handleLastSeq(ws);
      break;

    case "CHANGES_SUB":
      if (parsed.length < 2) {
        send(ws, ["NOTICE", "error: CHANGES_SUB message must have subscription ID"]);
        return;
      }
      handleChangesSub(ws, parsed[1] as string, parsed[2]);
      break;

    case "CHANGES_UNSUB":
      if (parsed.length !== 2) {
        send(ws, ["NOTICE", "error: CHANGES_UNSUB message must have exactly 2 elements"]);
        return;
      }
      handleChangesUnsub(ws, parsed[1] as string);
      break;

    default:
      send(ws, ["NOTICE", `error: unknown message type: ${messageType}`]);
  }
}

// Handle new connection
export function handleOpen(ws: ServerWebSocket<ClientState>): void {
  const state: ClientState = {
    subscriptions: new Map(),
    changesSubscriptions: new Map(),
  };
  clients.set(ws, state);
  console.log(`Client connected. Total clients: ${clients.size}`);
}

// Handle connection close
export function handleDisconnect(ws: ServerWebSocket<ClientState>): void {
  clients.delete(ws);
  console.log(`Client disconnected. Total clients: ${clients.size}`);
}
