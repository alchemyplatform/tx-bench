import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import type { RunOutput } from '../benchmark/output.js'

const RUN_DIR_RE = /^run-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d+))?$/

export type RunArtifact = {
  runId: string
  runDir: string
  runJsonPath: string
  tablePath: string
  manifestPath: string
}

export type RunManifest = {
  runId: string
  generatedAt: string
  toolVersion: string
  gitCommit: string
  files: {
    runJson: 'run.json'
    table: 'table.txt'
  }
}

export function formatRunId(generatedAt: string): string {
  const date = new Date(generatedAt)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid generatedAt timestamp: ${generatedAt}`)
  }

  const pad = (n: number) => String(n).padStart(2, '0')
  return [
    'run',
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
  ].join('-') + `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
}

function nextAvailableRunId(rootDir: string, baseRunId: string): string {
  if (!existsSync(join(rootDir, baseRunId))) return baseRunId

  for (let i = 2; i < 10_000; i++) {
    const candidate = `${baseRunId}-${i}`
    if (!existsSync(join(rootDir, candidate))) return candidate
  }

  throw new Error(`Unable to find available run directory for ${baseRunId}`)
}

function runSortKey(name: string): string | undefined {
  const match = RUN_DIR_RE.exec(name)
  if (!match) return undefined
  const suffix = match[7] ? Number(match[7]) : 1
  return `${match[1]}${match[2]}${match[3]}${match[4]}${match[5]}${match[6]}-${String(suffix).padStart(4, '0')}`
}

export function writeRunArtifact(params: {
  output: RunOutput
  json: string
  table: string
  rootDir?: string
}): RunArtifact {
  const rootDir = resolve(params.rootDir ?? 'runs')
  mkdirSync(rootDir, { recursive: true })

  const baseRunId = formatRunId(params.output.env.generatedAt)
  const runId = nextAvailableRunId(rootDir, baseRunId)
  const finalDir = join(rootDir, runId)
  const stagingDir = join(rootDir, `.tmp-${runId}-${process.pid}-${Date.now()}`)

  rmSync(stagingDir, { recursive: true, force: true })
  mkdirSync(stagingDir, { recursive: true })

  const manifest: RunManifest = {
    runId,
    generatedAt: params.output.env.generatedAt,
    toolVersion: params.output.env.toolVersion,
    gitCommit: params.output.env.gitCommit,
    files: { runJson: 'run.json', table: 'table.txt' },
  }

  try {
    writeFileSync(join(stagingDir, 'run.json'), params.json)
    writeFileSync(join(stagingDir, 'table.txt'), params.table)
    writeFileSync(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

    for (const file of ['run.json', 'table.txt', 'manifest.json']) {
      if (!existsSync(join(stagingDir, file))) throw new Error(`Missing staged artifact: ${file}`)
    }

    renameSync(stagingDir, finalDir)
  } catch (e) {
    rmSync(stagingDir, { recursive: true, force: true })
    throw e
  }

  return {
    runId,
    runDir: finalDir,
    runJsonPath: join(finalDir, 'run.json'),
    tablePath: join(finalDir, 'table.txt'),
    manifestPath: join(finalDir, 'manifest.json'),
  }
}

export function resolveRunDirectoryJson(runDir: string): string {
  const resultPath = join(resolve(runDir), 'run.json')
  if (!existsSync(resultPath)) {
    throw new Error(`Run directory is missing run.json: ${resolve(runDir)}`)
  }
  return resultPath
}

export function findLatestRunJson(rootDir = 'runs'): string {
  const resolvedRoot = resolve(rootDir)
  if (!existsSync(resolvedRoot)) {
    throw new Error(`No runs found. Run the benchmark first.`)
  }

  const candidates = readdirSync(resolvedRoot)
    .map(name => ({ name, key: runSortKey(name) }))
    .filter((entry): entry is { name: string; key: string } => !!entry.key)
    .map(entry => ({ ...entry, dir: join(resolvedRoot, entry.name), json: join(resolvedRoot, entry.name, 'run.json') }))
    .filter(entry => {
      try {
        return statSync(entry.dir).isDirectory() && existsSync(entry.json)
      } catch {
        return false
      }
    })
    .sort((a, b) => a.key.localeCompare(b.key))

  const latest = candidates.at(-1)
  if (!latest) {
    throw new Error(`No valid runs found in ${resolvedRoot}. Run the benchmark first.`)
  }

  return latest.json
}

export function sourceNameForRunJson(runJsonPath: string): string {
  return basename(resolve(runJsonPath, '..'))
}
