import { and, count, eq, sql } from "drizzle-orm";
import {
  db,
  referralRewardsPendingAdminTable,
  referralRewardsTable,
  referralsTable,
  usersTable,
  wheelSpinsTable,
} from "@workspace/db";
import { getSupabaseAdmin } from "./supabase-server";
import { emitToUser } from "./socket-server";
import { sendPushToUser } from "./web-push";
import { grantWheelSpin } from "./wheel-spins";
import { completeNoDriverContest } from "./no-driver-contest";

export const REFERRAL_TARGETS: Record<string, number> = {
  "مستهلك": 20,
  "سائق": 10,
};

export const REFERRAL_REWARD_TYPE = "wheel_spin" as const;

export type ReferralQualificationReason =
  | "driver_approved"
  | "driver_completed_delivery"
  | "consumer_first_order";

export interface ReferralRewardResult {
  qualified: boolean;
  referrerId: string | null;
  qualifiedCount: number;
  milestone: number | null;
  rewardGranted: boolean;
  rewardType: typeof REFERRAL_REWARD_TYPE | "admin_review" | null;
  wheelSpinId: string | null;
  referredDriverWelcomeGranted?: boolean;
  referredDriverWelcomeSpinId?: string | null;
  socialShareRewardGranted?: boolean;
  socialShareSpinId?: string | null;
}

type DbExecutor = typeof db;

/**
 * Qualify one referral after a real product event:
 *   - a referred driver was approved by an admin and completed two deliveries
 *   - a referred consumer placed their first order
 *
 * The pending referral row and referrer row are locked together.  The unique
 * (referrer, milestone) constraint is the final idempotency guard, so retries
 * and concurrent event delivery cannot issue duplicate spins.
 */
