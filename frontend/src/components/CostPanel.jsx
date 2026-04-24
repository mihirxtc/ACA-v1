// =============================================================================
// CostPanel.jsx — AWS cost analysis UI for the Agentic Cloud Assistant
//
// This component fetches GET /cost and displays:
//   - Current month spend (large prominent card)
//   - Anomaly warning (if spend jumped 20%+ vs last month)
//   - 3-month trend bar chart (Recharts)
//   - Top services by cost (horizontal bar rows)
//   - LLM cost optimisation summary
//
// No external libraries beyond Recharts — only React built-ins (useState).
// All styles are inline — no CSS files or Tailwind.
// =============================================================================

import { useState } from 'react'
import toast from 'react-hot-toast'
import { useApiKeys } from '../context/ApiKeyContext'
import { callTool } from '../lib/mcpClient'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

export default function CostPanel() {

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [costData,  setCostData]  = useState(null)   // Full /cost response
  const [loading,   setLoading]   = useState(false)  // True while fetching
  const [error,     setError]     = useState(null)   // Error string or null
  const [hasLoaded, setHasLoaded] = useState(false)  // True after first success

  // Read model and keys from centralised Context.
  const { keys } = useApiKeys()

  // ---------------------------------------------------------------------------
  // fetchCostData — calls GET /cost and populates state
  // ---------------------------------------------------------------------------

  async function fetchCostData() {
    setLoading(true)
    setError(null)

    try {
      const resolvedKey = keys.model === 'anthropic' ? keys.anthropic : keys.groq
      const data = await callTool('get_cost_with_summary', {
        model:   keys.model || 'groq',
        api_key: resolvedKey || '',
      })
      setCostData(data)
      setHasLoaded(true)
      toast.success('Cost data loaded')

    } catch (err) {
      setError(err.message || 'Failed to load cost data.')
      toast.error(err.message || 'Failed to load cost data')
    } finally {
      setLoading(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Derived values — computed from costData when available
  // ---------------------------------------------------------------------------

  // Top 5 services maximum — the rest are minor and would clutter the display.
  const topServices  = costData?.by_service?.slice(0, 5) ?? []

  // Maximum amount among top services — used to calculate relative bar widths.
  // Math.max(...[]) returns -Infinity, so we default to 1 to avoid division
  // by zero when the services list is empty.
  const maxServiceAmount = topServices.length > 0
    ? Math.max(...topServices.map(s => s.amount))
    : 1

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div style={{ fontFamily: 'sans-serif', maxWidth: '900px', margin: '0 auto' }}>

      {/* -------------------------------------------------------------------- */}
      {/* Header row                                                            */}
      {/* -------------------------------------------------------------------- */}
      <div style={{
        display:      'flex',
        alignItems:   'center',
        gap:          '12px',
        flexWrap:     'wrap',
        marginBottom: '16px',
      }}>
        <h2 style={{ margin: 0, fontSize: '1.4rem' }}>💰 Cost Analysis</h2>

        {/* Load button — disabled while a fetch is already in progress */}
        <button
          onClick={fetchCostData}
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
          {loading ? 'Loading...' : 'Load Cost Data'}
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
      {/* Loading skeleton — chart-sized rectangle while data is fetching     */}
      {/* -------------------------------------------------------------------- */}
      {loading && (
        <div
          style={{
            height:      '200px',
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
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          gap:            '12px',
        }}>
          <span>{error}</span>
          <button
            onClick={() => { setError(null); fetchCostData() }}
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
      {/* Results — only shown after a successful load                         */}
      {/* -------------------------------------------------------------------- */}
      {hasLoaded && costData && !loading && (
        <>

          {/* ---------------------------------------------------------------- */}
          {/* A. Current month spend card                                      */}
          {/* ---------------------------------------------------------------- */}
          <div style={{
            backgroundColor: '#f0f8ff',
            border:          '1px solid #b3d9ff',
            borderRadius:    '12px',
            padding:         '1.5rem',
            marginBottom:    '16px',
            textAlign:       'center',
          }}>
            {/* Large spend number — Math.abs prevents "-0.00" display */}
            <div style={{
              fontSize:   '32px',
              fontWeight: 'bold',
              color:      '#0066cc',
            }}>
              ${Math.abs(costData.current_month?.amount ?? 0).toFixed(2)}{' '}
              {costData.current_month?.currency ?? 'USD'}
            </div>

            <div style={{ color: '#555', marginTop: '4px', fontSize: '0.95rem' }}>
              Current month spend
            </div>

            <div style={{ color: '#888', marginTop: '4px', fontSize: '0.8rem' }}>
              {costData.current_month?.period ?? ''}
            </div>
          </div>

          {/* ---------------------------------------------------------------- */}
          {/* B. Anomaly warning — only shown when anomaly is detected         */}
          {/* ---------------------------------------------------------------- */}
          {costData.anomaly?.detected && (
            <div style={{
              backgroundColor: '#fff8e6',
              border:          '1px solid #ffaa00',
              borderRadius:    '8px',
              padding:         '1rem',
              marginBottom:    '16px',
              fontSize:        '14px',
            }}>
              <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
                ⚠️ Cost Anomaly Detected
              </div>
              <div>{costData.anomaly.message}</div>
            </div>
          )}

          {/* ---------------------------------------------------------------- */}
          {/* C. 3-month trend bar chart                                       */}
          {/* ---------------------------------------------------------------- */}
          <div style={{ marginBottom: '24px' }}>
            <h3 style={{ fontSize: '1rem', marginBottom: '10px' }}>
              Monthly Trend
            </h3>

            {costData.monthly_trend?.length > 0 ? (
              // ResponsiveContainer makes the chart resize with the panel.
              // height={220} is explicit because ResponsiveContainer cannot
              // infer height from a parent with no fixed height — it would
              // render as 0px tall and be invisible.
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={costData.monthly_trend}
                  margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis
                    tickFormatter={v => `$${v.toFixed(2)}`}
                    tick={{ fontSize: 11 }}
                    width={55}
                  />
                  <Tooltip
                    formatter={(value) => [`$${Math.abs(value).toFixed(2)}`, 'Spend']}
                  />
                  <Bar
                    dataKey="amount"
                    fill="#4a90d9"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ color: '#888', fontStyle: 'italic' }}>
                No trend data available.
              </div>
            )}
          </div>

          {/* ---------------------------------------------------------------- */}
          {/* D. Top services by cost                                          */}
          {/* ---------------------------------------------------------------- */}
          <div style={{ marginBottom: '24px' }}>
            <h3 style={{ fontSize: '1rem', marginBottom: '10px' }}>
              Cost by Service
            </h3>

            {topServices.length > 0 ? (
              topServices.map((svc, index) => {
                // Width of the relative bar as a percentage of the max service.
                const barWidth = (svc.amount / maxServiceAmount) * 100

                return (
                  <div key={index} style={{ marginBottom: '10px' }}>
                    {/* Service name and amount on the same row */}
                    <div style={{
                      display:        'flex',
                      justifyContent: 'space-between',
                      fontSize:       '0.88rem',
                      marginBottom:   '3px',
                    }}>
                      <span>{svc.service}</span>
                      <span style={{ fontWeight: 'bold', color: '#0066cc' }}>
                        ${svc.amount.toFixed(2)}
                      </span>
                    </div>

                    {/* Relative cost bar — width proportional to max service */}
                    <div style={{
                      backgroundColor: '#e8f0fe',
                      borderRadius:    '3px',
                      height:          '8px',
                      width:           '100%',
                    }}>
                      <div style={{
                        backgroundColor: '#4a90d9',
                        borderRadius:    '3px',
                        height:          '8px',
                        width:           `${barWidth}%`,
                        transition:      'width 0.3s ease',
                      }} />
                    </div>
                  </div>
                )
              })
            ) : (
              <div style={{ color: '#888', fontStyle: 'italic' }}>
                No service breakdown available.
              </div>
            )}
          </div>

          {/* ---------------------------------------------------------------- */}
          {/* E. LLM cost summary box                                          */}
          {/* ---------------------------------------------------------------- */}
          <div style={{
            backgroundColor: '#f8f8f8',
            border:          '1px solid #e0e0e0',
            borderRadius:    '8px',
            padding:         '1rem',
          }}>
            <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>
              🤖 AI Cost Analysis
            </div>
            <div style={{
              whiteSpace: 'pre-wrap',
              lineHeight: '1.6',
              fontSize:   '0.9rem',
            }}>
              {costData.llm_summary}
            </div>
          </div>

        </>
      )}
    </div>
  )
}
