import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import Register from "@/pages/register";
import Dashboard from "@/pages/dashboard";
import DriverDashboard from "@/pages/driver-dashboard";
import DriverUploadDocs from "@/pages/driver-upload-docs";
import SubscriptionPage from "@/pages/subscription";
import ProfilePage from "@/pages/profile";
import WheelPage, { CouponsPage } from "@/pages/wheel";
import AdminPage from "@/pages/admin";
import { useAuth } from "@/hooks/use-auth";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { ThemeProvider } from "@/lib/theme";
import { I18nProvider } from "@/lib/i18n";
import { usePushSubscription } from "@/hooks/use-push-subscription";
import { useTokenRefresh } from "@/hooks/use-token-refresh";
import { useSubscriptionNotifications } from "@/hooks/use-subscription-notifications";
import { ErrorBoundary } from "@/components/error-boundary";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAccountStatus,
  getGetAccountStatusQueryKey,
  useGetDriverAccount,
  getGetDriverAccountQueryKey,
} from "@workspace/api-client-react";
import { getSocket } from "@/lib/socket-client";
import { useSupportChatStore } from "@/stores/support-chat";
import { AppealOverlay } from "@/components/appeal-overlay";
import { customFetch } from "@workspace/api-client-react";
import { ShieldAlert, HeadphonesIcon, XCircle, Loader2 } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Global session-eviction listener
// When the API returns SESSION_EVICTED, force-logout and redirect to login.
// ─────────────────────────────────────────────────────────────────────────────
function SessionEvictionGuard() {
  const logout = useAuth((s) => s.logout);
  const [, setLocation] = useLocation();

  useEffect(() => {
    const handler = (e: CustomEvent<{ code?: string }>) => {
      if (e.detail?.code === "SESSION_EVICTED") {
        logout();
        setLocation("/");
      }
    };
    window.addEventListener("api-error", handler as EventListener);
    return () => window.removeEventListener("api-error", handler as EventListener);
  }, [logout, setLocation]);

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suspended overlay — softer tone, no appeal form
// ─────────────────────────────────────────────────────────────────────────────
export function SuspendedAccountOverlay() {
  const openSupport = useSupportChatStore((s) => s.open);
  const userId = useAuth((s) => s.userId);
  const [liftLoading, setLiftLoading] = useState(false);
  const [liftError, setLiftError] = useState("");
  const [liftPending, setLiftPending] = useState(false);
  const liftRequestInFlight = useRef(false);

  useEffect(() => {
    if (!userId) return;
    const fetchLiftStatus = () => {
      customFetch<{ pendingLift: boolean }>("/api/driver/suspension-requests")
        .then((requests) => setLiftPending(requests.pendingLift))
        .catch(() => {});
    };
    fetchLiftStatus();
    const interval = setInterval(fetchLiftStatus, 30_000);
    return () => clearInterval(interval);
  }, [userId]);

  const submitLiftRequest = async () => {
    if (liftPending || liftRequestInFlight.current) {
      return;
    }

    setLiftError("");
    liftRequestInFlight.current = true;
    setLiftLoading(true);
    try {
      await customFetch("/api/driver/suspension-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestType: "lift" }),
      });
      setLiftPending(true);
    } catch (err: unknown) {
      const apiError = err as { data?: { error?: string } } | null;
      if (apiError?.data?.error === "يوجد طلب من نفس النوع قيد المراجعة") {
        setLiftPending(true);
      } else {
        setLiftError(apiError?.data?.error ?? "تعذّر إرسال الطلب");
      }
    } finally {
      liftRequestInFlight.current = false;
      setLiftLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div
        className="bg-white dark:bg-slate-900 rounded-3xl p-8 mx-4 max-w-sm w-full shadow-2xl border border-amber-200 dark:border-amber-700 text-center animate-in zoom-in-95 duration-300"
        dir="rtl"
      >
        <div className="w-16 h-16 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
          <ShieldAlert className="w-8 h-8 text-amber-500" />
        </div>
        <h2 className="text-xl font-black text-slate-800 dark:text-white mb-3">
          تم تعليق حسابك مؤقتا
        </h2>
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-2xl p-4 mb-6 text-right">
          <p className="text-slate-700 dark:text-slate-200 text-sm leading-loose font-bold">
            الرجاء طلب الغاء تعليقك ادا كنت تريد العودة للعمل اظغط على زر طلب الغاء التعليق
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={submitLiftRequest}
            disabled={liftLoading || liftPending}
            className="w-full min-h-12 flex items-center justify-center gap-2 bg-gradient-to-r from-primary to-cyan-500 text-white font-bold px-3 py-3 rounded-2xl shadow-lg hover:opacity-90 transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed text-sm"
            title="طلب إلغاء التعليق"
            aria-label="طلب إلغاء التعليق"
          >
            {liftLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ShieldAlert className="w-5 h-5" />}
            {liftPending ? "تم إرسال الطلب" : "طلب إلغاء التعليق"}
          </button>
          <button
            onClick={openSupport}
            className="w-full min-h-12 flex items-center justify-center gap-2 border-2 border-primary text-primary dark:text-cyan-300 dark:border-cyan-400 font-bold px-3 py-3 rounded-2xl hover:bg-primary/10 transition-all active:scale-[0.98] text-sm"
          >
            <HeadphonesIcon className="w-5 h-5" />
            خدمة العملاء
          </button>
        </div>
        {liftError && (
          <p className="mt-3 text-xs text-red-500" role="alert">
            {liftError}
          </p>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Banned overlay — uses the shared AppealOverlay component
// ─────────────────────────────────────────────────────────────────────────────
function BannedAccountOverlay() {
  return (
    <AppealOverlay
      title="حسابك محظور"
      idleDescription="الرجاء التواصل مع الإدارة أو تقديم طعن للمراجعة"
      icon={<XCircle className="w-8 h-8 text-red-500" />}
      zClass="z-[210]"
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AccountStatusGate — global freeze overlay (sibling of SessionEvictionGuard)
//
// • Polls GET /api/account/:userId/status every 10 s
// • Listens on the "account_status_changed" Socket.io event for instant freeze
// • Listens on the "api-error" window event for ACCOUNT_SUSPENDED/ACCOUNT_BANNED
//   fired by the QueryClient onError handler below (mirrors SESSION_EVICTED)
// • Shows SuspendedAccountOverlay or BannedAccountOverlay at z-[210], which is
//   above the page-level pending/rejected overlays in driver-dashboard (z-[200])
// • Does NOT force logout — user stays authenticated to reach appeal/support
// ─────────────────────────────────────────────────────────────────────────────
function AccountStatusGate() {
  const userId      = useAuth((s) => s.userId);
  const userType    = useAuth((s) => s.userType);
  const queryClient = useQueryClient();

  // Poll every 10 s; background refetch disabled to avoid noise when unfocused
  const { data } = useGetAccountStatus(userId ?? "", {
    query: {
      queryKey: getGetAccountStatusQueryKey(userId ?? ""),
      enabled:                    !!userId,
      refetchInterval:            10_000,
      refetchIntervalInBackground: false,
      // Don't retry on auth/freeze errors — just wait for next poll
      retry: (failureCount, err: any) => {
        if (err?.status === 401 || err?.status === 403) return false;
        return failureCount < 2;
      },
    },
  });
  const { data: driverAccount } = useGetDriverAccount(userId ?? "", {
    query: {
      queryKey: getGetDriverAccountQueryKey(userId ?? ""),
      enabled: !!userId && userType === "سائق",
      refetchInterval: 10_000,
      refetchIntervalInBackground: false,
    },
  });

  // Instant freeze via Socket.io event (emitted by admin suspend/ban endpoints)
  useEffect(() => {
    if (!userId) return;
    const socket = getSocket();
    function handleStatusChange() {
      queryClient.invalidateQueries({
        queryKey: getGetAccountStatusQueryKey(userId!),
      });
    }
    socket.on("account_status_changed", handleStatusChange);
    return () => { socket.off("account_status_changed", handleStatusChange); };
  }, [userId, queryClient]);

  // Instant freeze via global api-error event (dispatched by QueryClient below)
  useEffect(() => {
    if (!userId) return;
    function handler(e: CustomEvent<{ code?: string }>) {
      if (
        e.detail?.code === "ACCOUNT_SUSPENDED" ||
        e.detail?.code === "ACCOUNT_BANNED"
      ) {
        queryClient.invalidateQueries({
          queryKey: getGetAccountStatusQueryKey(userId!),
        });
      }
    }
    window.addEventListener("api-error", handler as EventListener);
    return () => window.removeEventListener("api-error", handler as EventListener);
  }, [userId, queryClient]);

  if (userType === "سائق" && (driverAccount as any)?.isSuspended === true) {
    return <SuspendedAccountOverlay />;
  }
  if (!userId || !data) return null;
  if (data.accountStatus === "suspended") return <SuspendedAccountOverlay />;
  if (data.accountStatus === "banned")    return <BannedAccountOverlay />;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Web Push subscription — registers SW and subscribes drivers after login.
// Fails silently on unsupported browsers or denied permission.
// ─────────────────────────────────────────────────────────────────────────────
function PushSubscriptionGate() {
  const userId   = useAuth((s) => s.userId);
  const userType = useAuth((s) => s.userType);
  // Only subscribe drivers — they are the ones receiving order push alerts
  usePushSubscription(userType === "سائق" ? userId : null);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription notification gate — listens for the `subscription_approved`
// Socket.io event that the server emits ONLY to this driver's private room.
// No other driver ever receives this event.
// ─────────────────────────────────────────────────────────────────────────────
function SubscriptionNotificationGate() {
  const userId   = useAuth((s) => s.userId);
  const userType = useAuth((s) => s.userType);
  useSubscriptionNotifications(userType === "سائق" ? userId : null);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token refresh gate — proactively refreshes the Supabase JWT before it
// expires and auto-retries on 401 via customFetch.
// ─────────────────────────────────────────────────────────────────────────────
function TokenRefreshGate() {
  useTokenRefresh();
  return null;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error: any) => {
        if (error?.data?.code === "SESSION_EVICTED") return false;
        if (error?.data?.code === "ACCOUNT_SUSPENDED") return false;
        if (error?.data?.code === "ACCOUNT_BANNED") return false;
        return failureCount < 2;
      },
    },
    mutations: {
      onError: (error: any) => {
        const code = error?.data?.code;
        if (
          code === "SESSION_EVICTED" ||
          code === "ACCOUNT_SUSPENDED" ||
          code === "ACCOUNT_BANNED"
        ) {
          window.dispatchEvent(new CustomEvent("api-error", { detail: { code } }));
        }
      },
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/driver-dashboard" component={DriverDashboard} />
      <Route path="/driver-upload-docs" component={DriverUploadDocs} />
      <Route path="/subscription" component={SubscriptionPage} />
      <Route path="/profile" component={ProfilePage} />
      <Route path="/wheel" component={WheelPage} />
      <Route path="/coupons" component={CouponsPage} />
      <Route path="/admin" component={AdminPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <SessionEvictionGuard />
              <TokenRefreshGate />
              <PushSubscriptionGate />
              <SubscriptionNotificationGate />
              {/* AccountStatusGate: z-[210] — above all page-level overlays */}
              <AccountStatusGate />
              <ErrorBoundary>
                <Router />
              </ErrorBoundary>
            </WouterRouter>
            <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

export default App;
