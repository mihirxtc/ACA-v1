// =============================================================================
// ExecutionLog.jsx — Execution history table for the Agentic Cloud Assistant
//
// Reads from GET /terraform/executions and displays a table of all past
// plan/apply runs with status badges, timestamps, resource counts, and
// expandable rows showing plan and apply output.
//
// This component is the audit trail — every AI-proposed change is recorded
// with its approval decision and outcome.
// =============================================================================

import { useState, useEffect } from 'react'
import { callTool } from '../lib/mcpClient'

// -----------------------------------------------------------------------------
// Colour config for status badges — mirrors the colours in ExecutionPanel
// so the two components have a consistent visual language.
// -----------------------------------------------------------------------------

const STATUS_COLOURS = {
  complete:          { bg: '#e8f5e9', color: '#2e7d32' },
  rejected:          { bg: '#f8f8f8', color: '#888' },
  failed:            { bg: '#fff0f0', color: '#cc0000' },
  plan_failed:       { bg: '#fff0f0', color: '#cc0000' },
  awaiting_approval: { bg: '#fff8e6', color: '#885500' },
}

// -----------------------------------------------------------------------------
// statusBadge — renders a small coloured pill for a given status string
// -----------------------------------------------------------------------------

function StatusBadge({ status }) {
  const c = STATUS_COLOURS[status] || { bg: '#f8f8f8', color: '#888' }
  return (
    <span style={{
      background:   c.bg,
      color:        c.color,
      padding:      '2px 8px',
      borderRadius: '20px',
      fontSize:     '11px',
      fontWeight:   'bold',
      whiteSpace:   'nowrap',
    }}>
      {status}
    </span>
  )
}

// =============================================================================
// ExecutionLog
// =============================================================================

