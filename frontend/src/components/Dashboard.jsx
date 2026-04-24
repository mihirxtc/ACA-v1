// =============================================================================
// Dashboard.jsx — Unified 4-panel layout for the Agentic Cloud Assistant
//
// This is the main application view. It arranges all four feature panels
// into a responsive 2×2 grid:
//
//   ┌─────────────────────┬─────────────────────┐
//   │  ☁️ Infrastructure   │  🔒 Security         │
//   │  Overview           │  Analysis            │
//   ├─────────────────────┼─────────────────────┤
//   │  💰 Cost            │  🤖 Chat             │
//   │  Analysis           │  Assistant           │
//   └─────────────────────┴─────────────────────┘
//
// On screens narrower than 1200px the grid collapses to a single column
// so all panels stack vertically — no horizontal scrolling.
//
// The InfrastructureOverview panel is defined inline here because it is
// simple enough (5 metric tiles from /scan) to not need its own file.
// All other panels are imported from their existing component files.
// =============================================================================

import { useState, useEffect } from 'react'
import Chat             from './Chat'
import SecurityPanel    from './SecurityPanel'
import CostPanel        from './CostPanel'
import TerraformPanel   from './TerraformPanel'
import ExecutionLog     from './ExecutionLog'
import ApiKeySettings   from './ApiKeySettings'
import { useApiKeys }   from '../context/ApiKeyContext'
import { useAuth }      from '../context/AuthContext'
import AgentPanel      from './AgentPanel'
import KnowledgeBasePanel from './KnowledgeBasePanel'
import { callTool }    from '../lib/mcpClient'


// =============================================================================
// InfrastructureOverview — inline panel showing 5 resource counts from /scan
// =============================================================================

