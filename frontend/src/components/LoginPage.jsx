// =============================================================================
// LoginPage.jsx — Frontend-only login screen for Agentic Cloud Assistant
//
// No backend call — credentials are validated locally in AuthContext.
// On success: navigate to / (Dashboard, protected by ProtectedRoute)
// On failure: show inline error without clearing the input fields
// =============================================================================

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function LoginPage() {

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  const { login }  = useAuth()
  const navigate   = useNavigate()

  // ---------------------------------------------------------------------------
  // handleSubmit — validate and navigate, or surface error
  // ---------------------------------------------------------------------------

  function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)

    // Small timeout gives a brief "working" feel and lets the button state
    // render before the synchronous credential check runs.
    setTimeout(() => {
      const ok = login(username.trim(), password)
      if (ok) {
        navigate('/', { replace: true })
      } else {
        setError('Invalid credentials')
        setLoading(false)
      }
    }, 200)
  }

  // ---------------------------------------------------------------------------
  // Styles — all inline, no external CSS dependency
  // ---------------------------------------------------------------------------

  const pageStyle = {
    minHeight:       '100vh',
    backgroundColor: '#0f172a',
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    fontFamily:      'system-ui, -apple-system, sans-serif',
  }

  const cardStyle = {
    background:    'white',
    borderRadius:  '16px',
    padding:       '2.5rem 2rem',
    width:         '380px',
    maxWidth:      '90vw',
    boxShadow:     '0 20px 60px rgba(0,0,0,0.4)',
  }

  const inputStyle = {
    width:         '100%',
    boxSizing:     'border-box',
    padding:       '10px 14px',
    borderRadius:  '8px',
    border:        '1px solid #d1d5db',
    fontSize:      '15px',
    outline:       'none',
    marginTop:     '6px',
    transition:    'border-color 0.15s',
  }

  const labelStyle = {
    display:    'block',
    fontSize:   '13px',
    fontWeight: '600',
    color:      '#374151',
  }

  const btnStyle = {
    width:           '100%',
    padding:         '11px',
    borderRadius:    '8px',
    border:          'none',
    background:      loading ? '#93c5fd' : '#2563eb',
    color:           'white',
    fontWeight:      'bold',
    fontSize:        '15px',
    cursor:          loading ? 'not-allowed' : 'pointer',
    marginTop:       '24px',
    transition:      'background 0.2s',
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>

        {/* Brand header */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>🤖</div>
          <h1 style={{
            margin:     0,
            fontSize:   '1.4rem',
            fontWeight: 'bold',
            color:      '#111827',
          }}>
            Agentic Cloud Assistant
          </h1>
          <p style={{
            margin:    '6px 0 0',
            fontSize:  '13px',
            color:     '#6b7280',
          }}>
            AWS Infrastructure Management
          </p>
        </div>

        {/* Login form */}
        <form onSubmit={handleSubmit} noValidate>

          {/* Username */}
          <div style={{ marginBottom: '16px' }}>
            <label style={labelStyle}>Username</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="Enter username"
              autoComplete="username"
              autoFocus
              required
              style={inputStyle}
            />
          </div>

          {/* Password */}
          <div style={{ marginBottom: '4px' }}>
            <label style={labelStyle}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Enter password"
              autoComplete="current-password"
              required
              style={inputStyle}
            />
          </div>

          {/* Inline error */}
          {error && (
            <div style={{
              marginTop:   '10px',
              padding:     '8px 12px',
              borderRadius: '6px',
              background:  '#fef2f2',
              border:      '1px solid #fca5a5',
              color:       '#dc2626',
              fontSize:    '13px',
            }}>
              {error}
            </div>
          )}

          {/* Submit */}
          <button type="submit" disabled={loading} style={btnStyle}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>

        </form>

        {/* Hint */}
        <p style={{
          textAlign:  'center',
          marginTop:  '16px',
          fontSize:   '12px',
          color:      '#9ca3af',
        }}>
          Demo: admin / demo2024
        </p>

      </div>
    </div>
  )
}
