import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ArrowRight, BookOpen, Check, ChevronLeft, Loader2, Plus, Wallet, X } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { Layout } from "@/components/layout";

type DebtAccount = {
  id: string;
  consumerId: string;
  consumerName: string | null;
  consumerPhone: string | null;
  debtCeiling: number;
  balance: number;
  status: string;
  updatedAt: string;
};

type EligibleConsumer = {
  consumerId: string;
  consumerName: string | null;
  consumerPhone: string | null;
  isInDebtBook: boolean;
  balance: number;
  debtCeiling: number | null;
};

type ConsumerDebt = {
  id: string;
  driverId: string;
  driverName: string;
  driverPhone: string | null;
  debtCeiling: number;
  balance: number;
  status: string;
  purchases: {
    orderId: string;
    amount: number;
    waterVolume: string;
    barrelCount: number;
    createdAt: string;
  }[];
};

function money(value: number) {
  return new Intl.NumberFormat("ar-DZ", { maximumFractionDigits: 0 }).format(value);
}

function errorMessage(error: unknown) {
  const apiError = error as { data?: { error?: string } } | null;
  return apiError?.data?.error ?? "تعذّر تنفيذ العملية، حاول مرة أخرى";
}

export default function DebtBookPage() {
  const { userId, userType } = useAuth();
  const [, setLocation] = useLocation();

  if (!userId) {
    setLocation("/");
    return null;
  }

  return (
    <Layout>
      {userType === "سائق" ? <DriverDebtBook /> : <ConsumerDebts />}
    </Layout>
  );
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  const [, setLocation] = useLocation();
  return (
    <div className="relative flex items-center justify-center mb-6 min-h-11" dir="rtl">
      <button
        onClick={() => setLocation("/profile")}
        className="absolute left-0 w-10 h-10 rounded-full bg-white/80 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-200 shadow-sm"
        aria-label="العودة إلى الملف الشخصي"
      >
        <ArrowRight className="w-5 h-5" />
      </button>
      <div className="text-right">
        <h1 className="text-2xl font-black text-slate-800 dark:text-white">{title}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{subtitle}</p>
      </div>
    </div>
  );
}

