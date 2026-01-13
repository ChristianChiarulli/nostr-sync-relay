// Quick test script for the relay
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as secp256k1 from "@noble/secp256k1";

// Configure secp256k1 with sha256
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

// Generate a test keypair
const privateKey = secp256k1.utils.randomSecretKey();
// For schnorr, we use the x-only public key
const publicKey = secp256k1.schnorr.getPublicKey(privateKey);
const pubkeyHex = bytesToHex(publicKey);

// Create a test event
function serializeEvent(event: {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

async function createEvent(
  kind: number,
  content: string,
  tags: string[][] = []
) {
  const event = {
    pubkey: pubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    kind,
    tags,
    content,
  };

  const serialized = serializeEvent(event);
  const hash = sha256(new TextEncoder().encode(serialized));
  const id = bytesToHex(hash);
  // Use schnorr.sign for BIP340 signatures as required by Nostr
  const sig = bytesToHex(secp256k1.schnorr.sign(hash, privateKey));

  return { ...event, id, sig };
}

async function main() {
  console.log("Connecting to relay...");
  const ws = new WebSocket("ws://localhost:3000");

  ws.onopen = async () => {
    console.log("Connected!");

    // Subscribe to events from our pubkey
    const subId = "test-sub";
    ws.send(
      JSON.stringify(["REQ", subId, { kinds: [1, 40001], authors: [pubkeyHex] }])
    );

    // Wait a bit for EOSE
    await new Promise((r) => setTimeout(r, 500));

    // Create and publish a regular event (kind 1)
    console.log("\nPublishing regular event (kind 1)...");
    const event1 = await createEvent(1, "Hello from test script!");
    ws.send(JSON.stringify(["EVENT", event1]));

    // Wait a bit
    await new Promise((r) => setTimeout(r, 500));

    // Create and publish a syncable event (kind 40001)
    console.log("\nPublishing syncable event (kind 40001)...");
    const docId = "test-doc-" + Date.now();
    const event2 = await createEvent(40001, "First revision", [
      ["d", docId],
      ["i", "1-" + bytesToHex(sha256(new TextEncoder().encode("First revision"))).slice(0, 32)],
    ]);
    ws.send(JSON.stringify(["EVENT", event2]));

    // Wait and then publish another revision
    await new Promise((r) => setTimeout(r, 500));

    console.log("\nPublishing second revision of syncable event...");
    const prevRev = event2.tags.find((t) => t[0] === "i")![1];
    const contentHash = bytesToHex(sha256(new TextEncoder().encode("Second revision")));
    const combinedHash = sha256(new TextEncoder().encode(prevRev + ":" + contentHash));
    const event3 = await createEvent(40001, "Second revision", [
      ["d", docId],
      ["i", "2-" + bytesToHex(combinedHash).slice(0, 32)],
      ["v", prevRev],
    ]);
    ws.send(JSON.stringify(["EVENT", event3]));

    // Wait and query all revisions of the document
    await new Promise((r) => setTimeout(r, 500));

    console.log("\nQuerying all revisions of the document...");
    ws.send(
      JSON.stringify(["REQ", "rev-query", { kinds: [40001], "#d": [docId] }])
    );

    // Wait for response
    await new Promise((r) => setTimeout(r, 1000));

    console.log("\nDone! Closing connection.");
    ws.close();
  };

  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    console.log("Received:", JSON.stringify(data, null, 2));
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };

  ws.onclose = () => {
    console.log("Connection closed.");
    process.exit(0);
  };
}

main().catch(console.error);
