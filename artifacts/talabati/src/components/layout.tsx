import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { LogOut, Sun, Moon, UserCircle, Bell, HeadphonesIcon, User, Loader2 } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { useTheme } from "@/lib/theme";
import { useTranslation, LOCALES, LOCALE_FLAG_CODES, type Locale } from "@/lib/i18n";
import { DZ, FR, GB } from "country-flag-icons/react/3x2";
import type { ComponentType, SVGProps } from "react";

const FLAG_SVG: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = { DZ, FR, GB };
import { useDriverOrderWatcher } from "@/hooks/use-driver-order-watcher";
import { useOrderNotificationStore } from "@/stores/order-notifications";
import { useSocketConnection } from "@/hooks/use-socket-connection";
import { useAnnouncements } from "@/hooks/use-announcements";
import { AnnouncementsPanel } from "@/components/announcements-panel";
import { useSupportChatStore } from "@/stores/support-chat";
import { useSupportUnread } from "@/hooks/use-support-unread";
import { SupportChatModal } from "@/components/support-chat-modal";

export function WaterDrops() {
  return (
    <div className="water-drops-container" aria-hidden="true">
      {Array.from({ length: 15 }).map((_, i) => (
        <div key={i} className="water-drop" />
      ))}
    </div>
  );
}

export function WaterTruckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 80 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect x="2" y="18" width="78" height="22" rx="3" fill="currentColor" opacity="0.85" />
      <rect x="2" y="10" width="22" height="14" rx="2" fill="currentColor" />
      <rect x="26" y="14" width="16" height="10" rx="2" fill="currentColor" opacity="0.9" />
      <rect x="44" y="14" width="16" height="10" rx="2" fill="currentColor" opacity="0.9" />
      <rect x="62" y="14" width="16" height="10" rx="2" fill="currentColor" opacity="0.9" />
      <rect x="4" y="12" width="18" height="10" rx="1.5" fill="white" opacity="0.25" />
      <circle cx="14" cy="42" r="5" fill="white" stroke="currentColor" strokeWidth="2" />
      <circle cx="14" cy="42" r="2" fill="currentColor" />
      <circle cx="64" cy="42" r="5" fill="white" stroke="currentColor" strokeWidth="2" />
      <circle cx="64" cy="42" r="2" fill="currentColor" />
      <circle cx="48" cy="42" r="5" fill="white" stroke="currentColor" strokeWidth="2" />
      <circle cx="48" cy="42" r="2" fill="currentColor" />
      <rect x="6" y="20" width="4" height="2" rx="1" fill="white" opacity="0.5" />
    </svg>
  );
}

function LanguageCycleButton() {
  const { locale, setLocale } = useTranslation();

  const cycleLocale = () => {
    const idx = LOCALES.indexOf(locale);
    const next = LOCALES[(idx + 1) % LOCALES.length] as Locale;
    setLocale(next);
  };

  const code = LOCALE_FLAG_CODES[locale];
  const FlagComponent = FLAG_SVG[code];

  return (
    <button
      onClick={cycleLocale}
      title={`Language: ${locale.toUpperCase()}`}
      className="w-9 h-9 rounded-full bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 flex items-center justify-center transition-colors overflow-hidden select-none"
      aria-label="Switch language"
    >
      {FlagComponent && (
        <FlagComponent className="w-6 h-auto" aria-hidden="true" />
      )}
    </button>
  );
}

