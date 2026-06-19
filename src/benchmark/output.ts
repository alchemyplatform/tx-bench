import type { Config } from './config.js'
import type { ProtocolClass } from './contracts.js'
import type { ProviderRunResult } from './service.js'

// ── Environment block ─────────────────────────────────────────────────────────

export type Environment = {
  toolVersion: string
  gitCommit: string
  runnerRegion: string
  generatedAt: string
}

function readVersion(): string {
  try {
    // Read from package.json at runtime
    const pkg = require('../../package.json') as { version: string }
    return pkg.version
  } catch {
    return '0.0.0'
  }
}

function readGitCommit(): string {
  try {
    const result = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'])
    if (result.exitCode === 0) return new TextDecoder().decode(result.stdout).trim()
  } catch { /* not in a git repo */ }
  return process.env.GIT_COMMIT ?? 'unknown'
}

export function buildEnvironment(): Environment {
  return {
    toolVersion: readVersion(),
    gitCommit: readGitCommit(),
    runnerRegion: process.env.RUNNER_REGION ?? 'local',
    generatedAt: new Date().toISOString(),
  }
}

// ── Config redaction ──────────────────────────────────────────────────────────

// Collect all secret string values from config, then do a string-replace pass
// over the JSON. This catches secrets embedded in URL path/query segments too.
function collectSecrets(config: Config): Set<string> {
  const secrets = new Set<string>()

  const add = (v: string | undefined) => { if (v && v.length > 0) secrets.add(v) }

  add(config.providers.alchemy?.apiKey)
  add(config.providers.alchemy?.policyId)
  add(config.providers.pimlico?.apiKey)
  add(config.providers.pimlico?.policyId)
  add(config.providers.zerodev?.apiKey)
  add(config.providers.zerodev?.projectId)
  if (config.ownerPrivateKey) add(config.ownerPrivateKey)

  return secrets
}

export function redactConfig(config: Config): unknown {
  const secrets = collectSecrets(config)
  let json = JSON.stringify(config)
  for (const secret of secrets) {
    // Replace all occurrences (including when embedded inside a URL string)
    json = json.split(secret).join('[REDACTED]')
  }
  return JSON.parse(json)
}

// ── Output record ─────────────────────────────────────────────────────────────

export type StageRow = {
  provider: string
  protocolClass: ProtocolClass
  accountTypeLabel: string
  runCount: number
  failureCount: number
  prepare?: { median: number; p95: number; count: number }
  submit?: { median: number; p95: number; count: number }
  preconf?: { median: number; p95: number; count: number }
  canonical?: { median: number; p95: number; count: number }
  preconfAvailable: boolean
}

export type RunOutput = {
  env: Environment
  config: unknown          // redacted
  preconfAvailable: boolean
  results: ProviderRunResult[]
}

export function buildOutput(params: {
  config: Config
  results: ProviderRunResult[]
  preconfAvailable: boolean
  env?: Environment
}): RunOutput {
  return {
    env: params.env ?? buildEnvironment(),
    config: redactConfig(params.config),
    preconfAvailable: params.preconfAvailable,
    results: params.results,
  }
}

export function serializeOutput(output: RunOutput): string {
  return JSON.stringify(output, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
    2
  )
}
