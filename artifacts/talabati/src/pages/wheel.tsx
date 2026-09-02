import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { Layout } from "@/components/layout";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  Dices,
  Gift,
  Loader2,
  RotateCcw,
  Search,
  Send,
  Ticket,
  UserRound,
  XCircle,
} from "lucide-react";

type SpinResult = {
  resultType: "discount" | "reroll";
  outcome: 100 | 75 | 50 | 25 | 10 | null;
  couponId: string | null;
  spinsRemaining: number;
  maxDiscountAmount: number | null;
  amountToPay: number | null;
  grantedSpinId: string | null;
};

export type Coupon = {
  id: string;
  discountPercentage: number;
  maxDiscountAmount: number | null;
  amountToPay: number;
  status: "pending_activation" | "active" | "used" | "expired";
  wonAt: string;
  activationTriggerAt: string | null;
  expiresAt: string | null;
  usedAt: string | null;
  appliedToPaymentId: string | null;
};

const SEGMENTS = [
  { label: "100%", color: "#8b5cf6" },
  { label: "75%", color: "#06b6d4" },
  { label: "50%", color: "#10b981" },
  { label: "25%", color: "#f59e0b" },
  { label: "10%", color: "#f97316" },
  { label: "إعادة", color: "#64748b" },
];

type GiftItem = {
  kind: "coupon" | "spin";
  id: string;
  label: string;
};

type DriverOption = {
  id: string;
  name: string;
  wilaya: string;
  commune: string;
};

function outcomeMessage(result: SpinResult): string {
  if (result.outcome === null) return "حصلت على لفة إضافية فوراً!";
  if (result.outcome === 100) return "مبروك! ربحت شهراً مجانياً بالكامل";
  if (result.outcome === 75) return "ربحت خصم 75% بحد أقصى 750 دج — السعر بعد الخصم 750 دج بدل 1500 دج";
  if (result.outcome === 50) return "ربحت خصم 50% بحد أقصى 500 دج — السعر بعد الخصم 1000 دج";
  if (result.outcome === 25) return "ربحت خصم 25% — السعر بعد الخصم 1125 دج";
  return "ربحت خصم 10% — السعر بعد الخصم 1350 دج";
}

export default function WheelPage() {
  const { userId } = useAuth();
  const [, setLocation] = useLocation();

  if (!userId) {
    setLocation("/");
    return null;
  }

  return (
    <Layout>
      <WheelContent />
    </Layout>
  );
}

