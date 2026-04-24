// =============================================================================
// AgentPanel.jsx — Autonomous security remediation agent UI
//
// Implements a 5-state machine:
//
//   IDLE → THINKING → AWAITING_APPROVAL → APPLYING → COMPLETE | FAILED
//
// The agent scans AWS, picks the highest-priority security issue, generates
// Terraform HCL, plans it, and returns a plain-English summary. The user
// must explicitly click "Approve & Apply" before anything touches AWS.
//
// State machine:
//   idle              — ready; shows "Run Security Agent" button
//   thinking          — waiting for POST /agent/run to resolve; animates steps
//   awaiting_approval — plan ready; shows issue + summary + collapsible HCL/plan
//   applying          — waiting for POST /agent/approve/{id} to resolve
//   complete          — apply succeeded; shows green output summary
//   failed            — apply failed; shows red error detail
// =============================================================================

import { useState, useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import { useApiKeys } from '../context/ApiKeyContext'
import { callTool } from '../lib/mcpClient'


// =============================================================================
// Constants
// =============================================================================

// Steps cycled in the THINKING state every STEP_INTERVAL_MS milliseconds.
const THINKING_STEPS = [
  'Scanning AWS infrastructure...',
  'Classifying security findings...',
  'Generating Terraform fix...',
  'Validating HCL syntax...',
  'Running terraform plan...',
  'Summarising changes for review...',
]

const STEP_INTERVAL_MS = 3000

// Colour palette — mirrors ExecutionPanel / SecurityPanel conventions.
const COLOURS = {
  blue:        '#2563eb',
  blueLight:   '#90b0e0',
  blueAlpha:   '#f0f8ff',
  green:       '#3B6D11',
  greenLight:  '#f0fff0',
  greenBorder: '#22c55e',
  red:         '#A32D2D',
  redLight:    '#fff0f0',
  redBorder:   '#ff4444',
  amber:       '#BA7517',
  amberLight:  '#fff8e6',
  gray:        '#888',
  grayBorder:  '#e0e0e0',
  grayLight:   '#f8f8f8',
  warningBg:   '#fff3cd',
  warningBorder:'#f59e0b',
}


// =============================================================================
// Small helpers
// =============================================================================

// Spinner — a simple CSS-animation-free pulsing dot row.
function Spinner() {
  return (
    <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}>
      {[0, 1, 2].map(i => (
        <span
          key={i}
          style={{
            width:           '8px',
            height:          '8px',
            borderRadius:    '50%',
            backgroundColor: COLOURS.blue,
            animation:       `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
      <style>{`
        @keyframes pulse {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
          40%            { opacity: 1;   transform: scale(1);   }
        }
      `}</style>
    </span>
  )
}

// CollapsibleSection — a toggleable block with a code-formatted body.
function CollapsibleSection({ label, content }) {
  const [open, setOpen] = useState(false)

  return (
    <div style={{ marginTop: '12px' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background:   'none',
          border:       `1px solid ${COLOURS.grayBorder}`,
          borderRadius: '6px',
          padding:      '6px 12px',
          cursor:       'pointer',
          fontSize:     '0.85rem',
          color:        '#444',
          display:      'flex',
          alignItems:   'center',
          gap:          '6px',
        }}
      >
        <span style={{ fontSize: '0.75rem' }}>{open ? '▼' : '▶'}</span>
        {label}
      </button>

      {open && (
        <pre style={{
          marginTop:    '8px',
          padding:      '12px',
          background:   '#1e1e1e',
          color:        '#d4d4d4',
          borderRadius: '8px',
          fontSize:     '0.8rem',
          overflowX:    'auto',
          whiteSpace:   'pre-wrap',
          wordBreak:    'break-word',
          maxHeight:    '300px',
          overflowY:    'auto',
        }}>
          {content || '(empty)'}
        </pre>
      )}
    </div>
  )
}


// =============================================================================
// AgentPanel
// =============================================================================

export default function AgentPanel() {

  const { keys } = useApiKeys()

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [phase,       setPhase]       = useState('idle')        // see state machine above
  const [stepIndex,   setStepIndex]   = useState(0)             // current THINKING_STEPS index
  const [agentResult, setAgentResult] = useState(null)          // response from /agent/run
  const [applyResult, setApplyResult] = useState(null)          // response from /agent/approve
  const [error,       setError]       = useState(null)          // error string for FAILED state

  // Ref so the interval cleanup works correctly across renders.
  const stepTimerRef = useRef(null)

  // ---------------------------------------------------------------------------
  // Thinking step animation — starts/stops with the 'thinking' phase.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (phase === 'thinking') {
      setStepIndex(0)
      stepTimerRef.current = setInterval(() => {
        setStepIndex(i => (i + 1) % THINKING_STEPS.length)
      }, STEP_INTERVAL_MS)
    } else {
      clearInterval(stepTimerRef.current)
    }

    return () => clearInterval(stepTimerRef.current)
  }, [phase])

  // ---------------------------------------------------------------------------
  // runAgent — POST /agent/run
  // ---------------------------------------------------------------------------

  async function runAgent() {
    setPhase('thinking')
    setAgentResult(null)
    setApplyResult(null)
    setError(null)

    try {
      const resolvedKey = keys.model === 'anthropic' ? keys.anthropic : keys.groq
      const data = await callTool('agent_run', {
        region:  keys.awsRegion || 'us-east-1',
        model:   keys.model     || 'groq',
        api_key: resolvedKey    || '',
      })

      if (data.status === 'no_issues') {
        setAgentResult(data)
        setPhase('complete')
        setApplyResult({ apply_output: 'No security issues found — your infrastructure is clean.' })
        return
      }

      if (data.status === 'error') {
        setError(data.error || 'Agent run failed.')
        toast.error(data.error || 'Agent run failed')
        setPhase('failed')
        return
      }

      // status === 'awaiting_approval'
      setAgentResult(data)
      setPhase('awaiting_approval')

    } catch (err) {
      setError(err.message || 'Network error contacting MCP server.')
      toast.error(err.message || 'Network error contacting MCP server')
      setPhase('failed')
    }
  }

  // ---------------------------------------------------------------------------
  // handleDecision — called by Approve or Reject buttons
  // ---------------------------------------------------------------------------

  async function handleDecision(approved) {
    if (!agentResult?.execution_id) return

    if (!approved) {
      callTool('agent_approve', {
        execution_id: agentResult.execution_id,
        approved:     false,
      }).catch(() => {})  // fire-and-forget; UI resets immediately

      toast('Execution rejected', { icon: '🚫' })
      setPhase('idle')
      setAgentResult(null)
      return
    }

    toast.success('Applying changes to AWS...')
    setPhase('applying')

    try {
      const data = await callTool('agent_approve', {
        execution_id: agentResult.execution_id,
        approved:     true,
      })

      setApplyResult(data)
      setPhase(data.status === 'complete' ? 'complete' : 'failed')
      if (data.status === 'complete') {
        toast.success('Changes applied successfully')
      } else {
        const applyErr = data.apply_output || 'Apply failed.'
        setError(applyErr)
        toast.error(applyErr)
      }

    } catch (err) {
      setError(err.message || 'Network error during apply.')
      toast.error(err.message || 'Network error during apply')
      setPhase('failed')
    }
  }

  // ---------------------------------------------------------------------------
  // reset — return to IDLE from any terminal state
  // ---------------------------------------------------------------------------

  function reset() {
    setPhase('idle')
    setAgentResult(null)
    setApplyResult(null)
    setError(null)
  }


  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div>

      {/* -------------------------------------------------------------------- */}
      {/* Panel header                                                           */}
      {/* -------------------------------------------------------------------- */}
      <div style={{
        display:        'flex',
        justifyContent: 'space-between',
        alignItems:     'center',
        marginBottom:   '20px',
      }}>
        <h2 style={{ margin: 0, fontSize: '1.4rem' }}>🤖 Security Remediation Agent</h2>
        <PhasePill phase={phase} />
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* Error banner — shown at top whenever an API/network error occurred   */}
      {/* -------------------------------------------------------------------- */}
      {error && phase === 'failed' && (
        <div style={{
          color:          '#cc0000',
          background:     '#fff0f0',
          border:         '1px solid #ff4444',
          borderRadius:   '8px',
          padding:        '10px 16px',
          marginBottom:   '16px',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          gap:            '12px',
          fontSize:       '0.9rem',
        }}>
          <span>{error}</span>
          <button
            onClick={() => { setError(null); runAgent() }}
            style={{
              padding:         '4px 12px',
              backgroundColor: '#cc0000',
              color:           'white',
              border:          'none',
              borderRadius:    '4px',
              cursor:          'pointer',
              fontSize:        '0.82rem',
              fontWeight:      'bold',
              whiteSpace:      'nowrap',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* IDLE                                                                   */}
      {/* -------------------------------------------------------------------- */}
      {phase === 'idle' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <p style={{ margin: 0, color: '#555', lineHeight: '1.6' }}>
            Autonomously scans your infrastructure, generates a fix, and presents
            it for your approval. No changes are made without explicit confirmation.
          </p>
          <div>
            <button
              onClick={runAgent}
              style={{
                padding:         '10px 22px',
                backgroundColor: COLOURS.blue,
                color:           'white',
                border:          'none',
                borderRadius:    '8px',
                cursor:          'pointer',
                fontWeight:      'bold',
                fontSize:        '0.95rem',
              }}
            >
              ▶ Run Security Agent
            </button>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* THINKING                                                               */}
      {/* -------------------------------------------------------------------- */}
      {phase === 'thinking' && (
        <div style={{
          backgroundColor: COLOURS.blueAlpha,
          border:          `1px solid #bcd`,
          borderRadius:    '10px',
          padding:         '24px',
          display:         'flex',
          flexDirection:   'column',
          gap:             '16px',
          alignItems:      'flex-start',
        }}>
          <Spinner />
          <div style={{ color: COLOURS.blue, fontWeight: 'bold', fontSize: '1rem' }}>
            {THINKING_STEPS[stepIndex]}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%' }}>
            {THINKING_STEPS.map((step, i) => (
              <div
                key={step}
                style={{
                  display:    'flex',
                  alignItems: 'center',
                  gap:        '10px',
                  opacity:    i <= stepIndex ? 1 : 0.35,
                  transition: 'opacity 0.4s',
                  fontSize:   '0.85rem',
                  color:      i < stepIndex ? COLOURS.green :
                              i === stepIndex ? COLOURS.blue : COLOURS.gray,
                }}
              >
                <span>{i < stepIndex ? '✓' : i === stepIndex ? '›' : '○'}</span>
                {step}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* AWAITING_APPROVAL                                                      */}
      {/* -------------------------------------------------------------------- */}
      {phase === 'awaiting_approval' && agentResult && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* Issue title + description */}
          <div style={{
            backgroundColor: COLOURS.amberLight,
            border:          `1px solid ${COLOURS.amberLight}`,
            borderLeft:      `4px solid ${COLOURS.amber}`,
            borderRadius:    '8px',
            padding:         '14px 16px',
          }}>
            <div style={{ fontWeight: 'bold', color: COLOURS.amber, marginBottom: '6px', fontSize: '1rem' }}>
              {agentResult.issue?.severity && (
                <span style={{
                  backgroundColor: agentResult.issue.severity === 'HIGH'   ? '#ff4444' :
                                   agentResult.issue.severity === 'MEDIUM' ? '#ff8800' : '#ccaa00',
                  color:     'white',
                  fontSize:  '0.75rem',
                  padding:   '2px 8px',
                  borderRadius: '4px',
                  marginRight:  '8px',
                }}>
                  {agentResult.issue.severity}
                </span>
              )}
              {agentResult.issue?.title || 'Security Issue'}
            </div>
            <div style={{ fontSize: '0.9rem', color: '#555', lineHeight: '1.5' }}>
              {agentResult.issue?.description || agentResult.issue?.recommendation || ''}
            </div>
            {agentResult.issue?.resource_id && (
              <div style={{ fontSize: '0.8rem', color: '#777', marginTop: '6px' }}>
                Resource: <code style={{ background: '#f0f0f0', padding: '1px 5px', borderRadius: '3px' }}>
                  {agentResult.issue.resource_id}
                </code>
              </div>
            )}
          </div>

          {/* Agent summary */}
          {agentResult.summary && (
            <div style={{
              backgroundColor: COLOURS.grayLight,
              border:          `1px solid ${COLOURS.grayBorder}`,
              borderRadius:    '8px',
              padding:         '14px 16px',
            }}>
              <div style={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '0.9rem', color: '#333' }}>
                Agent Summary
              </div>
              <div style={{ fontSize: '0.88rem', color: '#555', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>
                {agentResult.summary}
              </div>
            </div>
          )}

          {/* Collapsible sections */}
          <CollapsibleSection label="View Terraform HCL"       content={agentResult.hcl} />
          <CollapsibleSection label="View full terraform plan" content={agentResult.plan_output} />

          {/* Warning banner */}
          <div style={{
            backgroundColor: COLOURS.warningBg,
            border:          `1px solid ${COLOURS.warningBorder}`,
            borderRadius:    '8px',
            padding:         '12px 16px',
            fontSize:        '0.9rem',
            color:           '#7a5200',
            fontWeight:      'bold',
            display:         'flex',
            alignItems:      'center',
            gap:             '8px',
          }}>
            ⚠️ This will modify your live AWS infrastructure
          </div>

          {/* Approve / Reject buttons */}
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <button
              onClick={() => handleDecision(true)}
              style={{
                padding:         '10px 24px',
                backgroundColor: '#16a34a',
                color:           'white',
                border:          'none',
                borderRadius:    '8px',
                cursor:          'pointer',
                fontWeight:      'bold',
                fontSize:        '0.95rem',
              }}
            >
              ✓ Approve &amp; Apply
            </button>
            <button
              onClick={() => handleDecision(false)}
              style={{
                padding:         '10px 24px',
                backgroundColor: '#6b7280',
                color:           'white',
                border:          'none',
                borderRadius:    '8px',
                cursor:          'pointer',
                fontWeight:      'bold',
                fontSize:        '0.95rem',
              }}
            >
              ✕ Reject
            </button>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* APPLYING                                                               */}
      {/* -------------------------------------------------------------------- */}
      {phase === 'applying' && (
        <div style={{
          backgroundColor: COLOURS.blueAlpha,
          border:          `1px solid #bcd`,
          borderRadius:    '10px',
          padding:         '24px',
          display:         'flex',
          alignItems:      'center',
          gap:             '14px',
        }}>
          <Spinner />
          <span style={{ color: COLOURS.blue, fontWeight: 'bold', fontSize: '1rem' }}>
            Applying changes to AWS...
          </span>
        </div>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* COMPLETE                                                               */}
      {/* -------------------------------------------------------------------- */}
      {phase === 'complete' && (
        <div style={{
          backgroundColor: COLOURS.greenLight,
          border:          `1px solid ${COLOURS.greenBorder}`,
          borderRadius:    '10px',
          padding:         '20px',
          display:         'flex',
          flexDirection:   'column',
          gap:             '12px',
        }}>
          <div style={{ color: COLOURS.green, fontWeight: 'bold', fontSize: '1rem' }}>
            ✓ Changes applied successfully
          </div>
          {(applyResult?.apply_output || applyResult?.output) && (
            <pre style={{
              backgroundColor: '#1e1e1e',
              color:           '#d4d4d4',
              padding:         '12px',
              borderRadius:    '8px',
              fontSize:        '0.8rem',
              overflowX:       'auto',
              whiteSpace:      'pre-wrap',
              wordBreak:       'break-word',
              maxHeight:       '200px',
              overflowY:       'auto',
              margin:          0,
            }}>
              {applyResult.apply_output || applyResult.output}
            </pre>
          )}
          <div>
            <button onClick={reset} style={resetBtnStyle}>
              ↩ Run Again
            </button>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* FAILED                                                                 */}
      {/* -------------------------------------------------------------------- */}
      {phase === 'failed' && (
        <div style={{
          backgroundColor: COLOURS.redLight,
          border:          `1px solid ${COLOURS.redBorder}`,
          borderRadius:    '10px',
          padding:         '20px',
          display:         'flex',
          flexDirection:   'column',
          gap:             '12px',
        }}>
          <div style={{ color: COLOURS.red, fontWeight: 'bold', fontSize: '1rem' }}>
            ✗ Agent run failed
          </div>
          <div>
            <button onClick={reset} style={resetBtnStyle}>
              ↩ Try Again
            </button>
          </div>
        </div>
      )}

    </div>
  )
}


// =============================================================================
// PhasePill — small status pill shown in the panel header
// =============================================================================

const PHASE_LABELS = {
  idle:              { label: 'Idle',              color: '#888',          bg: '#f0f0f0' },
  thinking:          { label: 'Thinking...',        color: '#2563eb',       bg: '#dbeafe' },
  awaiting_approval: { label: 'Awaiting Approval',  color: '#BA7517',       bg: '#fff8e6' },
  applying:          { label: 'Applying...',         color: '#185FA5',       bg: '#e0f0ff' },
  complete:          { label: 'Complete',            color: '#3B6D11',       bg: '#dcfce7' },
  failed:            { label: 'Failed',              color: '#A32D2D',       bg: '#fee2e2' },
}

function PhasePill({ phase }) {
  const cfg = PHASE_LABELS[phase] || PHASE_LABELS.idle
  return (
    <span style={{
      backgroundColor: cfg.bg,
      color:           cfg.color,
      fontWeight:      'bold',
      fontSize:        '0.78rem',
      padding:         '4px 12px',
      borderRadius:    '999px',
      letterSpacing:   '0.03em',
    }}>
      {cfg.label}
    </span>
  )
}


// =============================================================================
// Shared style for reset / try-again buttons
// =============================================================================

const resetBtnStyle = {
  padding:         '8px 18px',
  backgroundColor: '#6b7280',
  color:           'white',
  border:          'none',
  borderRadius:    '6px',
  cursor:          'pointer',
  fontSize:        '0.88rem',
}