export async function qualifyReferralForUser(
  referredId: string,
  reason: ReferralQualificationReason,
  executor: DbExecutor = db,
): Promise<ReferralRewardResult> {
  const result = await executor.transaction(async (tx) => {
    const pendingRows = await tx.execute(sql`
      SELECT
        r."id",
        r."referrer_id",
        r."referred_role",
        r."source",
        u."user_type" AS "referred_user_type"
      FROM "referrals" r
      INNER JOIN "users" u ON u."id" = r."referred_id"
      WHERE r."referred_id" = ${referredId}
        AND r."status" = ${"pending"}
      FOR UPDATE OF r
    `);
    const pending = pendingRows.rows[0] as {
      id?: string;
      referrer_id?: string;
      referred_role?: string;
      source?: string;
      referred_user_type?: string;
    } | undefined;

    if (!pending?.id || !pending.referrer_id) {
      return {
        qualified: false,
        referrerId: null,
        qualifiedCount: 0,
        milestone: null,
        rewardGranted: false,
        rewardType: null,
        wheelSpinId: null,
      };
    }

    const isDriverQualification = reason === "driver_approved" || reason === "driver_completed_delivery";
    const expectedRole = isDriverQualification ? "سائق" : "مستهلك";
    if (pending.referred_role !== expectedRole || pending.referred_user_type !== expectedRole) {
      return {
        qualified: false,
        referrerId: pending.referrer_id,
        qualifiedCount: 0,
        milestone: null,
        rewardGranted: false,
        rewardType: null,
        wheelSpinId: null,
      };
    }

    const referrerRows = await tx.execute(sql`
      SELECT "id", "user_type"
      FROM "users"
      WHERE "id" = ${pending.referrer_id}
      FOR UPDATE
    `);
    const referrer = referrerRows.rows[0] as { id?: string; user_type?: string } | undefined;
    const target = REFERRAL_TARGETS[referrer?.user_type ?? ""] ?? 0;
    if (!referrer?.id || target < 1) {
      return {
        qualified: false,
        referrerId: pending.referrer_id,
        qualifiedCount: 0,
        milestone: null,
        rewardGranted: false,
        rewardType: null,
        wheelSpinId: null,
      };
    }

    if (isDriverQualification) {
      const deliveryRows = await tx.execute(sql`
        SELECT COUNT(*) AS "completed_deliveries"
        FROM "orders"
        WHERE "driver_id" = ${referredId}
          AND "status" = ${"تم التوصيل"}
      `);
      const completedDeliveries = Number(
        (deliveryRows.rows[0] as { completed_deliveries?: string | number } | undefined)
          ?.completed_deliveries ?? 0,
      );
      if (completedDeliveries < 2) {
        return {
          qualified: false,
          referrerId: pending.referrer_id,
          qualifiedCount: 0,
          milestone: null,
          rewardGranted: false,
          rewardType: null,
          wheelSpinId: null,
        };
      }
    }

    await tx
      .update(referralsTable)
      .set({ status: "qualified", qualifiedAt: new Date() })
      .where(and(eq(referralsTable.id, pending.id), eq(referralsTable.status, "pending")));

    let referredDriverWelcomeGranted = false;
    let referredDriverWelcomeSpinId: string | null = null;
    if (pending.referred_role === "سائق") {
      // Serialize all qualification retries for this driver before checking
      // the source-specific spin. This protects the one-spin guarantee even
      // if a pending referral is ever re-evaluated after qualification.
      await tx.execute(sql`
        SELECT "id"
        FROM "users"
        WHERE "id" = ${referredId}
        FOR UPDATE
      `);

      const [existingWelcomeSpin] = await tx
        .select({ id: wheelSpinsTable.id })
        .from(wheelSpinsTable)
        .where(and(
          eq(wheelSpinsTable.userId, referredId),
          eq(wheelSpinsTable.source, "referred_driver_welcome"),
        ))
        .limit(1);

      if (existingWelcomeSpin) {
        referredDriverWelcomeSpinId = existingWelcomeSpin.id;
      } else {
        referredDriverWelcomeSpinId = await grantWheelSpin(
          referredId,
          "referred_driver_welcome",
          tx,
        );
        referredDriverWelcomeGranted = true;
      }
    }

    // Phase 5: if this qualified referred driver belongs to an active
    // no-driver contest, the second qualified referral grants its spin in the
    // same transaction and cannot be duplicated by concurrent callbacks.
    if (pending.referred_role === "سائق" && referrer.user_type === "مستهلك") {
      await completeNoDriverContest(pending.referrer_id, tx);
    }

    // Phase 8: a consumer who referred someone through the social-share link
    // receives a separate spin, capped at two social-share spins per month.
    // The referrer row is locked above, so concurrent qualifications cannot
    // both observe the same remaining monthly allowance.
    let socialShareSpinId: string | null = null;
    if (pending.source === "social_share" && referrer.user_type === "مستهلك") {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const [socialCount] = await tx
        .select({ count: count() })
        .from(wheelSpinsTable)
        .where(and(
          eq(wheelSpinsTable.userId, pending.referrer_id),
          eq(wheelSpinsTable.source, "social_share"),
          sql`${wheelSpinsTable.createdAt} >= ${monthStart}`,
          sql`${wheelSpinsTable.createdAt} < ${nextMonthStart}`,
        ));

      if (Number(socialCount?.count ?? 0) < 2) {
        socialShareSpinId = await grantWheelSpin(pending.referrer_id, "social_share", tx);
      }
    }

    const [qualified] = await tx
      .select({ count: count() })
      .from(referralsTable)
      .where(and(
        eq(referralsTable.referrerId, pending.referrer_id),
        eq(referralsTable.status, "qualified"),
      ));
    const qualifiedCount = Number(qualified?.count ?? 0);

    // Driver referrals reach an administrative review queue at ten qualified
    // referrals. No asset is created or granted automatically for this path.
    if (referrer.user_type === "سائق") {
      if (qualifiedCount < 10) {
        return {
          qualified: true,
          referrerId: pending.referrer_id,
          qualifiedCount,
          milestone: null,
          rewardGranted: false,
          rewardType: null,
          wheelSpinId: null,
          referredDriverWelcomeGranted,
          referredDriverWelcomeSpinId,
        };
      }

      await tx
        .insert(referralRewardsPendingAdminTable)
        .values({
          driverId: pending.referrer_id,
          thresholdReached: 10,
        })
        .onConflictDoNothing();

      return {
        qualified: true,
        referrerId: pending.referrer_id,
        qualifiedCount,
        milestone: 10,
        rewardGranted: false,
        rewardType: "admin_review" as const,
        wheelSpinId: null,
        referredDriverWelcomeGranted,
        referredDriverWelcomeSpinId,
      };
    }

    const milestone = Math.floor(qualifiedCount / target) * target;

    if (milestone < target) {
      return {
        qualified: true,
        referrerId: pending.referrer_id,
        qualifiedCount,
        milestone: null,
        rewardGranted: false,
        rewardType: null,
        wheelSpinId: null,
        referredDriverWelcomeGranted,
        referredDriverWelcomeSpinId,
        socialShareRewardGranted: socialShareSpinId !== null,
        socialShareSpinId,
      };
    }

    const [reward] = await tx
      .insert(referralRewardsTable)
      .values({
        referrerId: pending.referrer_id,
        milestone,
        rewardType: REFERRAL_REWARD_TYPE,
      })
      .onConflictDoNothing()
      .returning({ id: referralRewardsTable.id });

    if (!reward) {
      return {
        qualified: true,
        referrerId: pending.referrer_id,
        qualifiedCount,
        milestone,
        rewardGranted: false,
        rewardType: REFERRAL_REWARD_TYPE,
        wheelSpinId: null,
        referredDriverWelcomeGranted,
        referredDriverWelcomeSpinId,
        socialShareRewardGranted: socialShareSpinId !== null,
        socialShareSpinId,
      };
    }

    const wheelSpinId = await grantWheelSpin(pending.referrer_id, "referral_reward", tx);
    await tx
      .update(referralRewardsTable)
      .set({ wheelSpinId })
      .where(eq(referralRewardsTable.id, reward.id));

    return {
      qualified: true,
      referrerId: pending.referrer_id,
      qualifiedCount,
      milestone,
      rewardGranted: true,
      rewardType: REFERRAL_REWARD_TYPE,
      wheelSpinId,
      referredDriverWelcomeGranted,
      referredDriverWelcomeSpinId,
      socialShareRewardGranted: socialShareSpinId !== null,
      socialShareSpinId,
    };
  });

  if (result.referredDriverWelcomeGranted && result.referredDriverWelcomeSpinId) {
    await notifyReferredDriverWelcome(referredId);
  }
  if (result.rewardGranted && result.referrerId && result.milestone) {
    await notifyReferralReward(result.referrerId, result.milestone);
  }
  if (result.socialShareRewardGranted && result.referrerId) {
    await notifySocialShareReward(result.referrerId);
  }

  return result;
}

