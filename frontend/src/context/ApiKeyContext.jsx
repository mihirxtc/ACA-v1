// =============================================================================
// ApiKeyContext.jsx — Centralised API key and model state for the
//                     Agentic Cloud Assistant
//
// Problem solved:
//   Previously, each panel (Chat, Security, Cost) managed its own
//   [model, apiKey] state independently. The user had to type their
//   API key three separate times — once per panel.
//
// Solution:
//   React Context acts as a single shared store. All panels read from
//   it. localStorage persists the keys across browser refreshes so
//   the user only ever needs to enter their key once.
//
// Architecture:
//   ApiKeyProvider — wraps the whole app in App.jsx. Holds state and
//                    writes to localStorage on every change.
//   useApiKeys()   — a custom hook that any component calls to read
//                    the shared state and access the update functions.
//
// localStorage key: "agentic_cloud_api_keys"
// =============================================================================

import { createContext, useContext, useState, useEffect } from 'react'

// The localStorage key used to persist the keys object.
const STORAGE_KEY = 'agentic_cloud_api_keys'

// The default state — empty strings mean "use the server .env key".
// This matches the existing fallback behaviour in each panel.
const DEFAULT_KEYS = {
  groq:           '',          // Groq API key — blank = fall back to server GROQ_API_KEY
  anthropic:      '',          // Anthropic key — blank = fall back to server ANTHROPIC_API_KEY
  ollamaUrl:      '',          // Ollama base URL — blank = http://localhost:11434
  model:          'groq',      // Which LLM provider all panels will use
  awsAccessKeyId: '',          // AWS Access Key ID (optional — falls back to ~/.aws/credentials)
  awsSecretKey:   '',          // AWS Secret Access Key
  awsRegion:      'us-east-1', // AWS region for scans
}

// Create the context object. null is the default value — if a component
// calls useApiKeys() without being inside an ApiKeyProvider, the null
// check in useApiKeys() will throw a helpful error message.
const ApiKeyContext = createContext(null)


// =============================================================================
// ApiKeyProvider — wraps the app so all children can access shared key state
// =============================================================================

export function ApiKeyProvider({ children }) {

  // ---------------------------------------------------------------------------
  // Initialise state from localStorage.
  //
  // Why a lazy initialiser (the arrow function)?
  //   If we wrote useState(JSON.parse(localStorage.getItem(...))) instead,
  //   React would call localStorage on EVERY re-render — which is wasteful.
  //   Passing a function means React calls it ONCE on mount, then never again.
  //
  // Why try/catch?
  //   In Safari private browsing, localStorage.getItem() throws a
  //   SecurityError instead of returning null. The try/catch ensures
  //   we always fall back to DEFAULT_KEYS rather than crashing.
  // ---------------------------------------------------------------------------

  const [keys, setKeys] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      return stored ? JSON.parse(stored) : DEFAULT_KEYS
    } catch {
      return DEFAULT_KEYS
    }
  })

  // ---------------------------------------------------------------------------
  // Persist to localStorage automatically whenever keys changes.
  //
  // This useEffect runs every time the 'keys' object changes.
  // Because we update it with setKeys (immutable update), every change
  // to any field triggers a save. The user never needs to manually save.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(keys))
    } catch {
      // localStorage unavailable (e.g. private browsing) — fail silently.
      // The app still works; keys just won't persist after refresh.
    }
  }, [keys])

  // ---------------------------------------------------------------------------
  // setKey — update a single key by name
  //
  // Example: setKey('groq', 'gsk_abc123')
  // Uses spread syntax to copy all existing keys and overwrite just one.
  // ---------------------------------------------------------------------------

  function setKey(name, value) {
    setKeys(prev => ({ ...prev, [name]: value }))
  }

  // ---------------------------------------------------------------------------
  // setModel — update the selected LLM provider
  //
  // Kept separate from setKey for clarity — the model is not an API key
  // but it lives in the same object for convenience.
  // ---------------------------------------------------------------------------

  function setModel(model) {
    setKeys(prev => ({ ...prev, model }))
  }

  // ---------------------------------------------------------------------------
  // clearAllKeys — reset state to defaults AND remove from localStorage
  //
  // Must do BOTH. Resetting state alone leaves the old value in storage,
  // so it would reappear on the next browser refresh.
  // ---------------------------------------------------------------------------

  function clearAllKeys() {
    setKeys(DEFAULT_KEYS)
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Fail silently — see note above.
    }
  }

  // ---------------------------------------------------------------------------
  // hasAwsKey — returns true if both AWS key fields are filled
  // ---------------------------------------------------------------------------

  function hasAwsKey() {
    return Boolean(
      keys.awsAccessKeyId && keys.awsAccessKeyId.trim() &&
      keys.awsSecretKey   && keys.awsSecretKey.trim()
    )
  }

  // ---------------------------------------------------------------------------
  // hasKey — returns true if a non-empty key is set for a given provider
  //
  // Used by Dashboard.jsx to decide whether to show the green dot indicator.
  // Example: hasKey('groq') → true if a Groq key has been entered.
  // ---------------------------------------------------------------------------

  function hasKey(provider) {
    return Boolean(keys[provider] && keys[provider].trim())
  }

  // ---------------------------------------------------------------------------
  // Provide all state and functions to the component tree below.
  // ---------------------------------------------------------------------------

  return (
    <ApiKeyContext.Provider value={{ keys, setKey, setModel, clearAllKeys, hasKey, hasAwsKey }}>
      {children}
    </ApiKeyContext.Provider>
  )
}


// =============================================================================
// useApiKeys — custom hook for consuming the context
//
// Any component inside ApiKeyProvider can call:
//   const { keys, setKey, setModel, clearAllKeys, hasKey } = useApiKeys()
//
// The error check ensures a helpful message rather than a cryptic
// "cannot read property of null" if the provider is accidentally missing.
// =============================================================================

export function useApiKeys() {
  const context = useContext(ApiKeyContext)

  if (!context) {
    throw new Error(
      'useApiKeys() must be called inside an <ApiKeyProvider>. ' +
      'Make sure ApiKeyProvider wraps your app in App.jsx.'
    )
  }

  return context
}


export default ApiKeyContext
