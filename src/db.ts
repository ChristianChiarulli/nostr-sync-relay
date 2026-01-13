import { Database } from "bun:sqlite";
import type { NostrEvent, NostrFilter } from "./types";
import {
  isReplaceableKind,
  isEphemeralKind,
  isAddressableKind,
  isSyncableKind,
} from "./types";

let db: Database;

export function initDatabase(path: string = "relay.db"): Database {
  db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");

  // Create events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      pubkey TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      kind INTEGER NOT NULL,
      tags TEXT NOT NULL,
      content TEXT NOT NULL,
      sig TEXT NOT NULL
    )
  `);

  // Create indexes for efficient querying
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pubkey ON events(pubkey);
    CREATE INDEX IF NOT EXISTS idx_kind ON events(kind);
    CREATE INDEX IF NOT EXISTS idx_created_at ON events(created_at);
    CREATE INDEX IF NOT EXISTS idx_kind_pubkey ON events(kind, pubkey);
    CREATE INDEX IF NOT EXISTS idx_kind_pubkey_created ON events(kind, pubkey, created_at);
  `);

  // Create tag index table for single-letter tags
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_tags (
      event_id TEXT NOT NULL,
      tag_name TEXT NOT NULL,
      tag_value TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tag ON event_tags(tag_name, tag_value);
    CREATE INDEX IF NOT EXISTS idx_tag_event ON event_tags(event_id);
  `);

  return db;
}

export function getDatabase(): Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

// Get the d tag value from an event
function getDTagValue(event: NostrEvent): string | null {
  const dTag = event.tags.find((t) => t[0] === "d");
  return dTag?.[1] ?? null;
}

// Get the i tag value (revision ID) from an event
function getITagValue(event: NostrEvent): string | null {
  const iTag = event.tags.find((t) => t[0] === "i");
  return iTag?.[1] ?? null;
}

// Parse revision ID into generation and hash
function parseRevisionId(revId: string): { generation: number; hash: string } {
  const parts = revId.split("-");
  const genStr = parts[0] ?? "0";
  const hash = parts[1] ?? "";
  return {
    generation: parseInt(genStr, 10) || 0,
    hash,
  };
}

// Store an event in the database
export function storeEvent(
  event: NostrEvent
): { success: boolean; message: string } {
  const database = getDatabase();

  // Don't store ephemeral events
  if (isEphemeralKind(event.kind)) {
    return { success: true, message: "" };
  }

  // Check for duplicate
  const existing = database
    .query("SELECT id FROM events WHERE id = ?")
    .get(event.id);
  if (existing) {
    return { success: true, message: "duplicate: already have this event" };
  }

  // Handle replaceable events (keep only latest per pubkey+kind)
  if (isReplaceableKind(event.kind)) {
    const existingReplaceable = database
      .query(
        `SELECT id, created_at FROM events
         WHERE pubkey = ? AND kind = ?
         ORDER BY created_at DESC, id ASC LIMIT 1`
      )
      .get(event.pubkey, event.kind) as
      | { id: string; created_at: number }
      | null;

    if (existingReplaceable) {
      // Keep the newer one, or if same timestamp, the one with lower id
      if (
        existingReplaceable.created_at > event.created_at ||
        (existingReplaceable.created_at === event.created_at &&
          existingReplaceable.id < event.id)
      ) {
        return {
          success: true,
          message: "duplicate: have a newer version of this replaceable event",
        };
      }
      // Delete old version
      deleteEvent(existingReplaceable.id);
    }
  }

  // Handle addressable events (keep only latest per pubkey+kind+d)
  if (isAddressableKind(event.kind)) {
    const dValue = getDTagValue(event);
    const existingAddressable = database
      .query(
        `SELECT e.id, e.created_at FROM events e
         JOIN event_tags t ON e.id = t.event_id
         WHERE e.pubkey = ? AND e.kind = ? AND t.tag_name = 'd' AND t.tag_value = ?
         ORDER BY e.created_at DESC, e.id ASC LIMIT 1`
      )
      .get(event.pubkey, event.kind, dValue ?? "") as
      | { id: string; created_at: number }
      | null;

    if (existingAddressable) {
      if (
        existingAddressable.created_at > event.created_at ||
        (existingAddressable.created_at === event.created_at &&
          existingAddressable.id < event.id)
      ) {
        return {
          success: true,
          message: "duplicate: have a newer version of this addressable event",
        };
      }
      deleteEvent(existingAddressable.id);
    }
  }

  // Handle syncable events (40000-49999): store all revisions for history
  // Only discard conflicting revisions at the same generation if they are not referenced as parents
  if (isSyncableKind(event.kind)) {
    const dValue = getDTagValue(event);
    const newRevisionId = getITagValue(event);

    if (newRevisionId) {
      const newParsed = parseRevisionId(newRevisionId);

      // Find all existing revisions for this document
      const existingRevisions = database
        .query(
          `SELECT e.id, e.tags FROM events e
           JOIN event_tags t ON e.id = t.event_id
           WHERE e.pubkey = ? AND e.kind = ? AND t.tag_name = 'd' AND t.tag_value = ?`
        )
        .all(event.pubkey, event.kind, dValue ?? "") as Array<{
        id: string;
        tags: string;
      }>;

      // Build set of revision IDs that are referenced as parents (v tags)
      const referencedRevisions = new Set<string>();
      for (const existing of existingRevisions) {
        const existingTags = JSON.parse(existing.tags) as string[][];
        for (const tag of existingTags) {
          if (tag[0] === "v" && tag[1]) {
            referencedRevisions.add(tag[1]);
          }
        }
      }
      // Also check v tags in the new event
      for (const tag of event.tags) {
        if (tag[0] === "v" && tag[1]) {
          referencedRevisions.add(tag[1]);
        }
      }

      for (const existing of existingRevisions) {
        const existingTags = JSON.parse(existing.tags) as string[][];
        const existingRevisionId = existingTags.find((t) => t[0] === "i")?.[1];

        if (existingRevisionId) {
          const existingParsed = parseRevisionId(existingRevisionId);

          // Only compare revisions at the same generation
          if (existingParsed.generation === newParsed.generation) {
            // If existing revision is referenced as a parent, keep it
            if (referencedRevisions.has(existingRevisionId)) {
              // Reject new revision - can't replace a revision that's part of the chain
              return {
                success: true,
                message:
                  "duplicate: existing revision at this generation is referenced as parent",
              };
            }

            // At same generation, higher hash wins
            if (existingParsed.hash > newParsed.hash) {
              // Existing wins, reject new
              return {
                success: true,
                message:
                  "duplicate: have a winning version at this generation",
              };
            } else if (existingParsed.hash < newParsed.hash) {
              // New wins, delete existing (unless it's referenced)
              deleteEvent(existing.id);
            }
          }
        }
      }
    }
  }

  // Regular events: store all

  try {
    database
      .query(
        `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.pubkey,
        event.created_at,
        event.kind,
        JSON.stringify(event.tags),
        event.content,
        event.sig
      );

    // Index single-letter tags
    for (const tag of event.tags) {
      if (tag.length >= 2 && tag[0].length === 1 && /^[a-zA-Z]$/.test(tag[0])) {
        database
          .query(
            `INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)`
          )
          .run(event.id, tag[0], tag[1]);
      }
    }

    return { success: true, message: "" };
  } catch (error) {
    return {
      success: false,
      message: `error: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}

// Delete an event and its tags
function deleteEvent(id: string): void {
  const database = getDatabase();
  database.query("DELETE FROM event_tags WHERE event_id = ?").run(id);
  database.query("DELETE FROM events WHERE id = ?").run(id);
}

// Query events by filters
export function queryEvents(filters: NostrFilter[]): NostrEvent[] {
  const database = getDatabase();
  const results: Map<string, NostrEvent> = new Map();

  for (const filter of filters) {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let needsTagJoin = false;
    const tagConditions: { name: string; values: string[] }[] = [];

    // ids filter
    if (filter.ids && filter.ids.length > 0) {
      conditions.push(`e.id IN (${filter.ids.map(() => "?").join(", ")})`);
      params.push(...filter.ids);
    }

    // authors filter
    if (filter.authors && filter.authors.length > 0) {
      conditions.push(
        `e.pubkey IN (${filter.authors.map(() => "?").join(", ")})`
      );
      params.push(...filter.authors);
    }

    // kinds filter
    if (filter.kinds && filter.kinds.length > 0) {
      conditions.push(`e.kind IN (${filter.kinds.map(() => "?").join(", ")})`);
      params.push(...filter.kinds);
    }

    // since filter
    if (filter.since !== undefined) {
      conditions.push("e.created_at >= ?");
      params.push(filter.since);
    }

    // until filter
    if (filter.until !== undefined) {
      conditions.push("e.created_at <= ?");
      params.push(filter.until);
    }

    // Tag filters (#e, #p, #d, etc.)
    for (const [key, values] of Object.entries(filter)) {
      if (
        key.startsWith("#") &&
        key.length === 2 &&
        Array.isArray(values) &&
        values.length > 0
      ) {
        const tagName = key.slice(1);
        needsTagJoin = true;
        tagConditions.push({ name: tagName, values });
      }
    }

    // Build query
    let query: string;
    if (needsTagJoin && tagConditions.length > 0) {
      // Use subqueries for each tag condition
      const tagSubqueries = tagConditions.map((tc, i) => {
        const placeholders = tc.values.map(() => "?").join(", ");
        params.push(tc.name, ...tc.values);
        return `EXISTS (
          SELECT 1 FROM event_tags t${i}
          WHERE t${i}.event_id = e.id
          AND t${i}.tag_name = ?
          AND t${i}.tag_value IN (${placeholders})
        )`;
      });
      conditions.push(...tagSubqueries);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause =
      filter.limit !== undefined ? `LIMIT ${filter.limit}` : "";

    query = `
      SELECT DISTINCT e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig
      FROM events e
      ${whereClause}
      ORDER BY e.created_at DESC, e.id ASC
      ${limitClause}
    `;

    const rows = database.query(query).all(...params) as Array<{
      id: string;
      pubkey: string;
      created_at: number;
      kind: number;
      tags: string;
      content: string;
      sig: string;
    }>;

    for (const row of rows) {
      if (!results.has(row.id)) {
        results.set(row.id, {
          id: row.id,
          pubkey: row.pubkey,
          created_at: row.created_at,
          kind: row.kind,
          tags: JSON.parse(row.tags),
          content: row.content,
          sig: row.sig,
        });
      }
    }
  }

  // Sort by created_at desc, id asc
  return Array.from(results.values()).sort((a, b) => {
    if (b.created_at !== a.created_at) {
      return b.created_at - a.created_at;
    }
    return a.id.localeCompare(b.id);
  });
}

// Get a single event by ID
export function getEvent(id: string): NostrEvent | null {
  const database = getDatabase();
  const row = database.query("SELECT * FROM events WHERE id = ?").get(id) as {
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string;
    content: string;
    sig: string;
  } | null;

  if (!row) return null;

  return {
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    kind: row.kind,
    tags: JSON.parse(row.tags),
    content: row.content,
    sig: row.sig,
  };
}
