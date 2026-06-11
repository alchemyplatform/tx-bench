const stages = ['submit', 'preconf', 'canonical']
const stageLabels = {
  submit: 'Submit',
  preconf: 'Flashblock',
  canonical: 'Canonical',
  providerReceipt: 'Receipt',
}

const state = {
  output: null,
  source: null,
  filter: '4337-bundler',
  selectedProvider: null,
}

const els = {
  sourceBadge: document.querySelector('#sourceBadge'),
  runMeta: document.querySelector('#runMeta'),
  summaryGrid: document.querySelector('#summaryGrid'),
  chart: document.querySelector('#chart'),
  chartSubtitle: document.querySelector('#chartSubtitle'),
  preconfMode: document.querySelector('#preconfMode'),
  providerCount: document.querySelector('#providerCount'),
  providerList: document.querySelector('#providerList'),
  detailTitle: document.querySelector('#detailTitle'),
  detailSubtitle: document.querySelector('#detailSubtitle'),
  detail: document.querySelector('#detail'),
  jsonInput: document.querySelector('#jsonInput'),
  downloadJson: document.querySelector('#downloadJson'),
}

async function init() {
  try {
    const [source, output] = await Promise.all([
      fetchJson('/source.json'),
      fetchJson('/results.json'),
    ])
    setOutput(output, source)
  } catch (error) {
    showError(error)
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Request failed: ${url}`)
  return response.json()
}

function setOutput(output, source) {
  validateOutput(output)
  state.output = output
  state.source = source

  const filtered = getFilteredResults()
  state.selectedProvider = filtered[0]?.row?.id ?? output.results[0]?.row?.id ?? null

  render()
}

function validateOutput(output) {
  if (!output || !Array.isArray(output.results)) {
    throw new Error('Expected a write-bench JSON output with a results array.')
  }
}

function getFilteredResults() {
  if (!state.output) return []
  const results = state.output.results
  if (state.filter === 'all') return results
  return results.filter(result => result.row.protocolClass === state.filter)
}

function render() {
  const results = getFilteredResults()

  if (!results.some(result => result.row.id === state.selectedProvider)) {
    state.selectedProvider = results[0]?.row?.id ?? null
  }

  renderSource()
  renderMeta()
  renderSummary()
  renderFilterButtons()
  renderChart(results)
  renderProviderList(results)
  renderDetail(results)
}

function renderSource() {
  const source = state.source
  if (!source) return
  els.sourceBadge.textContent = source.sample ? 'Sample data' : source.name
}

function renderMeta() {
  const { env, preconfAvailable } = state.output
  const results = state.output.results
  const runCount = results.reduce((sum, result) => sum + result.metrics.runCount, 0)

  els.runMeta.innerHTML = [
    metaItem('Generated', formatDate(env?.generatedAt)),
    metaItem('Version', env?.toolVersion ?? 'unknown'),
    metaItem('Runner', env?.runnerRegion ?? 'unknown'),
    metaItem('Runs', `${runCount} total / ${results.length} providers`),
  ].join('')

  els.preconfMode.textContent = preconfAvailable ? 'Preconf on' : 'Canonical only'
}

function renderSummary() {
  const bundlers = state.output.results.filter(result => result.row.protocolClass === '4337-bundler')
  const active = getFilteredResults()
  const bestCanonical = bestBy(active, 'canonical')
  const bestSubmit = bestBy(active, 'submit')
  const cleanRuns = active.filter(result => result.metrics.failureCount === 0).length
  const failureCount = active.reduce((sum, result) => sum + result.metrics.failureCount, 0)

  els.summaryGrid.innerHTML = [
    summaryCard('Fastest canonical', bestCanonical ? formatMs(bestCanonical.metric.median) : 'n/a', bestCanonical?.result.row.label ?? 'No completed runs'),
    summaryCard('Fastest submit', bestSubmit ? formatMs(bestSubmit.metric.median) : 'n/a', bestSubmit?.result.row.label ?? 'No completed runs'),
    summaryCard('Clean providers', `${cleanRuns}/${active.length}`, `${failureCount} failed run${failureCount === 1 ? '' : 's'}`),
    summaryCard('Same-class rows', String(bundlers.length), '4337 bundler comparison set'),
  ].join('')
}

function renderFilterButtons() {
  document.querySelectorAll('.segment').forEach(button => {
    button.classList.toggle('active', button.dataset.filter === state.filter)
  })
}

function renderChart(results) {
  const ranked = rankResults(results)
  const max = Math.max(1, ...ranked.flatMap(result => stages.map(stage => metricFor(result, stage)?.median ?? 0)))

  els.chartSubtitle.textContent = ranked.length
    ? `${ranked.length} provider${ranked.length === 1 ? '' : 's'} sorted by canonical median`
    : 'No providers in this view'

  if (ranked.length === 0) {
    els.chart.innerHTML = emptyState('No providers', 'This protocol class has no results in the loaded run.')
    return
  }

  els.chart.innerHTML = ranked.map(result => {
    const bars = stages.map(stage => stageBar(result, stage, max)).join('')
    const failureText = result.metrics.failureCount
      ? `${result.metrics.failureCount}/${result.metrics.runCount} failed`
      : `${result.metrics.runCount}/${result.metrics.runCount} ok`

    return `
      <article class="chart-row">
        <div>
          <p class="provider-name">${escapeHtml(result.row.label)}</p>
          <p class="provider-subtitle">${escapeHtml(result.row.accountTypeLabel)} / ${escapeHtml(failureText)}</p>
        </div>
        <div class="bar-stack">${bars}</div>
      </article>
    `
  }).join('')
}

function stageBar(result, stage, max) {
  const metric = metricFor(result, stage)
  const width = metric ? Math.max(3, Math.round((metric.median / max) * 100)) : 0
  const value = metric ? `${formatMs(metric.median)} / ${formatMs(metric.p95)}` : 'n/a'

  return `
    <div class="bar-line">
      <p class="bar-label">${stageLabels[stage]}</p>
      <div class="bar-track" aria-hidden="true">
        <span class="bar-fill ${stage}" style="--bar-width: ${width}%"></span>
      </div>
      <p class="bar-value">${value}</p>
    </div>
  `
}

function renderProviderList(results) {
  const ranked = rankResults(results)
  els.providerCount.textContent = `${ranked.length} visible`

  if (ranked.length === 0) {
    els.providerList.innerHTML = ''
    return
  }

  els.providerList.innerHTML = ranked.map((result, index) => {
    const canonical = metricFor(result, 'canonical')
    const active = result.row.id === state.selectedProvider ? ' active' : ''
    const failureText = result.metrics.failureCount
      ? `${result.metrics.failureCount} failed`
      : 'No failures'

    return `
      <button class="provider-card${active}" type="button" data-provider="${escapeAttr(result.row.id)}">
        <div class="provider-card-top">
          <p class="provider-card-title">${escapeHtml(result.row.label)}</p>
          <span class="rank-badge">#${index + 1}</span>
        </div>
        <div class="provider-card-bottom">
          <span>${escapeHtml(result.row.accountTypeLabel)}</span>
          <span>${canonical ? formatMs(canonical.median) : 'n/a'}</span>
        </div>
        <div class="provider-card-bottom">
          <span>${escapeHtml(result.row.protocolClass)}</span>
          <span>${escapeHtml(failureText)}</span>
        </div>
      </button>
    `
  }).join('')
}

function renderDetail(results) {
  const result = results.find(item => item.row.id === state.selectedProvider)

  if (!result) {
    els.detailTitle.textContent = 'Run detail'
    els.detailSubtitle.textContent = ''
    els.detail.innerHTML = emptyState('No selected provider', 'Select a provider from the visible comparison set.')
    return
  }

  els.detailTitle.textContent = result.row.label
  els.detailSubtitle.textContent = `${result.row.accountTypeLabel} / ${result.row.protocolClass}`

  const metrics = result.metrics
  const records = [...result.records].sort((a, b) => a.runIndex - b.runIndex)

  els.detail.innerHTML = `
    <div class="detail-grid">
      ${detailStat('Submit med/p95', formatMetric(metrics.stages.submit))}
      ${detailStat('Preconf med/p95', state.output.preconfAvailable ? formatMetric(metrics.stages.preconf) : 'Unavailable')}
      ${detailStat('Canonical med/p95', formatMetric(metrics.stages.canonical))}
      ${detailStat('Failures', `${metrics.failureCount}/${metrics.runCount}`)}
    </div>
    <div class="run-table-wrap">
      <table class="run-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Submit</th>
            <th>Flashblock</th>
            <th>Canonical</th>
            <th>Block</th>
            <th>UserOp</th>
            <th>Tx</th>
          </tr>
        </thead>
        <tbody>
          ${records.map(recordRow).join('')}
        </tbody>
      </table>
    </div>
  `
}

function recordRow(record) {
  const canonicalBlock = record.blockPositions?.canonical?.blockNumber ?? 'n/a'
  const txHash = record.blockPositions?.canonical?.txHash ?? record.error ?? 'n/a'

  return `
    <tr>
      <td>${record.runIndex + 1}</td>
      <td>${stageCell(record.stages.submit)}</td>
      <td>${stageCell(record.stages.preconf)}</td>
      <td>${stageCell(record.stages.canonical)}</td>
      <td>${escapeHtml(String(canonicalBlock))}</td>
      <td><div class="hash" title="${escapeAttr(record.userOpHash)}">${escapeHtml(record.userOpHash)}</div></td>
      <td><div class="hash" title="${escapeAttr(String(txHash))}">${escapeHtml(String(txHash))}</div></td>
    </tr>
  `
}

function stageCell(stage) {
  if (!stage) return '<span class="status not-observed">n/a</span>'
  if (stage.status === 'ok') return `<span class="status ok">${formatMs(stage.ms)}</span>`
  return `<span class="status ${escapeAttr(stage.status)}">${escapeHtml(stage.status)}</span>`
}

function detailStat(label, value) {
  return `
    <div class="detail-stat">
      <p class="table-label">${escapeHtml(label)}</p>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `
}

function metaItem(label, value) {
  return `
    <div class="meta-item">
      <p class="meta-label">${escapeHtml(label)}</p>
      <p class="meta-value">${escapeHtml(value)}</p>
    </div>
  `
}

function summaryCard(label, value, note) {
  return `
    <article class="summary-card">
      <p class="metric-label">${escapeHtml(label)}</p>
      <p class="metric-value">${escapeHtml(value)}</p>
      <p class="metric-note">${escapeHtml(note)}</p>
    </article>
  `
}

function emptyState(title, body) {
  return `
    <div class="empty-state">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(body)}</p>
    </div>
  `
}

function rankResults(results) {
  return [...results].sort((a, b) => {
    const aCanonical = metricFor(a, 'canonical')?.median ?? Number.POSITIVE_INFINITY
    const bCanonical = metricFor(b, 'canonical')?.median ?? Number.POSITIVE_INFINITY
    return aCanonical - bCanonical
  })
}

function bestBy(results, stage) {
  return results.reduce((best, result) => {
    const metric = metricFor(result, stage)
    if (!metric) return best
    if (!best || metric.median < best.metric.median) return { result, metric }
    return best
  }, null)
}

function metricFor(result, stage) {
  return result.metrics?.stages?.[stage]
}

function formatMetric(metric) {
  return metric ? `${formatMs(metric.median)} / ${formatMs(metric.p95)}` : 'n/a'
}

function formatMs(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return 'n/a'
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.round(ms)}ms`
}

