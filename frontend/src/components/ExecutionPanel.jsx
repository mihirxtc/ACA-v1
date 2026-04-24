// =============================================================================
// ExecutionPanel.jsx — Terraform plan/apply execution UI (Week 7)
//
// Implements a 7-state machine for the human-in-the-loop approval flow:
//
//   idle → planning → awaiting_approval → applying → complete
//                  ↘ plan_failed            ↘ failed
//                                     → rejected
//
// Props:
//   hclConfig   (str)  — the generated Terraform HCL to plan and apply
//   description (str)  — plain-English description shown in the header
//   onClose     (fn)   — called when the user dismisses this panel
//
// State colour mapping (exact colours from the spec):
//   idle:              gray   (#888)
//   planning:          teal   (#1D9E75)
//   awaiting_approval: amber  (#BA7517)
//   applying:          blue   (#185FA5)
//   complete:          green  (#3B6D11)
//   rejected:          gray   (#888)
//   failed:            red    (#A32D2D)
//   plan_failed:       red    (#A32D2D)
// =============================================================================

import { useState } from 'react'
import toast from 'react-hot-toast'
import { callTool } from '../lib/mcpClient'

// -----------------------------------------------------------------------------
// STATUS_CONFIG — maps each state to its visual style and label.
// Imported as a constant so all state-conditional rendering reads from one
// source of truth rather than scattering colours through the JSX.
// -----------------------------------------------------------------------------

const STATUS_CONFIG = {
  idle:             { color: '#888',    label: 'Ready',               bg: '#f8f8f8' },
  planning:         { color: '#1D9E75', label: 'Running plan...',     bg: '#f0fff8' },
  awaiting_approval:{ color: '#BA7517', label: 'Awaiting approval',   bg: '#fff8e6' },
  applying:         { color: '#185FA5', label: 'Applying changes...', bg: '#f0f8ff' },
  complete:         { color: '#3B6D11', label: 'Complete',            bg: '#f0fff0' },
  rejected:         { color: '#888',    label: 'Rejected',            bg: '#f8f8f8' },
  failed:           { color: '#A32D2D', label: 'Failed',              bg: '#fff0f0' },
  plan_failed:      { color: '#A32D2D', label: 'Plan failed',         bg: '#fff0f0' },
}


// =============================================================================
// ExecutionPanel
// =============================================================================

