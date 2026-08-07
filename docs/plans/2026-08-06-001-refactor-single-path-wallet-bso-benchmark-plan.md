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
| 2 | Time to mine | `ttm` *(renamed)* | `wallet_getCallsStatus` → **200 only** |
| 3 | First status response | `firstStatus` *(new)* | `wallet_getCallsStatus` → first terminal (110 **or** 200), split by `terminal_status` |

`ttm` means "actually mined in a block" — what readers already assumed `canonical` meant. That is what makes the Base special-case deletable.

**Amended 2026-08-06:** the stage was renamed `canonical` → `ttm` during implementation. "Canonical" is the word that invited the misreading this plan exists to fix, and it stayed ambiguous even after the definition was corrected. The chain-level vocabulary keeps the old word where it is accurate — `CanonicalOracle`, `canonicalObserver`, `canonicalIdentifier`, `TIMEOUT_CANONICAL_MS` — because there it means canonical chain inclusion, not the measured stage. No extra epoch bump: `wallet-bso-v1` was never deployed, so the label value changes inside the same epoch.

### Requirements

- R1. The monitored path is Wallet APIs with a BSO policy and defaults (7702 + MAv2). No second modality is monitored.
- R2. `ttm` terminates only on `wallet_getCallsStatus` 200, on every network. It never derives from a Flashblock and never accepts 110.
- R3. `firstStatus` terminates on the first terminal status (110 or 200) and carries `terminal_status` so the split is visible.
- R4. `preconf` remains the neutral Flashblocks WS measurement. It is Base-only; on other networks it reports `not-observed` and its panels are empty by design.
- R5. Monitoring continues for non-Base networks (eth/opt/arb) with datapoints 2 and 3 only.
- R6. The MAv2 BSO adapter is removed from *monitoring* but its code is retained — the public/CLI benchmark needs a 4337 path to compare against Pimlico and ZeroDev.
- R7. The account is reused across runs and delegation is established outside the timed loop, so 7702 delegation cost is not counted per-attempt. (Already true: `ensureDeployed()` runs in the untimed bootstrap phase.)

---

## Implementation Units

### Unit 0 — Gate: confirm a BSO policy works through the Wallet API path — ✅ PASSED 2026-08-06

**This gated every other unit.** The two adapters sponsor by different mechanisms:

- Wallet: `paymaster: { policyId }` on the SDK client plus per-call `capabilities` (`src/benchmark/providers/alchemy-wallet-sendcalls.ts:220,250,265`). A paymaster *contract* pays.
- BSO: an `x-alchemy-policy-id` HTTP header on the bundler transport (`src/benchmark/providers/alchemy-mav2-bso.ts:170`) **and all three gas fields zeroed** (`:277-280`), which signals the *bundler* to cover gas.

Three outcomes were possible: (a) it errors, (b) it works as real BSO, (c) it appears to work but quietly applies ordinary paymaster sponsorship, i.e. we ship a benchmark labelled BSO that is not BSO. Outcome (c) was the risk worth gating on.

**Result: (b).** `scripts/wallet-bso-policy-probe.ts` sent one op under each policy on Base mainnet and diffed the prepared user operation. Both mined (status 200). The BSO op is a genuine bundler-sponsored operation:

| field | regular policy | BSO policy |
|---|---|---|
| `paymaster` | `0x2cc0c798…` | absent |
| `paymasterData` | 156 chars | absent |
| `paymasterVerificationGasLimit` | 30013 | 0 |
| `maxFeePerGas` | 10825000 | **0** |
| `maxPriorityFeePerGas` | 1500000 | **0** |
| `preVerificationGas` | 47865 | **0** |
| `verificationGasLimit` | 33764 | 71401 |

No paymaster contract and all three gas fields zeroed is exactly the BSO signature documented in the 4337 adapter, so the Wallet API does recognise a BSO policy and route accordingly. **Unit 1 can proceed with a `cfg.policyId` → `cfg.bsoPolicyId` swap; no header plumbing is needed.**

Incidental notes: the prepared object carries a `feePayment` key alongside `type/data/chainId/signatureRequest/details`; it flows through `signPreparedCalls`/`sendPreparedCalls` untouched, so no handling is required. Mined latency was 1981ms (BSO) vs 2314ms (regular), but n=1 per policy — not a benchmark result and not to be quoted.

### Unit 1 — Wallet adapter uses the BSO policy

