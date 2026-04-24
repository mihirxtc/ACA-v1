// =============================================================================
// KnowledgeBasePanel.jsx — RAG knowledge base UI for the Agentic Cloud Assistant
//
// Two tabs:
//   Query          — ask a security question, get an LLM answer grounded in
//                    retrieved documentation with source attribution
//   Manage Docs    — upload PDF/text files, paste raw text, list and delete
//                    all documents currently in ChromaDB
//
// API calls:
//   POST   /rag/query                 — retrieve + answer
//   POST   /rag/documents/upload      — multipart file upload
//   POST   /rag/documents/text        — JSON text ingest
//   GET    /rag/documents             — list all documents
//   DELETE /rag/documents/{doc_id}    — remove a document
//
// Follows identical state / fetch / error patterns to CostPanel and SecurityPanel.
// All styles are inline — no CSS files or Tailwind.
// =============================================================================

import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { useApiKeys } from '../context/ApiKeyContext'
import { callTool } from '../lib/mcpClient'


// -----------------------------------------------------------------------------
// Resource type options — reused in Query filter dropdown and upload forms
// -----------------------------------------------------------------------------

const RESOURCE_OPTIONS = [
  { value: 'ec2',       label: 'EC2' },
  { value: 's3',        label: 'S3' },
  { value: 'iam',       label: 'IAM' },
  { value: 'vpc',       label: 'VPC' },
  { value: 'terraform', label: 'Terraform' },
  { value: 'general',   label: 'General' },
]

// Query tab also has an "All Types" blank option at the top
const FILTER_OPTIONS = [{ value: '', label: 'All Types' }, ...RESOURCE_OPTIONS]


// -----------------------------------------------------------------------------
// Helper — colour for a relevance score pill
// -----------------------------------------------------------------------------

function scoreColour(score) {
  if (score >= 0.7) return '#22c55e'   // green
  if (score >= 0.4) return '#f59e0b'   // amber
  return '#ef4444'                      // red
}


// =============================================================================
// Main component
// =============================================================================

