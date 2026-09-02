/**
 * Server-side lifecycle for ordinary orders.
 *
 * A pending ordinary order gets a warning after six hours and expires after
 * twelve hours. The database updates are conditional, so multiple server
 * instances cannot send duplicate lifecycle events for the same order.
 */

import { and, eq, isNull, lte } from "drizzle-orm";
import { db, ordersTable, usersTable } from "@workspace/db";
import { beginNoDriverContest } from "./no-driver-contest";
import { emitToDriversInRegion, emitToUser } from "./socket-server";
import { sendPushToUser } from "./web-push";
import { logger } from "./logger";

const SWEEP_INTERVAL_MS = 3 * 60 * 1000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

const SIX_HOUR_MESSAGE = "لا يوجد سائق بعد، انتبه إلى طلبك";
const FINAL_MESSAGE = "انتهت صلاحية طلبك بعد 12 ساعة لعدم قبول أي سائق.";

type OrderLifecycleRow = {
  id: string;
  userId: string;
  waterVolume: string;
  barrelCount: number;
};

async function consumerRegion(userId: string): Promise<{ wilaya: string; commune: string } | null> {
  const [user] = await db
    .select({ wilaya: usersTable.wilaya, commune: usersTable.commune })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  return user?.wilaya && user.commune
    ? { wilaya: user.wilaya, commune: user.commune }
    : null;
}

async function notifySixHourWarning(order: OrderLifecycleRow): Promise<void> {
  emitToUser(order.userId, "order_timeout_warning", {
    orderId: order.id,
    message: SIX_HOUR_MESSAGE,
  });
  await sendPushToUser(order.userId, {
    title: "تنبيه بشأن طلبك",
    body: SIX_HOUR_MESSAGE,
    url: "/dashboard",
  });

  const region = await consumerRegion(order.userId);
  if (region) {
    emitToDriversInRegion(region.wilaya, region.commune, "order_stale", {
      orderId: order.id,
      message: "طلب متأخر يحتاج إلى انتباهك",
      waterVolume: order.waterVolume,
      barrelCount: order.barrelCount,
    });
  }
}

async function notifyExpiry(order: OrderLifecycleRow): Promise<void> {
  const contest = await beginNoDriverContest(order.userId);

  emitToUser(order.userId, "order_expired", {
    orderId: order.id,
    message: FINAL_MESSAGE,
    contest: contest.noDriver ? contest.contest : null,
  });
  await sendPushToUser(order.userId, {
    title: "انتهت صلاحية الطلب",
    body: FINAL_MESSAGE,
    url: "/dashboard",
  });
}

async function expireOrders(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - TWELVE_HOURS_MS);
  const expiredOrders = await db
    .update(ordersTable)
    .set({ status: "منتهي الصلاحية" })
    .where(and(
      eq(ordersTable.status, "معلق"),
      eq(ordersTable.orderType, "normal"),
      lte(ordersTable.createdAt, cutoff),
    ))
    .returning({
      id: ordersTable.id,
      userId: ordersTable.userId,
      waterVolume: ordersTable.waterVolume,
      barrelCount: ordersTable.barrelCount,
    });

  for (const order of expiredOrders) {
    try {
      await notifyExpiry(order);
      logger.info({ orderId: order.id }, "Order expired after twelve hours");
    } catch (err) {
      logger.warn({ err, orderId: order.id }, "Order expired but notification failed");
    }
  }
}

async function markStaleOrders(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - SIX_HOURS_MS);
  const staleOrders = await db
    .update(ordersTable)
    .set({ staleNoticeSentAt: now })
    .where(and(
      eq(ordersTable.status, "معلق"),
      eq(ordersTable.orderType, "normal"),
      isNull(ordersTable.staleNoticeSentAt),
      lte(ordersTable.createdAt, cutoff),
    ))
    .returning({
      id: ordersTable.id,
      userId: ordersTable.userId,
      waterVolume: ordersTable.waterVolume,
      barrelCount: ordersTable.barrelCount,
    });

  for (const order of staleOrders) {
    try {
      await notifySixHourWarning(order);
      logger.info({ orderId: order.id }, "Order marked stale after six hours");
    } catch (err) {
      logger.warn({ err, orderId: order.id }, "Order marked stale but notification failed");
    }
  }
}

export async function runOrderTimeoutSweep(): Promise<void> {
  const now = new Date();
  await expireOrders(now);
  await markStaleOrders(now);
}

export function startOrderTimeoutSweep(): void {
  void runOrderTimeoutSweep().catch((err) => {
    logger.warn({ err }, "Initial order timeout sweep failed");
  });

  setInterval(() => {
    runOrderTimeoutSweep().catch((err) => {
      logger.warn({ err }, "Order timeout sweep tick failed");
    });
  }, SWEEP_INTERVAL_MS);

  logger.info({ intervalMs: SWEEP_INTERVAL_MS }, "Order timeout sweep started");
}
