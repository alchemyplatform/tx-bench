---
title: Single-Path Wallet + BSO Internal Benchmark - Plan
type: refactor
date: 2026-08-06
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
origin: Slack #tx-engine-prs thread 1785959462.595319 (Ava Robinson, 2026-08-06)
---

# Single-Path Wallet + BSO Internal Benchmark - Plan

**Target repository:** `tx-bench`. Paths are repo-relative. The Grafana dashboard now lives in-repo at `monitoring/grafana/txe-write-bench-latency.json`.

## Goal Capsule

- **Objective:** Collapse internal monitoring onto one recommended path — Wallet APIs with a BSO policy and defaults (EIP-7702 + MAv2) — and emit exactly the three latency numbers we intend to share externally.
- **Authority:** Ava's 2026-08-06 summary in #tx-engine-prs is the product contract. It supersedes the two-modality comparison framing in `2026-07-20-001-fix-canonical-latency-integrity-plan.md`.
- **Stop conditions:** Do not remove the 4337 monitoring row until a BSO policy is confirmed working through the Wallet API path (Unit 0). Do not ship a `canonical` stage that means different things per provider or per network.
- **Tail ownership:** Bump the measurement epoch, cut the dashboard over, then validate against live Thanos data before quoting any number externally.

---

## Problem Frame

Internal monitoring currently runs two modalities (MAv2 BSO over raw 4337, and Wallet SendCalls over EIP-7702) and, on `base-mainnet`, derives the `canonical` stage differently for each:

- BSO `canonical` is copied from the first matching Flashblock (`canonicalFromFlashblock` in `src/benchmark/service.ts`), making it numerically identical to its own `preconf`.
- Wallet SendCalls `canonical` is `wallet_getCallsStatus` reaching 110 or 200, both block-level signals ~1.7s in.

Reading those two columns side by side suggests Wallet is ~4x slower than BSO. It is not: measured identically via the neutral Flashblocks oracle the two are within ~10ms (us-east-1 p50 218ms vs 208ms). This is the same apples-to-oranges artifact the benchmark exists to rebut, pointed inward, and it already caused a near-miss on numbers headed to Uniswap.

Two supporting findings from 2026-08-06:

- `wallet_getCallsStatus` code 110 is **not** a Flashblock-speed signal. Measured via `scripts/wallet-status-110-probe.ts`: it fires on a minority of ops and trails actual Flashblock inclusion by ~0.7–1.4s, carrying a receipt whose `blockNumber` is one past `pendingBundle.sentAtBlock`.
- Jake Hobbs identified the mechanism: **rundler dedups flashblocks on `header.hash`, but the pending block's hash is always 0**, so preconf transitions collapse. Fix expected early week of 2026-08-10, tracked in a separate #tx-engine thread.

## Product Contract

One path, three numbers, no stage that means two different things.

| # | Ava's datapoint (P90) | Stage | Source |
|---|---|---|---|
| 1 | Flashblocks preconfirm time | `preconf` | `newFlashblockTransactions` WS — unchanged |
| 2 | Time to mine | `canonical` | `wallet_getCallsStatus` → **200 only** |
| 3 | First status response | `firstStatus` *(new)* | `wallet_getCallsStatus` → first terminal (110 **or** 200), split by `terminal_status` |

`canonical` reverts to meaning "actually mined in a block", which is what readers already assume it means. That is what makes the Base special-case deletable.

### Requirements

- R1. The monitored path is Wallet APIs with a BSO policy and defaults (7702 + MAv2). No second modality is monitored.
- R2. `canonical` terminates only on `wallet_getCallsStatus` 200, on every network. It never derives from a Flashblock and never accepts 110.
- R3. `firstStatus` terminates on the first terminal status (110 or 200) and carries `terminal_status` so the split is visible.
- R4. `preconf` remains the neutral Flashblocks WS measurement. It is Base-only; on other networks it reports `not-observed` and its panels are empty by design.
- R5. Monitoring continues for non-Base networks (eth/opt/arb) with datapoints 2 and 3 only.
- R6. The MAv2 BSO adapter is removed from *monitoring* but its code is retained — the public/CLI benchmark needs a 4337 path to compare against Pimlico and ZeroDev.
- R7. The account is reused across runs and delegation is established outside the timed loop, so 7702 delegation cost is not counted per-attempt. (Already true: `ensureDeployed()` runs in the untimed bootstrap phase.)

---

## Implementation Units

### Unit 0 — Gate: confirm a BSO policy works through the Wallet API path

**This gates every other unit.** The two adapters pass policies by different mechanisms:

- Wallet: `paymaster: { policyId }` on the SDK client plus per-call `capabilities` (`src/benchmark/providers/alchemy-wallet-sendcalls.ts:220,250,265`).
- BSO: an `x-alchemy-policy-id` HTTP header on the bundler transport (`src/benchmark/providers/alchemy-mav2-bso.ts:170`).

The working assumption (from Pavel) is that supplying the BSO policy ID as the Wallet paymaster policy is sufficient. Verify with a one-off script: single sponsored send, assert success, print the resolved paymaster fields. If it instead requires the header, Unit 1 changes shape — and we learn that before removing the 4337 row.

### Unit 1 — Wallet adapter uses the BSO policy