export default function ExecutionPanel({ hclConfig, description, onClose }) {

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [state,       setState]      = useState('idle')
  const [executionId, setExecutionId]= useState(null)
  const [planData,    setPlanData]   = useState(null)
  const [applyData,   setApplyData]  = useState(null)
  const [error,       setError]      = useState(null)

  const cfg = STATUS_CONFIG[state] || STATUS_CONFIG.idle

  // ---------------------------------------------------------------------------
  // runPlan — calls POST /terraform/plan
  //
  // This is the read-only first step. It tells the user exactly what
  // Terraform will do before anything is changed in AWS.
  // ---------------------------------------------------------------------------

  async function runPlan() {
    setState('planning')
    setError(null)
    setPlanData(null)
    setApplyData(null)

    try {
      const data = await callTool('run_terraform_plan_mcp', {
        hcl_config:  hclConfig,
        description: description,
      })
      setExecutionId(data.execution_id)
      setPlanData(data)
      setState(data.status)   // "awaiting_approval" or "plan_failed"
      if (data.status === 'awaiting_approval') toast.success('Plan ready for review')
    } catch (err) {
      setError(err.message || 'Failed to connect to MCP server.')
      toast.error(err.message || 'Plan failed')
      setState('failed')
    }
  }

  // ---------------------------------------------------------------------------
  // handleApprove — calls POST /terraform/apply with approved=true
  //
  // WHY approved IS IN THE REQUEST BODY (not a URL flag):
  //   Making it explicit in the body means every apply request carries
  //   a clear record of the approval decision — the audit trail is
  //   self-documenting.
  // ---------------------------------------------------------------------------

  async function handleApprove() {
    setState('applying')
    try {
      const data = await callTool('run_terraform_apply_mcp', {
        execution_id: executionId,
        approved:     true,
      })
      setApplyData(data)
      setState(data.status)   // "complete" or "failed"
      if (data.status === 'complete') toast.success('Changes applied successfully')
      else toast.error('Apply failed — check the output below')
    } catch (err) {
      setError(err.message || 'Apply request failed — check MCP server logs.')
      toast.error(err.message || 'Apply request failed')
      setState('failed')
    }
  }

  // ---------------------------------------------------------------------------
  // handleReject — calls POST /terraform/apply with approved=false
  //
  // The server logs the rejection and returns immediately without
  // touching Terraform. We set state to 'rejected' regardless of the
  // response, so the UI updates even if the log call fails.
  // ---------------------------------------------------------------------------

  async function handleReject() {
    callTool('run_terraform_apply_mcp', {
      execution_id: executionId,
      approved:     false,
    }).catch(() => {})  // best-effort — no AWS change happened regardless
    setState('rejected')
    toast('Execution rejected', { icon: '🚫' })
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div style={{
      background:    cfg.bg,
      border:        `1px solid ${cfg.color}`,
      borderRadius:  '12px',
      padding:       '1.5rem',
      transition:    'background 0.3s, border-color 0.3s',
      marginTop:     '16px',
    }}>

      {/* -------------------------------------------------------------------- */}
      {/* Error banner — shown at top whenever a network/API error occurred   */}
      {/* -------------------------------------------------------------------- */}
      {error && (
        <div style={{
          color:          '#cc0000',
          background:     '#fff0f0',
          border:         '1px solid #ff4444',
          borderRadius:   '6px',
          padding:        '10px 14px',
          marginBottom:   '12px',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          gap:            '12px',
          fontSize:       '13px',
        }}>
          <span>{error}</span>
          <button
            onClick={() => { setError(null); setState('idle'); setExecutionId(null); setPlanData(null); runPlan() }}
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
      {/* Status header row — always visible                                   */}
      {/* -------------------------------------------------------------------- */}
      <div style={{
        display:        'flex',
        justifyContent: 'space-between',
        alignItems:     'center',
        marginBottom:   '1rem',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Status badge pill */}
          <span style={{
            background:   cfg.color,
            color:        'white',
            padding:      '3px 10px',
            borderRadius: '20px',
            fontSize:     '11px',
            fontWeight:   'bold',
          }}>
            {cfg.label}
          </span>
          {/* Description */}
          <span style={{ fontSize: '13px', color: '#555' }}>
            {description}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Execution ID — shown once plan starts */}
          {executionId && (
            <span style={{ fontSize: '10px', color: '#aaa', fontFamily: 'monospace' }}>
              {executionId}
            </span>
          )}
          {/* Dismiss button */}
          {onClose && (
            <button onClick={onClose} style={{
              background: 'transparent',
              border:     'none',
              cursor:     'pointer',
              fontSize:   '16px',
              color:      '#aaa',
              lineHeight: 1,
            }}>
              ✕
            </button>
          )}
        </div>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* SECTION 2 — idle: show "Run Terraform Plan" button                  */}
      {/* -------------------------------------------------------------------- */}
      {state === 'idle' && (
        <button onClick={runPlan} style={{
          width:        '100%',
          padding:      '10px',
          borderRadius: '8px',
          border:       'none',
          background:   '#007bff',
          color:        'white',
          fontSize:     '14px',
          fontWeight:   'bold',
          cursor:       'pointer',
        }}>
          Run Terraform Plan
        </button>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* SECTION 3 — planning: loading indicator                              */}
      {/* -------------------------------------------------------------------- */}
      {state === 'planning' && (
        <p style={{ color: '#1D9E75', fontStyle: 'italic', fontSize: '13px', margin: 0 }}>
          Running terraform plan — this may take 30–60 seconds...
        </p>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* SECTION 4 — awaiting_approval: plan output + approve/reject          */}
      {/* -------------------------------------------------------------------- */}
      {state === 'awaiting_approval' && planData && (
        <div>

          {/* A. Resource change summary badges */}
          <div style={{ display: 'flex', gap: '12px', marginBottom: '1rem', flexWrap: 'wrap' }}>
            {[
              { label: `+${planData.resources_to_add} to add`,      color: '#3B6D11' },
              { label: `~${planData.resources_to_change} to change`, color: '#BA7517' },
              { label: `-${planData.resources_to_destroy} to destroy`, color: '#A32D2D' },
            ].map((item, i) => (
              <span key={i} style={{
                padding:      '4px 12px',
                borderRadius: '20px',
                border:       `1px solid ${item.color}`,
                color:        item.color,
                fontSize:     '12px',
                fontWeight:   'bold',
              }}>
                {item.label}
              </span>
            ))}
          </div>

          {/* B. Plan output terminal box */}
          <pre style={{
            background:   '#1e1e1e',
            color:        '#d4d4d4',
            padding:      '1rem',
            borderRadius: '8px',
            fontSize:     '11px',
            overflow:     'auto',
            maxHeight:    '240px',
            marginBottom: '1rem',
            whiteSpace:   'pre-wrap',
            wordBreak:    'break-word',
            fontFamily:   'monospace',
          }}>
            {planData.plan_output}
          </pre>

          {/* C. Warning box */}
          <div style={{
            background:    '#fff8e6',
            border:        '1px solid #ffaa00',
            borderRadius:  '8px',
            padding:       '0.75rem',
            marginBottom:  '1rem',
            fontSize:      '12px',
            color:         '#885500',
          }}>
            ⚠️ <strong>Warning:</strong> Approving this will modify your real AWS
            infrastructure. Review the plan above carefully before proceeding.
          </div>

          {/* D. Approve / Reject buttons */}
          <div style={{ display: 'flex', gap: '12px' }}>
            <button onClick={handleApprove} style={{
              flex:         1,
              padding:      '10px',
              borderRadius: '8px',
              border:       'none',
              background:   '#22aa44',
              color:        'white',
              fontSize:     '14px',
              fontWeight:   'bold',
              cursor:       'pointer',
            }}>
              ✅ Approve &amp; Apply
            </button>
            <button onClick={handleReject} style={{
              flex:         1,
              padding:      '10px',
              borderRadius: '8px',
              border:       '1px solid #ff4444',
              background:   'white',
              color:        '#ff4444',
              fontSize:     '14px',
              fontWeight:   'bold',
              cursor:       'pointer',
            }}>
              ❌ Reject
            </button>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* SECTION 5 — applying: loading indicator                              */}
      {/* -------------------------------------------------------------------- */}
      {state === 'applying' && (
        <p style={{ color: '#185FA5', fontStyle: 'italic', fontSize: '13px', margin: 0 }}>
          Applying changes to AWS — do not close this window...
        </p>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* SECTION 6 — complete: apply output + resources created               */}
      {/* -------------------------------------------------------------------- */}
      {state === 'complete' && applyData && (
        <div>
          <p style={{ color: '#3B6D11', fontWeight: 'bold', fontSize: '13px', marginTop: 0 }}>
            ✅ Changes applied successfully!
          </p>

          {/* Resource tags */}
          {applyData.resources_applied?.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '12px' }}>
              {applyData.resources_applied.map((r, i) => (
                <span key={i} style={{
                  background:   '#e8f5e9',
                  border:       '1px solid #a5d6a7',
                  borderRadius: '4px',
                  padding:      '2px 8px',
                  fontSize:     '11px',
                  color:        '#2e7d32',
                  fontFamily:   'monospace',
                }}>
                  {r}
                </span>
              ))}
            </div>
          )}

          {/* Apply output terminal box */}
          <pre style={{
            background:  '#1e1e1e',
            color:       '#86efac',
            padding:     '1rem',
            borderRadius:'8px',
            fontSize:    '11px',
            overflow:    'auto',
            maxHeight:   '200px',
            whiteSpace:  'pre-wrap',
            fontFamily:  'monospace',
          }}>
            {applyData.apply_output}
          </pre>
        </div>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* SECTION 7 — rejected: confirmation + reset button                   */}
      {/* -------------------------------------------------------------------- */}
      {state === 'rejected' && (
        <div>
          <p style={{ color: '#888', fontSize: '13px', marginTop: 0 }}>
            Plan rejected. No changes were made to your AWS infrastructure.
          </p>
          <button onClick={() => { setState('idle'); setExecutionId(null); setPlanData(null) }}
            style={{
              padding:      '8px 16px',
              borderRadius: '8px',
              border:       '1px solid #ccc',
              background:   'white',
              color:        '#555',
              fontSize:     '13px',
              cursor:       'pointer',
            }}>
            Start new plan
          </button>
        </div>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* SECTION 8 — failed / plan_failed: error output + retry button        */}
      {/* -------------------------------------------------------------------- */}
      {(state === 'failed' || state === 'plan_failed') && (
        <div>
          <p style={{ color: '#A32D2D', fontWeight: 'bold', fontSize: '13px', marginTop: 0 }}>
            {state === 'plan_failed' ? 'Plan failed' : 'Apply failed'}
          </p>

          {/* Show plan output for plan failures; apply output for apply failures */}
          {(planData?.plan_output || applyData?.apply_output) && (
            <pre style={{
              background:   '#1e1e1e',
              color:        '#f09595',
              padding:      '1rem',
              borderRadius: '8px',
              fontSize:     '11px',
              overflow:     'auto',
              maxHeight:    '200px',
              whiteSpace:   'pre-wrap',
              fontFamily:   'monospace',
              marginBottom: '12px',
            }}>
              {planData?.plan_output || applyData?.apply_output}
            </pre>
          )}

          <button onClick={() => { setState('idle'); setExecutionId(null); setPlanData(null); setError(null) }}
            style={{
              padding:      '8px 16px',
              borderRadius: '8px',
              border:       '1px solid #ccc',
              background:   'white',
              color:        '#555',
              fontSize:     '13px',
              cursor:       'pointer',
            }}>
            Try again
          </button>
        </div>
      )}

      {/* Error banner is rendered at the top of this component. */}

    </div>
  )
}
