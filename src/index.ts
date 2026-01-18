import type { ClientState } from "./types";
import { initDatabase } from "./db";
import {
  handleMessage,
  handleOpen,
  handleDisconnect,
} from "./handlers";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const DB_PATH = process.env.DB_PATH ?? "relay.db";

// Initialize database
console.log(`Initializing database at ${DB_PATH}...`);
initDatabase(DB_PATH);

// Start WebSocket server
const server = Bun.serve<ClientState>({
  port: PORT,
  fetch(req, server) {
    // Handle WebSocket upgrade
    const url = new URL(req.url);

    // NIP-11 relay information document
    if (req.headers.get("Accept") === "application/nostr+json") {
      return new Response(
        JSON.stringify({
          name: "NIP-DB Relay",
          description: "A Nostr relay with support for NIP-01 and NIP-DB (syncable events with changes feed)",
          pubkey: "",
          contact: "",
          supported_nips: [1],
          software: "nip-db-relay",
          version: "0.3.0",
          supported_messages: ["EVENT", "REQ", "CLOSE", "CHANGES", "LASTSEQ", "CHANGES_SUB", "CHANGES_UNSUB"],
        }),
        {
          headers: {
            "Content-Type": "application/nostr+json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Upgrade to WebSocket
    const upgraded = server.upgrade(req, {
      data: {
        subscriptions: new Map(),
        changesSubscriptions: new Map(),
      },
    });

    if (!upgraded) {
      return new Response("Expected WebSocket connection", { status: 400 });
    }
  },
  websocket: {
    open(ws) {
      handleOpen(ws);
    },
    async message(ws, message) {
      if (typeof message === "string") {
        await handleMessage(ws, message);
      } else {
        // Handle binary message (convert to string)
        const text = new TextDecoder().decode(message);
        await handleMessage(ws, text);
      }
    },
    close(ws) {
      handleDisconnect(ws);
    },
  },
});

console.log(`Nostr relay running on ws://localhost:${server.port}`);
console.log(`NIP-11 info available at http://localhost:${server.port}`);
