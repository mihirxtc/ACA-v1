// =============================================================================
// TerraformPanel.jsx — Terraform HCL generation UI for the Agentic Cloud Assistant
//
// This component calls POST /terraform/generate and displays:
//   - Quick-request pills for common AWS resources
//   - Free-text input for custom requests
//   - Validation badge (✅ Valid / ❌ Invalid)
//   - LLM-generated HCL in a scrollable code block
//   - Copy-to-clipboard button
//
// Uses ApiKeyContext for model and API key — no local key state.
// All styles are inline — no CSS files or Tailwind.
// =============================================================================

import { useState, useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import { useApiKeys } from '../context/ApiKeyContext'
import ExecutionPanel from './ExecutionPanel'
import { callTool } from '../lib/mcpClient'

// -----------------------------------------------------------------------------
// Quick-request pills — one-click shortcuts for the most common resources
// -----------------------------------------------------------------------------

const QUICK_REQUESTS = [
  'Create an EC2 t3.micro instance with a security group',
  'Create an S3 bucket with versioning enabled',
  'Create an RDS MySQL db.t3.micro instance',
  'Create a VPC with public and private subnets',
  'Create an IAM role for EC2 with S3 read access',
]

// -----------------------------------------------------------------------------
// ValidationBadge — shows pass/fail result from terraform validate
// -----------------------------------------------------------------------------

function ValidationBadge({ validation }) {
  if (!validation) return null

  const valid = validation.valid
  return (
    <span style={{
      display:         'inline-flex',
      alignItems:      'center',
      gap:             '6px',
      padding:         '4px 12px',
      borderRadius:    '999px',
      fontSize:        '0.85rem',
      fontWeight:      'bold',
      backgroundColor: valid ? '#e6f9ec' : '#fff0f0',
      color:           valid ? '#1a7a3a' : '#cc0000',
      border:          `1px solid ${valid ? '#5acd80' : '#ff4444'}`,
    }}>
      {valid ? '✅ Valid' : '❌ Invalid'}
      {!valid && (
        <span style={{ fontWeight: 'normal', fontSize: '0.8rem' }}>
          — {validation.message}
        </span>
      )}
    </span>
  )
}

// =============================================================================
// Main component
// =============================================================================

export default function TerraformPanel({ prefill = '' }) {

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [customRequest, setCustomRequest] = useState('')    // Text input value
  const [hcl,           setHcl]           = useState('')    // Generated HCL
  const [validation,    setValidation]    = useState(null)  // {valid, message}
  const [resourceType,  setResourceType]  = useState('')    // e.g. "aws_instance"
  const [description,   setDescription]  = useState('')    // One-liner from LLM
  const [loading,       setLoading]       = useState(false) // True while generating
  const [error,         setError]         = useState(null)  // Error message or null
  const [copied,         setCopied]        = useState(false) // Clipboard flash state
  const [showExecution,  setShowExecution] = useState(false) // Show ExecutionPanel below HCL

  // Tracks the last request sent so the Retry button can replay it.
  const currentRequestRef = useRef('')

  const { keys } = useApiKeys()

  // When the parent passes a new prefill (from "Fix This →" in SecurityPanel),
  // populate the custom request input so the user can review before generating.
  useEffect(() => {
    if (prefill) {
      setCustomRequest(prefill)
      // Clear any previous generation results so the panel looks fresh.
      setHcl('')
      setValidation(null)
      setResourceType('')
      setDescription('')
      setError(null)
    }
  }, [prefill])

  // ---------------------------------------------------------------------------
  // generateHcl — sends the request to POST /terraform/generate
  // ---------------------------------------------------------------------------

  async function generateHcl(request) {
    if (!request.trim() || loading) return

    currentRequestRef.current = request
    setLoading(true)
    setError(null)
    setHcl('')
    setValidation(null)
    setResourceType('')
    setDescription('')

    try {
      const resolvedKey = keys.model === 'anthropic' ? keys.anthropic : keys.groq

      const data = await callTool('generate_terraform_from_request', {
        request: request.trim(),
        model:   keys.model || 'groq',
        api_key: resolvedKey || '',
      })

      if (data.error) {
        setError(data.error)
        return
      }

      setHcl(data.hcl            || '')
      setValidation(data.validation || null)
      setResourceType(data.resource_type || '')
      setDescription(data.description   || '')
      toast.success('Terraform HCL generated')

    } catch (err) {
      setError(err.message || 'Failed to generate Terraform.')
      toast.error(err.message || 'Terraform generation failed')
    } finally {
      setLoading(false)
    }
  }

  // ---------------------------------------------------------------------------
  // copyToClipboard — copies HCL and flashes "Copied!" for 1.5s
  // ---------------------------------------------------------------------------

  function copyToClipboard() {
    if (!hcl) return
    navigator.clipboard.writeText(hcl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      toast.success('Copied to clipboard')
    })
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div style={{ fontFamily: 'sans-serif' }}>

      {/* -------------------------------------------------------------------- */}
      {/* Header                                                                */}
      {/* -------------------------------------------------------------------- */}
      <h2 style={{ margin: '0 0 16px 0', fontSize: '1.4rem' }}>
        🏗️ Terraform Generator
      </h2>

      {/* Read-only model indicator */}
      <div style={{ fontSize: '12px', color: '#888', marginBottom: '12px' }}>
        Model:{' '}
        {keys.model === 'groq'      ? '☁️ Groq'
        : keys.model === 'anthropic' ? '🧠 Anthropic'
        :                              '🖥️ Ollama'}
        &nbsp;·&nbsp;
        {(keys.model === 'anthropic' ? keys.anthropic : keys.groq)
          ? '🔑 Custom key' : '🔑 Server key'}
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* Quick-request pills                                                   */}
      {/* -------------------------------------------------------------------- */}
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '0.85rem', color: '#555', marginBottom: '8px' }}>
          Quick requests:
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {QUICK_REQUESTS.map((req, i) => (
            <button
              key={i}
              onClick={() => generateHcl(req)}
              disabled={loading}
              style={{
                padding:         '6px 14px',
                fontSize:        '0.82rem',
                backgroundColor: loading ? '#f0f0f0' : '#eef2ff',
                color:           loading ? '#aaa'    : '#3730a3',
                border:          '1px solid #c7d2fe',
                borderRadius:    '999px',
                cursor:          loading ? 'not-allowed' : 'pointer',
                whiteSpace:      'nowrap',
              }}
            >
              {req}
            </button>
          ))}
        </div>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* Custom request input                                                  */}
      {/* -------------------------------------------------------------------- */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <input
          type="text"
          value={customRequest}
          onChange={e => setCustomRequest(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && generateHcl(customRequest)}
          placeholder="Or describe what you want to create..."
          disabled={loading}
          style={{
            flex:         1,
            padding:      '10px 14px',
            fontSize:     '0.9rem',
            border:       '1px solid #ccc',
            borderRadius: '8px',
            fontFamily:   'sans-serif',
          }}
        />
        <button
          onClick={() => generateHcl(customRequest)}
          disabled={loading || !customRequest.trim()}
          style={{
            padding:         '10px 20px',
            fontSize:        '0.9rem',
            backgroundColor: (loading || !customRequest.trim()) ? '#ccc' : '#2563eb',
            color:           'white',
            border:          'none',
            borderRadius:    '8px',
            cursor:          (loading || !customRequest.trim()) ? 'not-allowed' : 'pointer',
            fontWeight:      'bold',
            whiteSpace:      'nowrap',
          }}
        >
          {loading ? 'Generating...' : 'Generate'}
        </button>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* Loading skeleton — code-block sized rectangle while generating       */}
      {/* -------------------------------------------------------------------- */}
      {loading && (
        <div
          style={{
            height:      '150px',
            width:       '100%',
            borderRadius:'8px',
            background:  'rgba(128,128,128,0.15)',
            animation:   'skeleton-pulse 1.5s ease-in-out infinite',
            marginBottom:'16px',
          }}
        />
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
          fontSize:       '0.9rem',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          gap:            '12px',
        }}>
          <span>{error}</span>
          <button
            onClick={() => { setError(null); generateHcl(currentRequestRef.current) }}
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
      {/* Results — only shown after a successful generation                   */}
      {/* -------------------------------------------------------------------- */}
      {hcl && !loading && (
        <>
          {/* Meta row: resource type, description, validation badge */}
          <div style={{ marginBottom: '12px' }}>
            <div style={{
              display:      'flex',
              alignItems:   'center',
              gap:          '12px',
              flexWrap:     'wrap',
              marginBottom: '6px',
            }}>
              {resourceType && (
                <span style={{
                  fontSize:        '0.82rem',
                  fontFamily:      'monospace',
                  backgroundColor: '#f0f4ff',
                  border:          '1px solid #c7d2fe',
                  borderRadius:    '4px',
                  padding:         '2px 8px',
                  color:           '#3730a3',
                }}>
                  {resourceType}
                </span>
              )}
              <ValidationBadge validation={validation} />
            </div>
            {description && (
              <div style={{ fontSize: '0.9rem', color: '#555' }}>
                {description}
              </div>
            )}
          </div>

          {/* Naming note */}
          <div style={{
            fontSize:        '0.8rem',
            color:           '#666',
            backgroundColor: '#fffbea',
            border:          '1px solid #fde68a',
            borderRadius:    '6px',
            padding:         '8px 12px',
            marginBottom:    '12px',
          }}>
            💡 Resources use a <code>name_prefix</code> variable (default: <code>"demo"</code>).
            Change it to avoid naming conflicts in your AWS account.
          </div>

          {/* HCL code block + copy button */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={copyToClipboard}
              style={{
                position:        'absolute',
                top:             '10px',
                right:           '10px',
                padding:         '4px 12px',
                fontSize:        '0.78rem',
                backgroundColor: copied ? '#22c55e' : '#f0f0f0',
                color:           copied ? 'white'   : '#333',
                border:          '1px solid #ccc',
                borderRadius:    '6px',
                cursor:          'pointer',
                fontWeight:      'bold',
                transition:      'background-color 0.2s',
              }}
            >
              {copied ? '✓ Copied!' : 'Copy'}
            </button>

            <pre style={{
              backgroundColor: '#1e1e2e',
              color:           '#cdd6f4',
              borderRadius:    '8px',
              padding:         '16px 16px 16px 16px',
              overflowX:       'auto',
              fontSize:        '0.82rem',
              lineHeight:      '1.6',
              margin:          0,
              fontFamily:      '"Fira Code", "Cascadia Code", monospace',
              maxHeight:       '400px',
              overflowY:       'auto',
              whiteSpace:      'pre',
            }}>
              {hcl}
            </pre>
          </div>

          {/* ---------------------------------------------------------------- */}
          {/* Run Plan & Deploy button — opens ExecutionPanel below            */}
          {/* ---------------------------------------------------------------- */}
          {!showExecution && (
            <button
              onClick={() => setShowExecution(true)}
              style={{
                width:           '100%',
                marginTop:       '16px',
                padding:         '12px',
                backgroundColor: '#22aa44',
                color:           'white',
                border:          'none',
                borderRadius:    '8px',
                cursor:          'pointer',
                fontSize:        '0.95rem',
                fontWeight:      'bold',
              }}
            >
              🚀 Run Plan &amp; Deploy
            </button>
          )}

          {/* ExecutionPanel — rendered inline when Run Plan is clicked */}
          {showExecution && (
            <ExecutionPanel
              hclConfig={hcl}
              description={description || customRequest}
              onClose={() => setShowExecution(false)}
            />
          )}
        </>
      )}
    </div>
  )
}
