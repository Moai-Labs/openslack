// Product limits. These are published to users before any real invitation
// (see docs/limits.md) and enforced in the store and API.
module.exports = {
  // Free tier (the tier every workspace starts on).
  FREE_MAX_MEMBERS: 5,

  // Paid tier: $12 per workspace for 30 days at a time. While real payments
  // stay blocked, the entitlement is granted only by a clearly labelled
  // test-USDC payment, which counts as zero revenue.
  PAID_PRICE_USDC: 12,
  PAID_DAYS: 30,
  PAID_MAX_MEMBERS: 25,

  // History: messages older than this are pruned, and each workspace keeps at
  // most this many messages overall (oldest dropped first). Paid workspaces
  // keep their history searchable for much longer.
  RETENTION_DAYS: 30,
  MAX_MESSAGES_PER_WORKSPACE: 10000,
  PAID_RETENTION_DAYS: 365,
  PAID_MAX_MESSAGES_PER_WORKSPACE: 100000,

  // Rough cap on stored message text per workspace; pruning starts with the
  // oldest messages when it is exceeded.
  MAX_STORAGE_CHARS_PER_WORKSPACE: 20 * 1000 * 1000,

  // A single message and a single API request body.
  MAX_MESSAGE_CHARS: 4000,
  MAX_BODY_BYTES: 64 * 1024,

  // One user may post at most this many messages in a rolling minute.
  RATE_LIMIT_PER_MINUTE: 30,

  // Sign-up rules.
  MIN_PASSWORD_CHARS: 8,
  MAX_HANDLES: 1, // one account per handle; handles are unique sitewide

  // Session cookie lifetime (sliding): idle sessions older than this are dropped.
  SESSION_DAYS: 30,

  // Channels per workspace.
  MAX_CHANNELS_PER_WORKSPACE: 100,

  // Live stream heartbeat.
  SSE_HEARTBEAT_SECONDS: 25
};
