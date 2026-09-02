import { and, isNull, lte, sql } from "drizzle-orm";
import { couponsTable, db } from "@workspace/db";
import { getSupabaseAdmin } from "./supabase-server";

/**
 * A coupon starts its 60-day clock at the first paid renewal or at the end
 * of the original free period, whichever happens first. The daily job is
 * deliberately catch-up safe so a restart does not lose an activation.
 */
export async function activateExpiredTrialCoupons(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE "coupons" AS c
    SET
      "activation_trigger_at" = u."subscription_expires_at",
      "expires_at" = u."subscription_expires_at" + INTERVAL '60 days'
    FROM "users" AS u
    WHERE c."user_id" = u."id"
      AND c."activation_trigger_at" IS NULL
      AND c."used_at" IS NULL
      AND u."user_type" = 'سائق'
      AND u."first_approval_granted" = true
      AND u."subscription_expires_at" IS NOT NULL
      AND u."subscription_expires_at" <= NOW()
      AND NOT EXISTS (
        SELECT 1
        FROM "subscription_payments" AS p
        WHERE p."driver_id" = u."id"
          AND p."status" = 'approved'
      )
    RETURNING c."id"
  `);

  return result.rows.length;
}

async function notifyExpiringCoupons(): Promise<number> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return 0;

  const now = new Date();
  const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const expiring = await db
    .select({
      id: couponsTable.id,
      userId: couponsTable.userId,
      expiresAt: couponsTable.expiresAt,
    })
    .from(couponsTable)
    .where(and(
      isNull(couponsTable.usedAt),
      sql`${couponsTable.expiresAt} > ${now}`,
      lte(couponsTable.expiresAt, nextWeek),
    ));

  let notified = 0;
  for (const coupon of expiring) {
    const key = `[coupon-expiry:${coupon.id}]`;
    const { data: existing, error: lookupError } = await supabase
      .from("announcements")
      .select("id")
      .eq("target_audience", coupon.userId)
      .like("content", `%${key}%`)
      .limit(1);

    if (lookupError || existing?.length) continue;

    const { error } = await supabase.from("announcements").insert({
      title: "قسيمتك تنتهي قريباً",
      content: `قسيمتك تنتهي قريباً، استخدمها الآن! ${key}`,
      target_audience: coupon.userId,
      is_active: true,
    });
    if (!error) notified += 1;
  }

  return notified;
}

async function runCouponLifecycleJobs(): Promise<void> {
  try {
    const activated = await activateExpiredTrialCoupons();
    const notified = await notifyExpiringCoupons();
    if (activated || notified) {
      console.log(`[coupons] lifecycle run: activated=${activated}, notified=${notified}`);
    }
  } catch (error) {
    console.error("[coupons] lifecycle run failed", error);
  }
}

export function startCouponLifecycleJobs(): void {
  // Run once at startup to catch up, then once every 24 hours.
  void runCouponLifecycleJobs();
  setInterval(() => void runCouponLifecycleJobs(), 24 * 60 * 60 * 1000);
}