function ThemeToggleButton() {
  const { theme, toggleTheme } = useTheme();
  const { t } = useTranslation();

  return (
    <button
      onClick={toggleTheme}
      title={theme === "dark" ? t("theme.light") : t("theme.dark")}
      className="w-9 h-9 rounded-full bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 flex items-center justify-center transition-colors text-slate-600 dark:text-slate-300"
      aria-label="Toggle theme"
    >
      {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
    </button>
  );
}

export function AuthControls() {
  return (
    <div className="fixed top-4 left-4 z-50 flex items-center gap-2">
      <LanguageCycleButton />
      <ThemeToggleButton />
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { name, userId, userType, logout } = useAuth();
  const { t } = useTranslation();
  const [, setLocation] = useLocation();

  const isDriver = userType === "سائق" && !!userId;
  const announcementUserType = isDriver ? "driver" : "customer";

  // ── Fan count (driver-only) ───────────────────────────────────────────────
  const [fanCount, setFanCount] = useState(0);
  const [fansModalOpen, setFansModalOpen] = useState(false);
  const [fans, setFans] = useState<string[]>([]);
  const [fansLoading, setFansLoading] = useState(false);

  useEffect(() => {
    if (!isDriver || !userId) return;
    const fetchFanCount = () => {
      customFetch<{ fanCount: number }>("/api/favorite-drivers/fan-count")
        .then(data => setFanCount(data.fanCount))
        .catch(() => {});
    };
    fetchFanCount();
    const interval = setInterval(fetchFanCount, 60_000);
    return () => clearInterval(interval);
  }, [isDriver, userId]);

  const handleFansClick = async () => {
    setFansModalOpen(true);
    setFansLoading(true);
    try {
      const data = await customFetch<{ fans: string[] }>("/api/favorite-drivers/fans");
      setFans(data.fans);
    } catch { /* silently fail */ }
    finally { setFansLoading(false); }
  };

  useDriverOrderWatcher(isDriver);
  useSocketConnection(userId ?? null, isDriver);

  const notifCount = useOrderNotificationStore((s) => s.count);
  const resetNotif = useOrderNotificationStore((s) => s.reset);

  const { announcements, unreadCount, dismissAnnouncement } = useAnnouncements(
    userId ?? null,
    announcementUserType
  );

  const [panelOpen, setPanelOpen] = useState(false);

  // Support chat
  const { isOpen: supportOpen, open: openSupport, close: closeSupport } = useSupportChatStore();
  const { hasUnread, latestAdminMsgId, markViewed, refetch: refetchUnread } = useSupportUnread(userId ?? null);
  const autoOpenedForRef = useRef<string | null>(null);

  const handleSupportOpen = () => {
    markViewed();
    openSupport();
  };

  // Auto-open chat when there is a new unread admin reply
  useEffect(() => {
    if (!hasUnread || !latestAdminMsgId) return;
    if (supportOpen) return;
    if (autoOpenedForRef.current === latestAdminMsgId) return;
    autoOpenedForRef.current = latestAdminMsgId;
    openSupport();
  }, [hasUnread, latestAdminMsgId, supportOpen, openSupport]);

  // Re-check unread when support chat closes
  useEffect(() => {
    if (!supportOpen) {
      refetchUnread();
    }
  }, [supportOpen]);

  // Reset driver order notifications when panel opens
  useEffect(() => {
    if (panelOpen) {
      resetNotif();
    }
  }, [panelOpen]);

  const handleBellClick = () => setPanelOpen(true);

  const handleLogout = () => {
    logout();
    setLocation("/");
  };

  // Total badge = unread announcements + pending order notifications (drivers)
  const totalBadge = unreadCount + (isDriver ? notifCount : 0);

  return (
    <div className="min-h-[100dvh] flex flex-col w-full relative">
      <WaterDrops />
      <header className="sticky top-0 z-50 glass-panel border-b-0 border-white/20">
        <div className="max-w-md mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
              <WaterTruckIcon className="w-7 h-5 text-primary" />
            </div>
            <span className="font-bold text-lg text-primary tracking-tight">Mizu</span>
          </div>

          <div className="flex items-center gap-2">
            <LanguageCycleButton />
            <ThemeToggleButton />

            {name && (
              <>
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200 hidden sm:block">
                  {t("nav.greeting")}، {name}
                </span>

                {/* Fan count button — drivers only */}
                {isDriver && (
                  <button
                    onClick={handleFansClick}
                    className="relative w-9 h-9 rounded-full bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 flex flex-col items-center justify-center transition-colors gap-0"
                    title="جماهيري"
                    aria-label="جماهيري"
                  >
                    <span className="text-sm leading-none">🎉</span>
                    <span className="text-[9px] font-bold text-slate-600 dark:text-slate-300 leading-none">
                      {fanCount}
                    </span>
                  </button>
                )}

                {/* Support chat button */}
                <button
                  onClick={handleSupportOpen}
                  className="relative w-9 h-9 rounded-full bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 flex items-center justify-center transition-colors text-slate-600 dark:text-slate-300"
                  title="الدعم الفني"
                  aria-label="الدعم الفني"
                >
                  <HeadphonesIcon className={`w-4 h-4 ${hasUnread ? "text-primary" : ""}`} />
                  {hasUnread && (
                    <span className="absolute -top-1 -right-1 w-[10px] h-[10px] rounded-full bg-red-500 shadow-md" />
                  )}
                </button>

                {/* Announcements bell — visible to all logged-in users */}
                <button
                  onClick={handleBellClick}
                  className="relative w-9 h-9 rounded-full bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 flex items-center justify-center transition-colors text-slate-600 dark:text-slate-300"
                  title="الإعلانات"
                  aria-label="الإعلانات"
                >
                  <Bell
                    className={`w-4 h-4 ${totalBadge > 0 ? "text-primary animate-bounce" : ""}`}
                  />
                  {totalBadge > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-black flex items-center justify-center leading-none shadow-md">
                      {totalBadge > 99 ? "99+" : totalBadge}
                    </span>
                  )}
                </button>

                <button
                  onClick={() => setLocation("/profile")}
                  className="w-9 h-9 rounded-full bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 flex items-center justify-center transition-colors text-slate-600 dark:text-slate-300"
                  title="الملف الشخصي"
                  data-testid="button-profile"
                >
                  <UserCircle className="w-4 h-4" />
                </button>
                <button
                  onClick={handleLogout}
                  className="w-9 h-9 rounded-full bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 flex items-center justify-center transition-colors text-slate-600 dark:text-slate-300"
                  data-testid="button-logout"
                  title={t("nav.logout")}
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-md mx-auto p-4 pb-20 flex flex-col relative z-10">
        {children}
      </main>

      {/* Announcements panel — rendered outside main so it can overlay everything */}
      <AnnouncementsPanel
        isOpen={panelOpen}
        onClose={() => setPanelOpen(false)}
        announcements={announcements}
        onDismiss={dismissAnnouncement}
      />

      {/* Support chat modal — globally controlled via store */}
      {supportOpen && userId && (
        <SupportChatModal
          userId={userId}
          userName={name ?? ""}
          onClose={closeSupport}
        />
      )}

      {/* Fans modal — driver-only */}
      {fansModalOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center"
          onClick={() => setFansModalOpen(false)}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div
            className="relative bg-white dark:bg-slate-900 rounded-t-3xl p-6 w-full max-w-md max-h-[70dvh] overflow-y-auto animate-in slide-in-from-bottom-4 duration-300 shadow-2xl"
            dir="rtl"
            onClick={e => e.stopPropagation()}
          >
            {/* Handle bar */}
            <div className="w-10 h-1 bg-slate-200 dark:bg-slate-700 rounded-full mx-auto mb-4" />
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-bold text-slate-800 dark:text-white text-lg">جماهيري 🎉</h3>
              <button
                onClick={() => setFansModalOpen(false)}
                className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
              >
                ✕
              </button>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-5">
              هؤلاء المستهلكون اختاروك كسائقهم المفضل 🎉
            </p>

            {fansLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
              </div>
            ) : fans.length === 0 ? (
              <div className="flex flex-col items-center py-10 text-center gap-3">
                <span className="text-4xl">🌟</span>
                <p className="text-slate-500 dark:text-slate-400 text-sm leading-relaxed max-w-[220px]">
                  ما عندك جماهير بعد — واصل في عملك وسيأتون!
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {fans.map((fanName, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-3 bg-slate-50 dark:bg-slate-800/60 rounded-2xl px-4 py-3"
                  >
                    <div className="w-8 h-8 bg-rose-100 dark:bg-rose-900/30 rounded-full flex items-center justify-center shrink-0">
                      <User className="w-4 h-4 text-rose-500" />
                    </div>
                    <span className="font-medium text-slate-800 dark:text-white text-sm">{fanName}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