export default function ExecutionLog() {

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [history,     setHistory]     = useState([])   // All entries, newest first
  const [loading,     setLoading]     = useState(false) // True while fetching
  const [expandedId,  setExpandedId]  = useState(null)  // ID of expanded row

  // ---------------------------------------------------------------------------
  // fetchHistory — GET /terraform/executions
  //
  // Called on mount and on Refresh. Results are reversed so newest
  // entries appear at the top of the table.
  // ---------------------------------------------------------------------------

  async function fetchHistory() {
    setLoading(true)
    try {
      const data = await callTool('get_execution_history_tool')
      setHistory([...(data.executions || [])].reverse())
    } catch {
      // Silently fail — user can click Refresh to retry.
    } finally {
      setLoading(false)
    }
  }

  // Fetch on mount so history is visible immediately when the panel loads.
  useEffect(() => { fetchHistory() }, [])

  // ---------------------------------------------------------------------------
  // toggleExpand — open a row if closed, close it if already open
  // ---------------------------------------------------------------------------

  function toggleExpand(id) {
    setExpandedId(prev => prev === id ? null : id)
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div style={{ fontFamily: 'sans-serif' }}>

      {/* -------------------------------------------------------------------- */}
      {/* Header row                                                            */}
      {/* -------------------------------------------------------------------- */}
      <div style={{
        display:        'flex',
        justifyContent: 'space-between',
        alignItems:     'center',
        marginBottom:   '16px',
      }}>
        <h2 style={{ margin: 0, fontSize: '1.4rem' }}>📋 Execution History</h2>
        <button
          onClick={fetchHistory}
          disabled={loading}
          style={{
            padding:         '6px 16px',
            backgroundColor: loading ? '#ccc' : '#2563eb',
            color:           'white',
            border:          'none',
            borderRadius:    '6px',
            cursor:          loading ? 'not-allowed' : 'pointer',
            fontSize:        '0.85rem',
            fontWeight:      'bold',
          }}
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* Loading state                                                         */}
      {/* -------------------------------------------------------------------- */}
      {loading && (
        <p style={{ color: '#888', fontStyle: 'italic', fontSize: '13px' }}>
          Loading history...
        </p>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* Empty state                                                           */}
      {/* -------------------------------------------------------------------- */}
      {!loading && history.length === 0 && (
        <p style={{ color: '#aaa', fontStyle: 'italic', fontSize: '13px' }}>
          No executions yet.
        </p>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* History table                                                         */}
      {/* -------------------------------------------------------------------- */}
      {history.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Timestamp', 'Status', 'Description', 'Changes', 'Details'].map(h => (
                <th key={h} style={{
                  fontSize:    '11px',
                  color:       '#888',
                  fontWeight:  'bold',
                  textAlign:   'left',
                  padding:     '6px 6px',
                  borderBottom:'2px solid #e0e0e0',
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {history.map(entry => {
              const isExpanded = expandedId === entry.execution_id
              return (
                <>
                  {/* Main row */}
                  <tr
                    key={entry.execution_id}
                    onClick={() => toggleExpand(entry.execution_id)}
                    style={{
                      borderBottom: '1px solid #f0f0f0',
                      cursor:       'pointer',
                    }}
                  >
                    {/* Timestamp */}
                    <td style={{ fontSize: '12px', padding: '8px 6px', whiteSpace: 'nowrap', color: '#555' }}>
                      {entry.timestamp
                        ? new Date(entry.timestamp).toLocaleString()
                        : '—'}
                    </td>

                    {/* Status badge */}
                    <td style={{ padding: '8px 6px' }}>
                      <StatusBadge status={entry.status} />
                    </td>

                    {/* Description — truncated to 40 chars */}
                    <td style={{ fontSize: '12px', padding: '8px 6px', color: '#333', maxWidth: '200px' }}>
                      {(entry.description || '').length > 40
                        ? entry.description.slice(0, 40) + '…'
                        : entry.description || '—'}
                    </td>

                    {/* Resource change counts */}
                    <td style={{ fontSize: '11px', padding: '8px 6px', whiteSpace: 'nowrap' }}>
                      <span style={{ color: '#3B6D11', marginRight: '4px' }}>
                        +{entry.resources_to_add ?? 0}
                      </span>
                      <span style={{ color: '#BA7517', marginRight: '4px' }}>
                        ~{entry.resources_to_change ?? 0}
                      </span>
                      <span style={{ color: '#A32D2D' }}>
                        -{entry.resources_to_destroy ?? 0}
                      </span>
                    </td>

                    {/* Expand toggle */}
                    <td style={{ fontSize: '11px', color: '#aaa', padding: '8px 6px', textAlign: 'center' }}>
                      {isExpanded ? '▲' : '▼'}
                    </td>
                  </tr>

                  {/* Expanded row — plan + apply output */}
                  {isExpanded && (
                    <tr key={`${entry.execution_id}-expanded`}>
                      <td colSpan={5} style={{ padding: '0 6px 12px 6px', background: '#fafafa' }}>

                        {/* Execution ID */}
                        <div style={{ fontSize: '10px', color: '#aaa', fontFamily: 'monospace', marginBottom: '8px', marginTop: '8px' }}>
                          {entry.execution_id}
                        </div>

                        {/* Plan output */}
                        {entry.plan_output && (
                          <>
                            <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#555', marginBottom: '4px' }}>
                              Plan output:
                            </div>
                            <pre style={{
                              background:   '#1e1e1e',
                              color:        '#d4d4d4',
                              padding:      '0.75rem',
                              borderRadius: '6px',
                              fontSize:     '10px',
                              overflow:     'auto',
                              maxHeight:    '200px',
                              whiteSpace:   'pre-wrap',
                              fontFamily:   'monospace',
                              marginBottom: '8px',
                            }}>
                              {entry.plan_output}
                            </pre>
                          </>
                        )}

                        {/* Apply output */}
                        {entry.apply_output && (
                          <>
                            <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#555', marginBottom: '4px' }}>
                              Apply output:
                            </div>
                            <pre style={{
                              background:   '#1e1e1e',
                              color:        entry.status === 'complete' ? '#86efac' : '#f09595',
                              padding:      '0.75rem',
                              borderRadius: '6px',
                              fontSize:     '10px',
                              overflow:     'auto',
                              maxHeight:    '200px',
                              whiteSpace:   'pre-wrap',
                              fontFamily:   'monospace',
                            }}>
                              {entry.apply_output}
                            </pre>
                          </>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
