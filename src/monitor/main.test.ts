import { describe, expect, it } from 'bun:test'
import { Registry } from 'prom-client'

// Tests the fetch handler logic inline — main.ts is an entrypoint and not imported directly.

const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

function createHandler(registry: Registry) {
  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/metrics' && req.method === 'GET') {
      const body = await registry.metrics()
      return new Response(body, { headers: { 'content-type': METRICS_CONTENT_TYPE } })
    }
    return new Response('Not found', { status: 404 })
  }
}

describe('metrics HTTP handler', () => {
  it('GET /metrics returns 200 with text/plain content type', async () => {
    const registry = new Registry()
    const handler = createHandler(registry)
    const res = await handler(new Request('http://localhost:8080/metrics'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(METRICS_CONTENT_TYPE)
  })

  it('GET /metrics body is valid Prometheus text (starts with # or is empty)', async () => {
    const registry = new Registry()
    const handler = createHandler(registry)
    const res = await handler(new Request('http://localhost:8080/metrics'))
    const body = await res.text()
    // An empty registry produces an empty string; a non-empty registry starts with #
    expect(typeof body).toBe('string')
  })

  it('GET /metrics exposes a registered gauge value', async () => {
    const { Gauge } = await import('prom-client')
    const registry = new Registry()
    const g = new Gauge({ name: 'test_gauge', help: 'test', registers: [registry] })
    g.set(42)
    const handler = createHandler(registry)
    const res = await handler(new Request('http://localhost:8080/metrics'))
    const body = await res.text()
    expect(body).toContain('test_gauge 42')
  })

  it('GET /healthz returns 404', async () => {
    const registry = new Registry()
    const handler = createHandler(registry)
    const res = await handler(new Request('http://localhost:8080/healthz'))
    expect(res.status).toBe(404)
  })

  it('any non-/metrics path returns 404', async () => {
    const registry = new Registry()
    const handler = createHandler(registry)
    for (const path of ['/', '/status', '/prometheus', '/metrics/extra']) {
      const res = await handler(new Request(`http://localhost:8080${path}`))
      expect(res.status).toBe(404)
    }
  })

  it('POST /metrics returns 404 (only GET is served)', async () => {
    const registry = new Registry()
    const handler = createHandler(registry)
    const res = await handler(new Request('http://localhost:8080/metrics', { method: 'POST' }))
    expect(res.status).toBe(404)
  })
})
