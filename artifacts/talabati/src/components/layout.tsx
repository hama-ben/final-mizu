import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import {
  LogOut,
  Sun,
  Moon,
  UserCircle,
  Megaphone,
  HeadphonesIcon,
  User,
  Loader2,
  Menu,
  X,
  Globe2,
  PauseCircle,
  Send,
  Dices,
  Ticket,
} from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { useTheme } from "@/lib/theme";
import { useTranslation, LOCALES, LOCALE_FLAG_CODES, type Locale } from "@/lib/i18n";
import { DZ, FR, GB } from "country-flag-icons/react/3x2";
import type { ComponentType } from "react";

// The flag package's SVG prop type is narrower than React's generic SVG props.
// Keep the registry flexible while preserving the typed component usage below.
const FLAG_SVG: Record<string, ComponentType<any>> = { DZ, FR, GB };
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
  const { t, locale, setLocale } = useTranslation();
  const { theme, toggleTheme } = useTheme();
  const [, setLocation] = useLocation();
  const menuRef = useRef<HTMLDivElement>(null);

  const cycleLanguage = () => {
    const idx = LOCALES.indexOf(locale);
    const next = LOCALES[(idx + 1) % LOCALES.length] as Locale;
    setLocale(next);
  };

  const isDriver = userType === "سائق" && !!userId;
  const announcementUserType = isDriver ? "driver" : "customer";

  // ── Fan count (driver-only) ───────────────────────────────────────────────
  const [fanCount, setFanCount] = useState(0);
  const [availableSpins, setAvailableSpins] = useState(0);
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

  useEffect(() => {
    if (!userId) return;
    const fetchSpinBalance = () => {
      customFetch<{ availableSpins: number }>("/api/wheel-spins/balance")
        .then((data) => setAvailableSpins(data.availableSpins))
        .catch(() => {});
    };
    fetchSpinBalance();
    const interval = setInterval(fetchSpinBalance, 30_000);
    return () => clearInterval(interval);
  }, [userId]);

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [suspensionModalOpen, setSuspensionModalOpen] = useState(false);
  const [suspensionReason, setSuspensionReason] = useState("");
  const [suspensionReasonText, setSuspensionReasonText] = useState("");
  const [suspensionPending, setSuspensionPending] = useState(false);
  const [liftPending, setLiftPending] = useState(false);
  const [isSuspended, setIsSuspended] = useState(false);
  const [suspensionRequestType, setSuspensionRequestType] = useState<"suspend" | "lift">("suspend");
  const [suspensionLoading, setSuspensionLoading] = useState(false);
  const [suspensionError, setSuspensionError] = useState("");
  const [suspensionSubmitted, setSuspensionSubmitted] = useState(false);

  useEffect(() => {
    if (!isDriver) return;
    const fetchSuspensionStatus = () => {
      Promise.all([
        customFetch<{ pendingSuspend: boolean; pendingLift: boolean }>("/api/driver/suspension-requests"),
        customFetch<{ isSuspended?: boolean }>(`/api/driver/${userId}/account`),
      ])
        .then(([requests, account]) => {
          setSuspensionPending(requests.pendingSuspend);
          setLiftPending(requests.pendingLift);
          setIsSuspended(account.isSuspended === true);
        })
        .catch(() => {});
    };
    fetchSuspensionStatus();
    const interval = setInterval(fetchSuspensionStatus, 30_000);
    return () => clearInterval(interval);
  }, [isDriver, userId]);

  const openSuspensionModal = (requestType: "suspend" | "lift") => {
    setMenuOpen(false);
    setSuspensionReason("");
    setSuspensionReasonText("");
    setSuspensionError("");
    setSuspensionSubmitted(false);
    setSuspensionRequestType(requestType);
    setSuspensionModalOpen(true);
  };

  const submitSuspensionRequest = async () => {
    if (!suspensionReason) {
      setSuspensionError("يرجى اختيار سبب التعليق");
      return;
    }
    if (suspensionReason === "سبب آخر" && !suspensionReasonText.trim()) {
      setSuspensionError("يرجى كتابة تفاصيل السبب");
      return;
    }

    setSuspensionError("");
    setSuspensionLoading(true);
    try {
      await customFetch("/api/driver/suspension-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestType: suspensionRequestType,
          reason: suspensionReason,
          ...(suspensionReason === "سبب آخر"
            ? { reasonText: suspensionReasonText.trim() }
            : {}),
        }),
      });
      if (suspensionRequestType === "lift") {
        setLiftPending(true);
      } else {
        setSuspensionPending(true);
      }
      setSuspensionSubmitted(true);
    } catch (err: unknown) {
      const apiError = err as { data?: { error?: string } } | null;
      setSuspensionError(apiError?.data?.error ?? "تعذّر إرسال الطلب");
    } finally {
      setSuspensionLoading(false);
    }
  };

  // The menu is intentionally shared by both account types. It closes on
  // outside clicks and Escape, matching the behavior of a single dropdown.
  useEffect(() => {
    if (!menuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

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
    setMenuOpen(false);
    logout();
    setLocation("/");
  };

  // Total badge = unread announcements + pending order notifications (drivers)
  const totalBadge = unreadCount + (isDriver ? notifCount : 0);

  return (
    <div className="min-h-[100dvh] flex flex-col w-full relative">
      <WaterDrops />
      <header className="sticky top-0 z-50 glass-panel border-b-0 border-white/20">
        <div
          className="relative max-w-md mx-auto px-4 h-16 flex items-center justify-center"
          dir="ltr"
        >
          {/* The hamburger is the only control at the far left. */}
          <div ref={menuRef} className="absolute left-4 top-1/2 -translate-y-1/2">
            <button
              onClick={() => setMenuOpen((open) => !open)}
              className="w-9 h-9 rounded-full bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 flex items-center justify-center transition-colors text-slate-600 dark:text-slate-300"
              title="القائمة"
              aria-label="فتح القائمة"
              aria-expanded={menuOpen}
              aria-controls="account-menu"
              data-testid="button-menu"
            >
              {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>

            {menuOpen && (
              <div
                id="account-menu"
                className="absolute left-0 top-12 w-64 rounded-2xl border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 shadow-2xl animate-in fade-in-0 zoom-in-95 duration-150"
                dir="rtl"
                role="menu"
              >
                {name && (
                  <div className="px-3 py-2 mb-1 border-b border-slate-100 dark:border-slate-800">
                    <p className="text-xs text-slate-500 dark:text-slate-400">{t("nav.greeting")}</p>
                    <p className="font-bold text-slate-800 dark:text-white truncate">{name}</p>
                  </div>
                )}

                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setLocation("/profile");
                  }}
                  className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-right text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  title="الملف الشخصي"
                  data-testid="button-profile"
                  role="menuitem"
                >
                  <UserCircle className="w-4 h-4 text-slate-500" />
                  <span>الملف الشخصي</span>
                </button>

                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setLocation("/wheel");
                  }}
                  className="w-full flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-right text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  title="عجلة الحظ"
                  role="menuitem"
                  data-testid="button-wheel"
                >
                  <span className="flex items-center gap-3">
                    <Dices className="w-4 h-4 text-violet-500" />
                    <span>عجلة الحظ</span>
                  </span>
                  <span className="min-w-[20px] h-5 px-1 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 text-[10px] font-black flex items-center justify-center">
                    {availableSpins}
                  </span>
                </button>

                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setLocation("/coupons");
                  }}
                  className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-right text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  title="قسائمي"
                  role="menuitem"
                  data-testid="button-coupons"
                >
                  <Ticket className="w-4 h-4 text-violet-500" />
                  <span>قسائمي</span>
                </button>

                <button
                  onClick={() => {
                    setMenuOpen(false);
                    handleBellClick();
                  }}
                  className="w-full flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-right text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  title="الإشعارات"
                  role="menuitem"
                >
                  <span className="flex items-center gap-3">
                    <Megaphone className={`w-4 h-4 ${totalBadge > 0 ? "text-primary" : "text-slate-500"}`} />
                    <span>الإشعارات</span>
                  </span>
                  {totalBadge > 0 && (
                    <span className="min-w-[20px] h-5 px-1 rounded-full bg-red-500 text-white text-[10px] font-black flex items-center justify-center">
                      {totalBadge > 99 ? "99+" : totalBadge}
                    </span>
                  )}
                </button>

                {isDriver && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      handleSupportOpen();
                    }}
                    className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-right text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                    title="الدعم الفني"
                    aria-label="الدعم الفني"
                    role="menuitem"
                  >
                    <HeadphonesIcon className={`w-4 h-4 ${hasUnread ? "text-primary" : "text-slate-500"}`} />
                    <span>الدعم الفني</span>
                    {hasUnread && (
                      <span className="mr-auto w-2 h-2 rounded-full bg-red-500 shadow-md" />
                    )}
                  </button>
                )}

                {isDriver && (
                  <button
                    onClick={() => openSuspensionModal("suspend")}
                    disabled={suspensionPending}
                    className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-right text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                    title="طلب تعليق الحساب"
                    aria-label="طلب تعليق الحساب"
                    role="menuitem"
                  >
                    <PauseCircle className={`w-4 h-4 ${suspensionPending ? "text-amber-500" : "text-slate-500"}`} />
                    <span>{suspensionPending ? "طلب قيد المراجعة" : "طلب تعليق الحساب"}</span>
                  </button>
                )}

                {isDriver && isSuspended && (
                  <button
                    onClick={() => openSuspensionModal("lift")}
                    disabled={liftPending}
                    className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-right text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                    title="طلب إلغاء تعليق الحساب"
                    aria-label="طلب إلغاء تعليق الحساب"
                    role="menuitem"
                  >
                    <PauseCircle className={`w-4 h-4 ${liftPending ? "text-amber-500" : "text-slate-500"}`} />
                    <span>{liftPending ? "طلب قيد المراجعة" : "طلب إلغاء تعليق الحساب"}</span>
                  </button>
                )}

                <button
                  onClick={() => {
                    setMenuOpen(false);
                    toggleTheme();
                  }}
                  className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-right text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  role="menuitem"
                >
                  {theme === "dark" ? (
                    <Sun className="w-4 h-4 text-slate-500" />
                  ) : (
                    <Moon className="w-4 h-4 text-slate-500" />
                  )}
                  <span>الوضع الليلي/الفاتح</span>
                </button>

                <button
                  onClick={() => {
                    setMenuOpen(false);
                    cycleLanguage();
                  }}
                  className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-right text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  title="تبديل اللغة"
                  role="menuitem"
                >
                  <Globe2 className="w-4 h-4 text-slate-500" />
                  <span>تبديل اللغة</span>
                </button>

                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-right text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                  data-testid="button-logout"
                  title={t("nav.logout")}
                  role="menuitem"
                >
                  <LogOut className="w-4 h-4" />
                  <span>{t("nav.logout")}</span>
                </button>
              </div>
            )}
          </div>

          {/* Exactly three controls remain beside the centered brand:
              account-specific action | Mizu | support/announcements. */}
          <div className="flex items-center gap-2">
            {isDriver ? (
              <button
                onClick={handleBellClick}
                className="relative w-9 h-9 rounded-full bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 flex items-center justify-center transition-colors text-slate-600 dark:text-slate-300"
                title="الإعلانات"
                aria-label="الإعلانات"
              >
                <Megaphone
                  className={`w-4 h-4 ${totalBadge > 0 ? "text-primary animate-bounce" : ""}`}
                />
                {totalBadge > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-black flex items-center justify-center leading-none shadow-md">
                    {totalBadge > 99 ? "99+" : totalBadge}
                  </span>
                )}
              </button>
            ) : (
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
            )}

            <div className="flex items-center gap-2 mx-1">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                <WaterTruckIcon className="w-7 h-5 text-primary" />
              </div>
              <span className="font-bold text-lg text-primary tracking-tight">Mizu</span>
            </div>

            {isDriver ? (
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
            ) : (
              <button
                onClick={handleBellClick}
                className="relative w-9 h-9 rounded-full bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 flex items-center justify-center transition-colors text-slate-600 dark:text-slate-300"
                title="الإعلانات"
                aria-label="الإعلانات"
              >
                <Megaphone
                  className={`w-4 h-4 ${totalBadge > 0 ? "text-primary animate-bounce" : ""}`}
                />
                {totalBadge > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-black flex items-center justify-center leading-none shadow-md">
                    {totalBadge > 99 ? "99+" : totalBadge}
                  </span>
                )}
              </button>
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

      {suspensionModalOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center"
          onClick={() => !suspensionLoading && setSuspensionModalOpen(false)}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div
            className="relative bg-white dark:bg-slate-900 rounded-t-3xl p-6 w-full max-w-md shadow-2xl animate-in slide-in-from-bottom-4 duration-300"
            dir="rtl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="w-10 h-1 bg-slate-200 dark:bg-slate-700 rounded-full mx-auto mb-4" />
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-bold text-slate-800 dark:text-white text-lg">
                {suspensionRequestType === "lift" ? "طلب إلغاء تعليق الحساب" : "طلب تعليق الحساب"}
              </h3>
              <button
                onClick={() => setSuspensionModalOpen(false)}
                disabled={suspensionLoading}
                className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 disabled:opacity-50"
                aria-label="إغلاق"
              >
                ✕
              </button>
            </div>

            {suspensionSubmitted ? (
              <div className="mt-5 rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700 p-4 text-center">
                <p className="font-bold text-emerald-700 dark:text-emerald-300">تم إرسال طلبك وهو قيد المراجعة</p>
                <button
                  onClick={() => setSuspensionModalOpen(false)}
                  className="mt-4 w-full rounded-2xl bg-emerald-600 py-3 text-sm font-bold text-white"
                >
                  إغلاق
                </button>
              </div>
            ) : (
              <>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-4 mb-4">
                  {suspensionRequestType === "lift"
                    ? "اختر سبب طلب إلغاء تعليق حسابك"
                    : "اختر سبب طلب تعليق حسابك"}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {["إشغال الشاحنة", "سبب مرضي", "عطلة شخصية", "سبب آخر"].map((reason) => (
                    <button
                      key={reason}
                      onClick={() => { setSuspensionReason(reason); setSuspensionError(""); }}
                      className={`rounded-xl border px-3 py-3 text-sm font-medium transition-colors ${
                        suspensionReason === reason
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                      }`}
                    >
                      {reason}
                    </button>
                  ))}
                </div>
                {suspensionReason === "سبب آخر" && (
                  <textarea
                    value={suspensionReasonText}
                    onChange={(event) => setSuspensionReasonText(event.target.value)}
                    rows={3}
                    className="mt-3 w-full rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-3 text-sm text-slate-800 dark:text-white resize-none focus:outline-none focus:ring-2 focus:ring-primary"
                    placeholder="اكتب تفاصيل السبب"
                    required
                  />
                )}
                {suspensionError && <p className="mt-3 text-xs text-red-500">{suspensionError}</p>}
                <button
                  onClick={submitSuspensionRequest}
                  disabled={
                    suspensionLoading ||
                    (suspensionRequestType === "lift" ? liftPending : suspensionPending)
                  }
                  className="mt-5 w-full flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-primary to-cyan-500 py-3 font-bold text-white shadow-lg disabled:opacity-60"
                >
                  {suspensionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  إرسال الطلب
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
