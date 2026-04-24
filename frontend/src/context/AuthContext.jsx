// =============================================================================
// AuthContext.jsx — Frontend-only authentication for Agentic Cloud Assistant
//
// Design:
//   - Hardcoded demo credentials (admin / demo2024) — no backend call needed
//   - isAuthenticated persisted to localStorage under 'aca_auth'
//   - login() returns true/false so LoginPage can show an error on failure
//   - logout() clears all localStorage then hard-navigates to /login so that
//     ApiKeyContext's cached keys are also wiped from the session
// =============================================================================

import { createContext, useContext, useState } from 'react'

const STORAGE_KEY  = 'aca_auth'
const DEMO_USER    = 'admin'
const DEMO_PASS    = 'demo2024'

const AuthContext = createContext(null)


// =============================================================================
// AuthProvider — wrap the whole app so all routes can access auth state
// =============================================================================

export function AuthProvider({ children }) {

  // Seed from localStorage so a page refresh keeps the user logged in.
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })

  // ---------------------------------------------------------------------------
  // login — validate credentials and persist auth state
  // Returns true on success, false on failure.
  // ---------------------------------------------------------------------------

  function login(username, password) {
    if (username === DEMO_USER && password === DEMO_PASS) {
      setIsAuthenticated(true)
      try {
        localStorage.setItem(STORAGE_KEY, 'true')
      } catch {
        // localStorage unavailable — auth still works for this session.
      }
      return true
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // logout — wipe all localStorage (auth + API keys) then redirect to /login.
  //
  // We use window.location.href rather than React Router's navigate() because:
  //   1. The context isn't a component and can't use useNavigate()
  //   2. A hard redirect is intentional — it tears down all React state,
  //      ensuring nothing from the previous session leaks into the next login.
  // ---------------------------------------------------------------------------

  function logout() {
    setIsAuthenticated(false)
    try {
      localStorage.clear()
    } catch {}
    window.location.href = '/login'
  }

  return (
    <AuthContext.Provider value={{ isAuthenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}


// =============================================================================
// useAuth — custom hook for consuming auth context
// =============================================================================

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error(
      'useAuth() must be called inside an <AuthProvider>. ' +
      'Make sure AuthProvider wraps your app in App.jsx.'
    )
  }
  return context
}

export default AuthContext
