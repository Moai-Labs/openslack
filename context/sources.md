# Source ledger

| URL | Fetched | Supports |
| --- | --- | --- |
| https://sepolia.base.org (JSON-RPC: eth_chainId) | 2026-10-27 | Base Sepolia public RPC responds; chain id 0x14a34 = 84532 |
| https://sepolia.base.org (eth_call symbol()/decimals(), eth_getCode) | 2026-10-27 | 0x036CbD53842c5426634e7929541eC2318f3dCF7e is "USDC", 6 decimals, has contract code |
| https://sepolia.base.org (eth_getLogs, eth_getTransactionReceipt) | 2026-10-27 | ERC-20 Transfer topic0 0xddf252ad…3b3ef; receipt shape status "0x1", logs array (e.g. tx 0x355ab92e0fac52856a6d5dd1bfe9868d5d64baaf10b4389dd0a0d580bd6c030a) |
