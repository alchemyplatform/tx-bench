# Monitoring artifacts

## `grafana/txe-write-bench-latency.json`

The Grafana dashboard for the recurring monitor's `txe_bench_*` metrics (datasource
`thanos-obsv2`). Import via **Dashboards → Import → paste JSON**, or update an existing
dashboard by pasting over it. Importing replaces the saved dashboard, so review before
confirming.

This file is the source of truth. Grafana's UI lets anyone edit a dashboard in place,
which silently diverges from what is committed here — if you change panels in the UI,
export the JSON (**Dashboard settings → JSON Model**) and commit it back in the same PR
as any query or label change it depends on.

### Reading it correctly

Use the **`preconf`** stage for any cross-provider or cross-modality latency claim. It is
measured identically for every provider by the same non-contestant
`newFlashblockTransactions` oracle.

Do **not** compare the `canonical` panels across providers on `base-mainnet` — that stage
means different things per modality there:

- `alchemy-mav2-bso` — the Flashblock signal, which is the *same measurement* as its
  `preconf` (`canonicalFromFlashblock` copies `tMs`), not an independent confirmation.
- `alchemy-wallet-sendcalls` — `wallet_getCallsStatus` reaching `110` or `200`, both
  block-level signals landing ~1.7s in. Despite the name, `110` is not a Flashblock
  preconfirmation: it fires intermittently and trails actual Flashblock inclusion by
  ~0.7–1.4s. See `scripts/wallet-status-110-probe.ts` for the measurement.

The `preconf not-observed rate` panel is a validity guard for the preconf figures: those
percentiles only describe the whole population while it reads ~0. If Flashblock
attribution degrades, the latencies silently become a biased fast subset and look
*better*, so check it before quoting numbers.
