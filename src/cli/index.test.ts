import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parseRunCount, readDashboardPayload, resolveAssetPath, selectRunnableRows } from './index'
import type { ProviderRow } from '../benchmark/contracts'

const tempDirs: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tx-bench-cli-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const rows: ProviderRow[] = [
  { id: 'alchemy-light-account', label: 'Alchemy', protocolClass: '4337-bundler', accountTypeLabel: 'Light', requiredEnv: [], runnable: true, missingEnv: [] },
  { id: 'pimlico-safe', label: 'Pimlico', protocolClass: '4337-bundler', accountTypeLabel: 'Safe', requiredEnv: ['PIMLICO_API_KEY'], runnable: false, missingEnv: ['PIMLICO_API_KEY'] },
  { id: 'zerodev-kernel', label: 'ZeroDev', protocolClass: '4337-bundler', accountTypeLabel: 'Kernel', requiredEnv: [], runnable: true, missingEnv: [] },
]

describe('parseRunCount', () => {
  it('accepts integer counts in range', () => {
    expect(parseRunCount('10')).toBe(10)
  })

  it('rejects invalid counts', () => {
    for (const value of ['0', '-1', '1.5', 'NaN', '101']) {
      expect(() => parseRunCount(value)).toThrow('Invalid run count')
    }
  })
})

describe('selectRunnableRows', () => {
  it('returns all runnable rows by default', () => {
    expect(selectRunnableRows(rows).map(row => row.id)).toEqual(['alchemy-light-account', 'zerodev-kernel'])
  })

  it('selects requested runnable rows', () => {
    expect(selectRunnableRows(rows, ' zerodev-kernel ').map(row => row.id)).toEqual(['zerodev-kernel'])
  })

  it('rejects unknown provider IDs', () => {
    expect(() => selectRunnableRows(rows, 'typo')).toThrow('Unknown provider row')
  })

  it('rejects known but non-runnable provider IDs with missing env names', () => {
    expect(() => selectRunnableRows(rows, 'pimlico-safe')).toThrow('PIMLICO_API_KEY')
  })
})

describe('readDashboardPayload', () => {
  it('reads bundled sample data when no input is provided', () => {
    const payload = readDashboardPayload(undefined)
    expect(payload.source).toMatchObject({ kind: 'sample', name: 'sample-results.json', sample: true })
    expect(JSON.parse(payload.json).results).toBeArray()
  })

  it('reads a standalone legacy JSON file', () => {
    const root = tempRoot()
    const file = join(root, 'results.json')
    writeFileSync(file, '{"results":[]}')

    const payload = readDashboardPayload(file)
    expect(payload.json).toBe('{"results":[]}')
    expect(payload.source).toMatchObject({ kind: 'file', name: 'results.json', sample: false })
  })

  it('reads run.json from a run directory', () => {
    const root = tempRoot()
    const runDir = join(root, 'run-2026-06-11-143022')
    mkdirSync(runDir)
    writeFileSync(join(runDir, 'run.json'), '{"results":[]}')

    const payload = readDashboardPayload(runDir)
    expect(payload.json).toBe('{"results":[]}')
    expect(payload.source).toMatchObject({ kind: 'run', name: 'run-2026-06-11-143022', sample: false })
  })

  it('rejects invalid JSON before serving', () => {
    const root = tempRoot()
    const file = join(root, 'bad.json')
    writeFileSync(file, '{bad')

    expect(() => readDashboardPayload(file)).toThrow('Invalid JSON')
  })

  it('rejects JSON without a results array before serving', () => {
    const root = tempRoot()
    const file = join(root, 'bad.json')
    writeFileSync(file, '{"ok":true}')

    expect(() => readDashboardPayload(file)).toThrow('expected top-level results array')
  })
})

describe('resolveAssetPath', () => {
  it('resolves normal dashboard assets', () => {
    expect(resolveAssetPath('/')).toEndWith('web/index.html')
    expect(resolveAssetPath('/app.js')).toEndWith('web/app.js')
  })

  it('rejects traversal outside the web root', () => {
    expect(resolveAssetPath('/../package.json')).toBeUndefined()
  })
})
