# Source ledger

| URL | Fetched | Supports |
| --- | --- | --- |
| https://sepolia.base.org (JSON-RPC: eth_chainId) | 2026-10-27 | Base Sepolia public RPC responds; chain id 0x14a34 = 84532 |
| https://sepolia.base.org (eth_call symbol()/decimals(), eth_getCode) | 2026-10-27 | 0x036CbD53842c5426634e7929541eC2318f3dCF7e is "USDC", 6 decimals, has contract code |
| https://sepolia.base.org (eth_getLogs, eth_getTransactionReceipt) | 2026-10-27 | ERC-20 Transfer topic0 0xddf252ad…3b3ef; receipt shape status "0x1", logs array (e.g. tx 0x355ab92e0fac52856a6d5dd1bfe9868d5d64baaf10b4389dd0a0d580bd6c030a) |
| https://sepolia.base.org (eth_chainId) | 2026-10-28 | Base Sepolia still live, chain id 0x14a34 |
| https://fl-dev-a08b773d-0291-4db7-b6c9-9c2a93c26218.fly.dev/ | 2026-10-28 | Dev preview live (HTTP 200) and serving the merged test-payment revision: sign-up, workspace create and pay-test/start all work through the real API |
| https://fl-dev-a08b773d-0291-4db7-b6c9-9c2a93c26218.fly.dev/api/ws/…/pay-test/confirm | 2026-10-28 | Confirm with an unmined hash refused with "not settled yet — no receipt on the test chain": the live preview drives the real sepolia.base.org RPC end to end |
| https://sepolia.base.org (eth_getCode on a per-request payment address) | 2026-10-28 | A payment request's recipient is a plain keyless account (code 0x), as designed |
| https://docs.base.org/base-chain/network-information/network-faucets | 2026-10-28 | Official faucet list: CDP (login/API key), thirdweb, Alchemy (account), QuickNode, Chainstack (API key), ethfaucet (Twitter); test USDC only via Circle (login) |
| alchemy.com/faucets/base-sepolia, faucet.quicknode.com/base (search results) | 2026-10-28 | Even the "no account" drips gate on the claiming wallet holding mainnet ETH, which a fresh ephemeral wallet does not |
