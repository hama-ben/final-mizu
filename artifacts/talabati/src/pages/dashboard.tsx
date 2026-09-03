import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Layout } from "@/components/layout";
import { useTranslation } from "@/lib/i18n";
import { useCreateOrder, useGetUserOrders, getGetUserOrdersQueryKey, customFetch } from "@workspace/api-client-react";
import { useCancelOrder } from "@/hooks/use-cancel-order";
import { useQueryClient } from "@tanstack/react-query";
import { Droplet, ShoppingBag, ListOrdered, CircleCheck as CheckCircle2, Truck, Clock, ArrowRight, Loader as Loader2, MapPin, Bell, X, User, Phone, Circle as XCircle, Star, Bookmark, BookmarkCheck, Trash2, Headphones as HeadphonesIcon, Heart, Search, RefreshCw, Share2, Copy, Check, Users, Trophy, AlertTriangle, Wallet } from "lucide-react";
import { getSocket } from "@/lib/socket-client";
import { useRealtimeOrderStatus } from "@/hooks/use-realtime-order-status";
import { format } from "date-fns";
import { playNotificationSound, stopNotificationSound, CONSUMER_ARRIVAL_SOUND_KEY } from "@/hooks/use-notification-sound";
import { useSupportChatStore } from "@/stores/support-chat";
import { supabase } from "@/lib/supabase";
import { getSessionBootReady } from "@/hooks/use-auth";

type View = "menu" | "new-order" | "my-orders" | "no-driver-contest";

interface FavoriteDriver {
  id: string;
  driverId: string;
  driverName: string;
  currentStatus: string;
  createdAt: string;
}

interface SearchDriver {
  driverId: string;
  driverName: string;
  currentStatus: string;
  isFavorite: boolean;
}

const VOLUMES = ["5ل", "10ل", "15ل", "20ل", "30ل", "40ل", "50ل", "100ل", "150ل", "200ل", "300ل", "500ل", "1000ل"];

const PRICE_MAP: Record<string, number> = {
  "5ل": 20, "10ل": 30, "15ل": 40, "20ل": 60,
  "30ل": 70, "40ل": 100, "50ل": 120, "100ل": 250,
  "150ل": 300, "200ل": 400, "300ل": 600, "500ل": 1000,
  "1000ل": 1600,
};


interface DriverAcceptedInfo {
  driverName: string | null;
  driverPhone: string | null;
  orderId: string;
}

interface NoDriverContestSnapshot {
  status: "available" | "active" | "completed" | "cancelled" | "already_used" | "unavailable";
  name: string;
  qualifiedDrivers: number;
  requiredDrivers: number;
  referralCode: string | null;
  startedAt: string | null;
}

export default function Dashboard() {
  const { userId, userType, name, email } = useAuth();
  const { t } = useTranslation();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("menu");
  const [activeContest, setActiveContest] = useState<NoDriverContestSnapshot | null>(null);
  const [orderTimeoutNotice, setOrderTimeoutNotice] = useState<{
    kind: "warning" | "expired";
    message: string;
    contest?: NoDriverContestSnapshot | null;
  } | null>(null);
  const [showArrivalModal, setShowArrivalModal] = useState(false);
  const [showDriverAcceptedModal, setShowDriverAcceptedModal] = useState(false);
  const [driverAcceptedInfo, setDriverAcceptedInfo] = useState<DriverAcceptedInfo | null>(null);
  const arrivedOrderIdRef = useRef<string | null>(null);
  const acceptedOrderIdRef = useRef<Set<string>>(new Set());
  const arrivalLoopRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Favorite window expiry modal (Socket "favorite_window_expired") ─────────
  const [favoriteWindowModal, setFavoriteWindowModal] = useState<{ orderId: string } | null>(null);

  useEffect(() => {
    if (!userId) return;
    const socket = getSocket();
    const handler = (payload: { orderId: string }) => {
      setFavoriteWindowModal({ orderId: payload.orderId });
    };
    socket.on("favorite_window_expired", handler);
    return () => { socket.off("favorite_window_expired", handler); };
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    const socket = getSocket();
    const handleWarning = (payload: { message?: string }) => {
      setOrderTimeoutNotice({
        kind: "warning",
        message: payload.message || "لا يوجد سائق بعد، انتبه إلى طلبك",
      });
      queryClient.invalidateQueries({ queryKey: getGetUserOrdersQueryKey(userId) });
    };
    const handleExpired = (payload: {
      message?: string;
      contest?: NoDriverContestSnapshot | null;
    }) => {
      const contest = payload.contest?.status === "active" ? payload.contest : null;
      if (contest) setActiveContest(contest);
      setOrderTimeoutNotice({
        kind: "expired",
        message: payload.message || "انتهت صلاحية طلبك بعد 12 ساعة لعدم قبول أي سائق.",
        contest,
      });
      queryClient.invalidateQueries({ queryKey: getGetUserOrdersQueryKey(userId) });
    };
    socket.on("order_timeout_warning", handleWarning);
    socket.on("order_expired", handleExpired);
    return () => {
      socket.off("order_timeout_warning", handleWarning);
      socket.off("order_expired", handleExpired);
    };
  }, [userId, queryClient]);

  const handleRenewFavoriteWindow = async () => {
    if (!favoriteWindowModal) return;
    try {
      await customFetch(`/api/orders/${favoriteWindowModal.orderId}/renew-favorite-window`, { method: "POST" });
    } catch { /* silently fail — server already cleared window; renewal may 404 but that's fine */ }
    setFavoriteWindowModal(null);
  };

  const openSupport = useSupportChatStore((s) => s.open);

  useEffect(() => {
    if (!userId || userType !== "مستهلك") return;
    const refreshContestEntry = () => {
      customFetch<NoDriverContestSnapshot>("/api/no-driver-contest")
        .then((snapshot) => setActiveContest(snapshot.status === "active" ? snapshot : null))
        .catch(() => {});
    };
    refreshContestEntry();
    const interval = window.setInterval(refreshContestEntry, 15_000);
    return () => window.clearInterval(interval);
  }, [userId, userType]);

  if (!userId) { setLocation("/"); return null; }
  if (userType === "سائق") { setLocation("/driver-dashboard"); return null; }

  const startArrivalLoop = () => {
    stopArrivalLoop();
    playNotificationSound(CONSUMER_ARRIVAL_SOUND_KEY);
    arrivalLoopRef.current = setInterval(() => { playNotificationSound(CONSUMER_ARRIVAL_SOUND_KEY); }, 3000);
  };

  const stopArrivalLoop = () => {
    if (arrivalLoopRef.current !== null) {
      clearInterval(arrivalLoopRef.current);
      arrivalLoopRef.current = null;
    }
    // Stop any custom audio that may still be playing from the last interval tick
    stopNotificationSound();
  };

  const handleAcknowledge = () => { stopArrivalLoop(); setShowArrivalModal(false); };

  return (
    <Layout>
      <button
        onClick={() => setLocation("/debt-book")}
        className="w-full mb-4 rounded-3xl bg-gradient-to-r from-amber-500 to-orange-500 p-4 text-white shadow-lg shadow-amber-500/20 flex items-center justify-between text-right hover:opacity-95 transition-opacity"
        dir="rtl"
        data-testid="button-consumer-debts"
      >
        <span className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-2xl bg-white/20 flex items-center justify-center"><Wallet className="w-5 h-5" /></span>
          <span>
            <span className="block font-black">ديوني</span>
            <span className="block text-xs text-white/80 mt-1">تابع مشترياتك بالدين</span>
          </span>
        </span>
        <ArrowRight className="w-5 h-5 rotate-180" />
      </button>
      {orderTimeoutNotice && (
        <div
          className={`mb-4 rounded-3xl border p-4 shadow-sm ${
            orderTimeoutNotice.kind === "expired"
              ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-900/20 dark:text-red-300"
              : "border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900 dark:bg-orange-900/20 dark:text-orange-300"
          }`}
          dir="rtl"
          role="status"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="flex-1">
              <p className="font-bold">{orderTimeoutNotice.message}</p>
              {orderTimeoutNotice.contest && (
                <button
                  onClick={() => {
                    setOrderTimeoutNotice(null);
                    setView("no-driver-contest");
                  }}
                  className="mt-3 rounded-xl bg-violet-600 px-4 py-2 text-sm font-bold text-white hover:bg-violet-700"
                >
                  الدخول إلى المسابقة
                </button>
              )}
            </div>
            <button
              onClick={() => setOrderTimeoutNotice(null)}
              className="rounded-full p-1 opacity-70 hover:opacity-100"
              aria-label="إغلاق التنبيه"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
      {showArrivalModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-900 rounded-3xl p-8 mx-4 max-w-sm w-full shadow-2xl border border-sky-200 dark:border-sky-800 text-center animate-in zoom-in-95 duration-300">
            <div className="w-20 h-20 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-5 animate-bounce">
              <Truck className="w-10 h-10 text-amber-500" />
            </div>
            <h2 className="text-2xl font-black text-slate-800 dark:text-white mb-3">{t("dashboard.order.arrived")}</h2>
            <p className="text-slate-600 dark:text-slate-300 leading-relaxed mb-6">
              {t("dashboard.order.arrivedDesc")}
            </p>
            <button onClick={handleAcknowledge}
              className="w-full bg-gradient-to-r from-amber-400 to-orange-500 text-white font-bold py-3.5 rounded-2xl shadow-lg shadow-amber-400/30 hover:opacity-90 transition-all active:scale-[0.98]"
              data-testid="button-close-arrival-modal">
              حسناً، في الطريق
            </button>
          </div>
        </div>
      )}

      {showDriverAcceptedModal && driverAcceptedInfo && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-900 rounded-3xl p-8 mx-4 max-w-sm w-full shadow-2xl border border-emerald-200 dark:border-emerald-800 text-center animate-in zoom-in-95 duration-300" dir="rtl">
            <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-5">
              <Truck className="w-10 h-10 text-emerald-500" />
            </div>
            <h2 className="text-xl font-black text-slate-800 dark:text-white mb-2">{t("dashboard.order.accepted")}</h2>
            <p className="text-slate-500 text-sm mb-4">السائق التالي في طريقه إليك</p>
            <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700 rounded-2xl p-4 space-y-3 text-right mb-6">
              {driverAcceptedInfo.driverName && (
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-emerald-100 rounded-full flex items-center justify-center">
                    <User className="w-4 h-4 text-emerald-600" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">اسم السائق</p>
                    <p className="font-bold text-slate-800 dark:text-white">{driverAcceptedInfo.driverName}</p>
                  </div>
                </div>
              )}
              {driverAcceptedInfo.driverPhone && (
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-emerald-100 rounded-full flex items-center justify-center">
                    <Phone className="w-4 h-4 text-emerald-600" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">رقم الهاتف</p>
                    <a href={`tel:${driverAcceptedInfo.driverPhone}`} className="font-bold text-primary hover:underline">{driverAcceptedInfo.driverPhone}</a>
                  </div>
                </div>
              )}
            </div>
            <button onClick={() => setShowDriverAcceptedModal(false)}
              className="w-full bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-bold py-3.5 rounded-2xl shadow-lg hover:opacity-90 transition-all active:scale-[0.98]">
              حسناً، شكراً
            </button>
          </div>
        </div>
      )}

      {/* ── Favourite window expiry prompt ────────────────────────────────── */}
      {favoriteWindowModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-900 rounded-3xl p-8 mx-4 max-w-sm w-full shadow-2xl border border-sky-200 dark:border-sky-800 text-center animate-in zoom-in-95 duration-300" dir="rtl">
            <div className="w-16 h-16 bg-sky-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Heart className="w-8 h-8 text-sky-500" />
            </div>
            <h2 className="text-xl font-black text-slate-800 dark:text-white mb-2">انتهت مهلة سائقك المفضل</h2>
            <p className="text-slate-500 text-sm mb-6 leading-relaxed">
              هل تريد تجديدها 90 ثانية أخرى؟
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleRenewFavoriteWindow}
                className="flex-1 bg-gradient-to-r from-sky-500 to-primary text-white font-bold py-3 rounded-2xl hover:opacity-90 transition-all active:scale-[0.98]"
              >
                تجديد
              </button>
              <button
                onClick={() => setFavoriteWindowModal(null)}
                className="flex-1 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold py-3 rounded-2xl hover:bg-slate-200 dark:hover:bg-slate-700 transition-all active:scale-[0.98]"
              >
                لا، أرسل للجميع
              </button>
            </div>
          </div>
        </div>
      )}

      {view === "menu" && (
        <>
          <MenuView onSelect={setView} />
          {activeContest && (
            <button
              onClick={() => setView("no-driver-contest")}
              className="mt-4 w-full rounded-3xl border border-violet-200 dark:border-violet-800/60 bg-violet-50 dark:bg-violet-900/20 p-4 text-right shadow-sm hover:border-violet-400 transition-colors"
              dir="rtl"
              data-testid="button-resume-no-driver-contest"
            >
              <span className="flex items-center gap-3">
                <span className="w-10 h-10 rounded-2xl bg-violet-100 dark:bg-violet-900/50 flex items-center justify-center">
                  <Trophy className="w-5 h-5 text-violet-600 dark:text-violet-300" />
                </span>
                <span className="flex-1">
                  <span className="block font-black text-violet-900 dark:text-violet-100">مسابقة بلديتك ما زالت نشطة</span>
                  <span className="block text-xs text-violet-700/70 dark:text-violet-200/70 mt-1">
                    {activeContest.qualifiedDrivers}/{activeContest.requiredDrivers} سائقين مؤهلين — بدون مهلة زمنية
                  </span>
                </span>
                <ArrowRight className="w-5 h-5 text-violet-500 rotate-180" />
              </span>
            </button>
          )}
        </>
      )}
      {view === "new-order" && (
        <NewOrderView
          onBack={() => setView("menu")}
          onSuccess={() => setView("my-orders")}
          onEnterContest={() => setView("no-driver-contest")}
          userId={userId}
          queryClient={queryClient}
        />
      )}
      {view === "no-driver-contest" && (
        <NoDriverContestView
          userId={userId}
          consumerName={name ?? ""}
          onBack={() => setView("menu")}
        />
      )}
      {view === "my-orders" && (
        <MyOrdersView
          onBack={() => setView("menu")}
          userId={userId}
          onDriverArrived={(orderId) => {
            if (arrivedOrderIdRef.current !== orderId) {
              arrivedOrderIdRef.current = orderId;
              setShowArrivalModal(true);
              startArrivalLoop();
            }
          }}
          onDriverAccepted={(info) => {
            if (!acceptedOrderIdRef.current.has(info.orderId)) {
              acceptedOrderIdRef.current.add(info.orderId);
              setDriverAcceptedInfo(info);
              setShowDriverAcceptedModal(true);
            }
          }}
          queryClient={queryClient}
        />
      )}

      {/* ── Feature 5: Customer Service floating button ───────────────── */}
      <button onClick={() => openSupport()}
        className="fixed bottom-6 left-6 w-14 h-14 bg-primary text-white rounded-full flex items-center justify-center shadow-xl shadow-primary/30 hover:scale-105 active:scale-95 transition-all z-50"
        data-testid="button-support" title="تواصل مع الدعم">
        <HeadphonesIcon className="w-6 h-6" />
      </button>
    </Layout>
  );
}

