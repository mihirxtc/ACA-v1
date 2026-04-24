// =============================================================================
// SecurityPanel.jsx — Security analysis UI for the Agentic Cloud Assistant
//
// This component runs the GET /security endpoint and displays the results
// grouped by severity with expandable finding cards.
//
// Features:
//   - Model selector and API key input (same as Chat.jsx)
//   - "Run Security Scan" button triggers the backend analysis
//   - Severity count badges: HIGH / MEDIUM / LOW
//   - LLM summary displayed at the top of results
//   - Findings grouped HIGH → MEDIUM → LOW with colour coding
//   - Click a finding card to expand/collapse its details
//
// No external libraries — only React built-ins (useState).
// All styles are inline — no CSS files or Tailwind required.
// =============================================================================

import { useState } from 'react'
import toast from 'react-hot-toast'
import { useApiKeys } from '../context/ApiKeyContext'
import { callTool } from '../lib/mcpClient'

// -----------------------------------------------------------------------------
// Colour scheme by severity.
//
// Each severity has three values:
//   background — the card / section background colour
//   border     — the left border / outline colour
//   badge      — the pill badge background colour (text is always white)
// -----------------------------------------------------------------------------

const SEVERITY_COLOURS = {
  HIGH: {
    background: '#fff0f0',
    border:     '#ff4444',
    badge:      '#ff4444',
  },
  MEDIUM: {
    background: '#fff8f0',
    border:     '#ff8800',
    badge:      '#ff8800',
  },
  LOW: {
    background: '#fffef0',
    border:     '#ccaa00',
    badge:      '#ccaa00',
  },
}

// -----------------------------------------------------------------------------
// Helper: SeverityBadge
// A small coloured pill showing "X HIGH", "X MEDIUM", or "X LOW".
// -----------------------------------------------------------------------------

function SeverityBadge({ severity, count }) {
  const colours = SEVERITY_COLOURS[severity] || { badge: '#888888' }

  return (
    <span style={{
      backgroundColor: colours.badge,
      color:           'white',
      fontWeight:      'bold',
      fontSize:        '0.85rem',
      padding:         '4px 12px',
      borderRadius:    '999px',   // Fully rounded pill shape
      marginRight:     '8px',
      display:         'inline-block',
    }}>
      {count} {severity}
    </span>
  )
}

// -----------------------------------------------------------------------------
// Helper: FindingCard
// One card per finding. Clicking toggles expansion to show full details.
// The optional onFixThis prop enables the "Fix This →" button that pre-fills
// the TerraformPanel with a remediation request for this specific finding.
// -----------------------------------------------------------------------------