- `alchemy-wallet-sendcalls.ts`: source the policy from `cfg.bsoPolicyId` instead of `cfg.policyId`, with an explicit error when unset.
- `src/benchmark/rows.ts:60`: `requiredEnv` becomes `['ALCHEMY_API_KEY', 'ALCHEMY_BSO_POLICY_ID']`.
- Preflight/config messaging updated so a missing BSO policy fails loudly rather than silently falling back.

### Unit 2 — Add the `firstStatus` stage

- `src/benchmark/contracts.ts:41-48` (`RunRecord['stages']`) and `:86-93` (`ProviderMetrics['stages']`).
- `src/benchmark/metrics.ts`: build the stage from a `CanonicalResult`.
- `src/monitor/loop.ts`: add to `expectedStages`; extend `terminalStatusForStage` so `firstStatus` also carries a real terminal status (it is currently canonical-only).
- `src/benchmark/service.ts`: run all three observers concurrently per attempt — flashblock WS → `preconf`, `earlyInclusionObserver` → `firstStatus`, `canonicalObserver` → `canonical`.

No new observer code is needed for datapoint 2: `canonicalObserver` (target `'confirmed'`, 200-only) already exists and is simply **never called on Base today**, because the earliest-signal branch short-circuits it.

### Unit 3 — Delete the earliest-signal machinery

Remove from `src/benchmark/service.ts`:

- `canonicalFromFlashblock()`
- the `canonicalSource` option and `useEarliestSignalCanonical`
- the three-way branch that selects a canonical source

`src/monitor/loop.ts` stops passing `canonicalSource`. This is the single largest simplification in the plan and removes the root cause of the two-meanings-of-canonical confusion.

### Unit 4 — Monitor-only removal of the 4337 row

- `src/monitor/loop.ts:18`: drop `alchemyMAv2BSOAdapter` from `ALCHEMY_ADAPTERS`.
- Keep `src/benchmark/providers/alchemy-mav2-bso.ts` and its row/tests intact for CLI and public cross-provider runs.

### Unit 5 — Epoch bump

`MEASUREMENT_EPOCH` → `wallet-bso-v1`. The `canonical` definition genuinely changes (Flashblock/110 → 200-only), so history should break cleanly rather than silently mixing definitions inside one series. Contrast with the `terminal_status` label addition, which deliberately did **not** bump the epoch because only dimensionality changed.

### Unit 6 — Cleanups

- **Drop `providerReceipt` for `wallet-sendcalls`.** It is 100% `not-observed` in every production window — one series of pure noise.
- **Stop wasting ~30s per non-Base iteration.** With the no-op WS, `flashblockOracle.watch` always runs to the full `preconfMs` timeout, flooring a 20-attempt non-Base batch at ~10 minutes regardless of response speed. Skip the watch entirely when no Flashblocks WS URL is configured, and record `preconf` as `not-observed` directly.

### Unit 7 — Dashboard

`monitoring/grafana/txe-write-bench-latency.json`:

- Remove the BSO row and the cross-provider `preconf` comparison (single provider now).
- Three P90 panels matching Ava's numbering: `preconf`, `canonical` (time to mine), `firstStatus`.
- Keep the terminal-status breakdown, retargeted from `canonical` to `firstStatus`. This is where the rundler fix will visibly land: once dedup is fixed, `firstStatus` should drop toward `preconf`.
- Keep the `preconf` not-observed guard; note in its description that non-Base networks read empty by design.
- Update `monitoring/README.md` for the new stage vocabulary.

---

## Settled Decisions

- **Non-Base networks:** keep monitoring them; `preconf` panels are empty there by design (R4/R5).
- **MAv2 BSO adapter:** monitor-only removal, code retained (R6).
- **Sequencing vs the rundler fix:** ship this restructure without waiting. The epoch bump makes the before/after legible, and the fix is expected early week of 2026-08-10.
- **PR #13:** merge as-is before starting. `terminal_status` is load-bearing for datapoint 3, the probe script is in active use for the rundler investigation, and the dashboard corrections prevent a misleading external screenshot in the interim. The only churn is the `canonicalSource` rename, deleted here in Unit 3.

## Validation

1. `bun test` and `bunx tsc --noEmit` green.
2. Unit 0 gate passes before any removal.
3. One live monitor run against `base-mainnet`: confirm three distinct stage timings per attempt, with `preconf` < `firstStatus` ≤ `canonical`.
4. One live run against a non-Base network: confirm `preconf` is `not-observed` and no 30s stall per iteration.
5. Post-deploy Thanos check under `wallet-bso-v1`: all three stages present, `terminal_status` split visible on `firstStatus`, non-Base `preconf` absent.
6. Re-check after the rundler fix lands: `firstStatus` should converge toward `preconf`.

## Risks

- **Unit 0 fails.** If the Wallet path needs the `x-alchemy-policy-id` header rather than a paymaster policy ID, Unit 1 grows. Mitigated by gating.
- **Single-account nonce contention.** One path from one stable EOA means sequential sends. The probe hit "replacement underpriced" when sends overlapped. Monitor iterations are already serialized behind a full canonical wait, and dropping the second modality *reduces* per-iteration concurrency, but watch for it once `canonical` waits for 200 (~2s) rather than 110.
- **Losing the cross-modality tie evidence.** After Unit 4 the monitor no longer produces the BSO-vs-Wallet `preconf` comparison that disproved the "4x slower" reading. Preserve the current numbers (us-east-1 p50 218ms vs 208ms) in this doc and in the PR description, and keep the CLI path able to reproduce it on demand.
