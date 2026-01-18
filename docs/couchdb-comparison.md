# NIP-DB vs CouchDB: Feature Comparison

This document compares NIP-DB's document synchronization protocol with CouchDB's replication protocol, identifying both alignments and gaps.

## Features NIP-DB Implements Well

### 1. Revision ID Format
Both use the same `{generation}-{hash}` format:
- Generation: Integer incremented with each update
- Hash: Derived from content and parent revision

### 2. Deterministic Conflict Resolution
Identical algorithm:
1. Higher generation wins
2. If equal, higher hash (lexicographic) wins

This ensures all clients converge to the same winning revision without coordination.

### 3. Tombstone Deletions
Deleted documents are marked with a `deleted` tag rather than being removed. This allows:
- Deletion to propagate during sync
- "Undelete" by creating a new revision without the deleted tag

### 4. Multi-Master Replication
Any client can write to any relay. Conflicts are detected and resolved deterministically.

### 5. Offline-First Support
Clients can:
- Work offline with local document stores
- Queue changes while disconnected
- Sync when connectivity is restored

---

## Gaps and Limitations

### 1. No Revision Tree

**CouchDB**: Maintains a complete revision tree showing all branching history. You can traverse from any revision back to the root, visualize branches, and understand the full edit history.

**NIP-DB**: Only stores:
- Current revision ID (`i` tag)
- Immediate parent revision(s) (`v` tags)

**Impact**: Cannot reconstruct full document history or visualize branch structure. Limited ability to answer "how did we get here?"

**Potential Fix**: Store full ancestry chain in document content or add ancestor tags.

---

### 2. No Compaction Control

**CouchDB**: Sophisticated compaction with:
- Configurable revision retention (keep last N revisions)
- Prune old branches while preserving winning path
- On-demand compaction triggers
- Automatic background compaction

**NIP-DB**: Spec says relays "MAY implement compaction" but provides:
- No protocol for clients to request compaction
- No standard retention policies
- No way to query compaction status

**Impact**: Relays may retain unlimited revisions, causing storage bloat. No client control over history retention.

**Potential Fix**: Define compaction-related filters or relay configuration endpoints.

---

### 3. No Changes Feed

**CouchDB**: The `_changes` endpoint provides:
- All changes since a sequence number
- Long-polling and continuous feed modes
- Filtering by document ID, view, or custom function
- Precise checkpointing for replication

**NIP-DB**: Relies on Nostr's `since` timestamp filter.

**Impact**:
- Timestamps can collide (multiple events at same second)
- Clock drift can cause events to appear out of order
- No continuous feed (must poll or maintain subscription)
- Less precise replication checkpointing

**IMPLEMENTED**: This relay implements a changes feed extension:

```
// Request changes since sequence 0
["CHANGES", { since: 0, kinds: [40001], authors: ["pubkey..."], limit: 100 }]

// Response
["CHANGES", { changes: [{ seq: 1, event: {...} }, ...], lastSeq: 42 }]

// Get current sequence number
["LASTSEQ"]
["LASTSEQ", 42]
```

This provides CouchDB-like checkpointing with monotonic sequence numbers.

---

### 4. No Attachments

**CouchDB**: First-class support for binary attachments:
- Attached to documents with content-type metadata
- Streamed separately from document JSON
- Included in replication

**NIP-DB**: No attachment support defined.

**Impact**: Binary data must be stored externally or base64-encoded in content (inefficient).

**Potential Fix**: Reference NIP-94 (File Metadata) events via tags. Define attachment-specific tags.

---

### 5. No Views/Indexes

**CouchDB**: MapReduce views enable:
- Custom indexes on document fields
- Aggregations (count, sum, etc.)
- Complex queries across documents

**NIP-DB**: Limited to Nostr's tag-based filtering:
- Filter by exact tag values
- No field-level queries on content
- No aggregations

**Impact**: Complex queries must be done client-side after fetching all documents.

**Potential Fix**: This is a fundamental Nostr limitation. Clients must build local indexes.

---

### 6. No Bulk Operations

**CouchDB**: `_bulk_docs` endpoint provides:
- Atomic batch inserts/updates
- All-or-nothing transaction mode
- Efficient bulk replication

**NIP-DB**: Each revision is a separate Nostr event.

**Impact**:
- No transactional guarantees across multiple documents
- Higher overhead for batch operations
- Partial failures possible during bulk updates

**Potential Fix**: Fundamental Nostr limitation. Applications must handle partial failures.

---

### 7. No Sequence Numbers

**CouchDB**: Assigns monotonically increasing sequence numbers to every change:
- Precise ordering guaranteed
- Efficient replication checkpointing
- "Give me everything after seq 12345"

**NIP-DB**: Uses Unix timestamps (seconds).

**Impact**:
- Multiple events can share the same timestamp
- Clock drift between clients causes ordering issues
- Replication may miss events or duplicate them

**IMPLEMENTED**: This relay assigns monotonic sequence numbers to each stored event. The `seq` column is an auto-incrementing primary key. See the CHANGES feed above for how to use it.

---

### 8. Limited Conflict Querying

**CouchDB**: Conflicts are queryable:
- `?conflicts=true` returns all conflicting revisions
- `_all_docs` can filter for documents with conflicts
- Losing revisions remain accessible until compacted

**NIP-DB**: All revisions are stored, but:
- No standard query for "documents with conflicts"
- Client must fetch all revisions and compute conflicts locally
- No relay-side conflict detection

**Impact**: Clients must do more work to find and present conflicts to users.

**Potential Fix**: Define a conflict-aware filter or relay capability for returning conflict status.

---

## Summary Table

| Feature | CouchDB | NIP-DB Spec | This Relay | Gap Severity |
|---------|---------|-------------|------------|--------------|
| Revision IDs | Yes | Yes | Yes | None |
| Deterministic Conflict Resolution | Yes | Yes | Yes | None |
| Tombstone Deletions | Yes | Yes | Yes | None |
| Multi-Master Replication | Yes | Yes | Yes | None |
| Offline-First | Yes | Yes | Yes | None |
| Revision Tree | Yes | No | No | Medium |
| Compaction Control | Yes | No | No | Medium |
| Changes Feed | Yes | No | **Yes** | None (implemented) |
| Attachments | Yes | No | No | Medium |
| Views/Indexes | Yes | No | No | High (Nostr limitation) |
| Bulk Operations | Yes | No | No | Medium (Nostr limitation) |
| Sequence Numbers | Yes | No | **Yes** | None (implemented) |
| Conflict Querying | Yes | Partial | Partial | Low |

---

## Recommendations

### For the NIP Spec

1. **Add optional revision tree support** - Define how clients can store/query full ancestry
2. **Define compaction protocol** - Standard tags or filters for retention control
3. **Improve conflict querying** - Relay capability for returning conflict metadata

### For Relay Implementations

1. **Index by document ID** - Efficient `#d` tag queries are essential
2. **Consider conflict detection** - Optional relay-side conflict flagging
3. **Implement reasonable defaults** - Default retention policies to prevent unbounded growth

### For Client Implementations

1. **Build local indexes** - Don't rely on relay-side querying
2. **Handle timestamp collisions** - Use event ID as tiebreaker
3. **Expect partial failures** - No atomic batch guarantees
