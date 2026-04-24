// =============================================================================
// mcpClient.js — JavaScript MCP client for the Agentic Cloud Assistant
//
// Speaks the Model Context Protocol (MCP) JSON-RPC 2.0 over HTTP to
// POST /mcp on the FastMCP server.
//
// Usage:
//   import { callTool } from '../lib/mcpClient'
//   const result = await callTool('full_aws_scan', { region: 'us-east-1' })
//
// Protocol flow:
//   1. First call lazily sends an MCP initialize request to negotiate
//      capabilities and receive a session ID.
//   2. Subsequent calls include the Mcp-Session-Id header.
//   3. Each tools/call response is JSON-RPC 2.0:
//        { result: { content: [{ type:'text', text: '{"key":"val"}' }] } }
//      We parse content[0].text as JSON to get the actual tool result.
// =============================================================================

const MCP_ENDPOINT = 'http://localhost:8000/mcp'

// ---------------------------------------------------------------------------
// MCPClient class — manages session lifecycle and JSON-RPC serialisation
// ---------------------------------------------------------------------------

class MCPClient {
  constructor(endpoint) {
    this.endpoint    = endpoint
    this._id         = 0
    this._sessionId  = null
    this._initialized = false
    this._initPromise = null
  }

  // -------------------------------------------------------------------------
  // _ensureInitialized — lazily sends MCP initialize (first call only)
  // -------------------------------------------------------------------------

  async _ensureInitialized() {
    if (this._initialized) return
    if (this._initPromise) return this._initPromise

    this._initPromise = this._doInitialize()
    return this._initPromise
  }

  async _doInitialize() {
    try {
      await this._request({
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'aca-web', version: '1.0.0' },
        },
      })
      // Await the notification so no tool call can race ahead of it
      await this._notify({ method: 'notifications/initialized' })
      this._initialized = true
    } catch (err) {
      this._initPromise = null  // allow retry
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // _notify — one-way message (no id, no response expected)
  // -------------------------------------------------------------------------

  async _notify(message) {
    const headers = { 'Content-Type': 'application/json' }
    if (this._sessionId) headers['Mcp-Session-Id'] = this._sessionId

    await fetch(this.endpoint, {
      method:  'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    }).catch(() => {})
  }

  // -------------------------------------------------------------------------
  // _request — send a JSON-RPC message and return the result object
  // -------------------------------------------------------------------------

  async _request(message) {
    const id      = ++this._id
    const headers = {
      'Content-Type': 'application/json',
      'Accept':       'application/json, text/event-stream',
    }
    if (this._sessionId) headers['Mcp-Session-Id'] = this._sessionId

    const res = await fetch(this.endpoint, {
      method:  'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, ...message }),
    })

    // Capture session ID returned by server
    const sid = res.headers.get('mcp-session-id')
    if (sid) this._sessionId = sid

    const contentType = res.headers.get('content-type') || ''

    let data
    if (contentType.includes('text/event-stream')) {
      data = await this._parseSSE(res, id)
    } else {
      data = await res.json()
    }

    if (data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error))
    }

    return data.result
  }

  // -------------------------------------------------------------------------
  // _parseSSE — read a buffered SSE response and find the matching message
  // -------------------------------------------------------------------------

  async _parseSSE(response, targetId) {
    const text  = await response.text()
    const lines = text.split('\n')

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const msg = JSON.parse(line.slice(6))
        if (msg.id === targetId) return msg
        // Some servers emit events without id — take the first result we see
        if (msg.result !== undefined || msg.error !== undefined) return msg
      } catch {
        // skip malformed lines
      }
    }

    throw new Error('No matching response in SSE stream')
  }

  // -------------------------------------------------------------------------
  // callTool — public API: call a named MCP tool with arguments
  // -------------------------------------------------------------------------

  async callTool(name, args = {}) {
    await this._ensureInitialized()

    const result = await this._request({
      method: 'tools/call',
      params: { name, arguments: args },
    })

    if (!result?.content?.length) {
      throw new Error(`Tool "${name}" returned empty content`)
    }

    const text = result.content[0].text

    if (result.isError) {
      throw new Error(text)
    }

    try {
      return JSON.parse(text)
    } catch {
      // Plain-text response — wrap in an object
      return { text }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton instance — one client, one session, shared across the whole app
// ---------------------------------------------------------------------------

export const mcpClient = new MCPClient(MCP_ENDPOINT)

// ---------------------------------------------------------------------------
// callTool — convenience export used by React components
// ---------------------------------------------------------------------------

export async function callTool(name, args = {}) {
  return mcpClient.callTool(name, args)
}
