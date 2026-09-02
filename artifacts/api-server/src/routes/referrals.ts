import { Router, type IRouter } from "express";
import { and, count, eq } from "drizzle-orm";
import { db, referralRewardsTable, referralsTable, usersTable } from "@workspace/db";
import { ensureReferralCode } from "../lib/referral-code";
import { REFERRAL_REWARD_TYPE, REFERRAL_TARGETS } from "../lib/referral-rewards";

const router: IRouter = Router();

router.get("/referrals/me", async (req, res): Promise<void> => {
  const userId = req.auth!.userId;

  try {
    const [user] = await db
      .select({
        name: usersTable.name,
        userType: usersTable.userType,
        referralCode: usersTable.referralCode,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId));

    if (!user) {
      res.status(404).json({ error: "الحساب غير موجود" });
      return;
    }

    const referralCode = user.referralCode ?? await ensureReferralCode(userId, user.name);
    const [[total], [qualified], [rewards]] = await Promise.all([
      db
        .select({ count: count() })
        .from(referralsTable)
        .where(eq(referralsTable.referrerId, userId)),
      db
        .select({ count: count() })
        .from(referralsTable)
        .where(and(
          eq(referralsTable.referrerId, userId),
          eq(referralsTable.status, "qualified"),
        )),
      db
        .select({ count: count() })
        .from(referralRewardsTable)
        .where(eq(referralRewardsTable.referrerId, userId)),
    ]);

    const target = REFERRAL_TARGETS[user.userType] ?? 20;
    const referralCount = Number(total?.count ?? 0);
    const qualifiedCount = Number(qualified?.count ?? 0);
    const rewardCount = Number(rewards?.count ?? 0);
    const progressInCycle = qualifiedCount % target;
    const nextRewardAt = (Math.floor(qualifiedCount / target) + 1) * target;

    res.json({
      referralCode,
      referralCount,
      qualifiedCount,
      targetCount: target,
      remainingCount: target - progressInCycle,
      userType: user.userType,
      rewardType: REFERRAL_REWARD_TYPE,
      rewardCount,
      nextRewardAt,
    });
  } catch (error) {
    req.log.error({ err: error, userId }, "referrals/me failed");
    res.status(500).json({ error: "تعذر تحميل بيانات الدعوات" });
  }
});

export default router;