export default function KnowledgeBasePanel() {

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [activeTab,          setActiveTab]          = useState('query')
  const [query,              setQuery]              = useState('')
  const [resourceFilter,     setResourceFilter]     = useState('')
  const [queryLoading,       setQueryLoading]       = useState(false)
  const [queryResult,        setQueryResult]        = useState(null)
  const [documents,          setDocuments]          = useState([])
  const [docsLoading,        setDocsLoading]        = useState(false)
  const [uploadFile,         setUploadFile]         = useState(null)
  const [uploadDocId,        setUploadDocId]        = useState('')
  const [uploadResourceType, setUploadResourceType] = useState('general')
  const [uploadLoading,      setUploadLoading]      = useState(false)
  const [textDocId,          setTextDocId]          = useState('')
  const [textContent,        setTextContent]        = useState('')
  const [textResourceType,   setTextResourceType]   = useState('general')
  const [error,              setError]              = useState(null)
  const [chunksExpanded,     setChunksExpanded]     = useState(false)

  // Read credentials from centralised Context — same pattern as CostPanel
  const { keys } = useApiKeys()

  // Load document list once when the panel mounts
  useEffect(() => {
    fetchDocuments()
  }, [])


  // ---------------------------------------------------------------------------
  // fetchDocuments — GET /rag/documents
  // ---------------------------------------------------------------------------

  async function fetchDocuments() {
    setDocsLoading(true)

    try {
      const data = await callTool('rag_list_documents')
      setDocuments(data.documents || [])
    } catch (err) {
      toast.error(err.message || 'Failed to load documents')
    } finally {
      setDocsLoading(false)
    }
  }


  // ---------------------------------------------------------------------------
  // handleQuery — POST /rag/query
  // ---------------------------------------------------------------------------

  async function handleQuery() {
    if (!query.trim()) return

    setQueryLoading(true)
    setError(null)
    setQueryResult(null)
    setChunksExpanded(false)

    try {
      const args = {
        question:  query,
        n_results: 3,
        groq_key:  keys.groq || '',
      }
      if (resourceFilter) args.resource_type = resourceFilter

      const data = await callTool('rag_query_tool', args)
      setQueryResult(data)
      toast.success('Knowledge base searched')

    } catch (err) {
      setError(err.message || 'Query failed.')
      toast.error(err.message || 'Query failed')
    } finally {
      setQueryLoading(false)
    }
  }


  // ---------------------------------------------------------------------------
  // handleFileUpload — POST /rag/documents/upload  (multipart FormData)
  // ---------------------------------------------------------------------------

  async function handleFileUpload() {
    if (!uploadFile || !uploadDocId.trim()) return

    setUploadLoading(true)

    try {
      // Read as raw bytes then base64-encode so the MCP tool can handle
      // both plain text and binary PDFs identically over JSON.
      const arrayBuffer = await uploadFile.arrayBuffer()
      const bytes = new Uint8Array(arrayBuffer)
      let binary = ''
      const chunkSize = 8192
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
      }
      const base64 = btoa(binary)

      const data = await callTool('rag_upload_file', {
        doc_id:               uploadDocId,
        file_content_base64:  base64,
        filename:             uploadFile.name,
        resource_type:        uploadResourceType,
      })

      if (data.error) throw new Error(data.error)
      toast.success(`Added as ${data.chunks_added} chunk(s)`)
      setUploadFile(null)
      setUploadDocId('')
      await fetchDocuments()

    } catch (err) {
      toast.error(err.message || 'Upload failed')
    } finally {
      setUploadLoading(false)
    }
  }


  // ---------------------------------------------------------------------------
  // handleTextIngest — POST /rag/documents/text  (JSON body)
  // ---------------------------------------------------------------------------

  async function handleTextIngest() {
    if (!textDocId.trim() || !textContent.trim()) return

    try {
      const data = await callTool('rag_add_text_document', {
        doc_id:        textDocId,
        text:          textContent,
        resource_type: textResourceType,
      })

      toast.success(`Added as ${data.chunks_added} chunk(s)`)
      setTextDocId('')
      setTextContent('')
      await fetchDocuments()

    } catch (err) {
      toast.error(err.message || 'Failed to add document')
    }
  }


  // ---------------------------------------------------------------------------
  // handleDelete — DELETE /rag/documents/{doc_id}
  // ---------------------------------------------------------------------------

  async function handleDelete(docId) {
    try {
      const data = await callTool('rag_delete_document', { doc_id: docId })

      if (!data.deleted) throw new Error(data.message || 'Delete failed')
      toast.success(`Deleted "${docId}"`)
      await fetchDocuments()

    } catch (err) {
      toast.error(err.message || 'Delete failed')
    }
  }


  // ---------------------------------------------------------------------------
  // Shared sub-styles
  // ---------------------------------------------------------------------------

  const inputStyle = {
    padding:      '7px 10px',
    border:       '1px solid #ccc',
    borderRadius: '5px',
    fontSize:     '0.88rem',
    width:        '100%',
    boxSizing:    'border-box',
  }

  const selectStyle = {
    ...inputStyle,
    backgroundColor: 'white',
    cursor:          'pointer',
  }

  const primaryBtn = (disabled) => ({
    padding:         '8px 18px',
    backgroundColor: disabled ? '#90b0e0' : '#2563eb',
    color:           'white',
    border:          'none',
    borderRadius:    '6px',
    cursor:          disabled ? 'not-allowed' : 'pointer',
    fontWeight:      'bold',
    fontSize:        '0.9rem',
    whiteSpace:      'nowrap',
  })

  const sectionHeadingStyle = {
    margin:       '0 0 12px 0',
    fontSize:     '0.95rem',
    fontWeight:   'bold',
    color:        '#333',
    paddingBottom:'6px',
    borderBottom: '1px solid #eee',
  }


  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div style={{ fontFamily: 'sans-serif' }}>

      {/* -------------------------------------------------------------------- */}
      {/* Panel heading                                                         */}
      {/* -------------------------------------------------------------------- */}
      <h2 style={{ margin: '0 0 16px 0', fontSize: '1.4rem' }}>
        📚 Knowledge Base
      </h2>

      {/* -------------------------------------------------------------------- */}
      {/* Tab bar                                                               */}
      {/* -------------------------------------------------------------------- */}
      <div style={{
        display:      'flex',
        gap:          '2px',
        marginBottom: '20px',
        borderBottom: '2px solid #e0e0e0',
      }}>
        {[
          { id: 'query',  label: '🔍 Query' },
          { id: 'manage', label: '📂 Manage Documents' },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding:         '8px 20px',
              border:          'none',
              borderRadius:    '6px 6px 0 0',
              cursor:          'pointer',
              fontWeight:      activeTab === tab.id ? 'bold' : 'normal',
              backgroundColor: activeTab === tab.id ? '#2563eb' : 'transparent',
              color:           activeTab === tab.id ? 'white' : '#555',
              fontSize:        '0.9rem',
              transition:      'background-color 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>


      {/* ==================================================================== */}
      {/* TAB 1 — QUERY                                                        */}
      {/* ==================================================================== */}
      {activeTab === 'query' && (
        <div>
          <h3 style={{ margin: '0 0 4px 0', fontSize: '1rem' }}>
            Knowledge Base Query
          </h3>
          <p style={{ margin: '0 0 16px 0', color: '#666', fontSize: '0.88rem' }}>
            Answers grounded in curated AWS security documentation
          </p>

          {/* ---------------------------------------------------------------- */}
          {/* Input row                                                         */}
          {/* ---------------------------------------------------------------- */}
          <div style={{
            display:   'flex',
            gap:       '8px',
            flexWrap:  'wrap',
            marginBottom: '14px',
            alignItems: 'center',
          }}>
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleQuery()}
              placeholder="e.g. How do I secure an S3 bucket?"
              style={{ ...inputStyle, flex: '1', minWidth: '200px' }}
            />

            <select
              value={resourceFilter}
              onChange={e => setResourceFilter(e.target.value)}
              style={{ ...selectStyle, width: 'auto' }}
            >
              {FILTER_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>

            <button
              onClick={handleQuery}
              disabled={queryLoading || !query.trim()}
              style={primaryBtn(queryLoading || !query.trim())}
            >
              {queryLoading ? 'Searching...' : 'Search Knowledge Base'}
            </button>
          </div>

          {/* ---------------------------------------------------------------- */}
          {/* Loading skeleton — same pattern as CostPanel                     */}
          {/* ---------------------------------------------------------------- */}
          {queryLoading && (
            <div style={{
              height:       '80px',
              width:        '100%',
              borderRadius: '8px',
              background:   'rgba(128,128,128,0.15)',
              animation:    'skeleton-pulse 1.5s ease-in-out infinite',
              marginBottom: '12px',
            }} />
          )}

          {/* ---------------------------------------------------------------- */}
          {/* Error state — same pattern as CostPanel / SecurityPanel          */}
          {/* ---------------------------------------------------------------- */}
          {error && !queryLoading && (
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
                onClick={() => { setError(null); handleQuery() }}
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

          {/* ---------------------------------------------------------------- */}
          {/* Result display                                                    */}
          {/* ---------------------------------------------------------------- */}
          {queryResult && !queryLoading && (
            <div>

              {/* Answer box */}
              <div style={{
                backgroundColor: '#f8f8f8',
                border:          '1px solid #e0e0e0',
                borderRadius:    '8px',
                padding:         '1rem',
                marginBottom:    '12px',
              }}>
                <div style={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '0.9rem' }}>
                  🤖 Answer
                </div>
                <p style={{
                  margin:     0,
                  lineHeight: '1.65',
                  fontSize:   '0.88rem',
                  whiteSpace: 'pre-wrap',
                  color:      '#222',
                }}>
                  {queryResult.answer}
                </p>
              </div>

              {/* Source chips row */}
              <div style={{
                display:    'flex',
                flexWrap:   'wrap',
                gap:        '6px',
                alignItems: 'center',
                marginBottom: '6px',
              }}>
                <span style={{ fontSize: '0.8rem', color: '#666' }}>Sources:</span>
                {(queryResult.sources || []).map(src => (
                  <span key={src} style={{
                    backgroundColor: '#f0f0f0',
                    border:          '1px solid #ddd',
                    borderRadius:    '4px',
                    padding:         '2px 8px',
                    fontSize:        '0.76rem',
                    color:           '#444',
                    fontFamily:      'monospace',
                  }}>
                    {src}
                  </span>
                ))}
              </div>

              {/* Stats line */}
              <div style={{ fontSize: '0.79rem', color: '#888', marginBottom: '12px' }}>
                Retrieved {queryResult.chunks_used} chunk(s) from{' '}
                {(queryResult.sources || []).length} source(s)
              </div>

              {/* Collapsible chunk viewer */}
              <div>
                <button
                  onClick={() => setChunksExpanded(prev => !prev)}
                  style={{
                    background:    'none',
                    border:        '1px solid #ccc',
                    borderRadius:  '4px',
                    padding:       '4px 12px',
                    cursor:        'pointer',
                    fontSize:      '0.82rem',
                    color:         '#555',
                    marginBottom:  chunksExpanded ? '10px' : '0',
                    display:       'inline-block',
                  }}
                >
                  {chunksExpanded ? '▲ Hide retrieved chunks' : '▼ View retrieved chunks'}
                </button>

                {chunksExpanded && (queryResult.raw_chunks || []).map((chunk, i) => {
                  const score  = chunk.relevance_score
                  const colour = scoreColour(score)
                  return (
                    <div key={i} style={{
                      border:          `1px solid #e8e8e8`,
                      borderLeft:      `4px solid ${colour}`,
                      borderRadius:    '6px',
                      padding:         '10px 14px',
                      marginBottom:    '8px',
                      backgroundColor: '#fafafa',
                    }}>
                      {/* Chunk header row */}
                      <div style={{
                        display:        'flex',
                        justifyContent: 'space-between',
                        alignItems:     'center',
                        marginBottom:   '6px',
                      }}>
                        <span style={{ fontSize: '0.78rem', color: '#666', fontFamily: 'monospace' }}>
                          {chunk.metadata?.doc_id ?? 'unknown'}
                          {' · chunk '}
                          {chunk.metadata?.chunk_index ?? i}
                        </span>

                        {/* Relevance score pill */}
                        <span style={{
                          backgroundColor: colour,
                          color:           'white',
                          borderRadius:    '999px',
                          padding:         '2px 8px',
                          fontSize:        '0.74rem',
                          fontWeight:      'bold',
                        }}>
                          {score.toFixed(2)}
                        </span>
                      </div>

                      {/* Chunk text preview — truncated at 300 chars */}
                      <p style={{
                        margin:     0,
                        fontSize:   '0.82rem',
                        lineHeight: '1.5',
                        color:      '#333',
                      }}>
                        {chunk.text.length > 300
                          ? chunk.text.slice(0, 300) + '…'
                          : chunk.text}
                      </p>
                    </div>
                  )
                })}
              </div>

            </div>
          )}
        </div>
      )}


      {/* ==================================================================== */}
      {/* TAB 2 — MANAGE DOCUMENTS                                             */}
      {/* ==================================================================== */}
      {activeTab === 'manage' && (
        <div>

          {/* ---------------------------------------------------------------- */}
          {/* Section A — Upload a File                                        */}
          {/* ---------------------------------------------------------------- */}
          <div style={{ marginBottom: '28px' }}>
            <h3 style={sectionHeadingStyle}>Upload a File</h3>

            <div style={{
              display:       'flex',
              flexDirection: 'column',
              gap:           '8px',
              maxWidth:      '460px',
            }}>
              <input
                type="file"
                accept=".txt,.pdf"
                onChange={e => setUploadFile(e.target.files?.[0] ?? null)}
                style={{ fontSize: '0.88rem' }}
              />

              <input
                type="text"
                value={uploadDocId}
                onChange={e => setUploadDocId(e.target.value)}
                placeholder="Document ID — e.g. my-audit-report-2025"
                style={inputStyle}
              />

              <select
                value={uploadResourceType}
                onChange={e => setUploadResourceType(e.target.value)}
                style={selectStyle}
              >
                {RESOURCE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>

              <button
                onClick={handleFileUpload}
                disabled={uploadLoading || !uploadFile || !uploadDocId.trim()}
                style={{
                  ...primaryBtn(uploadLoading || !uploadFile || !uploadDocId.trim()),
                  alignSelf: 'flex-start',
                }}
              >
                {uploadLoading ? 'Uploading...' : 'Upload Document'}
              </button>
            </div>
          </div>

          {/* ---------------------------------------------------------------- */}
          {/* Section B — Paste Text Directly                                  */}
          {/* ---------------------------------------------------------------- */}
          <div style={{ marginBottom: '28px' }}>
            <h3 style={sectionHeadingStyle}>Paste Text Directly</h3>

            <div style={{
              display:       'flex',
              flexDirection: 'column',
              gap:           '8px',
              maxWidth:      '460px',
            }}>
              <input
                type="text"
                value={textDocId}
                onChange={e => setTextDocId(e.target.value)}
                placeholder="Document ID"
                style={inputStyle}
              />

              <textarea
                value={textContent}
                onChange={e => setTextContent(e.target.value)}
                placeholder="Paste document content here"
                rows={8}
                style={{
                  ...inputStyle,
                  fontFamily: 'sans-serif',
                  resize:     'vertical',
                  lineHeight: '1.5',
                }}
              />

              <select
                value={textResourceType}
                onChange={e => setTextResourceType(e.target.value)}
                style={selectStyle}
              >
                {RESOURCE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>

              <button
                onClick={handleTextIngest}
                disabled={!textDocId.trim() || !textContent.trim()}
                style={{
                  ...primaryBtn(!textDocId.trim() || !textContent.trim()),
                  alignSelf: 'flex-start',
                }}
              >
                Add to Knowledge Base
              </button>
            </div>
          </div>

          {/* ---------------------------------------------------------------- */}
          {/* Section C — Current Knowledge Base (always visible)             */}
          {/* ---------------------------------------------------------------- */}
          <div>
            <div style={{
              display:     'flex',
              alignItems:  'center',
              gap:         '12px',
              marginBottom:'12px',
            }}>
              <h3 style={{ ...sectionHeadingStyle, margin: 0, border: 'none' }}>
                Current Knowledge Base
              </h3>
              <button
                onClick={fetchDocuments}
                disabled={docsLoading}
                style={{
                  padding:         '5px 14px',
                  backgroundColor: docsLoading ? '#90b0e0' : '#2563eb',
                  color:           'white',
                  border:          'none',
                  borderRadius:    '5px',
                  cursor:          docsLoading ? 'not-allowed' : 'pointer',
                  fontSize:        '0.82rem',
                  fontWeight:      'bold',
                }}
              >
                {docsLoading ? 'Loading...' : '🔄 Refresh'}
              </button>
            </div>

            {/* Loading */}
            {docsLoading && (
              <div style={{ color: '#555', fontStyle: 'italic', fontSize: '0.9rem' }}>
                Loading documents...
              </div>
            )}

            {/* Empty state */}
            {!docsLoading && documents.length === 0 && (
              <div style={{
                color:      '#888',
                fontStyle:  'italic',
                fontSize:   '0.9rem',
                padding:    '16px',
                textAlign:  'center',
                background: '#fafafa',
                border:     '1px dashed #ccc',
                borderRadius: '6px',
              }}>
                Knowledge base is empty. Run seed_knowledge.py or add documents above.
              </div>
            )}

            {/* Document list */}
            {!docsLoading && documents.length > 0 && (
              <div style={{
                border:       '1px solid #e0e0e0',
                borderRadius: '8px',
                overflow:     'hidden',
              }}>
                {/* List header */}
                <div style={{
                  display:         'grid',
                  gridTemplateColumns: '1fr auto auto auto',
                  gap:             '12px',
                  padding:         '8px 14px',
                  backgroundColor: '#f5f5f5',
                  borderBottom:    '1px solid #e0e0e0',
                  fontSize:        '0.78rem',
                  fontWeight:      'bold',
                  color:           '#666',
                  textTransform:   'uppercase',
                  letterSpacing:   '0.04em',
                }}>
                  <span>Document ID</span>
                  <span>Type</span>
                  <span>Chunks</span>
                  <span></span>
                </div>

                {documents.map((doc, i) => (
                  <div key={doc.doc_id} style={{
                    display:             'grid',
                    gridTemplateColumns: '1fr auto auto auto',
                    gap:                 '12px',
                    padding:             '10px 14px',
                    alignItems:          'center',
                    borderBottom:        i < documents.length - 1
                                           ? '1px solid #f0f0f0'
                                           : 'none',
                    backgroundColor:     i % 2 === 0 ? 'white' : '#fafafa',
                  }}>
                    {/* doc_id */}
                    <span style={{
                      fontFamily: 'monospace',
                      fontSize:   '0.85rem',
                      color:      '#222',
                      overflow:   'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {doc.doc_id}
                    </span>

                    {/* resource_type badge */}
                    <span style={{
                      backgroundColor: '#e8f0fe',
                      color:           '#2563eb',
                      borderRadius:    '4px',
                      padding:         '2px 7px',
                      fontSize:        '0.75rem',
                      fontWeight:      'bold',
                      textAlign:       'center',
                    }}>
                      {doc.resource_type}
                    </span>

                    {/* chunk count */}
                    <span style={{ fontSize: '0.82rem', color: '#666', textAlign: 'center' }}>
                      {doc.chunk_count}
                    </span>

                    {/* Delete button */}
                    <button
                      onClick={() => handleDelete(doc.doc_id)}
                      style={{
                        padding:         '3px 10px',
                        backgroundColor: 'transparent',
                        color:           '#cc0000',
                        border:          '1px solid #cc0000',
                        borderRadius:    '4px',
                        cursor:          'pointer',
                        fontSize:        '0.78rem',
                        whiteSpace:      'nowrap',
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      )}

    </div>
  )
}