// ─── Star Rating Modal ────────────────────────────────────────────────────────
interface RatingModalProps {
  orderId: string;
  raterUserId: string;
  ratedUserId: string;
  raterType: "consumer" | "driver";
  ratedName?: string;
  onClose: () => void;
  onSubmitted: () => void;
}
function RatingModal({ orderId, raterUserId, ratedUserId, raterType, ratedName, onClose, onSubmitted }: RatingModalProps) {
  const [stars, setStars] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const submitRating = async () => {
    if (stars === 0) { setError("يرجى اختيار عدد النجوم"); return; }
    setLoading(true); setError("");
    try {
      await customFetch<{ id: string }>(`/api/orders/${orderId}/rate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raterUserId, ratedUserId, raterType, stars, comment: comment.trim() || undefined }),
      });
      setDone(true);
      setTimeout(() => { onSubmitted(); }, 1500);
    } catch (err: any) {
      setError(err?.data?.error || "تعذّر الإرسال، يرجى المحاولة مرة أخرى");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white dark:bg-slate-900 rounded-3xl p-6 mx-4 max-w-sm w-full shadow-2xl border border-primary/20 animate-in zoom-in-95 duration-300" dir="rtl">
        {done ? (
          <div className="text-center py-4">
            <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <CheckCircle2 className="w-8 h-8 text-emerald-500" />
            </div>
            <p className="font-bold text-slate-800 dark:text-white">شكراً على تقييمك!</p>
          </div>
        ) : (
          <>
            <button onClick={onClose} className="absolute top-4 left-4 w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 hover:bg-slate-200">
              <X className="w-4 h-4" />
            </button>
            <h3 className="font-bold text-slate-800 dark:text-white mb-1 text-lg">قيّم التوصيل</h3>
            {ratedName && <p className="text-sm text-slate-500 mb-4">{ratedName}</p>}
            <div className="flex items-center justify-center gap-2 mb-5">
              {[1, 2, 3, 4, 5].map(n => (
                <button key={n} onMouseEnter={() => setHovered(n)} onMouseLeave={() => setHovered(0)} onClick={() => setStars(n)}
                  className="transition-transform hover:scale-110 active:scale-95">
                  <Star className={`w-10 h-10 ${n <= (hovered || stars) ? "fill-amber-400 text-amber-400" : "text-slate-300"}`} />
                </button>
              ))}
            </div>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="أضف تعليقاً (اختياري)..."
              rows={3}
              className="w-full border border-slate-200 dark:border-slate-700 rounded-2xl p-3 text-sm resize-none outline-none focus:ring-2 focus:ring-primary/40 bg-white dark:bg-slate-800 text-slate-800 dark:text-white mb-4"
            />
            {error && <p className="text-red-500 text-xs mb-3">{error}</p>}
            <button onClick={submitRating} disabled={loading || stars === 0}
              className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-primary to-cyan-500 text-white font-bold flex items-center justify-center gap-2 disabled:opacity-50 transition-all hover:opacity-90">
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Star className="w-5 h-5 fill-white" />}
              إرسال التقييم
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function MenuView({ onSelect }: { onSelect: (view: View) => void }) {
  const { t } = useTranslation();

  const [favorites, setFavorites] = useState<FavoriteDriver[]>([]);
  const [favLoading, setFavLoading] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchDrivers, setSearchDrivers] = useState<SearchDriver[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [addingSearchDriverId, setAddingSearchDriverId] = useState<string | null>(null);
  const [searchAddError, setSearchAddError] = useState("");

  useEffect(() => {
    customFetch<FavoriteDriver[]>("/api/favorite-drivers")
      .then(setFavorites)
      .catch(() => {})
      .finally(() => setFavLoading(false));
  }, []);

  const handleRemoveFavorite = async (driverId: string) => {
    setRemovingId(driverId);
    try {
      await customFetch(`/api/favorite-drivers/${driverId}`, { method: "DELETE" });
      setFavorites(prev => prev.filter(f => f.driverId !== driverId));
    } catch { /* silently fail */ }
    finally { setRemovingId(null); }
  };

  const openDriverSearch = async () => {
    setSearchOpen(true);
    setSearchQuery("");
    setSearchError("");
    setSearchAddError("");
    setSearchLoading(true);
    try {
      const data = await customFetch<{ drivers: SearchDriver[] }>(
        "/api/favorite-drivers/search",
      );
      setSearchDrivers(data.drivers);
    } catch {
      setSearchDrivers([]);
      setSearchError("تعذّر تحميل السائقين في بلديتك حالياً");
    } finally {
      setSearchLoading(false);
    }
  };

  const handleAddSearchFavorite = async (driver: SearchDriver) => {
    setAddingSearchDriverId(driver.driverId);
    setSearchAddError("");
    try {
      const result = await customFetch<{ id: string; driverId: string; createdAt: string }>(
        "/api/favorite-drivers",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ driverId: driver.driverId }),
        },
      );

      setFavorites((previous) => (
        previous.some((favorite) => favorite.driverId === driver.driverId)
          ? previous
          : [...previous, {
              id: result.id,
              driverId: driver.driverId,
              driverName: driver.driverName,
              currentStatus: driver.currentStatus,
              createdAt: result.createdAt,
            }]
      ));
      setSearchDrivers((previous) => previous.map((candidate) => (
        candidate.driverId === driver.driverId
          ? { ...candidate, isFavorite: true }
          : candidate
      )));
    } catch (err: unknown) {
      const error = err as { data?: { error?: string } };
      setSearchAddError(error?.data?.error || "تعذّرت إضافة السائق كمفضّل");
    } finally {
      setAddingSearchDriverId(null);
    }
  };

  const statusMeta: Record<string, { label: string; color: string }> = {
    "حاضر":    { label: "حاضر",    color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" },
    "استراحة": { label: "استراحة", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" },
    "مغلق":    { label: "مغلق",    color: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" },
  };

  const filteredSearchDrivers = searchDrivers.filter((driver) =>
    driver.driverName.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()),
  );

  const favoritesSection = (
    <>
      {!favLoading && (
        <div className="bubble-card p-6" dir="rtl">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h3 className="font-bold text-slate-800 dark:text-white flex items-center gap-2 text-lg">
              <Heart className="w-5 h-5 text-rose-500 fill-rose-500" />
              السائقون المفضلون
            </h3>
            <button
              onClick={openDriverSearch}
              className="w-9 h-9 rounded-full bg-sky-50 text-sky-600 hover:bg-sky-100 dark:bg-sky-900/30 dark:text-sky-300 dark:hover:bg-sky-900/50 flex items-center justify-center transition-colors"
              title="البحث عن سائقين في بلديتك"
              aria-label="البحث عن سائقين في بلديتك"
              data-testid="button-search-favorite-drivers"
            >
              <Search className="w-4 h-4" />
            </button>
          </div>
          {favorites.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <div className="w-10 h-10 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center">
                <User className="w-5 h-5 text-slate-300 dark:text-slate-600" />
              </div>
              <p className="text-slate-500 dark:text-slate-400 text-sm font-medium">ما عندك سائقين مفضلين بعد</p>
              <p className="text-slate-400 dark:text-slate-500 text-xs leading-relaxed max-w-[220px]">
                ابحث عن سائقين في بلديتك وأضفهم إلى مفضليك
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {favorites.map(fav => {
                const meta = statusMeta[fav.currentStatus] ?? statusMeta["مغلق"];
                return (
                  <div key={fav.driverId} className="flex items-center justify-between bg-slate-50 dark:bg-slate-800/60 rounded-2xl px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 bg-rose-100 dark:bg-rose-900/30 rounded-full flex items-center justify-center shrink-0">
                        <User className="w-4 h-4 text-rose-500" />
                      </div>
                      <div>
                        <p className="font-bold text-slate-800 dark:text-white text-sm">{fav.driverName}</p>
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${meta.color}`}>
                          {meta.label}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => handleRemoveFavorite(fav.driverId)}
                      disabled={removingId === fav.driverId}
                      className="p-2 rounded-xl text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
                      title="إزالة"
                    >
                      {removingId === fav.driverId
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : <Trash2 className="w-4 h-4" />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {searchOpen && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={(event) => { if (event.target === event.currentTarget) setSearchOpen(false); }}
        >
          <div
            className="bg-white dark:bg-slate-900 rounded-3xl p-5 w-full max-w-md max-h-[82dvh] overflow-y-auto shadow-2xl border border-sky-200 dark:border-sky-800 animate-in zoom-in-95 duration-200"
            dir="rtl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="favorite-driver-search-title"
          >
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h2 id="favorite-driver-search-title" className="font-black text-lg text-slate-800 dark:text-white">
                  البحث عن سائقين
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  السائقون المسجّلون في بلديتك فقط
                </p>
              </div>
              <button
                onClick={() => setSearchOpen(false)}
                className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-500 hover:text-slate-800 dark:hover:text-white"
                aria-label="إغلاق البحث"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="relative mb-4">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                autoFocus
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="ابحث باسم السائق..."
                className="w-full rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 py-3 pr-10 pl-4 text-sm text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-primary/40"
                aria-label="البحث باسم السائق"
              />
            </div>

            {searchLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : searchError ? (
              <p className="text-center text-sm text-red-500 py-8">{searchError}</p>
            ) : filteredSearchDrivers.length === 0 ? (
              <p className="text-center text-sm text-slate-500 dark:text-slate-400 py-8">
                {searchDrivers.length === 0
                  ? "لا يوجد سائقون مسجّلون في بلديتك حالياً"
                  : "لا يوجد سائق بهذا الاسم"}
              </p>
            ) : (
              <div className="space-y-2">
                {filteredSearchDrivers.map((driver) => {
                  const meta = statusMeta[driver.currentStatus] ?? statusMeta["مغلق"];
                  const isAdding = addingSearchDriverId === driver.driverId;
                  return (
                    <div
                      key={driver.driverId}
                      className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 dark:bg-slate-800/60 px-3 py-3"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-9 h-9 shrink-0 rounded-full bg-sky-100 dark:bg-sky-900/30 flex items-center justify-center">
                          <User className="w-4 h-4 text-sky-600 dark:text-sky-300" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-bold text-sm text-slate-800 dark:text-white truncate">{driver.driverName}</p>
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${meta.color}`}>
                            {meta.label}
                          </span>
                        </div>
                      </div>
                      {driver.isFavorite ? (
                        <span className="shrink-0 flex items-center gap-1 text-xs font-bold text-emerald-600 dark:text-emerald-300">
                          <CheckCircle2 className="w-4 h-4" />
                          مفضّل بالفعل
                        </span>
                      ) : (
                        <button
                          onClick={() => handleAddSearchFavorite(driver)}
                          disabled={isAdding}
                          className="shrink-0 flex items-center gap-1 rounded-xl bg-rose-50 hover:bg-rose-100 dark:bg-rose-900/20 dark:hover:bg-rose-900/40 px-2.5 py-2 text-xs font-bold text-rose-600 dark:text-rose-300 disabled:opacity-50"
                        >
                          {isAdding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Heart className="w-3.5 h-3.5" />}
                          إضافة كمفضّل
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {searchAddError && (
              <p className="mt-3 text-xs leading-relaxed text-red-500">{searchAddError}</p>
            )}
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="flex flex-col gap-6 mt-8">
      {favoritesSection}
      <button onClick={() => onSelect("new-order")} className="bubble-card p-8 flex flex-col items-center justify-center gap-4 group" data-testid="button-nav-new-order">
        <div className="w-20 h-20 bg-gradient-to-tr from-sky-400 to-primary rounded-full flex items-center justify-center shadow-lg shadow-sky-400/40 group-hover:scale-110 transition-transform duration-300">
          <ShoppingBag className="w-10 h-10 text-white" />
        </div>
        <h2 className="text-2xl font-bold text-slate-800 dark:text-white">{t("dashboard.newOrder")}</h2>
        <p className="text-slate-500 text-center max-w-[200px]">{t("dashboard.newOrderDesc")}</p>
      </button>
      <button onClick={() => onSelect("my-orders")} className="bubble-card p-8 flex flex-col items-center justify-center gap-4 group" data-testid="button-nav-my-orders">
        <div className="w-20 h-20 bg-gradient-to-tr from-teal-400 to-emerald-500 rounded-full flex items-center justify-center shadow-lg shadow-teal-400/40 group-hover:scale-110 transition-transform duration-300">
          <ListOrdered className="w-10 h-10 text-white" />
        </div>
        <h2 className="text-2xl font-bold text-slate-800 dark:text-white">{t("dashboard.myOrders")}</h2>
        <p className="text-slate-500 text-center max-w-[200px]">{t("dashboard.myOrdersDesc")}</p>
      </button>
    </div>
  );
}

type SavedLocation = { id: string; label: string; latitude: number; longitude: number };

function NewOrderView({ onBack, onSuccess, onEnterContest, userId, queryClient }: {
  onBack: () => void; onSuccess: () => void;
  onEnterContest: (contest: NoDriverContestSnapshot) => void;
  userId: string; queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [selectedVolumes, setSelectedVolumes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [contestPrompt, setContestPrompt] = useState<NoDriverContestSnapshot | null>(null);
  const [gpsState, setGpsState] = useState<"idle" | "loading" | "acquired">("idle");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const createOrderMutation = useCreateOrder();

  // ── Favourite driver window: show countdown banner after sentToFavorite ──────
  const [favoriteMode, setFavoriteMode] = useState<{ orderId: string; countdown: number } | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, []);

  const startFavoriteCountdown = (orderId: string, expiresAt: string) => {
    const initialSeconds = Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
    setFavoriteMode({ orderId, countdown: initialSeconds });
    countdownRef.current = setInterval(() => {
      setFavoriteMode(prev => {
        if (!prev) return null;
        if (prev.countdown <= 1) {
          clearInterval(countdownRef.current!);
          countdownRef.current = null;
          onSuccess();
          return null;
        }
        return { ...prev, countdown: prev.countdown - 1 };
      });
    }, 1000);
  };

  const [savedLocations, setSavedLocations] = useState<SavedLocation[]>([]);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveLabel, setSaveLabel] = useState("");
  const [savingLocation, setSavingLocation] = useState(false);

  type TodayCount = { used: number; remaining: number; limit: number; resetsAt: string };
  const [todayCount, setTodayCount] = useState<TodayCount | null>(null);

  useEffect(() => {
    customFetch<SavedLocation[]>(`/api/locations`)
      .then(setSavedLocations)
      .catch(() => {});
    customFetch<TodayCount>("/api/orders/today-count")
      .then(setTodayCount)
      .catch(() => {});
  }, [userId]);

  const toggleVolume = (vol: string) => {
    if (selectedVolumes.includes(vol)) {
      setSelectedVolumes(prev => prev.filter(v => v !== vol));
    } else {
      if (selectedVolumes.length >= 3) return;
      setSelectedVolumes(prev => [...prev, vol]);
    }
  };

  const calculatePrice = () => {
    if (selectedVolumes.length === 0) return 0;
    return selectedVolumes.reduce((acc, vol) => acc + (PRICE_MAP[vol] ?? 0), 0);
  };

  const totalPrice = calculatePrice();

  const handleLocate = () => {
    if (!navigator.geolocation) { setError("المتصفح لا يدعم تحديد الموقع الجغرافي"); return; }
    setGpsState("loading");
    navigator.geolocation.getCurrentPosition(
      (pos) => { setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setGpsState("acquired"); setError(""); },
      () => { setGpsState("idle"); setError("تعذّر تحديد موقعك. تأكد من منح الإذن للمتصفح."); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const handleSelectSavedLocation = (loc: SavedLocation) => {
    setCoords({ lat: loc.latitude, lng: loc.longitude });
    setGpsState("acquired");
    setError("");
  };

  const handleSaveLocation = async () => {
    if (!coords || !saveLabel.trim()) return;
    setSavingLocation(true);
    try {
      const newLoc = await customFetch<SavedLocation>(`/api/locations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: saveLabel.trim(), latitude: coords.lat, longitude: coords.lng }),
      });
      setSavedLocations(prev => [...prev, newLoc]);
      setShowSaveForm(false);
      setSaveLabel("");
    } catch { /* silently fail */ }
    finally { setSavingLocation(false); }
  };

  const handleDeleteSavedLocation = async (locId: string) => {
    try {
      await customFetch(`/api/locations/${locId}`, { method: "DELETE" });
      setSavedLocations(prev => prev.filter(l => l.id !== locId));
    } catch { /* silently fail */ }
  };

  const handleSubmit = () => {
    if (selectedVolumes.length === 0) { setError("الرجاء اختيار حجم واحد على الأقل"); return; }
    if (!coords) { setError("الرجاء تحديد موقعك الجغرافي أولاً"); return; }
    createOrderMutation.mutate(
      { data: { userId, waterVolume: selectedVolumes.join(", "), barrelCount: 1, totalPrice, latitude: coords.lat, longitude: coords.lng } },
      {
        onSuccess: (data: unknown) => {
          queryClient.invalidateQueries({ queryKey: getGetUserOrdersQueryKey(userId) });
          customFetch<TodayCount>("/api/orders/today-count").then(setTodayCount).catch(() => {});
          // Phase 7: if the order was sent exclusively to a favourite driver,
          // show the 90-second countdown banner instead of navigating away.
          const resp = data as { id?: string; sentToFavorite?: boolean; exclusiveExpiresAt?: string } | undefined;
          if (resp?.sentToFavorite && resp?.id && resp?.exclusiveExpiresAt) {
            startFavoriteCountdown(resp.id, resp.exclusiveExpiresAt);
          } else {
            onSuccess();
          }
        },
        onError: (err: unknown) => {
          const e = err as { data?: { error?: string; code?: string; contest?: NoDriverContestSnapshot } };
          if (e?.data?.code === "DAILY_ORDER_LIMIT_EXCEEDED") {
            customFetch<TodayCount>("/api/orders/today-count").then(setTodayCount).catch(() => {});
          }
          if (e?.data?.code === "NO_DRIVER_CONTEST_AVAILABLE" && e.data.contest) {
            setError("");
            setContestPrompt(e.data.contest);
            return;
          }
          setError(e?.data?.error || "حدث خطأ في تقديم الطلب");
        },
      }
    );
  };

  // ── Favourite countdown banner — replaces form after sentToFavorite ─────────
  if (favoriteMode) {
    const mins = Math.floor(favoriteMode.countdown / 60);
    const secs = String(favoriteMode.countdown % 60).padStart(2, "0");
    return (
      <div className="flex flex-col items-center justify-center gap-6 mt-12 animate-in zoom-in-95 duration-300" dir="rtl">
        <div className="w-24 h-24 bg-sky-100 dark:bg-sky-900/30 rounded-full flex items-center justify-center shadow-lg shadow-sky-200">
          <Heart className="w-12 h-12 text-sky-500 fill-sky-500" />
        </div>
        <h2 className="text-2xl font-black text-slate-800 dark:text-white text-center">
          تم إرسال طلبك إلى سائقك المفضل
        </h2>
        <p className="text-slate-500 text-sm text-center leading-relaxed max-w-xs">
          إذا لم يختر طلبك خلال 1:30 دقيقة، سيظهر طلبك لبقية السائقين تلقائيًا.
        </p>
        {/* Countdown ring */}
        <div className="flex flex-col items-center gap-1 bg-sky-50 dark:bg-sky-900/20 border border-sky-200 dark:border-sky-800 rounded-3xl px-10 py-5">
          <span className="text-4xl font-black text-sky-600 dark:text-sky-300 tabular-nums tracking-tight">
            {mins}:{secs}
          </span>
          <span className="text-xs text-sky-400 font-medium">الوقت المتبقي</span>
        </div>
        <button
          onClick={() => { if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; } onSuccess(); }}
          className="w-full max-w-xs py-3.5 rounded-2xl bg-gradient-to-r from-primary to-cyan-500 text-white font-bold flex items-center justify-center gap-2 shadow-lg shadow-primary/30 hover:opacity-90 transition-all active:scale-[0.98]"
        >
          <ListOrdered className="w-5 h-5" />
          عرض طلباتي الآن
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col animate-in slide-in-from-bottom-4 duration-300">
      <div className="flex items-center mb-6">
        <button onClick={onBack} className="p-2 mr-[-8px] text-slate-500 hover:text-primary transition-colors">
          <ArrowRight className="w-6 h-6 ml-2" />
        </button>
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">طلب مياه جديد</h1>
      </div>

      {error && <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-2xl mb-4">{error}</div>}

      {contestPrompt && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-3xl p-5 mb-5 text-right animate-in fade-in slide-in-from-top-2 duration-300" dir="rtl">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 shrink-0 rounded-2xl bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center">
              <Users className="w-5 h-5 text-amber-600 dark:text-amber-300" />
            </div>
            <div>
              <h2 className="font-black text-amber-900 dark:text-amber-100">لا يوجد سائق في بلديتك</h2>
              <p className="text-sm text-amber-800/80 dark:text-amber-200/80 mt-1 leading-relaxed">
                نعتذر لعدم وجود سائق في بلديتك. يمكنك أن تدعو سائقين للحصول على هدايا معتبرة من المنصة.
              </p>
            </div>
          </div>
          <button
            onClick={() => onEnterContest(contestPrompt)}
            className="mt-4 w-full py-3 rounded-2xl bg-amber-500 hover:bg-amber-600 text-white font-bold transition-colors shadow-md shadow-amber-500/20"
            data-testid="button-enter-no-driver-contest"
          >
            الدخول إلى المسابقة
          </button>
        </div>
      )}

      <div className="glass-panel rounded-3xl p-6 mb-6">
        {/* ── Saved locations dropdown ── */}
        {savedLocations.length > 0 && (
          <div className="mb-5">
            <p className="text-xs font-bold text-slate-500 dark:text-slate-400 mb-2 flex items-center gap-1">
              <Bookmark className="w-3.5 h-3.5" />مواقعي المحفوظة
            </p>
            <div className="space-y-2">
              {savedLocations.map(loc => (
                <div key={loc.id} className="flex items-center gap-2">
                  <button
                    onClick={() => handleSelectSavedLocation(loc)}
                    className={`flex-1 flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 text-sm font-medium text-right transition-all ${
                      coords?.lat === loc.latitude && coords?.lng === loc.longitude
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-slate-200 dark:border-slate-700 bg-white/50 dark:bg-slate-800/50 text-slate-700 dark:text-slate-300 hover:border-primary/40"
                    }`}
                  >
                    {coords?.lat === loc.latitude && coords?.lng === loc.longitude
                      ? <BookmarkCheck className="w-4 h-4 shrink-0" />
                      : <Bookmark className="w-4 h-4 shrink-0 text-slate-400" />
                    }
                    {loc.label}
                  </button>
                  <button
                    onClick={() => handleDeleteSavedLocation(loc.id)}
                    className="p-2 rounded-xl text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    title="حذف"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mb-4">
          <button onClick={handleLocate} disabled={gpsState === "loading" || gpsState === "acquired"}
            className={`w-full py-4 rounded-2xl flex items-center justify-center gap-3 font-bold text-base transition-all shadow-md active:scale-[0.98] ${
              gpsState === "acquired"
                ? "bg-emerald-500 text-white shadow-emerald-500/20 cursor-default"
                : "bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300 border-2 border-sky-300 dark:border-sky-700 hover:bg-sky-200"
            }`} data-testid="button-locate">
            {gpsState === "loading" ? <Loader2 className="w-5 h-5 animate-spin" /> : <MapPin className="w-5 h-5" />}
            {gpsState === "acquired" ? "تم تحديد موقعك بدقة ✔" : gpsState === "loading" ? "جاري تحديد الموقع..." : "تحديد موقع منزلي تلقائياً"}
          </button>
          {coords && <p className="text-xs text-slate-400 text-center mt-2">{coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}</p>}
        </div>

        {/* ── Save current GPS location ── */}
        {gpsState === "acquired" && coords && !savedLocations.some(l => l.latitude === coords.lat && l.longitude === coords.lng) && (
          <div className="mb-5">
            {showSaveForm ? (
              <div className="flex gap-2 items-center">
                <input
                  value={saveLabel}
                  onChange={e => setSaveLabel(e.target.value)}
                  placeholder="اسم الموقع (مثال: منزلي)"
                  className="flex-1 bg-slate-100 dark:bg-slate-800 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
                  dir="rtl"
                />
                <button
                  onClick={handleSaveLocation}
                  disabled={!saveLabel.trim() || savingLocation}
                  className="px-3 py-2 rounded-xl bg-primary text-white text-sm font-bold disabled:opacity-50 flex items-center gap-1"
                >
                  {savingLocation ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BookmarkCheck className="w-3.5 h-3.5" />}
                  حفظ
                </button>
                <button onClick={() => { setShowSaveForm(false); setSaveLabel(""); }} className="p-2 rounded-xl text-slate-400 hover:text-slate-600">
                  <XCircle className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button onClick={() => setShowSaveForm(true)}
                className="w-full py-2 rounded-xl flex items-center justify-center gap-2 text-sm text-primary border border-primary/30 hover:bg-primary/5 transition-colors font-medium">
                <Bookmark className="w-4 h-4" />حفظ هذا الموقع للمرات القادمة
              </button>
            )}
          </div>
        )}


        {/* ── Daily order quota badge ── */}
        {todayCount !== null && (
          <div className={`flex items-center justify-between px-4 py-2.5 rounded-2xl mb-4 text-sm font-medium border ${
            todayCount.remaining === 0
              ? "bg-destructive/10 border-destructive/30 text-destructive"
              : todayCount.remaining === 1
              ? "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300"
              : "bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300"
          }`} dir="rtl">
            <span>الطلبات المتبقية اليوم: <span className="font-bold">{todayCount.remaining} من {todayCount.limit}</span></span>
            {todayCount.remaining === 0 && (
              <span className="text-xs opacity-80">تجدد بعد منتصف الليل</span>
            )}
          </div>
        )}

        {todayCount?.remaining === 0 && (
          <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-2xl mb-4 text-right leading-relaxed">
            لقد استنفدت الحد الأقصى لطلبات اليوم (3 طلبات). يمكنك تقديم طلبات جديدة بعد منتصف الليل.
          </div>
        )}

        <h3 className="font-bold text-lg mb-4 flex items-center gap-2"><Droplet className="w-5 h-5 text-primary" />اختر الحجم (اختر حتى 3)</h3>
        <div className="flex flex-wrap gap-2 mb-6">
          {VOLUMES.map(vol => (
            <button key={vol} onClick={() => toggleVolume(vol)}
              className={`px-4 py-2 rounded-xl border-2 transition-all font-medium ${
                selectedVolumes.includes(vol)
                  ? "bg-primary border-primary text-white shadow-md shadow-primary/20"
                  : "bg-white/50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:border-primary/40"
              } ${selectedVolumes.length >= 3 && !selectedVolumes.includes(vol) ? "opacity-50 cursor-not-allowed" : ""}`}
              data-testid={`volume-${vol}`}>{vol}</button>
          ))}
        </div>

        <div className="bg-slate-50 dark:bg-slate-800/50 rounded-2xl p-4 flex justify-between items-center mb-6 border border-slate-100 dark:border-slate-800">
          <span className="text-slate-500 font-medium">السعر الإجمالي:</span>
          <span className="text-2xl font-bold text-primary" data-testid="text-total-price">{totalPrice} دج</span>
        </div>

        <button
          onClick={handleSubmit}
          disabled={createOrderMutation.isPending || selectedVolumes.length === 0 || !coords || todayCount?.remaining === 0}
          className="w-full bg-gradient-to-r from-primary to-cyan-500 hover:from-primary/90 hover:to-cyan-500/90 text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-2 transition-all shadow-lg shadow-primary/30 disabled:opacity-50"
          data-testid="button-submit-order">
          {createOrderMutation.isPending
            ? <Loader2 className="w-6 h-6 animate-spin" />
            : <><CheckCircle2 className="w-5 h-5" /><span>إتمام الطلب</span></>}
        </button>
      </div>
    </div>
  );
}

function NoDriverContestView({
  userId,
  consumerName,
  onBack,
}: {
  userId: string;
  consumerName: string;
  onBack: () => void;
}) {
  const [contest, setContest] = useState<NoDriverContestSnapshot | null>(null);
  const [referralCode, setReferralCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refreshContest = useCallback(async () => {
    try {
      const [status, referral] = await Promise.all([
        customFetch<NoDriverContestSnapshot>("/api/no-driver-contest"),
        customFetch<{ referralCode: string }>("/api/referrals/me"),
      ]);
      setContest(status);
      setReferralCode(status.referralCode || referral.referralCode || "");
      setError("");
    } catch {
      setError("تعذر تحميل حالة المسابقة. حاول مرة أخرى.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshContest();
    const interval = window.setInterval(() => void refreshContest(), 15_000);
    const socket = getSocket();
    const handleCancellation = () => {
      setContest((current) => current ? { ...current, status: "cancelled" } : current);
    };
    socket.on("no_driver_contest_cancelled", handleCancellation);
    return () => {
      window.clearInterval(interval);
      socket.off("no_driver_contest_cancelled", handleCancellation);
    };
  }, [refreshContest, userId]);

  const handleInvite = async () => {
    if (!referralCode) return;
    const link = `${window.location.origin}/register?ref=${encodeURIComponent(referralCode)}`;
    const shareText = `انضم إلى Mizu وسجّل كسائق في بلديتك: ${link}`;

    try {
      if (navigator.share) {
        await navigator.share({ title: "دعوة للانضمام إلى Mizu", text: shareText, url: link });
      } else {
        await navigator.clipboard.writeText(shareText);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      }
    } catch {
      // Closing the native share sheet is not an error. Clipboard fallback is
      // intentionally best-effort for browsers without navigator.share.
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-5 animate-in fade-in duration-300" dir="rtl">
        <div className="h-8 w-40 rounded-xl bg-slate-200 dark:bg-slate-800 animate-pulse" />
        <div className="h-72 rounded-3xl bg-slate-200 dark:bg-slate-800 animate-pulse" />
      </div>
    );
  }

  if (error || !contest) {
    return (
      <div className="flex flex-col gap-5 animate-in fade-in duration-300" dir="rtl">
        <button onClick={onBack} className="self-start p-2 text-slate-500 hover:text-primary">
          <ArrowRight className="w-6 h-6" />
        </button>
        <div className="rounded-3xl bg-destructive/10 text-destructive p-5 text-center">
          <p>{error || "تعذر تحميل المسابقة"}</p>
          <button onClick={() => { setLoading(true); void refreshContest(); }} className="mt-4 rounded-xl bg-primary px-5 py-2 text-white font-bold">
            إعادة المحاولة
          </button>
        </div>
      </div>
    );
  }

  const displayName = contest.name || consumerName;
  const isActive = contest.status === "active";
  const isCompleted = contest.status === "completed";
  const isCancelled = contest.status === "cancelled";

  return (
    <div className="flex flex-col gap-5 animate-in slide-in-from-bottom-4 duration-300" dir="rtl">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="p-2 text-slate-500 hover:text-primary transition-colors" aria-label="رجوع">
          <ArrowRight className="w-6 h-6" />
        </button>
        <h1 className="text-2xl font-black text-slate-800 dark:text-white">مسابقة بلديتك</h1>
      </div>

      {isActive ? (
        <div className="rounded-[2rem] overflow-hidden border border-violet-200 dark:border-violet-800/60 bg-white dark:bg-slate-900 shadow-xl shadow-violet-200/30 dark:shadow-black/20">
          <div className="bg-gradient-to-br from-violet-600 via-indigo-600 to-primary p-6 text-white">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-violet-100 text-sm">أهلاً بك</p>
                <h2 className="text-2xl font-black mt-1">{displayName}</h2>
              </div>
              <div className="w-14 h-14 rounded-2xl bg-white/15 flex items-center justify-center">
                <Trophy className="w-8 h-8 text-amber-300" />
              </div>
            </div>
          </div>

          <div className="p-6">
            <div className="flex items-center justify-between gap-4 rounded-2xl bg-violet-50 dark:bg-violet-900/20 border border-violet-100 dark:border-violet-800/50 p-4">
              <div>
                <p className="text-xs text-violet-600 dark:text-violet-300 font-bold">السائقون المدعوون المؤهلون</p>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">يزداد العداد بعد اكتمال التأهل</p>
              </div>
              <span className="text-3xl font-black text-violet-700 dark:text-violet-200 tabular-nums">
                {Math.min(contest.qualifiedDrivers, contest.requiredDrivers)}/{contest.requiredDrivers}
              </span>
            </div>

            <p className="text-slate-600 dark:text-slate-300 leading-relaxed mt-5">
              ادعُ 2 سائق واحصل على لفة عجلة حظ تستطيع إهداءها لسائقك المفضل.
            </p>

            <button
              onClick={handleInvite}
              disabled={!referralCode}
              className="mt-5 w-full py-3.5 rounded-2xl bg-gradient-to-r from-violet-600 to-primary text-white font-bold flex items-center justify-center gap-2 shadow-lg shadow-violet-500/20 disabled:opacity-50"
              data-testid="button-invite-contest-driver"
            >
              {copied ? <Check className="w-5 h-5" /> : <Share2 className="w-5 h-5" />}
              {copied ? "تم نسخ رابط الدعوة" : "دعوة سائقين"}
            </button>
            {referralCode && (
              <div className="mt-3 flex items-center justify-center gap-2 text-xs text-slate-400">
                <span>رمزك:</span>
                <code className="font-black tracking-[0.2em] text-violet-600 dark:text-violet-300" dir="ltr">{referralCode}</code>
                <Copy className="w-3.5 h-3.5" />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className={`rounded-3xl p-6 text-center border ${
          isCompleted
            ? "bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800"
            : "bg-slate-100 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700"
        }`}>
          <div className="w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center bg-white/70 dark:bg-slate-900/60">
            {isCompleted ? <Trophy className="w-8 h-8 text-emerald-500" /> : <Users className="w-8 h-8 text-slate-500" />}
          </div>
          <h2 className="font-black text-lg text-slate-800 dark:text-white">
            {isCompleted ? "أكملت المسابقة وحصلت على لفة عجلة حظ" : "تم إخفاء المسابقة"}
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 leading-relaxed">
            {isCompleted
              ? "يمكنك استخدام اللفة من عجلة الحظ أو إهداؤها لسائق تختاره."
              : "أصبح هناك سائق مسجّل في بلديتك، لذلك لم تعد المسابقة متاحة."}
          </p>
          <button onClick={onBack} className="mt-5 w-full py-3 rounded-2xl bg-primary text-white font-bold">
            العودة
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LiveDriverMap — consumer-side live tracking
//
// • Fetches the driver's current position from driver_locations on mount
// • Subscribes to Supabase Realtime postgres_changes (UPDATE events) filtered
//   to this driver's row so the marker moves without polling
// • Unsubscribes automatically when the component unmounts (order delivered /
//   navigated away)
// ─────────────────────────────────────────────────────────────────────────────
function LiveDriverMap({
  driverId,
  destLat,
  destLng,
  orderId,
}: {
  driverId: string;
  /** Delivery address latitude — shown as the red "destination" pin */
  destLat: number;
  /** Delivery address longitude */
  destLng: number;
  orderId: string;
}) {
  const mapRef          = useRef<HTMLDivElement>(null);
  const mapInstanceRef  = useRef<unknown>(null);
  const driverMarkerRef = useRef<unknown>(null);
  const polylineRef     = useRef<unknown>(null);
  const channelRef      = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;

    // Load Leaflet CSS once
    if (!document.querySelector('link[href*="leaflet"]')) {
      const link = document.createElement("link");
      link.rel  = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }

    const win = window as unknown as Record<string, unknown>;

    type LeafletType = {
      map: (el: HTMLElement, opts: object) => {
        setView: (c: [number, number], z: number) => void;
        fitBounds: (b: [[number, number], [number, number]], opts: object) => void;
        remove: () => void;
      };
      tileLayer: (url: string, opts: object) => { addTo: (m: unknown) => unknown };
      marker: (c: [number, number], opts?: object) => {
        addTo: (m: unknown) => { bindPopup: (s: string) => unknown };
        setLatLng: (c: [number, number]) => void;
        bindPopup: (s: string) => unknown;
      };
      divIcon: (opts: object) => object;
      polyline: (latlngs: [number, number][], opts?: object) => {
        addTo: (m: unknown) => unknown;
        setLatLngs: (latlngs: [number, number][]) => void;
      };
    };

    const initMap = async (L: LeafletType) => {
      if (!mapRef.current || mapInstanceRef.current) return;

      const map = L.map(mapRef.current!, { zoomControl: true, attributionControl: false });
      mapInstanceRef.current = map;
      map.setView([destLat, destLng], 15);

      // Satellite tile layer (Esri World Imagery — free, no API key)
      L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 19, attribution: "© Esri, Maxar, Earthstar Geographics" }
      ).addTo(map);

      // Destination marker (red pin)
      const destIcon = L.divIcon({
        html: `<div style="width:18px;height:18px;border-radius:50%;background:#ef4444;border:3px solid white;box-shadow:0 2px 10px rgba(0,0,0,0.5)"></div>`,
        className: "",
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      L.marker([destLat, destLng], { icon: destIcon }).addTo(map).bindPopup("📍 موقع التوصيل");

      // Driver icon (blue pulsing dot)
      const driverIcon = L.divIcon({
        html: `<div style="position:relative;width:24px;height:24px">
          <div style="position:absolute;inset:0;border-radius:50%;background:#0ea5e9;opacity:0.3;animation:ping 1.2s cubic-bezier(0,0,0.2,1) infinite"></div>
          <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:14px;height:14px;border-radius:50%;background:#0ea5e9;border:2px solid white;box-shadow:0 2px 8px rgba(14,165,233,0.7)"></div>
        </div>`,
        className: "",
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });

      // Inject ping keyframe once
      if (!document.getElementById("driver-ping-style")) {
        const style = document.createElement("style");
        style.id = "driver-ping-style";
        style.textContent = `@keyframes ping{75%,100%{transform:scale(2.5);opacity:0}}`;
        document.head.appendChild(style);
      }

      const placeOrMoveDriver = (lat: number, lng: number) => {
        const latLng: [number, number] = [lat, lng];
        if (!driverMarkerRef.current) {
          driverMarkerRef.current = L.marker(latLng, { icon: driverIcon })
            .addTo(map)
            .bindPopup("🚚 موقع السائق");
          polylineRef.current = L.polyline([latLng, [destLat, destLng]], {
            color: "#0ea5e9", weight: 4, opacity: 0.85, dashArray: "10, 6",
          }).addTo(map);
          (map as unknown as { fitBounds: (b: [[number,number],[number,number]], opts: object) => void })
            .fitBounds([[lat, lng], [destLat, destLng]], { padding: [50, 50] });
        } else {
          (driverMarkerRef.current as { setLatLng: (c: [number, number]) => void }).setLatLng(latLng);
          if (polylineRef.current) {
            (polylineRef.current as { setLatLngs: (c: [number, number][]) => void })
              .setLatLngs([latLng, [destLat, destLng]]);
          }
        }
      };

      // Await boot-time setSession() before subscribing so postgres_changes
      // is opened with the user's real JWT rather than the anonymous role.
      // On a fresh login this resolves immediately (no pending boot promise).
      await getSessionBootReady().catch(() => {/* non-fatal; proceed anyway */});

      // Initial position — fetch current row from driver_locations
      supabase
        .from("driver_locations")
        .select("latitude, longitude")
        .eq("driver_id", driverId)
        .single()
        .then(({ data }) => {
          if (data) placeOrMoveDriver(data.latitude as number, data.longitude as number);
        });

      // Realtime subscription — move marker on INSERT or UPDATE.
      // We listen to "*" (all events) so we catch both:
      //   INSERT — first time the driver row is created during a delivery
      //   UPDATE — every subsequent position update
      // Typed as `any` because the Supabase JS v2 overloaded `.on()` signature
      // doesn't narrow cleanly for "postgres_changes" without importing its
      // internal enum; consistent with the rest of this codebase's approach.
      const handleLocationPayload = (payload: { new: Record<string, unknown> }) => {
        const { latitude, longitude } = payload.new;
        if (typeof latitude === "number" && typeof longitude === "number") {
          placeOrMoveDriver(latitude, longitude);
        }
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const channel = (supabase.channel(`consumer-driver-loc-${orderId}`) as any)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "driver_locations",
            filter: `driver_id=eq.${driverId}`,
          },
          handleLocationPayload
        )
        .subscribe();

      channelRef.current = channel;
    };

    const loadLeaflet = async () => {
      if (!win["L"]) {
        await new Promise<void>(resolve => {
          const s = document.createElement("script");
          s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
          s.onload = () => resolve();
          document.head.appendChild(s);
        });
      }
      await initMap(win["L"] as LeafletType);
    };

    loadLeaflet();

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      if (mapInstanceRef.current) {
        (mapInstanceRef.current as { remove: () => void }).remove();
        mapInstanceRef.current = null;
      }
      driverMarkerRef.current = null;
      polylineRef.current = null;
    };
  }, [orderId, driverId, destLat, destLng]);

  return (
    <div className="mt-3">
      <p className="text-xs text-sky-500 font-semibold mb-1.5 flex items-center gap-1">
        <Truck className="w-3 h-3" /> موقع السائق الحي
      </p>
      <div
        ref={mapRef}
        className="w-full rounded-2xl overflow-hidden border border-sky-200 dark:border-sky-800"
        style={{ height: "200px" }}
      />
    </div>
  );
}

function MyOrdersView({ onBack, userId, onDriverArrived, onDriverAccepted, queryClient }: {
  onBack: () => void;
  userId: string;
  onDriverArrived: (orderId: string) => void;
  onDriverAccepted: (info: DriverAcceptedInfo) => void;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  // Cross-network real-time: invalidates orders cache on driver status changes via Supabase Realtime.
  // Falls back to the 5-second poll transparently when WebSocket is unavailable.
  useRealtimeOrderStatus(userId);

  const { data: orders, isLoading } = useGetUserOrders(userId, {
    query: {
      enabled: !!userId,
      queryKey: getGetUserOrdersQueryKey(userId),
      refetchInterval: 5000,
    },
  });

  const cancelMutation = useCancelOrder();
  const notifiedArrivalRef = useRef<Set<string>>(new Set());
  const notifiedAcceptedRef = useRef<Set<string>>(new Set());

  const [ratingModal, setRatingModal] = useState<{ orderId: string; driverId: string } | null>(null);
  const [ratedOrders, setRatedOrders] = useState<Set<string>>(() => {
    try { return new Set<string>(JSON.parse(localStorage.getItem("rated_orders_consumer") || "[]")); }
    catch { return new Set<string>(); }
  });

  // ── Favourite driver state ─────────────────────────────────────────────────
  const [favDriverIds, setFavDriverIds] = useState<Set<string>>(new Set());
  const [addingFavFor, setAddingFavFor] = useState<string | null>(null); // orderId being processed
  const [favSuccess, setFavSuccess] = useState<Set<string>>(new Set());  // orderIds just added
  const [favError, setFavError] = useState<Record<string, string>>({});

  // ── Resend state ───────────────────────────────────────────────────────────
  const [resendConfirmOrderId, setResendConfirmOrderId] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resendResult, setResendResult] = useState<{
    orderId: string;
    type: "favorite" | "all" | "favorites-closed" | "offline";
  } | null>(null);
  const [socialReferralCode, setSocialReferralCode] = useState("");
  const [socialShareState, setSocialShareState] = useState<string | null>(null);

  useEffect(() => {
    customFetch<FavoriteDriver[]>("/api/favorite-drivers")
      .then((data: FavoriteDriver[]) => {
        setFavDriverIds(new Set(data.map((f: FavoriteDriver) => f.driverId)));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    customFetch<{ referralCode?: string }>("/api/referrals/me")
      .then((data) => setSocialReferralCode(data.referralCode || ""))
      .catch(() => {});
  }, []);

  const handleSocialShare = async (orderId: string) => {
    if (!socialReferralCode) return;

    const link = `${window.location.origin}/register?ref=${encodeURIComponent(socialReferralCode)}&social_share=1`;
    const text = `استمتعت بتجربتي مع Mizu 💧 شارك تجربتك واحصل على مكافآت من المنصة: ${link}`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: "شارك تجربتك مع Mizu",
          text,
          url: link,
        });
      } else {
        await navigator.clipboard.writeText(text);
      }
      setSocialShareState(orderId);
      window.setTimeout(() => setSocialShareState((current) => current === orderId ? null : current), 3000);
    } catch (error) {
      // Closing the native share sheet is expected and should not show an error.
      if ((error as DOMException)?.name === "AbortError") return;
      try {
        await navigator.clipboard.writeText(text);
        setSocialShareState(orderId);
      } catch {
        // Clipboard and native share can both be unavailable in restricted webviews.
      }
    }
  };

  const handleAddFavorite = async (orderId: string, driverId: string) => {
    setAddingFavFor(orderId);
    try {
      await customFetch("/api/favorite-drivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driverId }),
      });
      setFavDriverIds(prev => new Set([...prev, driverId]));
      setFavSuccess(prev => new Set([...prev, orderId]));
    } catch (err: unknown) {
      const e = err as { data?: { error?: string } };
      setFavError(prev => ({ ...prev, [orderId]: e?.data?.error || "تعذّر الإضافة" }));
    } finally {
      setAddingFavFor(null);
    }
  };

  const checkEvents = useCallback(() => {
    if (!orders) return;
    for (const order of orders) {
      if (order.status === "وصل السائق" && !notifiedArrivalRef.current.has(order.id)) {
        notifiedArrivalRef.current.add(order.id);
        onDriverArrived(order.id);
      }
      if (
        order.status === "قيد التوصيل" &&
        order.driverId &&
        !notifiedAcceptedRef.current.has(order.id)
      ) {
        notifiedAcceptedRef.current.add(order.id);
        onDriverAccepted({
          orderId: order.id,
          driverName: (order as any).driverName ?? null,
          driverPhone: (order as any).driverPhone ?? null,
        });
      }
    }
  }, [orders, onDriverArrived, onDriverAccepted]);

  useEffect(() => { checkEvents(); }, [checkEvents]);

  const handleCancel = (orderId: string) => {
    cancelMutation.mutate({ orderId }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetUserOrdersQueryKey(userId) }),
    });
  };

  const handleResend = async (orderId: string) => {
    setResending(true);
    try {
      const data = await customFetch<{
        success: boolean;
        sentToFavorite: boolean;
        needsFallbackConfirmation?: boolean;
        exclusiveExpiresAt?: string;
      }>(
        `/api/orders/${orderId}/resend`,
        { method: "POST" },
      );
      if (data.needsFallbackConfirmation) {
        setResendResult({ orderId, type: "favorites-closed" });
      } else if (data.sentToFavorite) {
        setResendResult({ orderId, type: "favorite" });
      } else {
        setResendResult({ orderId, type: "all" });
      }
      queryClient.invalidateQueries({ queryKey: getGetUserOrdersQueryKey(userId) });
    } catch {
      setResendResult({ orderId, type: "offline" });
    } finally {
      setResending(false);
      setResendConfirmOrderId(null);
    }
  };

  const handleFallbackToAll = async (orderId: string) => {
    setResending(true);
    try {
      await customFetch(`/api/orders/${orderId}/resend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fallbackToAll: true }),
      });
      queryClient.invalidateQueries({ queryKey: getGetUserOrdersQueryKey(userId) });
      setResendResult(null);
    } catch {
      setResendResult({ orderId, type: "offline" });
    } finally {
      setResending(false);
    }
  };

  const markRated = (orderId: string) => {
    const next = new Set(ratedOrders);
    next.add(orderId);
    setRatedOrders(next);
    try { localStorage.setItem("rated_orders_consumer", JSON.stringify([...next])); } catch { /* ignore */ }
    setRatingModal(null);
  };

  return (
    <div className="flex flex-col animate-in slide-in-from-bottom-4 duration-300 h-full">
      {ratingModal && (
        <RatingModal
          orderId={ratingModal.orderId}
          raterUserId={userId}
          ratedUserId={ratingModal.driverId}
          raterType="consumer"
          ratedName="السائق"
          onClose={() => setRatingModal(null)}
          onSubmitted={() => markRated(ratingModal.orderId)}
        />
      )}

      {/* ── Resend confirmation modal ─────────────────────────────────────── */}
      {resendConfirmOrderId && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 backdrop-blur-sm" dir="rtl">
          <div className="bg-white dark:bg-slate-900 rounded-3xl p-8 mx-4 max-w-sm w-full shadow-2xl border border-primary/20 text-center animate-in zoom-in-95 duration-300">
            <div className="w-16 h-16 bg-sky-100 dark:bg-sky-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
              <RefreshCw className="w-8 h-8 text-sky-500" />
            </div>
            <h2 className="text-xl font-black text-slate-800 dark:text-white mb-3">إعادة إرسال الطلبية</h2>
            <p className="text-slate-600 dark:text-slate-300 text-sm leading-relaxed mb-6">
              هل تريد إعادة إرسال الطلبية إلى سائقيك المفضّلين النشطين؟
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => handleResend(resendConfirmOrderId)}
                disabled={resending}
                className="flex-1 bg-gradient-to-r from-sky-500 to-primary text-white font-bold py-3 rounded-2xl shadow-lg hover:opacity-90 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {resending ? <Loader2 className="w-5 h-5 animate-spin" /> : "نعم"}
              </button>
              <button
                onClick={() => setResendConfirmOrderId(null)}
                className="flex-1 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold py-3 rounded-2xl hover:bg-slate-200 dark:hover:bg-slate-700 transition-all active:scale-[0.98]"
              >
                لا
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Resend result modal ───────────────────────────────────────────── */}
      {resendResult && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 backdrop-blur-sm" dir="rtl">
          <div className="bg-white dark:bg-slate-900 rounded-3xl p-8 mx-4 max-w-sm w-full shadow-2xl border border-primary/20 text-center animate-in zoom-in-95 duration-300">
            {resendResult.type === "favorites-closed" ? (
              <>
                <div className="w-16 h-16 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Heart className="w-8 h-8 text-amber-500" />
                </div>
                <h2 className="text-xl font-black text-slate-800 dark:text-white mb-6">
                  السائقون المفضّلون خارج الخدمة حالياً
                </h2>
              </>
            ) : resendResult.type === "favorite" ? (
              <>
                <div className="w-16 h-16 bg-sky-100 dark:bg-sky-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Heart className="w-8 h-8 text-sky-500 fill-sky-500" />
                </div>
                <h2 className="text-xl font-black text-slate-800 dark:text-white mb-2">تم الإرسال لسائقك المفضّل</h2>
                <p className="text-slate-500 text-sm leading-relaxed mb-6">
                  تم إرسال الطلبية إلى سائقك المفضّل النشط. سيظهر لجميع السائقين تلقائياً إذا لم يقبل خلال 90 ثانية.
                </p>
              </>
            ) : resendResult.type === "all" ? (
              <>
                <div className="w-16 h-16 bg-emerald-100 dark:bg-emerald-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Truck className="w-8 h-8 text-emerald-500" />
                </div>
                <h2 className="text-xl font-black text-slate-800 dark:text-white mb-2">تم الإرسال لجميع السائقين</h2>
                <p className="text-slate-500 text-sm leading-relaxed mb-6">
                  لا يوجد سائق مفضّل نشط حالياً. تم إرسال الطلبية لجميع السائقين في منطقتك.
                </p>
              </>
            ) : (
              <>
                <div className="w-16 h-16 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Heart className="w-8 h-8 text-amber-500" />
                </div>
                <h2 className="text-xl font-black text-slate-800 dark:text-white mb-2">السائقون المفضّلون خارج الخدمة حالياً</h2>
                <p className="text-slate-500 text-sm leading-relaxed mb-6">
                  تم إرسال الطلبية لبقية السائقين في منطقتك.
                </p>
              </>
            )}
            <button
              onClick={() => {
                if (resendResult.type === "favorites-closed") {
                  void handleFallbackToAll(resendResult.orderId);
                } else {
                  setResendResult(null);
                }
              }}
              disabled={resending}
              className="w-full bg-gradient-to-r from-primary to-cyan-500 text-white font-bold py-3.5 rounded-2xl shadow-lg hover:opacity-90 transition-all active:scale-[0.98]"
            >
              {resending ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : "موافق"}
            </button>
          </div>
        </div>
      )}
      <div className="flex items-center mb-6">
        <button onClick={onBack} className="p-2 mr-[-8px] text-slate-500 hover:text-primary transition-colors">
          <ArrowRight className="w-6 h-6 ml-2" />
        </button>
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">طلباتي</h1>
        <span className="mr-2 text-xs text-slate-400">(يتحدث تلقائياً)</span>
      </div>

      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-20 text-primary">
          <Loader2 className="w-10 h-10 animate-spin mb-4" /><p>جاري تحميل الطلبات...</p>
        </div>
      ) : !orders || orders.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-400 glass-panel rounded-3xl">
          <ShoppingBag className="w-16 h-16 mb-4 opacity-50" /><p className="text-lg">لا توجد طلبات سابقة</p>
        </div>
      ) : (
        <div className="space-y-4 pb-10">
          {orders.map(order => (
            <div key={order.id}
              className={`glass-panel p-5 rounded-3xl border-2 transition-all ${
                order.status === "وصل السائق"
                  ? "border-amber-400 shadow-amber-200 dark:shadow-amber-900/30 shadow-lg"
                  : "border-transparent"
              }`} data-testid={`order-card-${order.id}`}>
              <div className="flex justify-between items-start mb-3 border-b border-slate-100 dark:border-slate-800 pb-3">
                <div className="flex flex-col">
                  <span className="font-bold text-lg text-slate-800 dark:text-white">{order.waterVolume}</span>
                  <span className="text-xs text-slate-400">{format(new Date(order.createdAt), "dd/MM/yyyy HH:mm")}</span>
                </div>
                <div className="text-lg font-bold text-primary">{order.totalPrice} دج</div>
              </div>
              <div className="flex items-center justify-between mt-2">
                <div className="flex items-center gap-2">
                  {order.status === "معلق" && (
                    <div className="flex items-center gap-1.5 text-slate-500 bg-slate-100 dark:bg-slate-800 px-3 py-1.5 rounded-full text-sm font-medium">
                      <Clock className="w-4 h-4" /><span>معلق — بانتظار السائق</span>
                    </div>
                  )}
                  {order.status === "قيد التوصيل" && (
                    <div className="flex items-center gap-1.5 text-amber-600 bg-amber-50 dark:bg-amber-900/20 px-3 py-1.5 rounded-full text-sm font-medium animate-pulse">
                      <Truck className="w-4 h-4" /><span>قيد التوصيل</span>
                    </div>
                  )}
                  {order.status === "وصل السائق" && (
                    <div className="flex items-center gap-1.5 text-orange-600 bg-orange-50 dark:bg-orange-900/20 px-3 py-1.5 rounded-full text-sm font-bold">
                      <Bell className="w-4 h-4 animate-bounce" /><span>وصل السائق!</span>
                    </div>
                  )}
                  {order.status === "تم التوصيل" && (
                    <div className="flex items-center gap-1.5 text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-1.5 rounded-full text-sm font-medium">
                      <CheckCircle2 className="w-4 h-4" /><span>تم التوصيل ✔</span>
                    </div>
                  )}
                  {order.status === "منتهي الصلاحية" && (
                    <div className="flex items-center gap-1.5 text-red-700 bg-red-50 dark:bg-red-900/20 px-3 py-1.5 rounded-full text-sm font-bold">
                      <AlertTriangle className="w-4 h-4" /><span>منتهي الصلاحية</span>
                    </div>
                  )}
                  {order.status === "تم التوصيل" && order.driverId && !ratedOrders.has(order.id) && (
                    <button
                      onClick={() => setRatingModal({ orderId: order.id, driverId: order.driverId! })}
                      className="flex items-center gap-1 text-xs text-amber-600 bg-amber-50 hover:bg-amber-100 dark:bg-amber-900/20 px-3 py-1.5 rounded-full transition-colors font-medium"
                    >
                      <Star className="w-3 h-3 fill-amber-500 text-amber-500" />قيّم التوصيل
                    </button>
                  )}
                  {order.status === "تم التوصيل" && ratedOrders.has(order.id) && (
                    <div className="flex items-center gap-1 text-xs text-slate-400 px-3 py-1.5">
                      <Star className="w-3 h-3 fill-slate-300 text-slate-300" />تم التقييم
                    </div>
                  )}
                  {/* ── Add favourite driver (Phase 7) ──────────────────── */}
                  {order.status === "تم التوصيل" && order.driverId && (() => {
                    const dId = order.driverId!;
                    const alreadyAdded = favDriverIds.has(dId) || favSuccess.has(order.id);
                    if (alreadyAdded) return (
                      <div className="flex items-center gap-1 text-xs text-rose-400 px-3 py-1.5">
                        <Heart className="w-3 h-3 fill-rose-400 text-rose-400" />مفضل ✔
                      </div>
                    );
                    if (favError[order.id]) return (
                      <div className="text-xs text-red-500 px-3 py-1.5">{favError[order.id]}</div>
                    );
                    return (
                      <button
                        onClick={() => handleAddFavorite(order.id, dId)}
                        disabled={addingFavFor === order.id}
                        className="flex items-center gap-1 text-xs text-rose-600 bg-rose-50 hover:bg-rose-100 dark:bg-rose-900/20 px-3 py-1.5 rounded-full transition-colors font-medium disabled:opacity-50"
                      >
                        {addingFavFor === order.id
                          ? <Loader2 className="w-3 h-3 animate-spin" />
                          : <Heart className="w-3 h-3" />}
                        إضافة كسائق مفضل
                      </button>
                    );
                  })()}
                  {order.status === "ملغى" && (
                    <div className="flex items-center gap-1.5 text-red-500 bg-red-50 dark:bg-red-900/20 px-3 py-1.5 rounded-full text-sm font-medium">
                      <XCircle className="w-4 h-4" /><span>ملغى</span>
                    </div>
                  )}
                </div>
                {order.status === "معلق" && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setResendConfirmOrderId(order.id)}
                      disabled={resending}
                      className="flex items-center gap-1 text-xs text-sky-600 hover:text-sky-800 bg-sky-50 hover:bg-sky-100 dark:bg-sky-900/20 dark:hover:bg-sky-900/30 px-3 py-1.5 rounded-full transition-colors font-medium disabled:opacity-50"
                      data-testid={`button-resend-${order.id}`}
                    >
                      <RefreshCw className="w-3 h-3" />
                      إعادة الإرسال
                    </button>
                    <button
                      onClick={() => handleCancel(order.id)}
                      disabled={cancelMutation.isPending}
                      className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 dark:bg-red-900/20 px-3 py-1.5 rounded-full transition-colors font-medium"
                      data-testid={`button-cancel-${order.id}`}
                    >
                      {cancelMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
                      إلغاء الطلبية
                    </button>
                  </div>
                )}
              </div>

              {order.status === "تم التوصيل" && (
                <div className="mt-4 rounded-2xl border border-violet-200 bg-violet-50/80 p-4 dark:border-violet-800 dark:bg-violet-900/20" dir="rtl">
                  <div className="flex items-start gap-3">
                    <Share2 className="mt-0.5 h-5 w-5 shrink-0 text-violet-600 dark:text-violet-300" />
                    <div className="flex-1">
                      <p className="font-black text-violet-900 dark:text-violet-200">
                        شارك تجربتك واحصل على لفة عجلة حظ!
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-violet-700 dark:text-violet-300">
                        شارك الرابط الجاهز عبر واتساب أو فيسبوك أو إنستغرام.
                      </p>
                      <button
                        onClick={() => handleSocialShare(order.id)}
                        disabled={!socialReferralCode}
                        className="mt-3 flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid={`button-social-share-${order.id}`}
                      >
                        {socialShareState === order.id ? <Check className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}
                        {socialShareState === order.id ? "تم تجهيز المشاركة" : "مشاركة التجربة"}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Live driver map — visible only while the driver is en-route */}
              {order.status === "قيد التوصيل" && order.driverId && order.latitude && order.longitude && (
                <LiveDriverMap
                  driverId={order.driverId}
                  destLat={Number(order.latitude)}
                  destLng={Number(order.longitude)}
                  orderId={order.id}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
