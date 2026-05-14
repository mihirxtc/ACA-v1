import { useState, useEffect, useCallback } from 'react'
import { useApiKeys } from '../contexts/ApiKeyContext'
import { useRecommendations } from '../hooks/useRecommendations'
import Field from './ui/Field'

// Cloud catalog model IDs — require Ollama sign-in to run
const CLOUD_CATALOG_IDS = new Set([
  'gpt-oss:20b-cloud',
  'gpt-oss:120b-cloud',
  'qwen3-coder:480b-cloud',
])

const ONBOARDING_USE_OPTIONS = [
  { value: 'chat',     label: 'General AWS chat' },
  { value: 'security', label: 'Security audits & compliance' },
  { value: 'iac',      label: 'Terraform / IaC generation' },
  { value: 'agent',    label: 'Autonomous agent tasks' },
]

const ONBOARDING_LATENCY_OPTIONS = [
  { value: 'fast',     label: 'Speed — fast responses' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'quality',  label: 'Quality — I\'ll wait for better answers' },
]

function OnboardingQuestions({ onComplete }) {
  const [primaryUse, setPrimaryUse]   = useState(null)
  const [latencyPref, setLatencyPref] = useState(null)

  const handleComplete = useCallback((use, latency) => {
    const prefs = { primary_use: use, latency_pref: latency }
    try { localStorage.setItem('aca_user_preferences', JSON.stringify(prefs)) } catch {}
    onComplete(prefs)
  }, [onComplete])

  const handleLatency = (val) => {
    setLatencyPref(val)
    if (primaryUse) handleComplete(primaryUse, val)
  }

  const handleUse = (val) => {
    setPrimaryUse(val)
    if (latencyPref) handleComplete(val, latencyPref)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 0' }}>
      <div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
          What will you primarily use ACA for?
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ONBOARDING_USE_OPTIONS.map((opt) => (
            <label key={opt.value} style={{
              display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
              fontSize: 13, color: primaryUse === opt.value ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}>
              <input
                type="radio" name="primary_use" value={opt.value}
                checked={primaryUse === opt.value}
                onChange={() => handleUse(opt.value)}
                style={{ accentColor: 'var(--accent)' }}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>
      <div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
          What matters more right now?
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ONBOARDING_LATENCY_OPTIONS.map((opt) => (
            <label key={opt.value} style={{
              display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
              fontSize: 13, color: latencyPref === opt.value ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}>
              <input
                type="radio" name="latency_pref" value={opt.value}
                checked={latencyPref === opt.value}
                onChange={() => handleLatency(opt.value)}
                style={{ accentColor: 'var(--accent)' }}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

function RecommendationCard({ rec, rank, installState, onInstall }) {
  const isTop      = rank === 1
  const installing = installState?.status === 'installing'
  const done       = installState?.status === 'done'
  const authErr    = installState?.status === 'auth_required'
  const hasError   = installState?.status === 'error'
  const progress   = installState?.progress ?? 0

  return (
    <div style={{
      border: isTop ? '1px solid var(--accent)' : '1px solid var(--border)',
      borderRadius: 8, padding: isTop ? 14 : 10,
      opacity: isTop ? 1 : 0.75,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      {isTop && (
        <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, letterSpacing: '0.04em' }}>
          ★ Recommended for you
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: isTop ? 14 : 13, fontWeight: 600 }}>{rec.model_id}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Score: {rec.score.toFixed(2)}</span>
      </div>
      {isTop && rec.explanation && (
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
          {rec.explanation}
        </p>
      )}
      {isTop && rec.top_features && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Why: {rec.top_features[0]?.replace(/_/g, ' ')} ({rec.feature_breakdown?.[rec.top_features[0]]?.toFixed(2)})
          {' · '}{rec.top_features[1]?.replace(/_/g, ' ')} ({rec.feature_breakdown?.[rec.top_features[1]]?.toFixed(2)})
        </div>
      )}

      {installing && (
        <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{
            height: '100%', background: 'var(--accent)',
            width: `${progress}%`, transition: 'width 0.3s ease',
          }} />
        </div>
      )}
      {authErr && (
        <div style={{ fontSize: 11, color: 'var(--danger, #f44)' }}>
          Sign in required — run <code>ollama signin</code> first
        </div>
      )}
      {hasError && (
        <div style={{ fontSize: 11, color: 'var(--danger, #f44)' }}>
          {installState.message || 'Install failed — check Ollama is running'}
        </div>
      )}

      {done ? (
        <div style={{ fontSize: 12, color: 'var(--success, #4caf50)' }}>✓ Installed</div>
      ) : (
        <button
          className={isTop ? 'aca-btn-primary' : 'aca-btn-ghost small'}
          style={isTop ? { width: '100%' } : {}}
          onClick={() => onInstall(rec.model_id)}
          disabled={installing}
        >
          {installing ? `Installing… ${progress}%` : 'Install — takes ~5s'}
        </button>
      )}
    </div>
  )
}

function InstalledModelRow({ model, isSelected, onSelect }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 12px', borderRadius: 6, gap: 10,
      background: isSelected ? 'rgba(76,175,80,0.08)' : 'var(--bg-elevated)',
      border: isSelected ? '1px solid var(--success, #4caf50)' : '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{model.id}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {model.description}
        </span>
      </div>
      {isSelected ? (
        <span style={{
          fontSize: 10, fontWeight: 600, color: 'var(--success, #4caf50)',
          background: 'rgba(76,175,80,0.12)', padding: '2px 8px', borderRadius: 99,
          whiteSpace: 'nowrap', flexShrink: 0,
        }}>
          ✓ In use
        </span>
      ) : (
        <button
          className="aca-btn-ghost small"
          style={{ flexShrink: 0, fontSize: 12 }}
          onClick={() => onSelect(model.id)}
        >
          Use
        </button>
      )}
    </div>
  )
}

function OllamaModelsSection({ ollamaUrl, selectedModel, onSelectModel }) {
  const [probeResult, setProbeResult]   = useState(null)
  const [probing,     setProbing]       = useState(false)
  const [userPrefs,   setUserPrefs]     = useState(() => {
    try { return JSON.parse(localStorage.getItem('aca_user_preferences')) || null } catch { return null }
  })
  const [fadeIn,      setFadeIn]        = useState(true)
  const [installStates, setInstallStates] = useState({})

  const { recommendations, loading: recsLoading } = useRecommendations(userPrefs, 'none')

  // Probe Ollama status whenever the URL changes
  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      setProbing(true)
      try {
        const base = encodeURIComponent(ollamaUrl || 'http://localhost:11434')
        const res = await fetch(`/api/ollama/status?base_url=${base}`)
        if (!cancelled) setProbeResult(await res.json())
      } catch {
        if (!cancelled) setProbeResult({ state: 'unavailable', installed_models: [], available_models: [] })
      } finally {
        if (!cancelled) setProbing(false)
      }
    }
    probe()
    return () => { cancelled = true }
  }, [ollamaUrl])

  const installedModels = probeResult?.installed_models ?? []
  const availableModels = probeResult?.available_models ?? []
  const signedIn        = probeResult?.signed_in ?? true // default true until we know otherwise

  const hasCloudModel = (
    CLOUD_CATALOG_IDS.has(selectedModel) ||
    installedModels.some((m) => CLOUD_CATALOG_IDS.has(m.id))
  )
  const showAuthWarning = probeResult && !signedIn && hasCloudModel

  // Sort available models by recommendation rank when prefs are set
  const rankedAvailable = availableModels.map((m) => {
    const rec = recommendations.find((r) => r.model_id === m.id)
    return { model: m, rec }
  }).sort((a, b) => (a.rec?.rank ?? 99) - (b.rec?.rank ?? 99))

  const handleInstall = useCallback(async (modelId) => {
    setInstallStates((s) => ({ ...s, [modelId]: { status: 'installing', progress: 0 } }))
    try {
      const base = ollamaUrl || 'http://localhost:11434'
      const res = await fetch('/api/ollama/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, base_url: base }),  // key is "model", not "model_id"
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        if (err.error === 'model_not_in_catalog') {
          setInstallStates((s) => ({ ...s, [modelId]: { status: 'error', message: 'Not in catalog' } }))
        } else {
          setInstallStates((s) => ({ ...s, [modelId]: { status: 'error', message: 'Request failed' } }))
        }
        return
      }
      if (!res.body) throw new Error('no_stream')

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        const lines = decoder.decode(value).split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const evt = JSON.parse(line)
            if (evt.status === 'auth_required' || evt.error === 'auth_required') {
              setInstallStates((s) => ({ ...s, [modelId]: { status: 'auth_required' } }))
              return
            }
            if (typeof evt.progress === 'number') {
              setInstallStates((s) => ({ ...s, [modelId]: { status: 'installing', progress: evt.progress } }))
            }
          } catch {}
        }
      }
      setInstallStates((s) => ({ ...s, [modelId]: { status: 'done', progress: 100 } }))
      // Re-probe so installed list refreshes
      const base2 = encodeURIComponent(ollamaUrl || 'http://localhost:11434')
      fetch(`/api/ollama/status?base_url=${base2}`)
        .then((r) => r.json())
        .then(setProbeResult)
        .catch(() => {})
    } catch {
      setInstallStates((s) => ({ ...s, [modelId]: { status: 'error', message: 'Connection error' } }))
    }
  }, [ollamaUrl])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Status bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
          Ollama models
        </span>
        {probing && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Checking…</span>
        )}
        {!probing && probeResult?.state === 'unavailable' && (
          <span style={{ fontSize: 11, color: 'var(--danger, #f44)' }}>
            Not reachable — is Ollama running?
          </span>
        )}
        {!probing && probeResult?.state !== 'unavailable' && probeResult && (
          <span style={{ fontSize: 11, color: 'var(--success, #4caf50)' }}>
            Connected · v{probeResult.version || '?'}
          </span>
        )}
      </div>

      {/* Auth warning — shown when cloud model selected but not signed in */}
      {showAuthWarning && (
        <div style={{
          background: 'rgba(255,160,0,0.08)', border: '1px solid rgba(255,160,0,0.35)',
          borderRadius: 8, padding: '10px 12px', fontSize: 12,
          color: 'var(--text-secondary)', lineHeight: 1.5,
        }}>
          <span style={{ color: '#ffa000', fontWeight: 600 }}>⚠ Ollama sign-in required</span>
          <br />
          Cloud models need authentication. Run this in your terminal, then re-open settings:
          <pre style={{
            margin: '6px 0 0', padding: '6px 8px', borderRadius: 4,
            background: 'var(--bg-elevated)', fontSize: 11,
            color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}>ollama signin</pre>
        </div>
      )}

      {/* Installed models — always first */}
      {installedModels.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Installed
          </span>
          {installedModels.map((m) => (
            <InstalledModelRow
              key={m.id}
              model={m}
              isSelected={selectedModel === m.id}
              onSelect={onSelectModel}
            />
          ))}
        </div>
      )}

      {/* Available models to install */}
      {availableModels.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {installedModels.length > 0 ? 'More to install' : 'Install a model'}
            </span>
            {userPrefs && (
              <button
                className="aca-btn-ghost small"
                style={{ fontSize: 11 }}
                onClick={() => {
                  localStorage.removeItem('aca_user_preferences')
                  setFadeIn(false)
                  setTimeout(() => { setUserPrefs(null); setFadeIn(true) }, 200)
                }}
              >
                Re-tune
              </button>
            )}
          </div>

          {/* Onboarding — only if no prefs */}
          {!userPrefs && (
            <div style={{ opacity: fadeIn ? 1 : 0, transition: 'opacity 0.2s ease' }}>
              <OnboardingQuestions onComplete={(prefs) => {
                setFadeIn(false)
                setTimeout(() => { setUserPrefs(prefs); setFadeIn(true) }, 200)
              }} />
            </div>
          )}

          {/* Recommendation cards — shown once prefs are set */}
          {userPrefs && (
            <div style={{ opacity: fadeIn ? 1 : 0, transition: 'opacity 0.2s ease', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {recsLoading ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0' }}>Loading recommendations…</div>
              ) : (
                rankedAvailable.map(({ model: m, rec }, idx) => {
                  const syntheticRec = rec ?? {
                    model_id: m.id, score: 0, rank: idx + 1,
                    explanation: m.description, top_features: [], feature_breakdown: {},
                  }
                  return (
                    <RecommendationCard
                      key={m.id}
                      rec={syntheticRec}
                      rank={idx + 1}
                      installState={installStates[m.id]}
                      onInstall={handleInstall}
                    />
                  )
                })
              )}
            </div>
          )}
        </div>
      )}

      {/* Ollama reachable but all models installed */}
      {!probing && probeResult && probeResult.state !== 'unavailable' && availableModels.length === 0 && installedModels.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0' }}>
          All catalog models are installed.
        </div>
      )}
    </div>
  )
}

