// =============================================================================
// Chat.jsx — LLM chat interface for the Agentic Cloud Assistant
//
// This component provides a full chat UI that lets users ask questions
// about their AWS infrastructure in plain English.
//
// Features:
//   - Model selector: Groq, Anthropic, Ollama
//   - Optional API key input (hidden for Ollama, shown for cloud models)
//   - Conversation memory: full history sent on every request
//   - Loading state with "Thinking..." indicator
//   - Clear chat button
//   - Enter to send, Shift+Enter for new line
//
// No external libraries used — only React built-ins (useState).
// All styles are inline — no CSS files or Tailwind required.
// =============================================================================

import { useState } from 'react'
import toast from 'react-hot-toast'
import { useApiKeys } from '../context/ApiKeyContext'
import { callTool } from '../lib/mcpClient'

export default function Chat() {

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [messages,   setMessages]   = useState([])   // Full conversation history
  const [input,      setInput]      = useState('')    // Current text in the input box
  const [loading,    setLoading]    = useState(false) // True while waiting for LLM reply
  const [error,      setError]      = useState(null)  // API/network error string or null

  // Read model and keys from the centralised Context set via the
  // "🔑 API Keys" button in the Dashboard title bar.
  const { keys } = useApiKeys()

  // ---------------------------------------------------------------------------
  // sendMessage — called when user clicks Send or presses Enter
  // ---------------------------------------------------------------------------

  async function sendMessage() {
    // Guard: do nothing if input is blank or a request is already in flight.
    if (!input.trim() || loading) return

    // Capture the message text and clear the input field immediately
    // so the UI feels responsive before the API call completes.
    const userMessage = input.trim()
    setInput('')

    // Add the user's message to the conversation display.
    const updatedMessages = [...messages, { role: 'user', content: userMessage }]
    setMessages(updatedMessages)

    setLoading(true)

    try {
      const history = messages.map(m => ({ role: m.role, content: m.content }))
      const resolvedKey = keys.model === 'anthropic' ? keys.anthropic : keys.groq

      const data = await callTool('aws_chat', {
        message: userMessage,
        model:   keys.model || 'groq',
        api_key: resolvedKey || '',
        history,
      })

      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: data.reply }
      ])

    } catch (err) {
      setMessages(prev => prev.slice(0, -1))
      setInput(userMessage)
      const errMsg = err.message || 'Could not reach the MCP server on port 8000.'
      setError(errMsg)
      toast.error(errMsg)
    } finally {
      setLoading(false)
    }
  }

  // ---------------------------------------------------------------------------
  // handleKeyDown — Enter sends, Shift+Enter adds a new line
  // ---------------------------------------------------------------------------

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()  // Prevent a literal newline being added to the input
      sendMessage()
    }
  }

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  // Read-only display string for the model indicator shown above the chat.
  const resolvedKey = keys.model === 'anthropic' ? keys.anthropic : keys.groq

  // ---------------------------------------------------------------------------
  // Styles — all inline, no external CSS
  // ---------------------------------------------------------------------------

  const styles = {
    container: {
      border:       '1px solid #d0d0d0',
      borderRadius: '12px',
      padding:      '20px',
      marginTop:    '32px',
      backgroundColor: '#fafafa',
      fontFamily:   'sans-serif'
    },
    header: {
      display:        'flex',
      justifyContent: 'space-between',
      alignItems:     'center',
      marginBottom:   '16px'
    },
    title: {
      fontSize:   '18px',
      fontWeight: 'bold',
      color:      '#1a1a1a',
      margin:     0
    },
    clearButton: {
      padding:         '4px 12px',
      fontSize:        '13px',
      backgroundColor: '#f0f0f0',
      border:          '1px solid #ccc',
      borderRadius:    '6px',
      cursor:          'pointer',
      color:           '#555'
    },
    controls: {
      display:       'flex',
      flexDirection: 'column',
      gap:           '10px',
      marginBottom:  '16px'
    },
    select: {
      padding:      '8px 12px',
      fontSize:     '14px',
      borderRadius: '8px',
      border:       '1px solid #ccc',
      backgroundColor: '#fff',
      cursor:       'pointer'
    },
    apiKeyLabel: {
      fontSize:    '12px',
      color:       '#666',
      marginBottom: '4px'
    },
    apiKeyInput: {
      padding:      '8px 12px',
      fontSize:     '14px',
      borderRadius: '8px',
      border:       '1px solid #ccc',
      width:        '100%',
      boxSizing:    'border-box'
    },
    messageWindow: {
      height:       '420px',
      overflowY:    'auto',
      border:       '1px solid #e0e0e0',
      borderRadius: '8px',
      padding:      '12px',
      marginBottom: '12px',
      backgroundColor: '#fff',
      display:      'flex',
      flexDirection: 'column',
      gap:          '10px'
    },
    emptyState: {
      color:      '#aaa',
      fontStyle:  'italic',
      textAlign:  'center',
      marginTop:  '180px',
      fontSize:   '14px'
    },
    thinkingIndicator: {
      color:     '#888',
      fontStyle: 'italic',
      fontSize:  '13px',
      padding:   '4px 0'
    },
    inputRow: {
      display: 'flex',
      gap:     '8px'
    },
    textarea: {
      flex:         1,
      padding:      '10px 14px',
      fontSize:     '14px',
      borderRadius: '8px',
      border:       '1px solid #ccc',
      resize:       'none',
      fontFamily:   'sans-serif',
      lineHeight:   '1.4'
    },
    sendButton: {
      padding:         '10px 20px',
      fontSize:        '14px',
      backgroundColor: loading ? '#ccc' : '#007bff',
      color:           '#fff',
      border:          'none',
      borderRadius:    '8px',
      cursor:          loading ? 'not-allowed' : 'pointer',
      fontWeight:      'bold',
      whiteSpace:      'nowrap'
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div style={styles.container}>

      {/* -------------------------------------------------------------------- */}
      {/* Error banner — shown at top when an API/network error occurs        */}
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
            onClick={() => { setError(null); sendMessage() }}
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

      {/* Header row: title + clear button */}
      <div style={styles.header}>
        <p style={styles.title}>💬 AWS Infrastructure Chat</p>
        {messages.length > 0 && (
          <button style={styles.clearButton} onClick={() => setMessages([])}>
            Clear chat
          </button>
        )}
      </div>

      {/* Read-only model indicator — set via the "🔑 API Keys" button */}
      <div style={{ fontSize: '12px', color: '#888', marginBottom: '8px' }}>
        Model:{' '}
        {keys.model === 'groq'      ? '☁️ Groq (llama3-70b)'
        : keys.model === 'anthropic' ? '🧠 Anthropic (claude-haiku)'
        :                              '🖥️ Ollama (local)'}
        &nbsp;·&nbsp;
        {resolvedKey ? '🔑 Custom key set' : '🔑 Using server key'}
      </div>

      {/* Message display window */}
      <div style={styles.messageWindow}>

        {/* Empty state — shown when no messages yet */}
        {messages.length === 0 && !loading && (
          <p style={styles.emptyState}>
            💬 Ask anything about your AWS infrastructure...
          </p>
        )}

        {/* Render each message bubble */}
        {messages.map((msg, index) => (
          <div
            key={index}
            style={{
              display:        'flex',
              justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start'
            }}
          >
            <div
              style={{
                maxWidth:        '75%',
                padding:         '10px 14px',
                borderRadius:    '12px',
                fontSize:        '14px',
                lineHeight:      '1.5',
                whiteSpace:      'pre-wrap',   // Preserves line breaks in LLM replies
                backgroundColor: msg.role === 'user' ? '#007bff' : '#fff',
                color:           msg.role === 'user' ? '#fff'    : '#1a1a1a',
                border:          msg.role === 'user' ? 'none'    : '1px solid #e0e0e0'
              }}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {/* Thinking indicator — shown while waiting for LLM response */}
        {loading && (
          <p style={styles.thinkingIndicator}>Thinking...</p>
        )}

      </div>

      {/* Input row: textarea + send button */}
      <div style={styles.inputRow}>
        <textarea
          style={styles.textarea}
          rows={2}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about your AWS infrastructure... (Enter to send, Shift+Enter for new line)"
          disabled={loading}
        />
        <button
          style={styles.sendButton}
          onClick={sendMessage}
          disabled={loading}
        >
          {loading ? 'Sending...' : 'Send'}
        </button>
      </div>

    </div>
  )
}