function InfrastructureOverview() {

  const [scanData,    setScanData]    = useState(null)
  const [scanLoading, setScanLoading] = useState(false)
  const [scanError,   setScanError]   = useState(null)

  // ---------------------------------------------------------------------------
  // fetchScan — calls GET /scan and stores the result
  // ---------------------------------------------------------------------------

  async function fetchScan() {
    setScanLoading(true)
    setScanError(null)

    try {
      const data = await callTool('full_aws_scan')
      setScanData(data)
    } catch (err) {
      setScanError('Scan failed. Is the MCP server running on port 8000?')
    } finally {
      setScanLoading(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Metric tile — a small card showing one resource count with a label
  // ---------------------------------------------------------------------------

  function MetricTile({ label, value }) {
    return (
      <div style={{
        backgroundColor: 'white',
        border:          '1px solid #e0e0e0',
        borderRadius:    '8px',
        padding:         '12px 16px',
        textAlign:       'center',
      }}>
        <div style={{ fontSize: '28px', fontWeight: 'bold', color: '#333' }}>
          {value}
        </div>
        <div style={{ fontSize: '12px', color: '#888', marginTop: '4px' }}>
          {label}
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      {/* Header row */}
      <div style={{
        display:        'flex',
        justifyContent: 'space-between',
        alignItems:     'center',
        marginBottom:   '16px',
      }}>
        <h2 style={{ margin: 0, fontSize: '1.4rem' }}>☁️ Infrastructure Overview</h2>

        <button
          onClick={fetchScan}
          disabled={scanLoading}
          style={{
            padding:         '8px 16px',
            backgroundColor: scanLoading ? '#90b0e0' : '#2563eb',
            color:           'white',
            border:          'none',
            borderRadius:    '6px',
            cursor:          scanLoading ? 'not-allowed' : 'pointer',
            fontWeight:      'bold',
            fontSize:        '0.9rem',
          }}
        >
          {scanLoading ? 'Scanning...' : '🔄 Refresh Scan'}
        </button>
      </div>

      {/* Loading state */}
      {scanLoading && (
        <div style={{ color: '#555', fontStyle: 'italic' }}>
          Scanning AWS account...
        </div>
      )}

      {/* Error state */}
      {scanError && (
        <div style={{ color: '#cc0000', fontSize: '0.9rem' }}>
          {scanError}
        </div>
      )}

      {/* Pre-scan prompt — shown before the first scan */}
      {!scanData && !scanLoading && !scanError && (
        <div style={{ color: '#888', fontStyle: 'italic', fontSize: '0.9rem' }}>
          Click "Refresh Scan" to load infrastructure data.
        </div>
      )}

      {/* 5 metric tiles in a 2-column mini grid */}
      {scanData && !scanLoading && (
        <div style={{
          display:             'grid',
          gridTemplateColumns: '1fr 1fr',
          gap:                 '10px',
          marginTop:           '8px',
        }}>
          <MetricTile label="EC2 Instances"   value={scanData.ec2?.count              ?? 0} />
          <MetricTile label="S3 Buckets"      value={scanData.s3?.count               ?? 0} />
          <MetricTile label="IAM Users"       value={scanData.iam?.user_count          ?? 0} />
          <MetricTile label="Security Groups" value={scanData.security_groups?.count   ?? 0} />
          <MetricTile label="VPCs"            value={scanData.vpc?.count               ?? 0} />
        </div>
      )}
    </div>
  )
}


// =============================================================================
// Dashboard — main layout component
// =============================================================================

// -----------------------------------------------------------------------------
// computeHealthScore — AWS Security Hub-style control-based scoring.
//
// Each of the 7 backend security rules is treated as a control that either
// passes (no findings) or fails (≥1 finding). Score is the proportion of
// passing control weight out of the total possible weight × 100.
//
// Weights reflect severity: HIGH=3, MEDIUM=2, LOW=1.
// Total weight = 16, so each point ≈ 6.25%.
//
// This is intentionally rule-level (not resource-level) so that an account
// with 20 misconfigured security groups fails SSH_PORT_OPEN once, not 20
// times — matching how AWS Security Hub, CIS Benchmark, and SOC 2 tooling
// report security posture.
// -----------------------------------------------------------------------------

const RULE_WEIGHTS = {
  SSH_PORT_OPEN:            3,  // HIGH
  RDP_PORT_OPEN:            3,  // HIGH
  S3_BUCKET_PUBLIC:         3,  // HIGH
  UNRESTRICTED_ALL_TRAFFIC: 3,  // HIGH
  IAM_USER_NO_MFA:          2,  // MEDIUM
  IAM_USER_INACTIVE:        1,  // LOW
  DEFAULT_VPC_IN_USE:       1,  // LOW
}

const TOTAL_RULE_WEIGHT = Object.values(RULE_WEIGHTS).reduce((s, w) => s + w, 0) // 16

function computeHealthScore(findings) {
  const failingRules = new Set((findings || []).map(f => f.rule))
  const passingWeight = Object.entries(RULE_WEIGHTS)
    .filter(([rule]) => !failingRules.has(rule))
    .reduce((sum, [, w]) => sum + w, 0)
  return Math.round((passingWeight / TOTAL_RULE_WEIGHT) * 100)
}


export default function Dashboard() {

  // ---------------------------------------------------------------------------
  // Responsive layout state
  //
  // We check window.innerWidth on mount and listen for resize events.
  // Below 1200px we switch to a single-column layout so panels stack
  // vertically rather than being squashed into narrow columns.
  // ---------------------------------------------------------------------------

  const [isMobile,         setIsMobile]         = useState(window.innerWidth < 1200)
  const [showSettings,     setShowSettings]     = useState(false)
  const [securityScore,    setSecurityScore]    = useState(null)   // null = not yet scanned
  const [terraformPrefill, setTerraformPrefill] = useState('')     // pre-fills TerraformPanel
  const { hasKey, keys }                        = useApiKeys()
  const { logout }                              = useAuth()

  useEffect(() => {
    function handleResize() {
      setIsMobile(window.innerWidth < 1200)
    }

    window.addEventListener('resize', handleResize)

    // Clean up the listener when the component unmounts to prevent
    // memory leaks — React's useEffect cleanup pattern.
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // ---------------------------------------------------------------------------
  // handleSecurityScanComplete — called by SecurityPanel after each scan.
  // Receives the full findings array and computes the control-based score.
  // ---------------------------------------------------------------------------

  function handleSecurityScanComplete(findings) {
    setSecurityScore(computeHealthScore(findings))
  }

  // ---------------------------------------------------------------------------
  // handleFixThis — called by SecurityPanel when the user clicks "Fix This →"
  // on a finding. Builds a Terraform-friendly remediation request string,
  // populates TerraformPanel via prefill, and scrolls down to it.
  // ---------------------------------------------------------------------------

  function handleFixThis(finding) {
    const request =
      `Fix security issue: "${finding.title}" on ` +
      `${finding.resource_type} ${finding.resource_id}. ` +
      `${finding.recommendation}`
    setTerraformPrefill(request)
    // Use a small timeout so the state update propagates before scrolling.
    setTimeout(() => {
      document.getElementById('terraform-panel')?.scrollIntoView({ behavior: 'smooth' })
    }, 100)
  }

  // ---------------------------------------------------------------------------
  // Panel card style — applied to every panel wrapper div
  // ---------------------------------------------------------------------------

  const panelStyle = {
    background:    'white',
    borderRadius:  '12px',
    border:        '1px solid #e0e0e0',
    padding:       '1.5rem',
    overflow:      'auto',
    maxHeight:     '650px',
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f5f5f5' }}>

      {/* Settings modal — rendered at the top so it overlays everything */}
      {showSettings && (
        <ApiKeySettings onClose={() => setShowSettings(false)} />
      )}

      {/* -------------------------------------------------------------------- */}
      {/* Title bar                                                             */}
      {/* -------------------------------------------------------------------- */}
      <div style={{
        backgroundColor: '#1a1a2e',
        color:           'white',
        padding:         '1rem 2rem',
        display:         'flex',
        justifyContent:  'space-between',
        alignItems:      'center',
      }}>
        {/* Left side — title and subtitle */}
        <div>
          <div style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>
            🤖 Agentic Cloud Assistant
          </div>
          <div style={{ fontSize: '0.85rem', color: '#aab', marginTop: '2px' }}>
            AI-Powered AWS Infrastructure Management
          </div>
        </div>

        {/* Right side — health score + region + API Keys + Logout */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>

          {/* Shared pill base style applied to all 4 header elements */}

          {/* Security health score pill — only shown after a scan */}
          {securityScore !== null && (() => {
            const score = securityScore
            const colour =
              score >= 80 ? '#22c55e' :
              score >= 50 ? '#f59e0b' :
                            '#ef4444'
            return (
              <div style={{
                display:         'flex',
                alignItems:      'center',
                gap:             '8px',
                padding:         '8px 16px',
                borderRadius:    '8px',
                border:          `1px solid ${colour}`,
                background:      'rgba(255,255,255,0.08)',
                fontSize:        '13px',
                fontWeight:      '500',
                color:           'white',
              }}>
                <span style={{
                  width:           '8px',
                  height:          '8px',
                  borderRadius:    '50%',
                  backgroundColor: colour,
                  flexShrink:      0,
                }} />
                Security Score:
                <strong style={{ color: colour }}>{score}/100</strong>
              </div>
            )
          })()}

          {/* Region badge */}
          <button
            onClick={() => setShowSettings(true)}
            title="Change AWS region"
            style={{
              display:      'flex',
              alignItems:   'center',
              gap:          '8px',
              padding:      '8px 16px',
              borderRadius: '8px',
              border:       '1px solid rgba(255,255,255,0.25)',
              background:   'rgba(255,255,255,0.08)',
              color:        'rgba(255,255,255,0.85)',
              cursor:       'pointer',
              fontSize:     '13px',
              fontWeight:   '500',
            }}
          >
            {keys.awsRegion || 'us-east-1'}
          </button>

          {/* API Keys */}
          <button
            onClick={() => setShowSettings(true)}
            style={{
              display:      'flex',
              alignItems:   'center',
              gap:          '8px',
              padding:      '8px 16px',
              borderRadius: '8px',
              border:       '1px solid rgba(255,255,255,0.25)',
              background:   'rgba(255,255,255,0.08)',
              color:        'white',
              cursor:       'pointer',
              fontSize:     '13px',
              fontWeight:   '500',
            }}
          >
            🔑 API Keys
            {(hasKey('groq') || hasKey('anthropic')) && (
              <span style={{
                width:        '8px',
                height:       '8px',
                borderRadius: '50%',
                background:   '#22dd44',
                flexShrink:   0,
              }} />
            )}
          </button>

          {/* Logout */}
          <button
            onClick={logout}
            style={{
              display:      'flex',
              alignItems:   'center',
              gap:          '8px',
              padding:      '8px 16px',
              borderRadius: '8px',
              border:       '1px solid rgba(255,100,100,0.4)',
              background:   'rgba(220,50,50,0.12)',
              color:        '#ffaaaa',
              cursor:       'pointer',
              fontSize:     '13px',
              fontWeight:   '500',
            }}
          >
            ⏻ Logout
          </button>
        </div>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* 4-panel grid                                                          */}
      {/* -------------------------------------------------------------------- */}
      <div style={{
        padding:             '1.5rem',
        display:             'grid',
        gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
        gap:                 '1.5rem',
      }}>

        {/* Panel 1 — Infrastructure Overview (top-left) */}
        <div style={panelStyle}>
          <InfrastructureOverview />
        </div>

        {/* Panel 2 — Security Analysis (top-right) */}
        <div style={panelStyle}>
          <SecurityPanel
            onScanComplete={handleSecurityScanComplete}
            onFixThis={handleFixThis}
          />
        </div>

        {/* Panel 3 — Cost Analysis (bottom-left) */}
        <div style={panelStyle}>
          <CostPanel />
        </div>

        {/* Panel 4 — Chat Assistant (bottom-right) */}
        <div style={panelStyle}>
          <Chat />
        </div>

        {/* Panel 5 — Terraform Generator (full-width, spans both columns) */}
        <div
          id="terraform-panel"
          style={{
            ...panelStyle,
            gridColumn: isMobile ? '1' : '1 / -1',
          }}
        >
          <TerraformPanel prefill={terraformPrefill} />
        </div>

        {/* Panel 6 — Execution Log (full-width, spans both columns) */}
        <div style={{
          ...panelStyle,
          gridColumn: isMobile ? '1' : '1 / -1',
        }}>
          <ExecutionLog />
        </div>

        {/* Panel 7 — Security Remediation Agent (full-width, spans both columns) */}
        <div style={{
          ...panelStyle,
          gridColumn: isMobile ? '1' : '1 / -1',
        }}>
          <AgentPanel />
        </div>

        {/* Panel 8 — Knowledge Base (full-width, spans both columns) */}
        <div style={{
          ...panelStyle,
          gridColumn: isMobile ? '1' : '1 / -1',
        }}>
          <KnowledgeBasePanel />
        </div>

      </div>
    </div>
  )
}
