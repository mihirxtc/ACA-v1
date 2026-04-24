// =============================================================================
// ProtectedRoute.jsx — Route guard that requires authentication
//
// Usage in App.jsx:
//   <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
//
// If the user is not authenticated, they are immediately redirected to /login.
// The 'replace' prop replaces the current history entry so the user cannot
// press the browser Back button to return to the protected route.
// =============================================================================

import { Navigate } from 'react-router-dom'
import { useAuth }  from '../context/AuthContext'

export default function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuth()

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return children
}