async function notifyReferredDriverWelcome(referredDriverId: string): Promise<void> {
  const title = "لفة ترحيب للسائق المُحال";
  const content = "مبروك! أكملت شرطك واستحققت لفة عجلة الحظ.";

  const supabase = getSupabaseAdmin();
  if (supabase) {
    const { error } = await supabase.from("announcements").insert({
      title,
      content,
      target_audience: referredDriverId,
      is_active: true,
    });
    if (error) {
      console.error("[referrals] failed to persist referred-driver welcome notification", error);
    }
  }

  emitToUser(referredDriverId, "referred_driver_welcome_granted", {
    rewardType: "referred_driver_welcome",
    message: content,
  });
  await sendPushToUser(referredDriverId, {
    title,
    body: content,
    url: "/wheel",
  });
}

async function notifySocialShareReward(referrerId: string): Promise<void> {
  const title = "مكافأة مشاركة اجتماعية";
  const content = "مبروك! حصلت على لفة عجلة حظ لمشاركة تجربتك.";

  const supabase = getSupabaseAdmin();
  if (supabase) {
    const { error } = await supabase.from("announcements").insert({
      title,
      content,
      target_audience: referrerId,
      is_active: true,
    });
    if (error) {
      console.error("[referrals] failed to persist social-share reward notification", error);
    }
  }

  emitToUser(referrerId, "social_share_reward_granted", {
    rewardType: "social_share",
    message: content,
  });
  await sendPushToUser(referrerId, {
    title,
    body: content,
    url: "/wheel",
  });
}

async function notifyReferralReward(referrerId: string, milestone: number): Promise<void> {
  const title = "مكافأة إحالة جديدة";
  const content = `تهانينا! أكملت ${milestone} إحالة مؤهلة وحصلت على لفة مجانية في عجلة الحظ.`;

  const supabase = getSupabaseAdmin();
  if (supabase) {
    const { error } = await supabase.from("announcements").insert({
      title,
      content,
      target_audience: referrerId,
      is_active: true,
    });
    if (error) {
      console.error("[referrals] failed to persist reward notification", error);
    }
  }

  emitToUser(referrerId, "referral_reward_granted", {
    rewardType: REFERRAL_REWARD_TYPE,
    milestone,
    message: content,
  });
  await sendPushToUser(referrerId, {
    title,
    body: content,
    url: "/wheel",
  });
}

export async function getReferralRewardCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(referralRewardsTable)
    .where(eq(referralRewardsTable.referrerId, userId));
  return Number(row?.count ?? 0);
}