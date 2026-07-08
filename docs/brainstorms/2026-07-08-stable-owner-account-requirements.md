---
date: 2026-07-08
topic: stable-owner-account
---

# Stable Owner Account for Steady-State Benchmarking

## Summary

Switch the benchmark from random ephemeral owner accounts to a single stable, deterministic owner account (`OWNER_PRIVATE_KEY`) per (provider, network), so every run measures steady-state transaction latency on an already-deployed account. The account self-bootstraps on first run (one untimed deployment op, excluded from metrics), then is reused across all future runs.

---

## Problem Frame

The benchmark measures per-stage transaction latency (submit → flashblock preconf → canonical inclusion) for sponsored smart-account writes on Base and other EVM networks. Today every run calls `generatePrivateKey()` to mint a fresh random owner, producing a fresh smart account address per run. For ERC-4337 Modular Account v2 (counterfactual) and EIP-7702 wallet_sendCalls, the first operation on a fresh account includes account deployment / 7702 authorization setup in the userOp — inflating submit latency and mixing cold-start cost into what is supposed to be a steady-state pipeline measurement.

`OWNER_PRIVATE_KEY` is already plumbed through config (`src/benchmark/config.ts`), monitor secrets (`src/monitor/secrets.ts`), and the loop env injection (`src/monitor/loop.ts`), and is already redacted in output (`src/benchmark/output.ts`). But no adapter ever reads `config.ownerPrivateKey` — the plumbing is dead. The monitor runs hourly for regression detection, where the signal that matters is pipeline latency drift over time, not one-time account creation cost. Random accounts inject deployment noise into every run, making regression detection noisier than it needs to be.

---

## Actors

- A1. Monitor (automated hourly runner): runs the benchmark grid hourly across configured EVM networks, pushes latency/failure gauges.
- A2. Operator (on-call): reviews failure metrics and manually intervenes when a persistent account gets stuck (rare).

---

## Key Flows

- F1. Self-bootstrap
  - **Trigger:** Benchmark startup for a (provider, network) pair.
  - **Actors:** A1
  - **Steps:** Check whether the deterministic account is deployed on-chain. If not deployed, run one deployment userOp (untimed). If already deployed, skip. Proceed to steady-state measurement.
  - **Outcome:** The account is deployed and ready; all subsequent timed runs measure steady-state.
  - **Covered by:** R1, R2, R3, R4

- F2. Steady-state run
  - **Trigger:** Account is deployed; timed measurement begins.
  - **Actors:** A1
  - **Steps:** Run `runCount` timed iterations sending a sponsored write to a dead address. Each iteration measures submit, preconf, and canonical stages. Aggregate to median/p95. Push gauges.
  - **Outcome:** Steady-state latency metrics are recorded for this (provider, network).
  - **Covered by:** R1, R5

- F3. Stuck-account failure
  - **Trigger:** A run fails or times out (e.g. stuck userOp, nonce gap).
  - **Actors:** A1, A2
  - **Steps:** The failed/timed-out run is recorded as a failure in metrics. The next hourly run attempts normally — no active recovery. If failures persist, the operator investigates and manually fixes the account.
  - **Outcome:** Failures are visible in metrics; recovery is operator-driven, not automatic.
  - **Covered by:** R6

---

## Requirements

**Stable owner account**

- R1. Adapters must use `config.ownerPrivateKey` (from `OWNER_PRIVATE_KEY`) as the owner for the smart account, instead of generating a fresh random key per run. The same key is reused across all timed iterations and across all hourly runs.
- R2. One `OWNER_PRIVATE_KEY` derives the owner for every configured EVM network and every adapter. No per-network or per-adapter keys. Each (provider, network) pair is a distinct on-chain account instance (own deployment state and nonce) derived from the single key.

**Self-bootstrap**

- R3. On startup, for each (provider, network), the benchmark must check whether the deterministic account is deployed on-chain. If not deployed, it must run one deployment userOp before any timed measurement. If already deployed, it must skip straight to timed measurement.
- R4. The deployment userOp run during bootstrap must be excluded from steady-state latency metrics and must not count toward `runCount`.

**Steady-state measurement**

- R5. All `runCount` timed iterations must measure an already-deployed account's transaction latency (submit, preconf, canonical). No cold-start/deployment cost may be included in steady-state metrics.

**Failure handling**

- R6. Failed or timed-out runs must be reported as failures in metrics. The benchmark must not attempt active nonce-gap recovery (replace-by-fee, op replacement). Recovery is operator-driven.

**Credentials**

- R7. The monitor flow must require `OWNER_PRIVATE_KEY` (already enforced in `src/monitor/secrets.ts`). It must be a valid `0x` + 64-hex private key.

---

## Acceptance Examples

