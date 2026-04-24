// App.jsx — Entry point for the Agentic Cloud Assistant frontend.
//
// Provider nesting order (outermost → innermost):
//   BrowserRouter — React Router context needed by all routes
//   AuthProvider  — auth state; ProtectedRoute and LoginPage read it
//   ApiKeyProvider — API key state; Dashboard and its children read it
//
// Routes:
//   /login → LoginPage (public)
//   /      → ProtectedRoute → Dashboard (requires authentication)

import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Toaster }        from 'react-hot-toast'
import { AuthProvider }   from './context/AuthContext'
import { ApiKeyProvider } from './context/ApiKeyContext'
import Dashboard          from './components/Dashboard'
import LoginPage          from './components/LoginPage'
import ProtectedRoute     from './components/ProtectedRoute'

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ApiKeyProvider>
          <Toaster position="top-right" />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <Dashboard />
                </ProtectedRoute>
              }
            />
          </Routes>
        </ApiKeyProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App
