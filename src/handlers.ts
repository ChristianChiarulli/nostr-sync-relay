import type { ServerWebSocket } from "bun";
import type {
  NostrEvent,
  NostrFilter,
  ClientState,
  Subscription,
  RelayMessage,
} from "./types";
import { validateEvent } from "./validation";
import { validateFilter, matchesFilters } from "./filters";
import { storeEvent, queryEvents } from "./db";

// Map of all connected clients
export const clients = new Map<ServerWebSocket<ClientState>, ClientState>();

// Send a message to a client
function send(ws: ServerWebSocket<ClientState>, message: RelayMessage): void {
  ws.send(JSON.stringify(message));
}

// Broadcast an event to all clients with matching subscriptions
function broadcast(
  event: NostrEvent,
  excludeWs?: ServerWebSocket<ClientState>
): void {
  for (const [ws, state] of clients) {
    if (ws === excludeWs) continue;

    for (const [subId, subscription] of state.subscriptions) {
      if (matchesFilters(event, subscription.filters)) {
        send(ws, ["EVENT", subId, event]);
        break; // Only send once per client even if multiple subs match
      }
    }
  }
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
  const result = storeEvent(validEvent);

  send(ws, ["OK", validEvent.id, result.success, result.message]);

  // Broadcast to other clients with matching subscriptions
  if (result.success) {
    broadcast(validEvent);

    // Also check if this event matches any subscriptions on the sender
    const state = clients.get(ws);
    if (state) {
      for (const [subId, subscription] of state.subscriptions) {
        if (matchesFilters(validEvent, subscription.filters)) {
          send(ws, ["EVENT", subId, validEvent]);
          break;
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

    default:
      send(ws, ["NOTICE", `error: unknown message type: ${messageType}`]);
  }
}

// Handle new connection
export function handleOpen(ws: ServerWebSocket<ClientState>): void {
  const state: ClientState = {
    subscriptions: new Map(),
  };
  clients.set(ws, state);
  console.log(`Client connected. Total clients: ${clients.size}`);
}

// Handle connection close
export function handleDisconnect(ws: ServerWebSocket<ClientState>): void {
  clients.delete(ws);
  console.log(`Client disconnected. Total clients: ${clients.size}`);
}
