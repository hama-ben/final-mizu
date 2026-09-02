import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import QRCode from "qrcode";
import { useAuth } from "@/hooks/use-auth";
import { customFetch } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { NotificationSoundSettings } from "@/components/notification-sound-settings";
import { CustomerServiceModal } from "@/components/customer-service-modal";
import {
  DRIVER_ORDER_SOUND_KEY,
  CONSUMER_ARRIVAL_SOUND_KEY,
} from "@/hooks/use-notification-sound";
import {
  ArrowRight, UserCircle, Mail, Phone, Shield,
  Lock, Eye, EyeOff, Loader2, CheckCircle2, AlertCircle,
  Star, HeadphonesIcon, Gift, QrCode, Copy, Check, X,
} from "lucide-react";

type ReferralSummary = {
  referralCode: string;
  referralCount: number;
  qualifiedCount: number;
  targetCount: number;
  remainingCount: number;
  userType: string;
  rewardType: string;
  rewardCount: number;
  nextRewardAt: number;
};

export default function ProfilePage() {
  const { userId } = useAuth();
  const [, setLocation] = useLocation();

  if (!userId) { setLocation("/"); return null; }

  return (
    <Layout>
      <ProfileContent />
    </Layout>
  );
}

function ProfileContent() {
  const { name, email, userType, userId } = useAuth();
  const [, setLocation] = useLocation();

  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  const [showSupportModal, setShowSupportModal] = useState(false);
  const [referral, setReferral] = useState<ReferralSummary | null>(null);
  const [referralLoading, setReferralLoading] = useState(true);
  const [showReferralQr, setShowReferralQr] = useState(false);
  const [copiedReferral, setCopiedReferral] = useState(false);

  // Driver average rating
  const [avgRating, setAvgRating] = useState<number | null>(null);
  const [totalRatings, setTotalRatings] = useState(0);

  useEffect(() => {
    if (userType !== "سائق" || !userId) return;
    customFetch<{ avgStars: number | null; total: number }>(`/api/driver/${userId}/rating`)
      .then((data) => {
        setAvgRating(data.avgStars);
        setTotalRatings(data.total);
      })
      .catch(() => {});
  }, [userId, userType]);

  useEffect(() => {
    if (!userId) return;
    setReferralLoading(true);
    customFetch<ReferralSummary>("/api/referrals/me")
      .then(setReferral)
      .catch(() => {})
      .finally(() => setReferralLoading(false));
  }, [userId]);

  const handleBack = () => {
    if (userType === "سائق") setLocation("/driver-dashboard");
    else setLocation("/dashboard");
  };

  const handleChangePassword = async () => {
    setError("");
    setSuccess("");

    if (!oldPassword || !newPassword || !confirmPassword) {
      setError("يرجى ملء جميع حقول كلمة المرور");
      return;
    }
    if (newPassword.length < 6) {
      setError("كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("كلمة المرور الجديدة وتأكيدها غير متطابقتين");
      return;
    }

    setLoading(true);
    try {
      await customFetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      setSuccess("تم تغيير كلمة المرور بنجاح ✔");
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      setError(err?.data?.error ?? "تعذّر الاتصال بالخادم. يرجى التحقق من الاتصال بالإنترنت.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 w-full animate-in fade-in duration-500" dir="rtl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleBack}
          className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
        >
          <ArrowRight className="w-5 h-5 text-slate-600 dark:text-slate-300" />
        </button>
        <h1 className="text-xl font-black text-slate-800 dark:text-white">الملف الشخصي</h1>
      </div>

      {/* Profile info card */}
      <div className="glass-panel rounded-3xl p-6 border border-primary/20">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
            <UserCircle className="w-9 h-9 text-primary" />
          </div>
          <div>
            <p className="font-black text-lg text-slate-800 dark:text-white">{name}</p>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-primary/10 text-primary">
              {userType === "سائق" ? "سائق" : "مستهلك"}
            </span>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-3 bg-slate-50 dark:bg-slate-800/60 rounded-2xl p-4">
            <Mail className="w-5 h-5 text-slate-400 shrink-0" />
            <div className="min-w-0">
              <p className="text-xs text-slate-400 mb-0.5">البريد الإلكتروني</p>
              <p className="font-medium text-slate-800 dark:text-white text-sm truncate">{email}</p>
            </div>
          </div>

          <div className="flex items-center gap-3 bg-slate-50 dark:bg-slate-800/60 rounded-2xl p-4">
            <Shield className="w-5 h-5 text-emerald-500 shrink-0" />
            <div>
              <p className="text-xs text-slate-400 mb-0.5">حالة الحساب</p>
              <p className="font-medium text-emerald-600 dark:text-emerald-400 text-sm">نشط</p>
            </div>
          </div>
        </div>
      </div>

      {/* Referral invitations */}
      <div className="glass-panel rounded-3xl p-6 border border-violet-200 dark:border-violet-800/50">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-violet-50 dark:bg-violet-900/20 rounded-xl flex items-center justify-center">
            <Gift className="w-5 h-5 text-violet-600 dark:text-violet-400" />
          </div>
          <div>
            <h2 className="font-bold text-slate-800 dark:text-white">دعواتي</h2>
            <p className="text-xs text-slate-400">
              ادعُ أصدقاءك وساعدهم على الانضمام إلى Mizu
            </p>
          </div>
        </div>

        {referralLoading ? (
          <div className="h-24 rounded-2xl bg-slate-100/70 dark:bg-slate-800/60 animate-pulse" />
        ) : referral ? (
          <>
            <div className="rounded-2xl bg-violet-50 dark:bg-violet-900/20 p-4 mb-4">
              <p className="text-xs text-violet-700/70 dark:text-violet-300/70 mb-2">رمز الدعوة الخاص بك</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-center text-2xl font-black tracking-[0.25em] text-violet-700 dark:text-violet-300" dir="ltr">
                  {referral.referralCode}
                </code>
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(referral.referralCode);
                    } catch {
                      const input = document.createElement("textarea");
                      input.value = referral.referralCode;
                      document.body.appendChild(input);
                      input.select();
                      document.execCommand("copy");
                      input.remove();
                    }
                    setCopiedReferral(true);
                    window.setTimeout(() => setCopiedReferral(false), 1800);
                  }}
                  className="w-10 h-10 rounded-xl bg-white dark:bg-slate-800 text-violet-600 flex items-center justify-center shadow-sm"
                  title="نسخ الرمز"
                  aria-label="نسخ رمز الدعوة"
                  data-testid="button-copy-referral"
                >
                  {copiedReferral ? <Check className="w-5 h-5 text-emerald-500" /> : <Copy className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <p className="text-sm font-bold text-slate-700 dark:text-slate-200">
                  {referral.referralCount} دعوة مسجلة
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  {referral.qualifiedCount} مؤهلة · المكافأة التالية عند {referral.nextRewardAt}
                </p>
                <p className="text-xs text-violet-600 dark:text-violet-300 mt-1">
                  {userType === "سائق"
                    ? "مكافأة 10 إحالات: تُراجعها الإدارة"
                    : `المكافأة: لفة مجانية · حصلت عليها ${referral.rewardCount} مرة`}
                </p>
              </div>
              <div className="w-14 h-14 rounded-full border-4 border-violet-200 dark:border-violet-800 flex items-center justify-center text-sm font-black text-violet-700 dark:text-violet-300">
                {Math.round(((referral.qualifiedCount % referral.targetCount) / referral.targetCount) * 100)}%
              </div>
            </div>

            <button
              onClick={() => setShowReferralQr(true)}
              className="w-full py-3.5 rounded-2xl flex items-center justify-center gap-2 font-bold text-violet-700 dark:text-violet-300 bg-violet-100 dark:bg-violet-900/30 hover:bg-violet-200 dark:hover:bg-violet-900/50 transition-colors"
              data-testid="button-show-referral-qr"
            >
              <QrCode className="w-5 h-5" />
              عرض رمز QR للمشاركة
            </button>
          </>
        ) : (
          <p className="text-sm text-slate-400 text-center py-4">تعذر تحميل بيانات الدعوات</p>
        )}
      </div>

      {/* ── Feature 1: Driver star rating display ───────────────────────── */}
      {userType === "سائق" && (
        <div className="glass-panel rounded-3xl p-6 border border-amber-200 dark:border-amber-700/40">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-amber-50 dark:bg-amber-900/20 rounded-xl flex items-center justify-center">
              <Star className="w-5 h-5 text-amber-500 fill-amber-500" />
            </div>
            <div>
              <h2 className="font-bold text-slate-800 dark:text-white">تقييمي الإجمالي</h2>
              <p className="text-xs text-slate-400">تقييمات العملاء لأدائك</p>
            </div>
          </div>

          {avgRating === null && totalRatings === 0 ? (
            <div className="flex flex-col items-center gap-2 py-4 text-center">
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Star key={n} className="w-7 h-7 text-slate-200 dark:text-slate-700" />
                ))}
              </div>
              <p className="text-sm text-slate-400">لا توجد تقييمات بعد</p>
              <p className="text-xs text-slate-300 dark:text-slate-600">ستظهر تقييمات العملاء هنا بعد أول توصيل</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              {/* Star icons */}
              <div className="flex gap-1.5">
                {[1, 2, 3, 4, 5].map((n) => {
                  const filled = avgRating !== null && n <= Math.round(avgRating);
                  const half   = avgRating !== null && !filled && n - 0.5 <= avgRating;
                  return (
                    <Star
                      key={n}
                      className={`w-8 h-8 transition-colors ${
                        filled ? "fill-amber-400 text-amber-400"
                        : half  ? "fill-amber-200 text-amber-300"
                        : "text-slate-200 dark:text-slate-700"
                      }`}
                    />
                  );
                })}
              </div>
              {/* Numeric value */}
              <div className="text-center">
                <span className="text-3xl font-black text-slate-800 dark:text-white">
                  {avgRating !== null ? avgRating.toFixed(1) : "—"}
                </span>
                <span className="text-slate-400 text-lg font-medium"> / 5</span>
              </div>
              <p className="text-sm text-slate-500">
                بناءً على <span className="font-bold text-slate-700 dark:text-slate-200">{totalRatings}</span>{" "}
                {totalRatings === 1 ? "تقييم" : "تقييمات"}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Feature 4/6: Notification sound settings ────────────────────── */}
      {userType === "سائق" ? (
        <NotificationSoundSettings
          storageKey={DRIVER_ORDER_SOUND_KEY}
          title="صوت إشعار الطلب الجديد"
          description="النغمة التي تُشغَّل عند وصول طلب جديد"
        />
      ) : (
        <NotificationSoundSettings
          storageKey={CONSUMER_ARRIVAL_SOUND_KEY}
          title="صوت إشعار وصول السائق"
          description="النغمة التي تُشغَّل عند وصول السائق إلى منزلك"
        />
      )}

      {/* Password change card */}
      <div className="glass-panel rounded-3xl p-6 border border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 bg-amber-50 dark:bg-amber-900/20 rounded-xl flex items-center justify-center">
            <Lock className="w-5 h-5 text-amber-600" />
          </div>
          <div>
            <h2 className="font-bold text-slate-800 dark:text-white">تغيير كلمة المرور</h2>
            <p className="text-xs text-slate-400">أدخل كلمتك الحالية ثم الجديدة</p>
          </div>
        </div>

        <div className="space-y-4">
          <PasswordField
            label="كلمة المرور الحالية"
            value={oldPassword}
            onChange={setOldPassword}
            show={showOld}
            onToggle={() => setShowOld(v => !v)}
            placeholder="أدخل كلمة مرورك الحالية"
          />
          <PasswordField
            label="كلمة المرور الجديدة"
            value={newPassword}
            onChange={setNewPassword}
            show={showNew}
            onToggle={() => setShowNew(v => !v)}
            placeholder="6 أحرف على الأقل"
          />
          <PasswordField
            label="تأكيد كلمة المرور الجديدة"
            value={confirmPassword}
            onChange={setConfirmPassword}
            show={showConfirm}
            onToggle={() => setShowConfirm(v => !v)}
            placeholder="أعد كتابة كلمة المرور الجديدة"
          />
        </div>

        {error && (
          <div className="mt-4 flex items-center gap-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-2xl p-3">
            <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
            <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
          </div>
        )}

        {success && (
          <div className="mt-4 flex items-center gap-2 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700 rounded-2xl p-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
            <p className="text-sm text-emerald-700 dark:text-emerald-300">{success}</p>
          </div>
        )}

        <button
          onClick={handleChangePassword}
          disabled={loading}
          className="mt-5 w-full py-4 rounded-2xl flex items-center justify-center gap-3 font-bold text-white bg-gradient-to-r from-primary to-cyan-500 shadow-lg shadow-primary/25 hover:opacity-90 transition-all active:scale-[0.98] disabled:opacity-50"
        >
          {loading ? (
            <><Loader2 className="w-5 h-5 animate-spin" />جارٍ الحفظ...</>
          ) : (
            <><Lock className="w-5 h-5" />حفظ كلمة المرور الجديدة</>
          )}
        </button>
      </div>

      {/* ── Feature 5: Customer service ──────────────────────────────────── */}
      <div className="glass-panel rounded-3xl p-6 border border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-sky-50 dark:bg-sky-900/20 rounded-xl flex items-center justify-center">
            <HeadphonesIcon className="w-5 h-5 text-sky-600" />
          </div>
          <div>
            <h2 className="font-bold text-slate-800 dark:text-white">خدمة العملاء</h2>
            <p className="text-xs text-slate-400">تواصل مع فريق الدعم</p>
          </div>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4 leading-relaxed">
          هل واجهت مشكلة؟ هل لديك اقتراح؟ تواصل معنا مباشرةً وسنرد عليك في أقرب وقت.
        </p>
        <button
          onClick={() => setShowSupportModal(true)}
          className="w-full py-3.5 rounded-2xl flex items-center justify-center gap-2 font-bold text-white bg-gradient-to-r from-sky-500 to-cyan-500 shadow-md shadow-sky-400/25 hover:opacity-90 transition-all active:scale-[0.98]"
        >
          <HeadphonesIcon className="w-5 h-5" />
          مراسلة فريق الدعم
        </button>
      </div>

      {/* Customer service modal */}
      {showSupportModal && (
        <CustomerServiceModal
          userName={name ?? ""}
          userEmail={email ?? ""}
          userType={userType ?? ""}
          onClose={() => setShowSupportModal(false)}
        />
      )}

      {showReferralQr && referral && (
        <ReferralQrModal
          code={referral.referralCode}
          onClose={() => setShowReferralQr(false)}
        />
      )}
    </div>
  );
}

function ReferralQrModal({ code, onClose }: { code: string; onClose: () => void }) {
  const referralLink = `${window.location.origin}/register?ref=${encodeURIComponent(code)}`;
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);

  useEffect(() => {
    let active = true;
    setQrDataUrl(null);
    setQrError(false);

    QRCode.toDataURL(referralLink, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: "M",
    })
      .then((dataUrl) => {
        if (active) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (active) setQrError(true);
      });

    return () => {
      active = false;
    };
  }, [referralLink]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" dir="rtl">
      <div className="w-full max-w-sm bg-white dark:bg-slate-900 rounded-3xl shadow-2xl p-6 text-center">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-black text-slate-800 dark:text-white">رمز دعوة QR</h2>
          <button onClick={onClose} className="w-9 h-9 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center" aria-label="إغلاق">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>
        <div className="bg-white rounded-2xl p-4 inline-flex shadow-inner border border-slate-100 min-w-64 min-h-64 items-center justify-center">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt={`رمز الدعوة ${code}`} className="w-56 h-56" />
          ) : qrError ? (
            <p className="w-56 text-sm text-red-600">تعذر إنشاء رمز QR محلياً.</p>
          ) : (
            <p className="w-56 text-sm text-slate-500">جارٍ إنشاء رمز QR...</p>
          )}
        </div>
        <p className="text-xs text-slate-400 mt-4 leading-relaxed">
          عند مسح الرمز سيتم فتح صفحة التسجيل وتعبئة رمز الدعوة تلقائياً.
        </p>
        <code className="block mt-3 text-lg font-black tracking-[0.25em] text-violet-600" dir="ltr">{code}</code>
        <button onClick={onClose} className="w-full mt-5 py-3 rounded-2xl bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 font-bold">
          إغلاق
        </button>
      </div>
    </div>
  );
}

function PasswordField({
  label, value, onChange, show, onToggle, placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggle: () => void;
  placeholder: string;
}) {
  return (
    <div>
      <label className="text-sm font-medium text-slate-600 dark:text-slate-300 mb-1.5 block">{label}</label>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-2xl px-4 py-3 pr-12 text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all text-sm"
        />
        <button
          type="button"
          onClick={onToggle}
          className="absolute top-1/2 -translate-y-1/2 right-3 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors p-1"
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}