- `alchemy-wallet-sendcalls.ts`: source the policy from `cfg.bsoPolicyId` instead of `cfg.policyId`, with an explicit error when unset.
- `src/benchmark/rows.ts:60`: `requiredEnv` becomes `['ALCHEMY_API_KEY', 'ALCHEMY_BSO_POLICY_ID']`.
- Preflight/config messaging updated so a missing BSO policy fails loudly rather than silently falling back.

### Unit 2 — Add the `firstStatus` stage

- `src/benchmark/contracts.ts:41-48` (`RunRecord['stages']`) and `:86-93` (`ProviderMetrics['stages']`).
- `src/benchmark/metrics.ts`: build the stage from a `CanonicalResult`.
- `src/monitor/loop.ts`: add to `expectedStages`; extend `terminalStatusForStage` so `firstStatus` also carries a real terminal status (it is currently canonical-only).
- `src/benchmark/service.ts`: run the status observation and the flashblock WS concurrently per attempt — flashblock WS → `preconf`, status stream → `firstStatus` + `canonical`.

No new observer code is needed for datapoint 2: `canonicalObserver` (target `'confirmed'`, 200-only) already exists and is simply **never called on Base today**, because the earliest-signal branch short-circuits it.

**Amended 2026-08-06 after live validation.** The first implementation ran
`earlyInclusionObserver` and `canonicalObserver` as two concurrent poll loops. That fails
this plan's own ordering criterion: when 110 does not fire, both loops wait for the *same*
200 and their poll phases differ by up to one 250ms interval, so `firstStatus` can land
after `ttm`. Observed on 2 of 5 live attempts (inversions of 88ms and 55ms).

Replaced with a single poll stream: `AccountClient.earlyInclusionObserver` →
`statusStagesObserver`, returning `{ firstStatus, ttm }` from one loop that records
110 if it arrives and continues to 200. Ordering now holds by construction, per-attempt
`wallet_getCallsStatus` load halves, and when 110 does not fire both stages report the
*same observation object* rather than two timings of one event.

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

`MEASUREMENT_EPOCH` → `wallet-bso-v1`. The time-to-mine definition genuinely changes (Flashblock/110 → 200-only), so history should break cleanly rather than silently mixing definitions inside one series. Contrast with the `terminal_status` label addition, which deliberately did **not** bump the epoch because only dimensionality changed.

### Unit 6 — Cleanups

- **Drop `providerReceipt` for `wallet-sendcalls`.** It is 100% `not-observed` in every production window — one series of pure noise.
- **Stop wasting ~30s per non-Base iteration.** With the no-op WS, `flashblockOracle.watch` always runs to the full `preconfMs` timeout, flooring a 20-attempt non-Base batch at ~10 minutes regardless of response speed. Skip the watch entirely when no Flashblocks WS URL is configured, and record `preconf` as `not-observed` directly.

### Unit 7 — Dashboard

`monitoring/grafana/txe-write-bench-latency.json`:

- Remove the BSO row and the cross-provider `preconf` comparison (single provider now).
- Three P90 panels matching Ava's numbering: `preconf`, `ttm` (time to mine), `firstStatus`.
- Keep the terminal-status breakdown, retargeted from `ttm` to `firstStatus`. This is where the rundler fix will visibly land: once dedup is fixed, `firstStatus` should drop toward `preconf`.
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
3. One live monitor run against `base-mainnet`: confirm three distinct stage timings per attempt, with `preconf` < `firstStatus` ≤ `ttm`.
4. One live run against a non-Base network: confirm `preconf` is `not-observed` and no 30s stall per iteration.
5. Post-deploy Thanos check under `wallet-bso-v1`: all three stages present, `terminal_status` split visible on `firstStatus`, non-Base `preconf` absent.
6. Re-check after the rundler fix lands: `firstStatus` should converge toward `preconf`.

## Risks

- **Unit 0 fails.** If the Wallet path needs the `x-alchemy-policy-id` header rather than a paymaster policy ID, Unit 1 grows. Mitigated by gating.
- **Single-account nonce contention.** One path from one stable EOA means sequential sends. The probe hit "replacement underpriced" when sends overlapped. Monitor iterations are already serialized behind a full canonical wait, and dropping the second modality *reduces* per-iteration concurrency, but watch for it once `ttm` waits for 200 (~2s) rather than 110.
- **Losing the cross-modality tie evidence.** After Unit 4 the monitor no longer produces the BSO-vs-Wallet `preconf` comparison that disproved the "4x slower" reading. Preserve the current numbers (us-east-1 p50 218ms vs 208ms) in this doc and in the PR description, and keep the CLI path able to reproduce it on demand.
