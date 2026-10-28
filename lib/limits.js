// Product limits. These are published to users before any real invitation
// (see docs/limits.md) and enforced in the store and API.
const env = (key, fallback) => (process.env[key] != null && process.env[key] !== "" ? process.env[key] : fallback);

module.exports = {
  // Free tier (the tier every workspace starts on).
  FREE_MAX_MEMBERS: 5,

  // Paid tier: $12 per workspace for 30 days at a time. While real payments
  // stay blocked, the entitlement is granted only by a verified test-USDC
  // transfer, which counts as zero revenue.
  PAID_PRICE_USDC: 12,
  PAID_DAYS: 30,
  PAID_MAX_MEMBERS: 25,

  // How a test payment is verified: the workspace owner sends a real transfer
  // of Circle's test-USDC on a public test chain and pastes the transaction
  // hash; the server verifies the receipt read-only over JSON-RPC before any
  // entitlement is granted. Only test chains are accepted (see lib/payments.js).
  // Every value can be overridden by environment for tests and deployments.
  PAY_CHAIN_ID: Number(env("PAY_CHAIN_ID", "84532")), // 84532 = Base Sepolia
  PAY_RPC_URL: env("PAY_RPC_URL", "https://sepolia.base.org"),
  PAY_USDC_ADDRESS: env("PAY_USDC_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  // Receiving address for test payments. A sink with no private key on this
  // machine: test-USDC arriving here is unrecoverable, which is exactly right
  // for labelled tests that count as zero revenue. When a supported checkout
  // with verified settlement exists, its own recipient takes over.
  PAY_RECIPIENT: env("PAY_RECIPIENT", "0x4282d8578cd38d216efa7a3976d03f0542c40ea3"),
  PAY_USDC_DECIMALS: 6, // verified decimals() of the asset contract
  PAY_RPC_TIMEOUT_MS: 15000,

  // A payment request (intent) is created first, paid on-chain, then confirmed
  // by transaction hash. Intents expire, and a workspace cannot drown in them.
  PAYMENT_INTENT_TTL_MINUTES: 60,
  MAX_PENDING_PAYMENT_INTENTS: 5,

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
