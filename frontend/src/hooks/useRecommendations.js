import { useState, useEffect, useRef } from 'react'
import { CLOUD_MODELS, TASK_FIT, SCAN_SIZE_FIT, LATENCY_FIT, WEIGHTS } from '../lib/ollamaCatalog'
import { localUsageSummary } from '../lib/usageLog'

export function useRecommendations(userPrefs, scanSizeBucket = 'none') {
  const [state, setState] = useState({
    recommendations: [],
    contextUsed: null,
    loading: false,
    error: null,
  })
  const debounceRef = useRef(null)

  useEffect(() => {
    if (!userPrefs) return
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setState((s) => ({ ...s, loading: true }))
      try {
        const res = await fetch('/api/ollama/recommend', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            primary_use: userPrefs.primary_use,
            latency_pref: userPrefs.latency_pref,
            current_scan_size_bucket: scanSizeBucket,
            anthropic_key: null,
            groq_key: null,
          }),
        })
        if (!res.ok) throw new Error('backend_error')
        const data = await res.json()
        setState({
          recommendations: data.recommendations,
          contextUsed: data.context_used,
          loading: false,
          error: null,
        })
      } catch {
        const summary = localUsageSummary()
        const ranked = clientSideScore(userPrefs, scanSizeBucket, summary)
        setState({
          recommendations: ranked,
          contextUsed: { ...summary, explanation_source: 'local_fallback' },
          loading: false,
          error: 'backend_unavailable',
        })
      }
    }, 300)
  }, [userPrefs, scanSizeBucket])

  return state
}

const ACTION_TO_TASK = {
  chat: 'chat',
  security_analysis: 'security',
  terraform_generation: 'iac',
  cost_recommendation: 'iac',
  agent_run: 'agent',
}

const FEATURE_LABELS = {
  task_fit: 'task alignment',
  scan_size_fit: 'scan size handling',
  latency_fit: 'response speed',
  recency_boost: 'recent usage patterns',
}

function clientSideScore(userPrefs, scanSizeBucket, summary) {
  const dominantTask = ACTION_TO_TASK[summary.dominant_action] || null
  const eventCount = summary.total_events || 0

  return CLOUD_MODELS.map((model) => {
    const id = model.id
    const rawTask = TASK_FIT[`${id}:${userPrefs.primary_use}`] ?? 0.5
    const rawScan = SCAN_SIZE_FIT[`${id}:${scanSizeBucket}`] ?? 0.5
    const rawLatency = LATENCY_FIT[`${id}:${userPrefs.latency_pref}`] ?? 0.5
    const rawRecency = dominantTask ? (TASK_FIT[`${id}:${dominantTask}`] ?? 0.5) : 0.5

    const w = { ...WEIGHTS }
    if (eventCount < 3) {
      const scale = eventCount / 3.0
      const deficit = w.recency_boost * (1 - scale)
      w.recency_boost = w.recency_boost * scale
      const perFeature = deficit / 3
      w.task_fit += perFeature
      w.scan_size_fit += perFeature
      w.latency_fit += perFeature
    }

    const breakdown = {
      task_fit: rawTask * w.task_fit,
      scan_size_fit: rawScan * w.scan_size_fit,
      latency_fit: rawLatency * w.latency_fit,
      recency_boost: rawRecency * w.recency_boost,
    }
    const score = Object.values(breakdown).reduce((a, b) => a + b, 0)

    const topFeatures = Object.keys(breakdown).sort((a, b) => breakdown[b] - breakdown[a]).slice(0, 2)
    const top0 = FEATURE_LABELS[topFeatures[0]] || topFeatures[0]
    const top1 = FEATURE_LABELS[topFeatures[1]] || topFeatures[1]
    const explanation = `Optimised for ${userPrefs.primary_use} tasks with strong ${top1} for ${scanSizeBucket} scans. Selected based on ${top0} and ${top1}.`

    return { model_id: id, score: Math.round(score * 10000) / 10000, feature_breakdown: breakdown, top_features: topFeatures, explanation, explanation_source: 'local_fallback' }
  })
    .sort((a, b) => b.score - a.score)
    .map((rec, i) => ({ ...rec, rank: i + 1 }))
}
