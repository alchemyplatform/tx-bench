import type { RunOutput } from '../benchmark/output.js'
import type { ProviderMetrics } from '../benchmark/contracts.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMs(ms: number | undefined): string {
  if (ms == null) return 'n/a'
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${ms.toFixed(0)}ms`
}

function fmtStage(
  metrics: { median: number; p95: number; count: number } | undefined,
  status?: string
): string {
  if (!metrics) return status === 'timed-out' ? 'timed-out' : 'n/a'
  return `${fmtMs(metrics.median)} / ${fmtMs(metrics.p95)}`
}

function hr(width = 72, char = '─'): string {
  return char.repeat(width)
}

function col(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length)
}

// ── Render ────────────────────────────────────────────────────────────────────

export function renderTable(output: RunOutput): string {
  const lines: string[] = []
  const { results, preconfAvailable, env } = output

  lines.push(`write-bench ${env.toolVersion} · ${new Date(env.generatedAt).toUTCString()}`)
  if (!preconfAvailable) {
    lines.push('⚠  Canonical-only mode — NEUTRAL_FLASHBLOCK_WS_URL not configured or unreachable.')
    lines.push('   Preconfirmation timing is unavailable. This is a weaker rebuttal of a preconf-timed claim.')
  }
  lines.push('')

  const bundlerResults = results.filter(r => r.row.protocolClass === '4337-bundler')
  const relayResults = results.filter(r => r.row.protocolClass === 'intent-relay')
  const walletResults = results.filter(r => r.row.protocolClass === 'wallet-sendcalls')

  // ── 4337 Bundlers headline table ────────────────────────────────────────────
  lines.push('── 4337 Bundlers (same-class comparison) ' + hr(31))
  lines.push(
    col('Provider', 28) +
    col('Submit  (med/p95)', 22) +
    col('Flashblock (med/p95)', 24) +
    col('Canonical (med/p95)', 22)
  )
  lines.push(hr(96))

  for (const { row, metrics } of bundlerResults) {
    const preconfCol = preconfAvailable ? fmtStage(metrics.stages.preconf) : 'unavailable'
    const failNote = metrics.failureCount > 0 ? ` [${metrics.failureCount}/${metrics.runCount} failed]` : ''
    lines.push(
      col(row.label + failNote, 28) +
      col(fmtStage(metrics.stages.submit), 22) +
      col(preconfCol, 24) +
      col(fmtStage(metrics.stages.canonical), 22)
    )
  }

  lines.push('')
  lines.push('  Columns: median / p95 across successful runs.')
  if (preconfAvailable) {
    lines.push('  Flashblock timing depends on runner–node peering; cross-provider equality is the robust claim.')
  }
  lines.push('  Account types differ across providers (Light Account vs Safe vs Kernel) — not equivalent weight.')

  // ── Intent-relay exhibit ─────────────────────────────────────────────────────
  if (relayResults.length > 0) {
    lines.push('')
    lines.push('── Intent-Relay Exhibit (different protocol class — not comparable to above) ' + hr(0))
    lines.push('   UltraRelay uses ERC-7683 intent relay and settles via a different finish line.')
    lines.push('   These numbers reflect a different protocol, not a faster bundler.')
    lines.push('')
    lines.push(
      col('Provider', 28) +
      col('Submit  (med/p95)', 22) +
      col('Canonical (med/p95)', 22)
    )
    lines.push(hr(72))

    for (const { row, metrics } of relayResults) {
      const failNote = metrics.failureCount > 0 ? ` [${metrics.failureCount}/${metrics.runCount} failed]` : ''
      lines.push(
        col(row.label + failNote, 28) +
        col(fmtStage(metrics.stages.submit), 22) +
        col(fmtStage(metrics.stages.canonical), 22)
      )
    }
  }

  // ── Wallet SendCalls exhibit ─────────────────────────────────────────────────
  if (walletResults.length > 0) {
    lines.push('')
    lines.push('── Wallet SendCalls Exhibit (EIP-7702, different protocol class — not comparable to above) ' + hr(0))
    lines.push('   Uses wallet_sendCalls (EIP-5792) with EIP-7702 delegation, not ERC-4337.')
    lines.push('   Submit = time to call ID; Canonical = time from call ID to tx mined.')
    lines.push('')
    lines.push(
      col('Provider', 28) +
      col('Submit  (med/p95)', 22) +
      col('Canonical (med/p95)', 22)
    )
    lines.push(hr(72))

    for (const { row, metrics } of walletResults) {
      const failNote = metrics.failureCount > 0 ? ` [${metrics.failureCount}/${metrics.runCount} failed]` : ''
      lines.push(
        col(row.label + failNote, 28) +
        col(fmtStage(metrics.stages.submit), 22) +
        col(fmtStage(metrics.stages.canonical), 22)
      )
    }
  }

  lines.push('')
  return lines.join('\n')
}
