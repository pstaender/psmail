import { AppShell } from "@/components/layout/AppShell";
import { LoginView } from "@/components/auth/LoginView";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import "./index.css";

function Gate() {
  const { token, ready } = useAuth();

  if (!ready) return <div className="h-full w-full" />;
  return token ? <AppShell /> : <LoginView />;
}

export function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

export default App;
