const STORAGE_KEY = 'aca_recent_events'
const MAX_EVENTS = 20

function scanSizeBucket(scanData) {
  if (!scanData) return 'none'
  const total = Object.values(scanData).reduce((acc, val) => {
    if (typeof val === 'number') return acc + val
    if (val && typeof val === 'object') {
      return acc + Object.values(val).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0)
    }
    return acc
  }, 0)
  if (total === 0) return 'none'
  if (total < 5) return 'small'
  if (total <= 25) return 'medium'
  return 'large'
}

export function logEvent(actionType, modelUsed, scanData) {
  try {
    const events = getRecentEvents()
    events.push({
      timestamp: Date.now(),
      action_type: actionType,
      model_used: modelUsed,
      scan_size_bucket: scanSizeBucket(scanData),
    })
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)))
  } catch {}
}

export function getRecentEvents() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []
  } catch {
    return []
  }
}

export function localUsageSummary(windowHours = 24) {
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000
  const events = getRecentEvents().filter((e) => e.timestamp > cutoff)

  const actionCounts = {}
  const bucketCounts = {}
  for (const e of events) {
    if (e.action_type) actionCounts[e.action_type] = (actionCounts[e.action_type] || 0) + 1
    if (e.scan_size_bucket) bucketCounts[e.scan_size_bucket] = (bucketCounts[e.scan_size_bucket] || 0) + 1
  }

  const dominantAction = Object.keys(actionCounts).length
    ? Object.keys(actionCounts).reduce((a, b) => actionCounts[a] >= actionCounts[b] ? a : b)
    : null
  const dominantScanSize = Object.keys(bucketCounts).length
    ? Object.keys(bucketCounts).reduce((a, b) => bucketCounts[a] >= bucketCounts[b] ? a : b)
    : 'none'

  return {
    action_counts: actionCounts,
    dominant_action: dominantAction,
    dominant_scan_size: dominantScanSize,
    total_events: events.length,
  }
}
