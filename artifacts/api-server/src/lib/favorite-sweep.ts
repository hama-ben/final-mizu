/**
 * Favourite-driver exclusivity sweep.
 *
 * Runs every ~15 s inside the server process (no separate worker).
 * Finds orders whose exclusive window has expired (exclusiveExpiresAt < now,
 * exclusiveDriverId IS NOT NULL, status = "معلق") and:
 *   1. Clears the exclusivity fields.
 *   2. Broadcasts the order to all drivers in the region via Socket.io.
 *   3. Notifies the consumer with "favorite_window_expired" so the frontend
 *      can prompt: renew 90 s or let it go to everyone.
 */

import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db, ordersTable, usersTable } from "@workspace/db";
import { emitToDriversInRegion, emitToUser } from "./socket-server";
import { broadcastNewOrder } from "./supabase-server";
import { logger } from "./logger";

const SWEEP_INTERVAL_MS = 15_000;

export function startFavoriteSweep(): void {
  setInterval(async () => {
    try {
      const now = new Date();

      // Find all pending orders whose exclusive window has lapsed
      const expiredOrders = await db
        .select({
          id:               ordersTable.id,
          userId:           ordersTable.userId,
          exclusiveDriverId: ordersTable.exclusiveDriverId,
          waterVolume:      ordersTable.waterVolume,
          barrelCount:      ordersTable.barrelCount,
        })
        .from(ordersTable)
        .where(
          and(
            eq(ordersTable.status, "معلق"),
            isNotNull(ordersTable.exclusiveDriverId),
            lt(ordersTable.exclusiveExpiresAt, now),
          )
        );

      for (const order of expiredOrders) {
        try {
          // 1. Clear exclusivity so any driver can now accept
          await db
            .update(ordersTable)
            .set({ exclusiveDriverId: null, exclusiveExpiresAt: null })
            .where(eq(ordersTable.id, order.id));

          // 2. Broadcast to all region drivers (Socket.io + Supabase Realtime)
          const [user] = await db
            .select({ wilaya: usersTable.wilaya, commune: usersTable.commune })
            .from(usersTable)
            .where(eq(usersTable.id, order.userId));

          if (user?.wilaya && user?.commune) {
            const payload = {
              orderId:     order.id,
              commune:     user.commune,
              wilaya:      user.wilaya,
              waterVolume: order.waterVolume,
              barrelCount: order.barrelCount,
            };
            emitToDriversInRegion(user.wilaya, user.commune, "new_order", payload);
            broadcastNewOrder(payload).catch(() => {});
          }

          // 3. Tell the consumer — frontend shows "renew / let go" prompt
          emitToUser(order.userId, "favorite_window_expired", { orderId: order.id });

          logger.info({ orderId: order.id }, "Favourite window expired — order opened to region");
        } catch (err) {
          logger.warn({ err, orderId: order.id }, "Error processing expired favourite window");
        }
      }
    } catch (err) {
      logger.warn({ err }, "Favourite sweep tick error");
    }
  }, SWEEP_INTERVAL_MS);

  logger.info({ intervalMs: SWEEP_INTERVAL_MS }, "Favourite-driver sweep started");
}
