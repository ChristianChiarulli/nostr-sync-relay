import type { NostrEvent, NostrFilter } from "./types";

// Check if an event matches a single filter
export function matchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
  // Check ids
  if (filter.ids && filter.ids.length > 0) {
    if (!filter.ids.includes(event.id)) {
      return false;
    }
  }

  // Check authors
  if (filter.authors && filter.authors.length > 0) {
    if (!filter.authors.includes(event.pubkey)) {
      return false;
    }
  }

  // Check kinds
  if (filter.kinds && filter.kinds.length > 0) {
    if (!filter.kinds.includes(event.kind)) {
      return false;
    }
  }

  // Check since
  if (filter.since !== undefined) {
    if (event.created_at < filter.since) {
      return false;
    }
  }

  // Check until
  if (filter.until !== undefined) {
    if (event.created_at > filter.until) {
      return false;
    }
  }

  // Check tag filters (#e, #p, #d, #i, #v, etc.)
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith("#") && key.length === 2 && Array.isArray(values) && values.length > 0) {
      const tagName = key.slice(1);
      // Find all tag values for this tag name in the event
      const eventTagValues = event.tags
        .filter((tag) => tag[0] === tagName)
        .map((tag) => tag[1])
        .filter((v): v is string => v !== undefined);

      // At least one of the filter values must match at least one event tag value
      const hasMatch = values.some((v) => eventTagValues.includes(v));
      if (!hasMatch) {
        return false;
      }
    }
  }

  return true;
}

// Check if an event matches any of the filters
export function matchesFilters(
  event: NostrEvent,
  filters: NostrFilter[]
): boolean {
  // OR across filters
  return filters.some((filter) => matchesFilter(event, filter));
}

// Validate filter structure
export function validateFilter(
  filter: unknown
): { valid: false; error: string } | { valid: true; filter: NostrFilter } {
  if (!filter || typeof filter !== "object") {
    return { valid: false, error: "filter must be an object" };
  }

  const f = filter as Record<string, unknown>;

  // Validate ids
  if (f.ids !== undefined) {
    if (!Array.isArray(f.ids)) {
      return { valid: false, error: "ids must be an array" };
    }
    for (const id of f.ids) {
      if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) {
        return { valid: false, error: "ids must be 64 lowercase hex characters" };
      }
    }
  }

  // Validate authors
  if (f.authors !== undefined) {
    if (!Array.isArray(f.authors)) {
      return { valid: false, error: "authors must be an array" };
    }
    for (const author of f.authors) {
      if (typeof author !== "string" || !/^[a-f0-9]{64}$/.test(author)) {
        return {
          valid: false,
          error: "authors must be 64 lowercase hex characters",
        };
      }
    }
  }

  // Validate kinds
  if (f.kinds !== undefined) {
    if (!Array.isArray(f.kinds)) {
      return { valid: false, error: "kinds must be an array" };
    }
    for (const kind of f.kinds) {
      if (typeof kind !== "number" || !Number.isInteger(kind)) {
        return { valid: false, error: "kinds must be integers" };
      }
    }
  }

  // Validate since/until
  if (f.since !== undefined && (typeof f.since !== "number" || !Number.isInteger(f.since))) {
    return { valid: false, error: "since must be an integer" };
  }
  if (f.until !== undefined && (typeof f.until !== "number" || !Number.isInteger(f.until))) {
    return { valid: false, error: "until must be an integer" };
  }

  // Validate limit
  if (f.limit !== undefined && (typeof f.limit !== "number" || !Number.isInteger(f.limit) || f.limit < 0)) {
    return { valid: false, error: "limit must be a non-negative integer" };
  }

  // Validate tag filters (single-letter only per NIP-01)
  for (const [key, value] of Object.entries(f)) {
    if (key.startsWith("#")) {
      const tagLetter = key[1];
      if (key.length !== 2 || !tagLetter || !/^[a-zA-Z]$/.test(tagLetter)) {
        return {
          valid: false,
          error: "tag filters must be single letters (a-z, A-Z)",
        };
      }
      if (!Array.isArray(value)) {
        return { valid: false, error: `${key} must be an array` };
      }
      for (const v of value) {
        if (typeof v !== "string") {
          return { valid: false, error: `${key} values must be strings` };
        }
      }
    }
  }

  return { valid: true, filter: f as NostrFilter };
}
