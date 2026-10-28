// Verification of labelled test-USDC payments.
//
// The paid tier is granted only after a real transfer of test-USDC is verified
// on a public test chain. The supported mechanism here is Circle's USDC on
// Base Sepolia (chain id 84532), checked read-only through a JSON-RPC endpoint:
// the server asks for the transaction receipt and inspects the ERC-20 Transfer
// log itself — chain, asset contract, recipient, exact amount and settlement
// status. Nothing is signed or spent by the server, no keys exist here, and
// mainnet is unreachable by construction: the configured chain id must be one
// of the test chains below or payment start refuses outright.
//
// Constants were verified against the live chain on 2026-10-27:
// eth_chainId -> 0x14a34 (84532); symbol() -> "USDC"; decimals() -> 6;
// a real Transfer log carries topic0 as below. See sources.md.
"use strict";

const http = require("node:http");
const https = require("node:https");
const LIMITS = require("./limits");

// store.js requires this module, so its export is taken lazily — by the time
// any of these functions run, store.js has finished loading.
function apiError(status, message) {
  return new (require("./store").ApiError)(status, message);
}

// keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer event.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const TEST_CHAINS = { 84532: "Base Sepolia" };

function paymentConfig() {
  const chainId = LIMITS.PAY_CHAIN_ID;
  if (!TEST_CHAINS[chainId]) {
    throw apiError(503, "Test payments are misconfigured: the payment chain is not a supported test chain.");
  }
  const cfg = {
    chainId,
    chainName: TEST_CHAINS[chainId],
    rpcUrl: LIMITS.PAY_RPC_URL,
    asset: LIMITS.PAY_USDC_ADDRESS.toLowerCase(),
    recipient: LIMITS.PAY_RECIPIENT.toLowerCase(),
    amountUsdc: LIMITS.PAID_PRICE_USDC,
    amountRaw: String(LIMITS.PAID_PRICE_USDC * 10 ** LIMITS.PAY_USDC_DECIMALS) // 6 decimals on this asset
  };
  if (!/^0x[0-9a-f]{40}$/.test(cfg.recipient)) {
    throw apiError(503, "Test payments are misconfigured: the payment recipient is not a valid address.");
  }
  return cfg;
}

function rpcCall(url, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.request(
      url,
      {
        method: "POST",
        agent: false, // a fresh connection per verification call: no keep-alive socket can go stale between calls
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" }
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(apiError(502, `Payment verification failed: ${parsed.error.message || "RPC error"}.`));
            resolve(parsed.result);
          } catch {
            reject(apiError(502, "Payment verification failed: the payment node returned something unreadable."));
          }
        });
      }
    );
    req.setTimeout(LIMITS.PAY_RPC_TIMEOUT_MS, () => req.destroy(apiError(504, "Payment verification timed out; try again.")));
    req.on("error", (err) => {
      if (err && err.status) return reject(err); // an ApiError already, e.g. the timeout
      reject(apiError(502, "Payment verification is unreachable right now; try again."));
    });
    req.end(body);
  });
}

function hexToBig(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-f]*$/i.test(hex)) return null;
  return BigInt(hex === "0x" ? "0x0" : hex);
}

// Verify one settled test-USDC transfer. Returns details of the verified
// transfer, or throws an ApiError describing exactly what did not check out.
// A receipt that does not exist yet means "not settled (yet)", its own error.
async function verifyTransfer({ txHash, asset, recipient, amountRaw, chainId, rpcUrl }) {
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
    throw apiError(400, "That is not a transaction hash: it should be a 0x-prefixed string of 64 hex characters.");
  }
  // Addresses compare case-insensitively wherever they come from.
  asset = String(asset || "").toLowerCase();
  recipient = String(recipient || "").toLowerCase();

  const chain = await rpcCall(rpcUrl, "eth_chainId", []);
  if (hexToBig(chain) !== BigInt(chainId)) {
    throw apiError(502, "Payment verification failed: the payment node reports a different chain than the test chain payments are configured for.");
  }

  // The asset must be a real contract on that chain, not an address someone
  // happened to send tokens to.
  const code = await rpcCall(rpcUrl, "eth_getCode", [asset, "latest"]);
  if (!code || code === "0x") {
    throw apiError(503, "Test payments are misconfigured: the test-USDC asset has no contract code on the payment chain.");
  }

  const receipt = await rpcCall(rpcUrl, "eth_getTransactionReceipt", [txHash]);
  if (!receipt || typeof receipt !== "object" || !receipt.blockHash) {
    throw apiError(422, "That transaction is not settled yet — no receipt on the test chain. Once it is mined, confirm again.");
  }
  if (receipt.status !== "0x1") {
    throw apiError(422, "That transaction reverted on the test chain, so no transfer settled. Send a new transaction and confirm that one.");
  }

  const expectedTopic2 = "0x000000000000000000000000" + recipient.slice(2); // address topic is left-padded
  const log = (receipt.logs || []).find(
    (l) =>
      l &&
      typeof l.address === "string" &&
      l.address.toLowerCase() === asset &&
      Array.isArray(l.topics) &&
      l.topics[0] === TRANSFER_TOPIC && // the ERC-20 Transfer event, on the asset contract
      typeof l.topics[2] === "string" &&
      l.topics[2].toLowerCase() === expectedTopic2 && // to == our payment recipient
      !l.removed && // never count a log from a reorganised-away block
      hexToBig(l.data) != null &&
      hexToBig(l.data) === BigInt(amountRaw) // exactly the $12 worth of test-USDC
  );
  if (!log) {
    throw apiError(422, "That transaction does not carry a test-USDC transfer of exactly $12 to this workspace's payment address.");
  }

  return {
    txHash: txHash.toLowerCase(),
    from: log.topics[1] ? "0x" + log.topics[1].slice(-40) : null, // who sent it, for the audit record
    blockNumber: hexToBig(log.blockNumber).toString(),
    logIndex: hexToBig(log.logIndex).toString()
  };
}

module.exports = { paymentConfig, verifyTransfer, TRANSFER_TOPIC, TEST_CHAINS };