function DriverDebtBook() {
  const [accounts, setAccounts] = useState<DebtAccount[]>([]);
  const [consumers, setConsumers] = useState<EligibleConsumer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showConsumers, setShowConsumers] = useState(false);
  const [selectedConsumer, setSelectedConsumer] = useState<EligibleConsumer | null>(null);
  const [ceiling, setCeiling] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const loadAccounts = async () => {
    const data = await customFetch<DebtAccount[]>("/api/debt-book");
    setAccounts(data);
  };

  useEffect(() => {
    loadAccounts().catch((err) => setError(errorMessage(err))).finally(() => setIsLoading(false));
  }, []);

  const openConsumerPicker = async () => {
    setError("");
    try {
      const data = await customFetch<{ consumers: EligibleConsumer[] }>("/api/debt-book/consumers");
      setConsumers(data.consumers);
      setShowConsumers(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const addConsumer = async () => {
    if (!selectedConsumer) return;
    setSaving(true);
    setError("");
    try {
      await customFetch("/api/debt-book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consumerId: selectedConsumer.consumerId, debtCeiling: Number(ceiling) }),
      });
      await loadAccounts();
      setSelectedConsumer(null);
      setCeiling("");
      setShowConsumers(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-md mx-auto p-4 pb-10" dir="rtl">
      <div className="relative">
        <PageHeader title="دفتر الديون" subtitle="تابع ديون المستهلكين الذين توصلت إليهم" />
        <button
          onClick={openConsumerPicker}
          className="absolute top-0 right-0 w-11 h-11 rounded-2xl bg-primary text-white flex items-center justify-center shadow-lg shadow-primary/25 hover:opacity-90"
          aria-label="إضافة مستهلك إلى دفتر الديون"
          data-testid="button-add-debtor"
        >
          <Plus className="w-6 h-6" />
        </button>
      </div>

      {error && <p className="mb-4 rounded-2xl bg-red-50 text-red-600 p-3 text-sm font-bold" role="alert">{error}</p>}

      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-7 h-7 animate-spin text-primary" /></div>
      ) : accounts.length === 0 ? (
        <div className="glass-panel rounded-3xl p-8 text-center">
          <BookOpen className="w-12 h-12 text-primary/60 mx-auto mb-4" />
          <h2 className="font-black text-lg text-slate-800 dark:text-white">دفتر الديون فارغ</h2>
          <p className="text-sm text-slate-500 mt-2 leading-relaxed">
            أضف مستهلكًا من الطلبات التي أوصلتها، ثم حدد له سقف الدين.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {accounts.map((account) => {
            const remaining = Math.max(account.debtCeiling - account.balance, 0);
            return (
              <div key={account.id} className="glass-panel rounded-3xl p-5 border border-primary/15">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-black text-lg text-slate-800 dark:text-white">{account.consumerName || "مستهلك"}</h2>
                    {account.consumerPhone && <p className="text-xs text-slate-500 mt-1">{account.consumerPhone}</p>}
                  </div>
                  <div className="rounded-xl bg-primary/10 p-2.5 text-primary"><Wallet className="w-5 h-5" /></div>
                </div>
                <div className="grid grid-cols-2 gap-3 mt-4">
                  <div className="rounded-2xl bg-red-50 dark:bg-red-950/20 p-3">
                    <p className="text-xs text-slate-500">الدين الحالي</p>
                    <p className="font-black text-red-600 mt-1">{money(account.balance)} دج</p>
                  </div>
                  <div className="rounded-2xl bg-emerald-50 dark:bg-emerald-950/20 p-3">
                    <p className="text-xs text-slate-500">المتبقي من السقف</p>
                    <p className="font-black text-emerald-600 mt-1">{money(remaining)} دج</p>
                  </div>
                </div>
                <p className="text-xs text-slate-500 mt-3">سقف الدين: {money(account.debtCeiling)} دج</p>
              </div>
            );
          })}
        </div>
      )}

      {showConsumers && (
        <div className="fixed inset-0 z-[100] bg-slate-950/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-3xl p-5 w-full max-w-md max-h-[85vh] overflow-y-auto" dir="rtl">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-black text-slate-800 dark:text-white">اختر مستهلكًا</h2>
              <button onClick={() => setShowConsumers(false)} className="w-9 h-9 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center" aria-label="إغلاق"><X className="w-5 h-5" /></button>
            </div>
            {consumers.length === 0 ? (
              <p className="text-center text-sm text-slate-500 py-8">لا يوجد مستهلكون أكملت توصيل طلباتهم بعد.</p>
            ) : (
              <div className="space-y-2">
                {consumers.map((consumer) => (
                  <button
                    key={consumer.consumerId}
                    disabled={consumer.isInDebtBook}
                    onClick={() => setSelectedConsumer(consumer)}
                    className="w-full text-right p-4 rounded-2xl border border-slate-200 dark:border-slate-700 disabled:opacity-50 hover:border-primary transition-colors"
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span>
                        <span className="block font-bold text-slate-800 dark:text-white">{consumer.consumerName || "مستهلك"}</span>
                        {consumer.consumerPhone && <span className="block text-xs text-slate-500 mt-1">{consumer.consumerPhone}</span>}
                      </span>
                      {consumer.isInDebtBook ? <span className="text-xs text-emerald-600 font-bold flex items-center gap-1"><Check className="w-4 h-4" />مضاف</span> : <ChevronLeft className="w-5 h-5 text-primary" />}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {selectedConsumer && (
        <div className="fixed inset-0 z-[110] bg-slate-950/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-3xl p-5 w-full max-w-md" dir="rtl">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-black text-slate-800 dark:text-white">إضافة إلى دفتر الديون</h2>
              <button onClick={() => setSelectedConsumer(null)} className="w-9 h-9 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center" aria-label="إغلاق"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-slate-500 mb-5">{selectedConsumer.consumerName || "المستهلك"}</p>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-200 mb-2">سقف الدين (دج)</label>
            <input
              type="number"
              min="1"
              value={ceiling}
              onChange={(event) => setCeiling(event.target.value)}
              placeholder="مثال: 5000"
              className="w-full rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-4 py-3 outline-none focus:ring-2 focus:ring-primary"
              autoFocus
            />
            <p className="text-xs text-slate-500 mt-2">سيُضاف هذا السائق تلقائيًا إلى المفضلة لدى المستهلك.</p>
            <button
              onClick={addConsumer}
              disabled={saving || !ceiling || Number(ceiling) <= 0}
              className="w-full mt-5 py-3.5 rounded-2xl bg-primary text-white font-bold disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Check className="w-5 h-5" />}
              حفظ في دفتر الديون
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ConsumerDebts() {
  const [debts, setDebts] = useState<ConsumerDebt[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    customFetch<ConsumerDebt[]>("/api/debts")
      .then(setDebts)
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setIsLoading(false));
  }, []);

  const total = debts.reduce((sum, debt) => sum + debt.balance, 0);

  return (
    <div className="max-w-md mx-auto p-4 pb-10" dir="rtl">
      <PageHeader title="ديوني" subtitle="المبالغ المستحقة لكل سائق" />
      {error && <p className="mb-4 rounded-2xl bg-red-50 text-red-600 p-3 text-sm font-bold" role="alert">{error}</p>}
      <div className="rounded-3xl bg-gradient-to-br from-primary to-cyan-500 text-white p-5 mb-5 shadow-lg shadow-primary/20">
        <p className="text-sm text-white/80">إجمالي الديون</p>
        <p className="text-3xl font-black mt-1">{money(total)} <span className="text-base">دج</span></p>
      </div>
      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-7 h-7 animate-spin text-primary" /></div>
      ) : debts.length === 0 ? (
        <div className="glass-panel rounded-3xl p-8 text-center">
          <Wallet className="w-12 h-12 text-emerald-500/70 mx-auto mb-4" />
          <h2 className="font-black text-lg text-slate-800 dark:text-white">لا توجد ديون</h2>
          <p className="text-sm text-slate-500 mt-2">ستظهر هنا المبالغ التي اشتريتها بالدين.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {debts.map((debt) => (
            <div key={debt.id} className="glass-panel rounded-3xl p-5 border border-red-200/60 dark:border-red-900/40">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="font-black text-lg text-slate-800 dark:text-white">{debt.driverName}</h2>
                  {debt.driverPhone && <p className="text-xs text-slate-500 mt-1">{debt.driverPhone}</p>}
                </div>
                <p className="font-black text-red-600">{money(debt.balance)} دج</p>
              </div>
              <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500">
                سقف الدين: {money(debt.debtCeiling)} دج · المتبقي: {money(Math.max(debt.debtCeiling - debt.balance, 0))} دج
              </div>
              {debt.purchases.length > 0 && (
                <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800">
                  <p className="text-sm font-black text-slate-700 dark:text-slate-200 mb-2">المشتريات بالدين</p>
                  <div className="space-y-2">
                    {debt.purchases.map((purchase) => (
                      <div key={purchase.orderId} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 dark:bg-slate-800/70 px-3 py-2">
                        <span className="text-xs text-slate-500">{purchase.waterVolume} · {purchase.barrelCount} براميل</span>
                        <span className="text-sm font-black text-red-600">{money(purchase.amount)} دج</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}