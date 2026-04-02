import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import Login from './pages/Login';
import SubmitDeck from './pages/SubmitDeck';
import CRM from './pages/CRM';
import Analytics from './pages/Analytics';
import Layout from './components/Layout';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ padding: 40, textAlign: 'center' }}>Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      {/* Public routes */}
      <Route path="/submit" element={<SubmitDeck />} />
      <Route path="/login" element={<Login />} />

      {/* Protected routes */}
      <Route path="/crm" element={
        <ProtectedRoute><Layout><CRM /></Layout></ProtectedRoute>
      } />
      <Route path="/analytics" element={
        <ProtectedRoute><Layout><Analytics /></Layout></ProtectedRoute>
      } />

      {/* Default redirect */}
      <Route path="*" element={<Navigate to="/crm" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
