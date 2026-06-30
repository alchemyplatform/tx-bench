#!/usr/bin/env bun
import { Registry } from 'prom-client'
import { buildMetrics } from './metrics.js'
import { loadMonitoringCredentials } from './secrets.js'
import { startLoop } from './loop.js'

const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'
const PORT = 8080

const region = process.env.AWS_REGION ?? 'us-east-1'

const registry = new Registry()
const metrics = buildMetrics(registry)

const credentials = await loadMonitoringCredentials(region)

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/metrics' && req.method === 'GET') {
      const body = await registry.metrics()
      return new Response(body, { headers: { 'content-type': METRICS_CONTENT_TYPE } })
    }
    return new Response('Not found', { status: 404 })
  },
})

console.log(JSON.stringify({ event: 'server_start', port: PORT, region }))

startLoop(credentials, metrics, region)