export default function SettingsModal({ onClose }) {
  const { keys, setAllKeys, clearAllKeys } = useApiKeys()
  const [tab,   setTab]   = useState('CLOUD')
  const [draft, setDraft] = useState(keys)
  const [flash, setFlash] = useState(false)

  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }))

  const save = () => {
    setAllKeys(draft)
    setFlash(true)
    setTimeout(() => { setFlash(false); onClose() }, 1200)
  }

  const handleClear = () => {
    clearAllKeys()
    onClose()
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 460, maxHeight: '90vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-panel)', border: '1px solid var(--border-bright)',
        borderRadius: 12, overflow: 'hidden',
      }}>
        <div className="aca-panel-hd" style={{ padding: '14px 20px' }}>
          <span className="aca-panel-title">Settings</span>
          <button className="aca-btn-ghost small" onClick={onClose}>×</button>
        </div>
        <div style={{ padding: '0 20px' }}>
          <div className="aca-tab-bar">
            <button className="aca-tab" data-active={tab === 'CLOUD'} onClick={() => setTab('CLOUD')}>
              Cloud credentials
            </button>
            <button className="aca-tab" data-active={tab === 'LLM'} onClick={() => setTab('LLM')}>
              LLM keys
            </button>
          </div>
        </div>
        <div style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {tab === 'CLOUD' ? (
            <>
              <div style={{
                background: 'var(--bg-elevated)', padding: '8px 12px',
                borderRadius: 6, color: 'var(--text-secondary)', fontSize: 12,
              }}>
                Blank = uses ~/.aws/credentials
              </div>
              <Field label="AWS Access Key ID" saved={!!keys.aws_access_key}>
                <input className="aca-input" type="password"
                  value={draft.aws_access_key || ''}
                  onChange={(e) => set('aws_access_key', e.target.value)} />
              </Field>
              <Field label="AWS Secret Access Key" saved={!!keys.aws_secret_key}>
                <input className="aca-input" type="password"
                  value={draft.aws_secret_key || ''}
                  onChange={(e) => set('aws_secret_key', e.target.value)} />
              </Field>
              <Field label="AWS Region">
                <select className="aca-select"
                  value={draft.region || 'us-east-1'}
                  onChange={(e) => set('region', e.target.value)}>
                  <option>us-east-1</option>
                  <option>eu-west-1</option>
                  <option>ap-southeast-1</option>
                  <option>ap-southeast-2</option>
                </select>
              </Field>
            </>
          ) : (
            <>
              <div style={{
                background: 'var(--bg-elevated)', padding: '8px 12px',
                borderRadius: 6, color: 'var(--text-secondary)', fontSize: 12,
              }}>
                Keys stored in browser only.
              </div>
              <Field label="Default model">
                <select className="aca-select"
                  value={draft.model || 'groq'}
                  onChange={(e) => {
                    set('model', e.target.value)
                    if (e.target.value !== 'ollama') set('ollama_model', '')
                  }}>
                  <option value="groq">Groq</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="ollama">
                    {draft.ollama_model ? `Ollama — ${draft.ollama_model}` : 'Ollama'}
                  </option>
                </select>
              </Field>
              <Field label="Groq API key" saved={!!keys.groq_key} hint="Used for fast inference and chat">
                <input className="aca-input" type="password"
                  value={draft.groq_key || ''}
                  onChange={(e) => set('groq_key', e.target.value)} />
              </Field>
              <Field label="Anthropic API key" saved={!!keys.anthropic_key} hint="Used for agent reasoning">
                <input className="aca-input" type="password"
                  value={draft.anthropic_key || ''}
                  onChange={(e) => set('anthropic_key', e.target.value)} />
              </Field>
              <Field label="Ollama URL" hint="Local inference endpoint">
                <input className="aca-input"
                  placeholder="http://localhost:11434"
                  value={draft.ollama_url || ''}
                  onChange={(e) => set('ollama_url', e.target.value)} />
              </Field>
              <OllamaModelsSection
                ollamaUrl={draft.ollama_url}
                selectedModel={draft.ollama_model || ''}
                onSelectModel={(modelId) => {
                  set('ollama_model', modelId)
                  set('model', 'ollama')
                }}
              />
            </>
          )}
        </div>
        <div style={{
          padding: '14px 20px', borderTop: '1px solid var(--border)',
          display: 'flex', justifyContent: 'space-between', gap: 8,
        }}>
          <button className="aca-btn-ghost small danger" onClick={handleClear}>Clear all</button>
          <div className="aca-row" style={{ gap: 8 }}>
            <button className="aca-btn-ghost small" onClick={onClose}>Cancel</button>
            <button className="aca-btn-primary" onClick={save}>
              {flash ? '✓ Saved' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
