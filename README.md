# write-bench

A neutral ERC-4337 write-path latency benchmark for Base mainnet.

Measures each stage of the userOp lifecycle independently (submit/accept, flashblock preconfirmation, canonical inclusion) using a **provider-independent neutral oracle** so the timing of every provider is measured identically — never by polling that provider's own receipt API.

Designed to produce fair, reproducible, per-stage numbers across Alchemy (Light Account v2, Modular Account v2), Pimlico (Safe), and ZeroDev (Kernel + UltraRelay) on Base mainnet.

---

## Design principles

- **Neutral oracle, not provider receipt timing.** Canonical inclusion is detected by watching `UserOperationEvent` on an independent Base node. Flashblock preconfirmation is detected via a separate, non-contestant `eth_subscribe("newFlashblockTransactions")` endpoint. No provider's own `getUserOperationReceipt` is used for timing.
- **Block position as primary finish line.** The headline metric is which (flash)block a userOp first appears in — immune to runner-side transit skew and independently verifiable on a block explorer. Wall-clock arrival is a secondary intra-block tiebreaker only.
- **Per-stage decomposition, not a single headline.** Every run reports submit/accept lag, flashblock preconf, canonical inclusion, and provider receipt availability as separate stages with explicit statuses (`ok | failed | timed-out | not-observed`).
- **N runs, median/p95.** Single-sample mainnet numbers are not defensible. Each provider runs N times; output reports per-stage median and p95.
- **UltraRelay in a separate exhibit.** ZeroDev's UltraRelay is an ERC-7683 intent relay — a different protocol class with a different finish line. It is never averaged with 4337 bundler results.

---

## v1 framing limits

Before publishing a run record, review the environment block and note:

- **Numbers are timing-distortion-corrected but NOT account-equivalence-corrected.** Light Account, Safe, and Kernel have different on-chain weight (deployment gas, execution complexity). The account-weight confound is surfaced but not eliminated in v1 — normalized-equivalence configurations are deferred.
- **Absolute preconfirmation gaps are neutral-node-peering-dependent.** Flashblock timing depends on how quickly your neutral flashblock endpoint receives blocks. The robust cross-provider claim is *equality* (two providers in the same flashblock), not the absolute gap.
- **Runners should review the environment block.** Network conditions, runner geography, and RPC region affect absolute times. The run record captures all of this; treat a single run as a single data point.

---

## Setup

**Prerequisites:** [Bun](https://bun.sh) ≥ 1.3

```bash
git clone https://github.com/alchemyplatform/write-bench
cd write-bench
bun install
cp .env.example .env
# fill in .env
```

**API keys needed:**

| Provider | Env var(s) |
|----------|-----------|
| Alchemy (Light Account v2)         | `ALCHEMY_API_KEY`, `ALCHEMY_POLICY_ID` |
| Alchemy (Modular Account v2)       | `ALCHEMY_API_KEY`, `ALCHEMY_POLICY_ID` |
| Alchemy (MAv2 BSO)                 | `ALCHEMY_API_KEY`, `ALCHEMY_BSO_POLICY_ID` |
| Alchemy (Wallet SendCalls, EIP-7702) | `ALCHEMY_API_KEY`, `ALCHEMY_POLICY_ID` |
| Pimlico (Safe)                     | `PIMLICO_API_KEY`, `PIMLICO_POLICY_ID` |
| ZeroDev (Kernel / UltraRelay)      | `ZERODEV_API_KEY`, `ZERODEV_PROJECT_ID` |

Plus `NEUTRAL_RPC_URL` pointing to an independent Base mainnet HTTP RPC (must **not** be Alchemy, Pimlico, or ZeroDev), and optionally `NEUTRAL_FLASHBLOCK_WS_URL` for a non-contestant flashblock endpoint.

> **RPC routing:** `NEUTRAL_RPC_URL` is used exclusively by the canonical oracle (`getLogs`, `getBlockNumber`) — neutrality matters there. Provider-specific pre-flight reads (nonce lookups, contract code fetches) are routed separately: Pimlico reads use the Alchemy RPC (Pimlico's bundler URL does not support `eth_call`), and ZeroDev reads use ZeroDev's own RPC (it is a full node). This prevents the free public Base node from being rate-limited under concurrent load.

---

## Usage

```bash
# Check which providers are runnable and run preflight
bun run src/cli/index.ts doctor

# Run the benchmark (all configured providers, N=5 iterations)
bun run src/cli/index.ts run

# Run Alchemy only
bun run src/cli/index.ts run --providers alchemy-light-account

# Run with JSON output to file
bun run src/cli/index.ts run --json results.json

# View a saved run in the local web dashboard
bun run src/cli/index.ts view results.json

# Or open the dashboard with sample data
bun run view

# Run 10 iterations
bun run src/cli/index.ts run -n 10
```

The dashboard is intentionally read-only: it visualizes the JSON run record emitted by the CLI, including provider rankings, stage medians/p95s, failure counts, raw run rows, and the separate intent-relay exhibit.

---

## How it works

```
CLI
 └─ loadConfig()         env → validated Config
 └─ runPreflight()       chain ID agreement, neutrality guard, flashblock probe
 └─ runBenchmarkGrid()   N iterations × M providers, parallel per-iteration
      └─ sendSponsored()     adapter: build fresh account, submit userOp → hash
      │    ├─ Alchemy LAv2 / MAv2       reads → Alchemy RPC
      │    ├─ Alchemy MAv2 BSO          reads → Alchemy RPC; bundler carries x-alchemy-policy-id header
      │    ├─ Alchemy Wallet SendCalls  wallet_sendCalls → waitForCallsStatus (inline canonical)
      │    ├─ Pimlico                   reads → Alchemy RPC (bundler URL does not support eth_call)
      │    └─ ZeroDev                   reads → ZeroDev RPC (full node)
      └─ canonicalOracle.watch()   neutral getLogs poll → UserOperationEvent (skipped for wallet-sendcalls)
      └─ flashblockOracle.watch()  neutral WS → newFlashblockTransactions
      └─ buildRunRecord()          assemble RunRecord with block positions
 └─ aggregateRuns()      median/p95 per stage across N runs
 └─ renderTable()        human-readable table (4337 headline + intent-relay exhibit)
 └─ serializeOutput()    JSON run record with redacted config + environment block
```

---

## Run record

Every run produces a self-describing JSON record at `results.json` (or stdout with `--json`). It contains:

- Tool version + git commit
- Config used (API keys and private keys **redacted**)
- Per-provider per-stage median/p95 + per-run raw timings
- Block positions (the primary finish line) and wall-clock tiebreakers
- Protocol class and finish-line mapping per provider
- Gas metrics (neutral-node canonical gas labeled separately from provider-sourced userOp gas)
- Whether preconfirmation timing was available for this run
- Environment: runner region, timestamp, neutral RPC URL

---

## Reproducing published results

Anyone with their own API keys can re-run the benchmark:

```bash
# Clone, configure .env with your own keys, then:
bun run src/cli/index.ts run --json my-results.json
```

Compare `my-results.json` against a published run record. The stage structure, account types, and finish-line definition are identical; absolute times will differ by runner geography and RPC region (captured in the environment block).

---

## License

MIT — see [LICENSE](LICENSE).

Intended to be published under the [`alchemyplatform`](https://github.com/alchemyplatform) GitHub org. Iterate locally first.