function WheelContent() {
  const { userType } = useAuth();
  const [, setLocation] = useLocation();
  const [availableSpins, setAvailableSpins] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<SpinResult | null>(null);
  const [giftItem, setGiftItem] = useState<GiftItem | null>(null);
  const [error, setError] = useState("");

  const refreshBalance = () => {
    customFetch<{ availableSpins: number }>("/api/wheel-spins/balance")
      .then((data) => setAvailableSpins(data.availableSpins))
      .catch(() => setError("تعذر تحميل رصيد اللفات"));
  };

  useEffect(() => {
    refreshBalance();
  }, []);

  const handleSpin = async () => {
    if (spinning || availableSpins < 1) return;
    setError("");
    setResult(null);
    setSpinning(true);

    try {
      const spin = await customFetch<SpinResult>("/api/wheel-spins/spin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const segmentIndex = spin.outcome === 100 ? 0
        : spin.outcome === 75 ? 1
          : spin.outcome === 50 ? 2
            : spin.outcome === 25 ? 3
              : spin.outcome === 10 ? 4 : 5;
      const targetAngle = 360 - (segmentIndex * 60 + 30);
      setRotation((current) => current + 6 * 360 + ((targetAngle - current) % 360 + 360) % 360);
      setAvailableSpins(spin.spinsRemaining);
      window.setTimeout(() => {
        setResult(spin);
        setSpinning(false);
      }, 4300);
    } catch (err: unknown) {
      const response = err as { data?: { error?: string }; message?: string };
      setError(response?.data?.error || response?.message || "تعذر تنفيذ اللفة");
      setSpinning(false);
      refreshBalance();
    }
  };

  return (
    <div className="flex flex-col gap-6 w-full animate-in fade-in duration-500" dir="rtl">
      <div className="flex items-center gap-3">
        <button onClick={() => setLocation("/profile")} className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 transition-colors" aria-label="رجوع">
          <ArrowRight className="w-5 h-5 text-slate-600 dark:text-slate-300" />
        </button>
        <div>
          <h1 className="text-xl font-black text-slate-800 dark:text-white">عجلة الحظ</h1>
          <p className="text-sm text-slate-500">استخدم لفاتك واربح قسائم اشتراك</p>
        </div>
      </div>

      <div className="glass-panel rounded-3xl p-6 border border-violet-200 dark:border-violet-800/50 text-center">
        <div className="inline-flex items-center gap-2 rounded-full bg-violet-100 dark:bg-violet-900/30 px-4 py-2 text-violet-700 dark:text-violet-300 font-black">
          <Dices className="w-5 h-5" />
          {availableSpins} {availableSpins === 1 ? "لفة متاحة" : "لفات متاحة"}
        </div>

        <div className="relative w-72 h-72 max-w-full mx-auto my-8">
          <div className="absolute -top-4 left-1/2 -translate-x-1/2 z-10 w-0 h-0 border-l-[14px] border-l-transparent border-r-[14px] border-r-transparent border-t-[28px] border-t-slate-800 dark:border-t-white" />
          <div
            className="w-full h-full rounded-full border-[10px] border-white dark:border-slate-800 shadow-2xl overflow-hidden relative"
            style={{
              background: `conic-gradient(${SEGMENTS.map((segment, index) => `${segment.color} ${index * 60}deg ${(index + 1) * 60}deg`).join(", ")})`,
              transform: `rotate(${rotation}deg)`,
              transition: spinning ? "transform 4.2s cubic-bezier(0.16, 1, 0.3, 1)" : "none",
            }}
          >
            {SEGMENTS.map((segment, index) => (
              <span
                key={segment.label}
                className="absolute left-1/2 top-1/2 text-white font-black text-sm drop-shadow-md"
                style={{
                  transform: `rotate(${index * 60 + 30}deg) translateY(-105px) rotate(-${index * 60 + 30}deg)`,
                }}
              >
                {segment.label}
              </span>
            ))}
            <div className="absolute inset-1/3 rounded-full bg-white dark:bg-slate-900 border-4 border-violet-200 dark:border-violet-800 flex items-center justify-center">
              <Gift className="w-8 h-8 text-violet-600" />
            </div>
          </div>
        </div>

        {error && <p className="mb-4 rounded-2xl bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-600">{error}</p>}
        <button
          onClick={handleSpin}
          disabled={spinning || availableSpins < 1}
          className="w-full max-w-xs mx-auto py-4 rounded-2xl bg-gradient-to-r from-violet-600 to-cyan-500 text-white font-black shadow-lg shadow-violet-500/25 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          data-testid="button-spin-wheel"
        >
          {spinning ? <><Loader2 className="w-5 h-5 animate-spin" /> العجلة تدور...</> : <><RotateCcw className="w-5 h-5" /> {availableSpins ? "أدر العجلة" : "لا توجد لفات متاحة"}</>}
        </button>
        <button onClick={() => setLocation("/coupons")} className="mt-4 text-sm font-bold text-violet-600 hover:underline">
          <Ticket className="w-4 h-4 inline ml-1" /> عرض قسائمي
        </button>
      </div>

      {result && (
        <div className="glass-panel rounded-3xl p-6 text-center border-2 border-emerald-300 dark:border-emerald-700 animate-in zoom-in-95 duration-300">
          <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-3" />
          <h2 className="text-xl font-black text-slate-800 dark:text-white mb-2">{outcomeMessage(result)}</h2>
          <p className="text-sm text-slate-500">
            {result.couponId ? "تمت إضافة القسيمة إلى حسابك ويمكنك مراجعتها من قسم قسائمي." : "تمت إضافة اللفة الجديدة إلى رصيدك."}
          </p>
          {result.couponId && (
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button onClick={() => setLocation("/coupons")} className="rounded-2xl bg-emerald-100 dark:bg-emerald-900/30 px-5 py-3 text-emerald-700 dark:text-emerald-300 font-bold">
                فتح قسائمي
              </button>
              {userType === "مستهلك" && (
                <button
                  onClick={() => setGiftItem({ kind: "coupon", id: result.couponId!, label: `قسيمة خصم ${result.outcome}%` })}
                  className="rounded-2xl bg-violet-100 dark:bg-violet-900/30 px-5 py-3 text-violet-700 dark:text-violet-300 font-bold inline-flex items-center gap-2"
                >
                  <Send className="w-4 h-4" /> إهداء
                </button>
              )}
            </div>
          )}
          {result.grantedSpinId && userType === "مستهلك" && (
            <button
              onClick={() => setGiftItem({ kind: "spin", id: result.grantedSpinId!, label: "لفة عجلة حظ" })}
              className="mt-4 rounded-2xl bg-violet-100 dark:bg-violet-900/30 px-5 py-3 text-violet-700 dark:text-violet-300 font-bold inline-flex items-center gap-2"
            >
              <Send className="w-4 h-4" /> إهداء اللفة الجديدة
            </button>
          )}
        </div>
      )}

      {giftItem && (
        <GiftDialog
          item={giftItem}
          onClose={() => setGiftItem(null)}
          onSuccess={() => setGiftItem(null)}
        />
      )}
    </div>
  );
}

export function CouponsPage() {
  const { userId, userType } = useAuth();
  const [, setLocation] = useLocation();
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [giftItem, setGiftItem] = useState<GiftItem | null>(null);

  useEffect(() => {
    if (!userId) return;
    customFetch<Coupon[]>("/api/coupons")
      .then(setCoupons)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [userId]);

  if (!userId) {
    setLocation("/");
    return null;
  }

  return (
    <Layout>
      <div className="flex flex-col gap-5 w-full animate-in fade-in duration-500" dir="rtl">
        <div className="flex items-center gap-3">
          <button onClick={() => setLocation("/wheel")} className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 transition-colors" aria-label="رجوع">
            <ArrowRight className="w-5 h-5 text-slate-600 dark:text-slate-300" />
          </button>
          <div>
            <h1 className="text-xl font-black text-slate-800 dark:text-white">قسائمي</h1>
            <p className="text-sm text-slate-500">قسائم الخصم التي ربحتها من عجلة الحظ</p>
          </div>
        </div>

        {loading ? (
          <div className="h-40 rounded-3xl bg-slate-100 dark:bg-slate-800 animate-pulse" />
        ) : coupons.length === 0 ? (
          <div className="glass-panel rounded-3xl p-8 text-center">
            <Ticket className="w-12 h-12 text-slate-300 mx-auto mb-3" />
            <p className="font-bold text-slate-600 dark:text-slate-300">لا توجد قسائم بعد</p>
            <button onClick={() => setLocation("/wheel")} className="mt-4 text-sm text-violet-600 font-bold hover:underline">اذهب إلى عجلة الحظ</button>
          </div>
        ) : (
          coupons.map((coupon) => (
            <CouponCard
              key={coupon.id}
              coupon={coupon}
              isConsumer={userType === "مستهلك"}
              onUse={() => setLocation(`/subscription?couponId=${encodeURIComponent(coupon.id)}`)}
              onGift={() => setGiftItem({
                kind: "coupon",
                id: coupon.id,
                label: coupon.discountPercentage === 100 ? "شهر مجاني" : `قسيمة خصم ${coupon.discountPercentage}%`,
              })}
            />
          ))
        )}
      </div>
      {giftItem && (
        <GiftDialog
          item={giftItem}
          onClose={() => setGiftItem(null)}
          onSuccess={() => setGiftItem(null)}
        />
      )}
    </Layout>
  );
}

function CouponCard({
  coupon,
  isConsumer,
  onUse,
  onGift,
}: {
  coupon: Coupon;
  isConsumer: boolean;
  onUse: () => void;
  onGift: () => void;
}) {
  const status = {
    pending_activation: { label: "بانتظار التفعيل", icon: <Clock3 className="w-4 h-4" />, color: "text-amber-700 bg-amber-50 dark:bg-amber-900/20" },
    active: { label: "نشطة", icon: <CheckCircle2 className="w-4 h-4" />, color: "text-emerald-700 bg-emerald-50 dark:bg-emerald-900/20" },
    used: { label: "مستخدمة", icon: <CheckCircle2 className="w-4 h-4" />, color: "text-slate-500 bg-slate-100 dark:bg-slate-800" },
    expired: { label: "منتهية", icon: <XCircle className="w-4 h-4" />, color: "text-red-600 bg-red-50 dark:bg-red-900/20" },
  }[coupon.status];
  const description = coupon.discountPercentage === 100
    ? "مبروك! ربحت شهراً مجانياً بالكامل"
    : `خصم ${coupon.discountPercentage}%${coupon.maxDiscountAmount ? ` (بحد أقصى ${coupon.maxDiscountAmount} دج)` : ""} — السعر بعد الخصم: ${coupon.amountToPay} دج بدل 1500 دج`;

  return (
    <div className="glass-panel rounded-3xl p-5 border border-violet-200 dark:border-violet-800/50">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
            <Ticket className="w-6 h-6 text-violet-600" />
          </div>
          <div>
            <h2 className="font-black text-slate-800 dark:text-white">{coupon.discountPercentage === 100 ? "شهر مجاني" : `خصم ${coupon.discountPercentage}%`}</h2>
            <p className="text-xs text-slate-500 mt-1 leading-relaxed">{description}</p>
          </div>
        </div>
        <span className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold ${status.color}`}>
          {status.icon}{status.label}
        </span>
      </div>
      <div className="mt-4 text-xs text-slate-400">
        {coupon.status === "pending_activation"
          ? "يبدأ عدّ الصلاحية عند أول دفعة فعلية أو انتهاء الفترة المجانية."
          : coupon.expiresAt
            ? `تنتهي في: ${new Date(coupon.expiresAt).toLocaleDateString("ar-DZ")}`
            : ""}
      </div>
      {coupon.status === "active" && !coupon.appliedToPaymentId && !isConsumer && (
        <button onClick={onUse} className="w-full mt-4 rounded-2xl bg-violet-100 dark:bg-violet-900/30 py-3 text-violet-700 dark:text-violet-300 font-bold">
          استخدام القسيمة في الاشتراك
        </button>
      )}
      {isConsumer &&
        (coupon.status === "active" || coupon.status === "pending_activation") &&
        !coupon.appliedToPaymentId && (
          <button onClick={onGift} className="w-full mt-4 rounded-2xl bg-violet-100 dark:bg-violet-900/30 py-3 text-violet-700 dark:text-violet-300 font-bold inline-flex items-center justify-center gap-2">
            <Send className="w-4 h-4" /> إهداء لسائق
          </button>
        )}
      {coupon.appliedToPaymentId && coupon.status !== "used" && (
        <p className="mt-3 text-xs text-amber-600 font-bold text-center">القسيمة محجوزة لوصل دفع قيد المراجعة</p>
      )}
    </div>
  );
}

function GiftDialog({
  item,
  onClose,
  onSuccess,
}: {
  item: GiftItem;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [search, setSearch] = useState("");
  const [drivers, setDrivers] = useState<DriverOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const timer = window.setTimeout(() => {
      customFetch<DriverOption[]>(`/api/gifts/drivers?search=${encodeURIComponent(search)}`)
        .then((data) => { if (!cancelled) setDrivers(data); })
        .catch((err: any) => {
          if (!cancelled) setError(err?.data?.error || "تعذر تحميل السائقين");
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search]);

  const sendGift = async (driver: DriverOption) => {
    setSendingId(driver.id);
    setError("");
    try {
      await customFetch(`/api/gifts/${item.kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driverId: driver.id,
          ...(item.kind === "coupon" ? { couponId: item.id } : { spinId: item.id }),
        }),
      });
      setSent(true);
      window.setTimeout(onSuccess, 900);
    } catch (err: any) {
      setError(err?.data?.error || err?.message || "تعذر إتمام الإهداء");
    } finally {
      setSendingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4" dir="rtl" role="dialog" aria-modal="true">
      <div className="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-900 p-5 shadow-2xl">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="font-black text-lg text-slate-800 dark:text-white">إهداء {item.label}</h2>
            <p className="text-xs text-slate-500 mt-1">اختر سائقاً من بلديتك فقط</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl" aria-label="إغلاق">×</button>
        </div>

        {sent ? (
          <div className="py-10 text-center">
            <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-3" />
            <p className="font-bold text-emerald-700 dark:text-emerald-300">تم إرسال الهدية للسائق بنجاح</p>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="absolute right-3 top-3 w-4 h-4 text-slate-400" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="ابحث باسم السائق"
                className="w-full rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 py-3 pr-10 pl-3 text-sm outline-none focus:border-violet-500"
                autoFocus
              />
            </div>
            {error && <p className="mt-3 rounded-xl bg-red-50 dark:bg-red-900/20 p-3 text-xs text-red-600">{error}</p>}
            <div className="mt-3 space-y-2">
              {loading ? (
                <p className="py-6 text-center text-sm text-slate-400">جارٍ البحث...</p>
              ) : drivers.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-400">لا يوجد سائق مطابق في بلديتك</p>
              ) : drivers.map((driver) => (
                <button
                  key={driver.id}
                  onClick={() => sendGift(driver)}
                  disabled={!!sendingId}
                  className="w-full rounded-2xl border border-slate-200 dark:border-slate-700 p-3 flex items-center gap-3 text-right hover:border-violet-400 disabled:opacity-60"
                >
                  <span className="w-9 h-9 rounded-full bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                    <UserRound className="w-4 h-4 text-violet-600" />
                  </span>
                  <span className="flex-1">
                    <strong className="block text-sm text-slate-800 dark:text-white">{driver.name}</strong>
                    <span className="text-xs text-slate-500">{driver.commune}، {driver.wilaya}</span>
                  </span>
                  {sendingId === driver.id ? <Loader2 className="w-4 h-4 animate-spin text-violet-600" /> : <Send className="w-4 h-4 text-violet-500" />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}