- AE1. **Covers R3, R4.** Given a fresh `OWNER_PRIVATE_KEY` whose deterministic MAv2 account is not yet deployed on Base, when the monitor starts a run for (MAv2 BSO, base-mainnet), then it runs one untimed deployment userOp first, excludes that op from metrics, and then runs `runCount` timed iterations measuring steady-state latency.
- AE2. **Covers R3.** Given the same `OWNER_PRIVATE_KEY` on the next hourly run where the account is now deployed on Base, when the monitor starts, then it skips the deployment op and runs `runCount` timed iterations directly.
- AE3. **Covers R2.** Given one `OWNER_PRIVATE_KEY` and four configured networks (eth, base, opt, arb) with two adapters (MAv2 BSO, Wallet SendCalls), when the monitor runs, then eight distinct account instances bootstrap and run independently, all derived from the single key, each with its own deployment state.
- AE4. **Covers R6.** Given a persistent account where a userOp is stuck (submitted but not mined), when the next hourly run attempts a new op and it fails/times out, then the run is recorded as a failure in metrics and no automatic recovery is attempted; the account remains in whatever on-chain state it reached.

---

## Success Criteria

- Steady-state latency metrics (median/p95 submit, preconf, canonical) no longer include account deployment cost, reducing noise in hourly regression monitoring.
- A single `OWNER_PRIVATE_KEY` in the monitoring secret is sufficient to run the benchmark across all configured EVM networks — no per-network key management.
- The first-ever run on a fresh account self-bootstraps without operator intervention; subsequent runs skip deployment.
- A downstream planner can implement the change by rewiring adapters to read `config.ownerPrivateKey` and adding a per-(provider, network) deployment check, without inventing product behavior.

---

## Scope Boundaries

- Cold-start / first-transaction benchmarking is out of scope. The benchmark measures steady-state only; the deployment op is untimed and excluded from metrics.
- Active nonce-gap recovery (replace-by-fee, op replacement) and failure-streak alerting are out of scope. Operators handle rare stuck accounts manually.
- Out-of-band setup scripts for account deployment are out of scope. Deployment is self-bootstrapped inline.
- Per-invocation account freshness (fresh account per benchmark run) is out of scope. Accounts are per-deployment persistent.
- Account-weight equivalence normalization across account types (Light Account vs Safe vs Kernel on-chain weight) remains a known v1 limit per the README and is not addressed here.

---

## Key Decisions

- **Steady-state only, not cold-start:** The benchmark's purpose is pipeline latency regression detection, not first-user experience. Deployment cost is excluded from measurement.
- **Per-deployment persistence over per-invocation freshness:** One account per (provider, network), deployed once, reused forever. Gives the purest steady-state signal. Accepted trade-off: a stuck account blocks all future runs for that (provider, network) until operator intervention.
- **Trust-the-API recovery over active gap recovery:** The bundler / wallet API handles nonce management and replacement in the common case. The benchmark reports failures and does not attempt self-healing. Minimizes machinery; accepted trade-off: no automatic recovery when an account gets stuck.
- **Self-bootstrap + filter over out-of-band setup:** On startup, check deployment state via `getCode`; deploy inline if needed (untimed, excluded). Avoids a separate setup script and operational step; self-heals if an account is ever cleared.

---

## Dependencies / Assumptions

- A single EVM private key produces the same EOA address on every EVM chain (address derivation is chain-independent). Verified: all configured monitor networks (eth, base, opt, arb) are EVM.
- For EIP-7702 Wallet SendCalls, the account address is the owner EOA address (`signer.address`), so the same key yields the same account on every chain.
- For MAv2 BSO, `toModularAccountV2({ owner })` deterministically derives the counterfactual account address from the owner. Unverified assumption: whether the derived address is identical across chains or differs per chain. This does not affect the single-key design — one owner key deterministically derives the account regardless — but planning should confirm the derivation inputs.
- Each (provider, network) account instance has independent on-chain deployment state and nonce; they share the owner key but not state.
- `OWNER_PRIVATE_KEY` is already required and validated in `src/monitor/secrets.ts`; the monitor loop already injects it into env in `src/monitor/loop.ts`. The existing plumbing is reused; only adapter consumption is new.

---

## Outstanding Questions

### Resolve Before Planning

_(None — all product decisions resolved in dialogue.)_

### Deferred to Planning

- [Affects R6][Cheap-now-expensive-later] A lightweight "N consecutive failures for this (provider, network)" flag was surfaced during brainstorm as a way to disambiguate a stuck persistent account from a provider outage in the failure metrics. It was kept out of scope to minimize machinery, but planning should evaluate whether a small consecutive-failure counter is worth adding so an operator can tell "fix the account" from "fix the provider."
- [Affects R1][Technical] Should the CLI (non-monitor) flow require `OWNER_PRIVATE_KEY`, or fall back to random keys for local dev when it is unset? The monitor requires it; the CLI's behavior when unset is a planning decision.
- [Affects R3][Needs research] Confirm the exact `getCode` / deployment-state check per adapter (MAv2 counterfactual vs EIP-7702 delegated code) and whether the first userOp reliably deploys the account in both cases.