function FindingCard({ finding, isExpanded, onToggle, onFixThis }) {
  const colours = SEVERITY_COLOURS[finding.severity] || {
    background: '#f8f8f8',
    border:     '#888888',
  }

  return (
    <div
      onClick={onToggle}
      style={{
        backgroundColor: colours.background,
        border:          `1px solid ${colours.border}`,
        borderLeft:      `4px solid ${colours.border}`,  // Thicker left accent
        borderRadius:    '6px',
        padding:         '12px 16px',
        marginBottom:    '8px',
        cursor:          'pointer',
        userSelect:      'none',  // Prevent text selection on rapid clicking
      }}
    >
      {/* ------------------------------------------------------------------ */}
      {/* Card header — always visible                                        */}
      {/* ------------------------------------------------------------------ */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span style={{ fontWeight: 'bold', fontSize: '0.95rem' }}>
            {finding.title}
          </span>
          <span style={{ color: '#666', fontSize: '0.85rem', marginLeft: '10px' }}>
            {finding.resource_id}
          </span>
        </div>
        {/* Expand / collapse indicator */}
        <span style={{ color: '#888', fontSize: '0.8rem' }}>
          {isExpanded ? '▲ collapse' : '▼ expand'}
        </span>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Expanded detail — only visible when this card is selected          */}
      {/* ------------------------------------------------------------------ */}
      {isExpanded && (
        <div style={{ marginTop: '12px', fontSize: '0.9rem', lineHeight: '1.6' }}>

          <div style={{ marginBottom: '8px' }}>
            <strong>Description:</strong> {finding.description}
          </div>

          <div style={{ marginBottom: '8px' }}>
            <strong>Recommendation:</strong> {finding.recommendation}
          </div>

          <div style={{ marginBottom: '4px' }}>
            <strong>Resource Type:</strong> {finding.resource_type}
          </div>

          <div style={{ marginBottom: '8px' }}>
            <strong>Rule:</strong> {finding.rule}
          </div>

          {/* "Fix This →" button — only shown when a handler is provided */}
          {onFixThis && (
            <button
              onClick={(e) => {
                e.stopPropagation()   // Don't collapse the card
                onFixThis(finding)
              }}
              style={{
                marginTop:       '10px',
                padding:         '6px 16px',
                backgroundColor: '#2563eb',
                color:           'white',
                border:          'none',
                borderRadius:    '6px',
                cursor:          'pointer',
                fontSize:        '0.85rem',
                fontWeight:      'bold',
              }}
            >
              🔧 Fix This →
            </button>
          )}

          {/* Metadata: loop through whatever extra fields the rule provides */}
          {finding.metadata && Object.keys(finding.metadata).length > 0 && (
            <div style={{
              backgroundColor: 'rgba(0,0,0,0.04)',
              borderRadius:    '4px',
              padding:         '8px',
              marginTop:       '8px',
            }}>
              <strong>Details:</strong>
              {Object.entries(finding.metadata).map(([key, value]) => (
                <div key={key} style={{ marginTop: '4px' }}>
                  <span style={{ color: '#555' }}>{key}:</span>{' '}
                  <span>{String(value)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Helper: SeverityGroup
// Renders a heading + list of FindingCards for one severity level.
// Only renders if there is at least one finding at this severity.
// -----------------------------------------------------------------------------

function SeverityGroup({ severity, findings, expandedId, onToggle, onFixThis }) {
  if (findings.length === 0) return null

  const colours = SEVERITY_COLOURS[severity] || { border: '#888888' }

  // Emoji prefix per severity level for quick visual scanning
  const emoji = { HIGH: '🔴', MEDIUM: '🟠', LOW: '🟡' }[severity] || '⚪'

  return (
    <div style={{ marginBottom: '24px' }}>
      <h3 style={{
        fontSize:     '1rem',
        fontWeight:   'bold',
        marginBottom: '10px',
        borderBottom: `2px solid ${colours.border}`,
        paddingBottom: '4px',
      }}>
        {emoji} {severity} Risk ({findings.length})
      </h3>

      {findings.map(finding => (
        <FindingCard
          key={finding.finding_id}
          finding={finding}
          isExpanded={expandedId === finding.finding_id}
          onToggle={() => onToggle(finding.finding_id)}
          onFixThis={onFixThis}
        />
      ))}
    </div>
  )
}


// =============================================================================
// Main component
// =============================================================================

export default function SecurityPanel({ onFixThis, onScanComplete }) {

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [findings,   setFindings]   = useState([])   // All findings from /security
  const [summary,    setSummary]    = useState('')   // LLM plain-English summary
  const [counts,     setCounts]     = useState({})   // { HIGH: N, MEDIUM: N, LOW: N }
  const [loading,    setLoading]    = useState(false) // True while scan is running
  const [error,      setError]      = useState(null)  // Error message string or null
  const [expandedId, setExpandedId] = useState(null)  // finding_id of the open card
  const [hasScanned, setHasScanned] = useState(false) // True after first successful scan

  // Read model and keys from centralised Context.
  const { keys } = useApiKeys()

  // ---------------------------------------------------------------------------
  // runSecurityScan — calls GET /security and updates state
  // ---------------------------------------------------------------------------

  async function runSecurityScan() {
    setLoading(true)
    setError(null)

    try {
      const resolvedKey = keys.model === 'anthropic' ? keys.anthropic : keys.groq
      const data = await callTool('run_security_analysis_with_summary', {
        model:   keys.model || 'groq',
        api_key: resolvedKey || '',
      })

      const newFindings = data.findings  || []
      const newCounts   = data.severity_counts || {}
      setFindings(newFindings)
      setSummary(data.llm_summary || '')
      setCounts(newCounts)
      setHasScanned(true)
      toast.success('Scan complete')

      onScanComplete?.(newFindings)

    } catch (err) {
      setError(err.message || 'Failed to run security scan.')
      toast.error(err.message || 'Security scan failed')
    } finally {
      setLoading(false)
    }
  }

  // ---------------------------------------------------------------------------
  // toggleExpand — opens a card if closed, closes it if already open
  // ---------------------------------------------------------------------------

  function toggleExpand(id) {
    setExpandedId(prev => prev === id ? null : id)
  }

  // ---------------------------------------------------------------------------
  // Split findings by severity for grouped display.
  //
  // We filter the already-sorted array from the API — no client-side sort
  // needed because the backend guarantees HIGH → MEDIUM → LOW order.
  // ---------------------------------------------------------------------------

  const highFindings   = findings.filter(f => f.severity === 'HIGH')
  const mediumFindings = findings.filter(f => f.severity === 'MEDIUM')
  const lowFindings    = findings.filter(f => f.severity === 'LOW')

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div style={{
      fontFamily:  'sans-serif',
      maxWidth:    '900px',
      margin:      '2rem auto',
      padding:     '0 1rem',
    }}>

      {/* -------------------------------------------------------------------- */}
      {/* Header row                                                            */}
      {/* -------------------------------------------------------------------- */}
      <div style={{
        display:        'flex',
        alignItems:     'center',
        gap:            '12px',
        flexWrap:       'wrap',
        marginBottom:   '16px',
      }}>
        <h2 style={{ margin: 0, fontSize: '1.4rem' }}>🔒 Security Analysis</h2>

        {/* Scan button — disabled while loading to prevent double-clicks */}
        <button
          onClick={runSecurityScan}
          disabled={loading}
          style={{
            padding:         '8px 20px',
            backgroundColor: loading ? '#90b0e0' : '#2563eb',
            color:           'white',
            border:          'none',
            borderRadius:    '6px',
            cursor:          loading ? 'not-allowed' : 'pointer',
            fontWeight:      'bold',
            fontSize:        '0.95rem',
          }}
        >
          {loading ? 'Scanning...' : 'Run Security Scan'}
        </button>
      </div>

      {/* Read-only model indicator */}
      <div style={{ fontSize: '12px', color: '#888', marginBottom: '8px' }}>
        Model:{' '}
        {keys.model === 'groq'       ? '☁️ Groq'
        : keys.model === 'anthropic'  ? '🧠 Anthropic'
        :                               '🖥️ Ollama'}
        &nbsp;·&nbsp;
        {(keys.model === 'anthropic' ? keys.anthropic : keys.groq)
          ? '🔑 Custom key' : '🔑 Server key'}
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* Loading skeleton — 3 placeholder rows while scan is in progress     */}
      {/* -------------------------------------------------------------------- */}
      {loading && (
        <div style={{ marginBottom: '16px' }}>
          {[100, 85, 70].map((w, i) => (
            <div
              key={i}
              style={{
                height:     '20px',
                width:      `${w}%`,
                marginBottom:'8px',
                borderRadius:'4px',
                background:  'rgba(128,128,128,0.15)',
                animation:   'skeleton-pulse 1.5s ease-in-out infinite',
                animationDelay: `${i * 0.15}s`,
              }}
            />
          ))}
        </div>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* Error state                                                           */}
      {/* -------------------------------------------------------------------- */}
      {error && (
        <div style={{
          color:          '#cc0000',
          background:     '#fff0f0',
          border:         '1px solid #ff4444',
          borderRadius:   '6px',
          padding:        '10px 14px',
          marginBottom:   '16px',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          gap:            '12px',
        }}>
          <span>{error}</span>
          <button
            onClick={() => { setError(null); runSecurityScan() }}
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
      {/* Results — only shown after a successful scan                         */}
      {/* -------------------------------------------------------------------- */}
      {hasScanned && !loading && (

        <>
          {/* All-clear state */}
          {findings.length === 0 && (
            <div style={{ color: '#2a7a2a', fontSize: '1.1rem', marginBottom: '16px' }}>
              ✅ No security issues found.
            </div>
          )}

          {findings.length > 0 && (
            <>
              {/* ------------------------------------------------------------ */}
              {/* Severity count badges                                         */}
              {/* ------------------------------------------------------------ */}
              <div style={{ marginBottom: '16px' }}>
                <SeverityBadge severity="HIGH"   count={counts.HIGH   || 0} />
                <SeverityBadge severity="MEDIUM" count={counts.MEDIUM || 0} />
                <SeverityBadge severity="LOW"    count={counts.LOW    || 0} />
              </div>

              {/* ------------------------------------------------------------ */}
              {/* LLM summary box                                               */}
              {/* ------------------------------------------------------------ */}
              <div style={{
                backgroundColor: '#f8f8f8',
                border:          '1px solid #e0e0e0',
                borderRadius:    '8px',
                padding:         '1rem',
                marginBottom:    '24px',
              }}>
                <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>
                  🤖 AI Security Summary
                </div>
                <div style={{ whiteSpace: 'pre-wrap', lineHeight: '1.6', fontSize: '0.9rem' }}>
                  {summary}
                </div>
              </div>

              {/* ------------------------------------------------------------ */}
              {/* Findings grouped by severity                                  */}
              {/* ------------------------------------------------------------ */}
              <SeverityGroup
                severity="HIGH"
                findings={highFindings}
                expandedId={expandedId}
                onToggle={toggleExpand}
                onFixThis={onFixThis}
              />
              <SeverityGroup
                severity="MEDIUM"
                findings={mediumFindings}
                expandedId={expandedId}
                onToggle={toggleExpand}
                onFixThis={onFixThis}
              />
              <SeverityGroup
                severity="LOW"
                findings={lowFindings}
                expandedId={expandedId}
                onToggle={toggleExpand}
                onFixThis={onFixThis}
              />
            </>
          )}
        </>
      )}
    </div>
  )
}
