import { describe, expect, it } from 'bun:test'
import { buildRows, getRunnableRows, assertRowsExist } from './rows'

const ALCHEMY_ONLY = { ALCHEMY_API_KEY: 'key', ALCHEMY_POLICY_ID: 'policy' }

const FULL_ENV = {
  ALCHEMY_API_KEY: 'key',
  ALCHEMY_POLICY_ID: 'policy',
  PIMLICO_API_KEY: 'pkey',
  PIMLICO_POLICY_ID: 'ppolicy',
  ZERODEV_API_KEY: 'zkey',
  ZERODEV_PROJECT_ID: 'zproject',
}

describe('buildRows', () => {
  it('marks only Alchemy row as runnable with only Alchemy env set', () => {
    const rows = buildRows(ALCHEMY_ONLY)
    const runnable = getRunnableRows(rows)

    expect(runnable).toHaveLength(1)
    expect(runnable[0].id).toBe('alchemy-light-account')
  })

  it('reports missing env names on non-runnable rows', () => {
    const rows = buildRows(ALCHEMY_ONLY)
    const nonRunnable = rows.filter(r => !r.runnable)

    for (const row of nonRunnable) {
      expect(row.missingEnv.length).toBeGreaterThan(0)
      for (const key of row.missingEnv) {
        expect(ALCHEMY_ONLY).not.toHaveProperty(key)
      }
    }
  })

  it('marks all rows as runnable when all env vars are present', () => {
    const rows = buildRows(FULL_ENV)
    expect(getRunnableRows(rows)).toHaveLength(rows.length)
  })

  it('marks no rows as runnable with an empty env', () => {
    const rows = buildRows({})
    expect(getRunnableRows(rows)).toHaveLength(0)
  })

  it('exposes a valid protocolClass on every row', () => {
    const valid = new Set(['4337-bundler', 'intent-relay'])
    for (const row of buildRows({})) {
      expect(valid.has(row.protocolClass)).toBe(true)
    }
  })

  it('includes both ZeroDev rows (kernel and ultrarelay) with different protocol classes', () => {
    const rows = buildRows(FULL_ENV)
    const zdRows = rows.filter(r => r.id.startsWith('zerodev'))
    expect(zdRows).toHaveLength(2)
    const classes = new Set(zdRows.map(r => r.protocolClass))
    expect(classes.has('4337-bundler')).toBe(true)
    expect(classes.has('intent-relay')).toBe(true)
  })
})

describe('assertRowsExist', () => {
  it('throws on an unknown row id and lists available ids', () => {
    const rows = buildRows({})
    expect(() => assertRowsExist(['unknown-provider'], rows)).toThrow('unknown-provider')
    expect(() => assertRowsExist(['unknown-provider'], rows)).toThrow('Available')
  })

  it('does not throw for a known row id', () => {
    const rows = buildRows({})
    expect(() => assertRowsExist(['alchemy-light-account'], rows)).not.toThrow()
  })

  it('does not throw for an empty ids list', () => {
    const rows = buildRows({})
    expect(() => assertRowsExist([], rows)).not.toThrow()
  })
})
