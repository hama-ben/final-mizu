import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, eq, ilike, sql } from "drizzle-orm";
import { couponsTable, db, usersTable, wheelSpinsTable } from "@workspace/db";
import { getSupabaseAdmin } from "../lib/supabase-server";
import { emitToUser } from "../lib/socket-server";

const router: IRouter = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type GiftKind = "coupon" | "spin";

async function notifyGiftRecipient(args: {
  driverId: string;
  senderName: string;
  kind: GiftKind;
  discountPercentage?: number;
}): Promise<void> {
  const description = args.kind === "spin"
    ? "لفة عجلة حظ"
    : `قسيمة خصم ${args.discountPercentage}%`;
  const message = `${args.senderName} أرسل لك ${description}`;

  const supabase = getSupabaseAdmin();
  if (supabase) {
    const { error } = await supabase.from("announcements").insert({
      title: "هدية جديدة",
      content: message,
      target_audience: args.driverId,
      is_active: true,
    });
    if (error) {
      console.error("[gifts] failed to persist recipient notification", error);
    }
  }

  emitToUser(args.driverId, "gift_received", {
    kind: args.kind,
    message,
    discountPercentage: args.discountPercentage ?? null,
  });
}

async function findConsumer(userId: string) {
  const [consumer] = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      userType: usersTable.userType,
      wilaya: usersTable.wilaya,
      commune: usersTable.commune,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return consumer;
}

router.get("/gifts/drivers", async (req, res): Promise<void> => {
  const userId = req.auth!.userId;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const consumer = await findConsumer(userId);

  if (!consumer || consumer.userType !== "مستهلك") {
    res.status(403).json({ error: "الإهداء متاح للمستهلكين فقط" });
    return;
  }
  if (!consumer.commune) {
    res.status(400).json({ error: "يجب تحديد بلديتك قبل البحث عن سائق" });
    return;
  }

  const drivers = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      wilaya: usersTable.wilaya,
      commune: usersTable.commune,
    })
    .from(usersTable)
    .where(and(
      eq(usersTable.userType, "سائق"),
      eq(usersTable.accountStatus, "approved"),
      eq(usersTable.wilaya, consumer.wilaya),
      eq(usersTable.commune, consumer.commune),
      ilike(usersTable.name, `%${search}%`),
    ))
    .orderBy(asc(usersTable.name))
    .limit(30);

  res.json(drivers);
});

router.post("/gifts/coupon", async (req, res): Promise<void> => {
  await transferGift(req, res, "coupon");
});

router.post("/gifts/spin", async (req, res): Promise<void> => {
  await transferGift(req, res, "spin");
});

async function transferGift(
  req: Request,
  res: Response,
  kind: GiftKind,
): Promise<void> {
  const senderId = req.auth!.userId;
  const { driverId } = req.body as { driverId?: unknown; couponId?: unknown; spinId?: unknown };
  const assetId = kind === "coupon" ? req.body?.couponId : req.body?.spinId;

  if (typeof driverId !== "string" || !driverId.trim() || typeof assetId !== "string" || !assetId.trim()) {
    res.status(400).json({ error: "معرّف الهدية والسائق مطلوبان" });
    return;
  }
  if (!UUID_PATTERN.test(assetId.trim())) {
    res.status(400).json({ error: "معرّف الهدية غير صالح" });
    return;
  }

  const consumer = await findConsumer(senderId);
  if (!consumer || consumer.userType !== "مستهلك") {
    res.status(403).json({ error: "الإهداء متاح للمستهلكين فقط" });
    return;
  }
  if (!consumer.commune) {
    res.status(400).json({ error: "يجب تحديد بلديتك قبل الإهداء" });
    return;
  }

  try {
    const transfer = await db.transaction(async (tx) => {
      const [driver] = await tx
        .select({
          id: usersTable.id,
          name: usersTable.name,
          userType: usersTable.userType,
          wilaya: usersTable.wilaya,
          commune: usersTable.commune,
        })
        .from(usersTable)
        .where(and(
          eq(usersTable.id, driverId.trim()),
          eq(usersTable.userType, "سائق"),
          eq(usersTable.accountStatus, "approved"),
          eq(usersTable.wilaya, consumer.wilaya),
          eq(usersTable.commune, consumer.commune),
        ));

      if (!driver) throw new Error("DRIVER_NOT_IN_COMMUNE");

      if (kind === "coupon") {
        const couponRows = await tx.execute(sql`
          SELECT "id", "discount_percentage"
          FROM "coupons"
          WHERE "id" = ${assetId.trim()}
            AND "user_id" = ${senderId}
            AND "used_at" IS NULL
            AND "applied_to_payment_id" IS NULL
            AND ("expires_at" IS NULL OR "expires_at" > NOW())
          FOR UPDATE
        `);
        const coupon = couponRows.rows[0] as { id?: string; discount_percentage?: number } | undefined;
        if (!coupon?.id) throw new Error("COUPON_NOT_GIFTABLE");

        const [updated] = await tx
          .update(couponsTable)
          .set({ userId: driver.id })
          .where(and(
            eq(couponsTable.id, coupon.id),
            eq(couponsTable.userId, senderId),
          ))
          .returning({ id: couponsTable.id });
        if (!updated) throw new Error("COUPON_TRANSFER_FAILED");

        return {
          driverId: driver.id,
          driverName: driver.name,
          kind,
          discountPercentage: Number(coupon.discount_percentage),
        };
      }

      const spinRows = await tx.execute(sql`
        SELECT "id"
        FROM "wheel_spins"
        WHERE "id" = ${assetId.trim()}
          AND "user_id" = ${senderId}
          AND "used_at" IS NULL
        FOR UPDATE
      `);
      const spin = spinRows.rows[0] as { id?: string } | undefined;
      if (!spin?.id) throw new Error("SPIN_NOT_GIFTABLE");

      const [updated] = await tx
        .update(wheelSpinsTable)
        .set({ userId: driver.id })
        .where(and(
          eq(wheelSpinsTable.id, spin.id),
          eq(wheelSpinsTable.userId, senderId),
          sql`${wheelSpinsTable.usedAt} IS NULL`,
        ))
        .returning({ id: wheelSpinsTable.id });
      if (!updated) throw new Error("SPIN_TRANSFER_FAILED");

      return {
        driverId: driver.id,
        driverName: driver.name,
        kind,
      };
    });

    await notifyGiftRecipient({
      driverId: transfer.driverId,
      senderName: consumer.name,
      kind: transfer.kind,
      ...(transfer.kind === "coupon" ? { discountPercentage: transfer.discountPercentage } : {}),
    });

    res.json({
      ok: true,
      kind: transfer.kind,
      driverId: transfer.driverId,
      driverName: transfer.driverName,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "DRIVER_NOT_IN_COMMUNE") {
      res.status(404).json({ error: "السائق غير موجود في بلديتك" });
      return;
    }
    if (message === "COUPON_NOT_GIFTABLE") {
      res.status(409).json({ error: "القسيمة غير متاحة للإهداء أو تم استخدامها" });
      return;
    }
    if (message === "SPIN_NOT_GIFTABLE") {
      res.status(409).json({ error: "اللفة غير متاحة للإهداء أو تم استخدامها" });
      return;
    }
    throw error;
  }
}

export default router;