function formatDate(value) {
  if (!value) return 'unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function escapeAttr(value) {
  return escapeHtml(value)
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error)
  els.sourceBadge.textContent = 'Error'
  els.runMeta.innerHTML = ''
  els.summaryGrid.innerHTML = ''
  els.chart.innerHTML = emptyState('Unable to render this run', message)
  els.providerList.innerHTML = ''
  els.detail.innerHTML = ''
}

document.addEventListener('click', event => {
  const filterButton = event.target.closest('[data-filter]')
  if (filterButton) {
    state.filter = filterButton.dataset.filter
    render()
    return
  }

  const providerButton = event.target.closest('[data-provider]')
  if (providerButton) {
    state.selectedProvider = providerButton.dataset.provider
    render()
  }
})

els.jsonInput.addEventListener('change', async event => {
  const file = event.target.files?.[0]
  if (!file) return

  try {
    const output = JSON.parse(await file.text())
    setOutput(output, { kind: 'file', name: file.name, sample: false })
  } catch (error) {
    showError(error)
  } finally {
    event.target.value = ''
  }
})

els.downloadJson.addEventListener('click', () => {
  if (!state.output) return
  const blob = new Blob([JSON.stringify(state.output, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'write-bench-results.json'
  anchor.click()
  URL.revokeObjectURL(url)
})

init()
