import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import { setLanguage } from './lib/i18n';
import { Layout } from './components/Layout';
import { Spinner, ToastProvider } from './components/ui';
import { SetupPage } from './pages/Setup';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { PeoplePage } from './pages/People';
import { PersonPage } from './pages/Person';
import { AbsencesPage } from './pages/Absences';
import { TimePage } from './pages/Time';
import { MyDocumentsPage } from './pages/Documents';
import { RecruitingPage } from './pages/Recruiting';
import { JobPage } from './pages/Job';
import { CareersPage, CareerJobPage } from './pages/Careers';
import { SettingsPage } from './pages/settings/Settings';

function Guard({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  const setup = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<{ needsSetup: boolean }>('/setup/status') });
  useEffect(() => {
    if (me?.locale) setLanguage(me.locale);
  }, [me?.locale]);
  if (loading || setup.isLoading) return <Spinner />;
  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <Routes>
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/careers" element={<CareersPage />} />
            <Route path="/careers/:slug" element={<CareerJobPage />} />
            <Route
              element={
                <Guard>
                  <Layout />
                </Guard>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="people" element={<PeoplePage />} />
              <Route path="people/:id" element={<PersonPage />} />
              <Route path="absences" element={<AbsencesPage />} />
              <Route path="time" element={<TimePage />} />
              <Route path="documents" element={<MyDocumentsPage />} />
              <Route path="recruiting" element={<RecruitingPage />} />
              <Route path="recruiting/jobs/:id" element={<JobPage />} />
              <Route path="settings/*" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
