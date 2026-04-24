// =============================================================================
// ApiKeySettings.jsx — Two-tab settings modal
//
// Tab 1 — Cloud Credentials: AWS Access Key ID, Secret Key, Region
// Tab 2 — LLM Keys: Groq key, Anthropic key, Ollama URL, Default model
//
// Same draft pattern as before — edits stay local until "Save" is clicked.
// All values persist to localStorage via ApiKeyContext.
// =============================================================================

import { useState }    from 'react'
import { useApiKeys }  from '../context/ApiKeyContext'

const TABS = ['Cloud Credentials', 'LLM Keys']

const AWS_REGIONS = [
  'us-east-1',
  'eu-west-1',
  'ap-southeast-1',
  'ap-southeast-2',
]

export default function ApiKeySettings({ onClose }) {

  const { keys, setKey, setModel, clearAllKeys, hasKey } = useApiKeys()

  // Active tab: 0 = Cloud Credentials, 1 = LLM Keys
  const [activeTab, setActiveTab] = useState(0)

  // Draft state — local copy that only propagates to Context on Save.
  const [draft, setDraft] = useState({
    // Cloud Credentials
    awsAccessKeyId: keys.awsAccessKeyId ?? '',
    awsSecretKey:   keys.awsSecretKey   ?? '',
    awsRegion:      keys.awsRegion      ?? 'us-east-1',
    // LLM Keys
    groq:           keys.groq      ?? '',
    anthropic:      keys.anthropic ?? '',
    ollamaUrl:      keys.ollamaUrl ?? '',
    model:          keys.model     ?? 'groq',
  })

  const [saved, setSaved] = useState(false)

  // ---------------------------------------------------------------------------
  // handleSave — commit all draft fields to Context then close
  // ---------------------------------------------------------------------------

  function handleSave() {
    // Cloud creds
    setKey('awsAccessKeyId', draft.awsAccessKeyId)
    setKey('awsSecretKey',   draft.awsSecretKey)
    setKey('awsRegion',      draft.awsRegion)
    // LLM keys
    setKey('groq',      draft.groq)
    setKey('anthropic', draft.anthropic)
    setKey('ollamaUrl', draft.ollamaUrl)
    setModel(draft.model)

    setSaved(true)
    setTimeout(() => {
      setSaved(false)
      onClose?.()
    }, 1200)
  }

  // ---------------------------------------------------------------------------
  // handleClear — reset everything back to defaults
  // ---------------------------------------------------------------------------

  function handleClear() {
    clearAllKeys()
    setDraft({
      awsAccessKeyId: '',
      awsSecretKey:   '',
      awsRegion:      'us-east-1',
      groq:           '',
      anthropic:      '',
      ollamaUrl:      '',
      model:          'groq',
    })
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const inputStyle = {
    width:      '100%',
    boxSizing:  'border-box',
    padding:    '8px 12px',
    borderRadius: '8px',
    border:     '1px solid #ccc',
    fontSize:   '14px',
    marginTop:  '6px',
  }

  const labelStyle = {
    fontSize:   '13px',
    fontWeight: 'bold',
    color:      '#333',
  }

  const helperStyle = {
    fontSize:  '11px',
    color:     '#999',
    marginTop: '4px',
  }

  const sectionStyle = { marginBottom: '18px' }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    // Overlay — click outside to close
    <div
      onClick={onClose}
      style={{
        position:       'fixed',
        top: 0, left: 0,
        width:          '100vw',
        height:         '100vh',
        background:     'rgba(0,0,0,0.55)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        zIndex:         1000,
      }}
    >
      {/* Modal card — stopPropagation prevents accidental dismiss */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background:    'white',
          borderRadius:  '16px',
          padding:       '2rem',
          width:         '480px',
          maxWidth:      '92vw',
          maxHeight:     '90vh',
          overflowY:     'auto',
        }}
      >
        {/* ------------------------------------------------------------------ */}
        {/* Header                                                               */}
        {/* ------------------------------------------------------------------ */}
        <div style={{
          display:        'flex',
          justifyContent: 'space-between',
          alignItems:     'center',
          marginBottom:   '20px',
        }}>
          <span style={{ fontSize: '18px', fontWeight: 'bold' }}>
            🔑 Settings
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none',
              fontSize: '20px', cursor: 'pointer',
              color: '#888', lineHeight: 1, padding: '0 4px',
            }}
          >
            ✕
          </button>
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* Tab bar                                                              */}
        {/* ------------------------------------------------------------------ */}
        <div style={{
          display:      'flex',
          borderBottom: '1px solid #e5e7eb',
          marginBottom: '20px',
          gap:          '0',
        }}>
          {TABS.map((tab, i) => (
            <button
              key={tab}
              onClick={() => setActiveTab(i)}
              style={{
                flex:            1,
                padding:         '9px 0',
                border:          'none',
                borderBottom:    activeTab === i ? '2px solid #2563eb' : '2px solid transparent',
                background:      'none',
                cursor:          'pointer',
                fontWeight:      activeTab === i ? '600' : '400',
                color:           activeTab === i ? '#2563eb' : '#6b7280',
                fontSize:        '14px',
                transition:      'color 0.15s',
              }}
            >
              {i === 0 ? '☁️ ' : '🤖 '}{tab}
            </button>
          ))}
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* Tab 0 — Cloud Credentials                                           */}
        {/* ------------------------------------------------------------------ */}
        {activeTab === 0 && (
          <div>
            <div style={{
              background: '#f0f9ff',
              border:     '1px solid #bae6fd',
              borderRadius: '8px',
              padding:    '0.7rem 1rem',
              fontSize:   '13px',
              color:      '#0369a1',
              marginBottom: '18px',
            }}>
              💡 AWS credentials are optional — if left blank, the backend uses
              the credentials configured in <code style={{ background: '#e0f2fe', padding: '1px 5px', borderRadius: '3px' }}>~/.aws/credentials</code>.
            </div>

            {/* AWS Access Key ID */}
            <div style={sectionStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={labelStyle}>AWS Access Key ID</span>
                {keys.awsAccessKeyId?.trim() && (
                  <span style={{ fontSize: '11px', color: '#22aa44' }}>✅ Saved</span>
                )}
              </div>
              <input
                type="password"
                value={draft.awsAccessKeyId}
                onChange={e => setDraft(p => ({ ...p, awsAccessKeyId: e.target.value }))}
                placeholder="AKIA..."
                style={inputStyle}
              />
              <div style={helperStyle}>From IAM → Security credentials</div>
            </div>

            {/* AWS Secret Access Key */}
            <div style={sectionStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={labelStyle}>AWS Secret Access Key</span>
                {keys.awsSecretKey?.trim() && (
                  <span style={{ fontSize: '11px', color: '#22aa44' }}>✅ Saved</span>
                )}
              </div>
              <input
                type="password"
                value={draft.awsSecretKey}
                onChange={e => setDraft(p => ({ ...p, awsSecretKey: e.target.value }))}
                placeholder="Secret key..."
                style={inputStyle}
              />
            </div>

            {/* AWS Region */}
            <div style={sectionStyle}>
              <div style={labelStyle}>AWS Region</div>
              <select
                value={draft.awsRegion}
                onChange={e => setDraft(p => ({ ...p, awsRegion: e.target.value }))}
                style={{ ...inputStyle, cursor: 'pointer' }}
              >
                {AWS_REGIONS.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              <div style={helperStyle}>Region used for EC2, SG, and VPC scans</div>
            </div>
          </div>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Tab 1 — LLM Keys                                                    */}
        {/* ------------------------------------------------------------------ */}
        {activeTab === 1 && (
          <div>
            <div style={{
              background: '#f0f8ff',
              border:     '1px solid #b3d9ff',
              borderRadius: '8px',
              padding:    '0.7rem 1rem',
              fontSize:   '13px',
              color:      '#005fa3',
              marginBottom: '18px',
            }}>
              💾 Keys are saved in your browser and persist across page refreshes.
              They are never sent anywhere except the LLM provider you choose.
            </div>

            {/* Default Model */}
            <div style={sectionStyle}>
              <div style={labelStyle}>Default Model</div>
              <select
                value={draft.model}
                onChange={e => setDraft(p => ({ ...p, model: e.target.value }))}
                style={{ ...inputStyle, cursor: 'pointer' }}
              >
                <option value="groq">☁️ Groq — llama3-8b (Cloud · Fast · Free)</option>
                <option value="anthropic">🧠 Anthropic — claude-haiku (Cloud · Powerful)</option>
                <option value="ollama">🖥️ Ollama — local (Private · No key)</option>
              </select>
            </div>

            {/* Groq API Key */}
            <div style={sectionStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={labelStyle}>Groq API Key</span>
                {hasKey('groq') && (
                  <span style={{ fontSize: '11px', color: '#22aa44' }}>✅ Saved</span>
                )}
              </div>
              <input
                type="password"
                value={draft.groq}
                onChange={e => setDraft(p => ({ ...p, groq: e.target.value }))}
                placeholder="gsk_... (blank = use server .env key)"
                style={inputStyle}
              />
              <div style={helperStyle}>Free key at console.groq.com</div>
            </div>

            {/* Anthropic API Key */}
            <div style={sectionStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={labelStyle}>Anthropic API Key</span>
                {hasKey('anthropic') && (
                  <span style={{ fontSize: '11px', color: '#22aa44' }}>✅ Saved</span>
                )}
              </div>
              <input
                type="password"
                value={draft.anthropic}
                onChange={e => setDraft(p => ({ ...p, anthropic: e.target.value }))}
                placeholder="sk-ant-... (blank = use server .env key)"
                style={inputStyle}
              />
              <div style={helperStyle}>Key at console.anthropic.com</div>
            </div>

            {/* Ollama URL */}
            <div style={sectionStyle}>
              <div style={labelStyle}>Ollama URL</div>
              <input
                type="text"
                value={draft.ollamaUrl}
                onChange={e => setDraft(p => ({ ...p, ollamaUrl: e.target.value }))}
                placeholder="http://localhost:11434 (optional)"
                style={inputStyle}
              />
              <div style={helperStyle}>
                Ollama runs locally — no key needed. Start with{' '}
                <code style={{ background: '#eee', padding: '1px 5px', borderRadius: '3px' }}>ollama serve</code>
              </div>
            </div>
          </div>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Action buttons                                                       */}
        {/* ------------------------------------------------------------------ */}
        <div style={{
          display:        'flex',
          justifyContent: 'flex-end',
          gap:            '10px',
          marginTop:      '8px',
          paddingTop:     '16px',
          borderTop:      '1px solid #f0f0f0',
        }}>
          <button
            onClick={handleClear}
            style={{
              padding: '8px 16px', borderRadius: '8px',
              border: '1px solid #ff4444', color: '#ff4444',
              background: 'white', cursor: 'pointer', fontSize: '14px',
            }}
          >
            Clear All
          </button>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px', borderRadius: '8px',
              border: '1px solid #ddd', color: '#555',
              background: 'white', cursor: 'pointer', fontSize: '14px',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            style={{
              padding: '8px 20px', borderRadius: '8px',
              border: 'none',
              background: saved ? '#22aa44' : '#007bff',
              color: 'white', fontWeight: 'bold',
              cursor: 'pointer', fontSize: '14px',
              transition: 'background 0.2s',
            }}
          >
            {saved ? '✅ Saved!' : 'Save'}
          </button>
        </div>

      </div>
    </div>
  )
}
