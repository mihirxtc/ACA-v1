import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useApiKeys } from '../contexts/ApiKeyContext'
import { computeHealthScore } from '../utils/scoring'
import { callTool } from '../api/mcpClient'
import Topbar                from './ui/Topbar'
import InfrastructurePanel   from './panels/InfrastructurePanel'
import SecurityPanel         from './panels/SecurityPanel'
import CostPanel             from './panels/CostPanel'
import ChatPanel             from './panels/ChatPanel'
import TerraformPanel        from './panels/TerraformPanel'
import ExecutionHistoryPanel from './panels/ExecutionHistoryPanel'
import SecurityAgentPanel    from './panels/SecurityAgentPanel'
import KnowledgeBasePanel    from './panels/KnowledgeBasePanel'

export default function Dashboard({ onOpenSettings }) {
  const { keys }   = useApiKeys()
  const { logout } = useAuth()

  const [infra,           setInfra]           = useState(null)
  const [infraLoading,    setInfraLoading]    = useState(false)
  const [security,        setSecurity]        = useState(null)
  const [securityLoading, setSecurityLoading] = useState(false)
  const [cost,            setCost]            = useState(null)
  const [costLoading,     setCostLoading]     = useState(false)
  const [prefill,         setPrefill]         = useState(null)
  const [securityScore,   setSecurityScore]   = useState(null)

  const getApiKey = () => {
    if (keys.model === 'groq')      return keys.groq_key
    if (keys.model === 'anthropic') return keys.anthropic_key
    return keys.ollama_url
  }

  const runInfra = async () => {
    setInfraLoading(true)
    try { setInfra(await callTool('full_aws_scan')) }
    finally { setInfraLoading(false) }
  }

  const runSecurity = async () => {
    setSecurityLoading(true)
    try {
      const d = await callTool('run_security_analysis_with_summary', {
        model:   keys.model,
        api_key: getApiKey(),
      })
      setSecurity(d)
      setSecurityScore(computeHealthScore(d.findings))
    } finally { setSecurityLoading(false) }
  }

  const runCost = async () => {
    setCostLoading(true)
    try {
      setCost(await callTool('get_cost_with_summary', {
        model:   keys.model,
        api_key: getApiKey(),
      }))
    } finally { setCostLoading(false) }
  }

  const onFix = (finding) => {
    setPrefill(`Fix ${finding.rule} on ${finding.resource_id}: ${finding.recommendation}`)
    setTimeout(() => {
      document.getElementById('terraform-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 50)
  }

  const hasKeys = !!(keys.groq_key || keys.anthropic_key || keys.ollama_url)

  return (
    <div>
      <Topbar
        securityScore={securityScore}
        onOpenSettings={onOpenSettings}
        onLogout={logout}
        region={keys.region || 'us-east-1'}
        hasKeys={hasKeys}
      />
      <div className="aca-grid">
        <InfrastructurePanel data={infra} loading={infraLoading} onScan={runInfra} />
        <SecurityPanel data={security} loading={securityLoading} onScan={runSecurity} onFix={onFix} />
        <CostPanel data={cost} loading={costLoading} onLoad={runCost} />
        <ChatPanel model={keys.model || 'groq'} apiKey={getApiKey()} />
        <TerraformPanel
          model={keys.model || 'groq'} apiKey={getApiKey()}
          prefill={prefill} onPrefillConsumed={() => setPrefill(null)}
        />
        <ExecutionHistoryPanel />
        <SecurityAgentPanel
          region={keys.region || 'us-east-1'}
          model={keys.model || 'groq'}
          apiKey={getApiKey()}
        />
        <KnowledgeBasePanel />
      </div>
    </div>
  )
}
