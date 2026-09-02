import { Router, type IRouter } from "express";
import { and, asc, count, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import crypto from "crypto";
import {
  couponsTable,
  db,
  wheelSpinsTable,
} from "@workspace/db";
import { grantWheelSpin } from "../lib/wheel-spins";

const router: IRouter = Router();
export const SUBSCRIPTION_PRICE = 1500;

type WheelOutcome = 100 | 75 | 50 | 25 | 10 | null;

function selectOutcome(): WheelOutcome {
  const roll = crypto.randomInt(0, 100);
  if (roll < 2) return 100;
  if (roll < 7) return 75;
  if (roll < 20) return 50;
  if (roll < 45) return 25;
  if (roll < 80) return 10;
  return null;
}

function maxDiscountFor(percentage: number): number | null {
  if (percentage === 75) return 750;
  if (percentage === 50) return 500;
  return null;
}

export function discountAmountFor(percentage: number, maxDiscountAmount: number | null): number {
  if (percentage === 100) return SUBSCRIPTION_PRICE;
  const percentageDiscount = Math.round(SUBSCRIPTION_PRICE * percentage / 100);
  return maxDiscountAmount === null
    ? percentageDiscount
    : Math.min(percentageDiscount, maxDiscountAmount);
}

function amountToPay(percentage: number, maxDiscountAmount: number | null): number {
  return SUBSCRIPTION_PRICE - discountAmountFor(percentage, maxDiscountAmount);
}

function couponState(coupon: {
  activationTriggerAt: Date | null;
  expiresAt: Date | null;
  usedAt: Date | null;
}): "pending_activation" | "active" | "used" | "expired" {
  if (coupon.usedAt) return "used";
  if (coupon.expiresAt && coupon.expiresAt.getTime() <= Date.now()) return "expired";
  if (!coupon.activationTriggerAt) return "pending_activation";
  return "active";
}

router.get("/wheel-spins/balance", async (req, res): Promise<void> => {
  const userId = req.auth!.userId;
  const [available] = await db
    .select({ count: count() })
    .from(wheelSpinsTable)
    .where(and(eq(wheelSpinsTable.userId, userId), isNull(wheelSpinsTable.usedAt)));

  res.json({ availableSpins: Number(available?.count ?? 0) });
});

router.post("/wheel-spins/spin", async (req, res): Promise<void> => {
  const userId = req.auth!.userId;

  try {
    const outcome = selectOutcome();
    const result = await db.transaction(async (tx) => {
      const available = await tx.execute(sql`
        SELECT "id"
        FROM "wheel_spins"
        WHERE "user_id" = ${userId}
          AND "used_at" IS NULL
        ORDER BY "created_at" ASC
        LIMIT 1
        FOR UPDATE
      `);
      const spinId = (available.rows[0] as { id?: string } | undefined)?.id;
      if (!spinId) {
        const error = new Error("NO_SPINS");
        throw error;
      }

      const [spin] = await tx
        .update(wheelSpinsTable)
        .set({ usedAt: new Date(), resultPercentage: outcome })
        .where(and(eq(wheelSpinsTable.id, spinId), isNull(wheelSpinsTable.usedAt)))
        .returning({ id: wheelSpinsTable.id });

      if (!spin) throw new Error("SPIN_ALREADY_USED");

      let couponId: string | null = null;
      let grantedSpinId: string | null = null;
      if (outcome !== null) {
        const [coupon] = await tx
          .insert(couponsTable)
          .values({
            userId,
            discountPercentage: outcome,
            maxDiscountAmount: maxDiscountFor(outcome),
          })
          .returning({ id: couponsTable.id });
        couponId = coupon?.id ?? null;
      } else {
        // "إعادة لفة" consumes the current spin and grants a fresh,
        // transferable spin without creating a coupon.
        grantedSpinId = await grantWheelSpin(userId, "wheel_reroll", tx);
      }

      const [remaining] = await tx
        .select({ count: count() })
        .from(wheelSpinsTable)
        .where(and(eq(wheelSpinsTable.userId, userId), isNull(wheelSpinsTable.usedAt)));

      return {
        outcome,
        couponId,
        grantedSpinId,
        spinsRemaining: Number(remaining?.count ?? 0),
      };
    });

    res.json({
      ...result,
      resultType: result.outcome === null ? "reroll" : "discount",
      grantedSpinId: result.grantedSpinId,
      maxDiscountAmount: result.outcome === null ? null : maxDiscountFor(result.outcome),
      amountToPay: result.outcome === null
        ? null
        : amountToPay(result.outcome, maxDiscountFor(result.outcome)),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "NO_SPINS") {
      res.status(409).json({ error: "لا توجد لفات متاحة حالياً" });
      return;
    }
    throw error;
  }
});

router.get("/coupons", async (req, res): Promise<void> => {
  const userId = req.auth!.userId;
  const coupons = await db
    .select()
    .from(couponsTable)
    .where(eq(couponsTable.userId, userId))
    .orderBy(sql`${couponsTable.wonAt} DESC`);

  res.json(coupons.map((coupon) => {
    const status = couponState(coupon);
    return {
      id: coupon.id,
      discountPercentage: coupon.discountPercentage,
      maxDiscountAmount: coupon.maxDiscountAmount,
      amountToPay: amountToPay(coupon.discountPercentage, coupon.maxDiscountAmount),
      status,
      wonAt: coupon.wonAt.toISOString(),
      activationTriggerAt: coupon.activationTriggerAt?.toISOString() ?? null,
      expiresAt: coupon.expiresAt?.toISOString() ?? null,
      usedAt: coupon.usedAt?.toISOString() ?? null,
      appliedToPaymentId: coupon.appliedToPaymentId ?? null,
    };
  }));
});

export { amountToPay, couponState, grantWheelSpin, maxDiscountFor };
export default router;