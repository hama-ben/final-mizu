import { Router, type IRouter } from "express";
import { eq, asc, desc, count, sql, and, gte, lt, lte, or, isNull, isNotNull } from "drizzle-orm";
import { db, ordersTable, usersTable, driverDetailsTable, driverStatusTable, favoriteDriversTable } from "@workspace/db";
import {
  CreateOrderBody,
  GetUserOrdersParams,
  UpdateOrderStatusParams,
  UpdateOrderStatusBody,
  GetOrdersSummaryResponse,
} from "@workspace/api-zod";
import { broadcastNewOrder, broadcastOrderClaimed, broadcastOrderStatusChange } from "../lib/supabase-server";
import { emitToDrivers, emitToDriversInRegion, emitToUser } from "../lib/socket-server";
import { sendPushToUser } from "../lib/web-push";
import { qualifyReferralForUser } from "../lib/referral-rewards";
import { haversineKm } from "../lib/geo";
import { beginNoDriverContest } from "../lib/no-driver-contest";

const router: IRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Daily order limit helpers
// Algeria is UTC+1 year-round (Africa/Algiers, no DST).
// ─────────────────────────────────────────────────────────────────────────────
const DAILY_ORDER_LIMIT  = Number(process.env.DAILY_ORDER_LIMIT) || 3; // override in staging only, e.g. for load testing — production must not set this env var

// ─────────────────────────────────────────────────────────────────────────────
// Geographic boundary for favourite-driver feature (Phase 6).
// Override via FAVORITE_LOCATION_RADIUS_KM env var; default is 15 km.
// ─────────────────────────────────────────────────────────────────────────────
const FAVORITE_LOCATION_RADIUS_KM =
  Number(process.env.FAVORITE_LOCATION_RADIUS_KM) || 15;
const ALGERIA_OFFSET_MS  = 60 * 60 * 1000; // UTC+1

function algeriaDateBoundaries(): { start: Date; end: Date; resetsAt: string } {
  const nowUtcMs       = Date.now();
  const nowAlgeriaMs   = nowUtcMs + ALGERIA_OFFSET_MS;
  const dayMs          = 24 * 60 * 60 * 1000;
  const startAlgeriaMs = nowAlgeriaMs - (nowAlgeriaMs % dayMs);

  const start    = new Date(startAlgeriaMs - ALGERIA_OFFSET_MS);      // UTC
  const end      = new Date(startAlgeriaMs + dayMs - ALGERIA_OFFSET_MS); // UTC
  const resetsAt = end.toISOString();

  return { start, end, resetsAt };
}

function mapOrder(o: {
  id: string;
  userId: string;
  driverId: string | null;
  userName: string | null;
  userPhone: string | null;
  driverName?: string | null;
  driverPhone?: string | null;
  waterVolume: string;
  barrelCount: number;
  totalPrice: string;
  latitude: string | null;
  longitude: string | null;
  status: string;
  createdAt: Date;
  isStale?: boolean;
}) {
  return {
    id: o.id,
    userId: o.userId,
    driverId: o.driverId ?? null,
    userName: o.userName ?? null,
    userPhone: o.userPhone ?? null,
    driverName: o.driverName ?? null,
    driverPhone: o.driverPhone ?? null,
    waterVolume: o.waterVolume,
    barrelCount: o.barrelCount,
    totalPrice: Number(o.totalPrice),
    latitude: o.latitude !== null ? Number(o.latitude) : null,
    longitude: o.longitude !== null ? Number(o.longitude) : null,
    status: o.status,
    createdAt: o.createdAt.toISOString(),
    ...(o.isStale === undefined ? {} : { isStale: o.isStale }),
  };
}

router.post("/orders", async (req, res): Promise<void> => {
  const parsed = CreateOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { waterVolume, barrelCount, totalPrice, latitude, longitude } = parsed.data;
  // Always use the authenticated user's ID — never trust client-supplied userId
  const userId = req.auth!.userId;

  // ── Daily order limit — customers only, drivers are not restricted ───────────
  if (req.auth?.userType === "مستهلك") {
    try {
      const { start, end } = algeriaDateBoundaries();
      const [{ value: todayCount }] = await db
        .select({ value: count() })
        .from(ordersTable)
        .where(and(
          eq(ordersTable.userId, userId),
          gte(ordersTable.createdAt, start),
          lt(ordersTable.createdAt, end),
        ));

      if (todayCount >= DAILY_ORDER_LIMIT) {
        req.log.warn({ userId, todayCount }, "Daily order limit exceeded");
        res.status(429).json({
          error: "لقد استنفدت الحد الأقصى لطلبات اليوم (3 طلبات). يمكنك تقديم طلبات جديدة بعد منتصف الليل.",
          code:  "DAILY_ORDER_LIMIT_EXCEEDED",
        });
        return;
      }
    } catch (err) {
      req.log.warn({ err }, "Daily limit check failed — allowing order anyway");
    }
  }

  // ── Phase 6: Geographic boundary check ──────────────────────────────────────
  // If the consumer already has a home anchor (set on their very first order),
  // reject the new order when its coordinates are further than
  // FAVORITE_LOCATION_RADIUS_KM km away.  This keeps favourite-driver routing
  // meaningful: a consumer placing an order from a completely different city
  // would be matched to drivers they know from home, which makes no sense.
  //
  // Failure strategy: if the DB read itself fails we log a warning and let the
  // order through — a DB hiccup must never silently block a real order.
  if (latitude != null && longitude != null) {
    try {
      const [homeLocation] = await db
        .select({
          homeLatitude:  usersTable.homeLatitude,
          homeLongitude: usersTable.homeLongitude,
        })
        .from(usersTable)
        .where(eq(usersTable.id, userId));

      if (homeLocation?.homeLatitude != null && homeLocation?.homeLongitude != null) {
        const distKm = haversineKm(
          homeLocation.homeLatitude,
          homeLocation.homeLongitude,
          Number(latitude),
          Number(longitude),
        );

        if (distKm > FAVORITE_LOCATION_RADIUS_KM) {
          req.log.warn(
            { userId, distKm, radiusKm: FAVORITE_LOCATION_RADIUS_KM },
            "Order rejected — outside home region",
          );
          res.status(403).json({
            error:
              "يبدو أنك خارج نطاق بلديتك المسجّلة. لإكمال الطلب من هذا الموقع، يرجى التواصل مع خدمة العملاء لتحديث بياناتك أو إنشاء حساب جديد لمنطقتك الحالية.",
            code: "OUTSIDE_HOME_REGION",
          });
          return;
        }
      }
    } catch (err) {
      req.log.warn({ err }, "Geo boundary check failed — allowing order anyway");
    }
  }

  // ── Phase 5: a municipality with no approved driver enters the contest ──
  // beginNoDriverContest is the single source of truth for this gate and only
  // counts users who are both drivers and account_status = 'approved'.
  if (req.auth?.userType === "مستهلك") {
    try {
      const contestGate = await beginNoDriverContest(userId);
      if (contestGate.noDriver) {
        const alreadyUsedMessage = contestGate.alreadyUsed
          ? "نعتذر، لا يوجد سائق مسجّل في بلديتك حالياً."
          : "نعتذر لعدم وجود سائق في بلديتك. يمكنك أن تدعو سائقين للحصول على هدايا معتبرة من المنصة.";
        res.status(409).json({
          error: alreadyUsedMessage,
          code: contestGate.alreadyUsed
            ? "NO_DRIVER_CONTEST_ALREADY_USED"
            : "NO_DRIVER_CONTEST_AVAILABLE",
          contest: contestGate.contest,
        });
        return;
      }
    } catch (err) {
      req.log.error({ err, userId }, "No-driver contest municipality check failed");
      res.status(503).json({ error: "تعذر التحقق من توفر السائقين حالياً، حاول مرة أخرى." });
      return;
    }
  }

  try {
    const [order] = await db
      .insert(ordersTable)
      .values({
        userId,
        waterVolume,
        barrelCount,
        totalPrice: String(totalPrice),
        status: "معلق",
        latitude: latitude !== undefined && latitude !== null ? String(latitude) : null,
        longitude: longitude !== undefined && longitude !== null ? String(longitude) : null,
      })
      .returning();

    const [user] = await db
      .select({
        name: usersTable.name,
        phone: usersTable.phone,
        commune: usersTable.commune,
        wilaya: usersTable.wilaya,
        homeLatitude: usersTable.homeLatitude,
        homeLongitude: usersTable.homeLongitude,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId));

    req.log.info({ orderId: order.id }, "Order created");

    if (req.auth?.userType === "مستهلك") {
      await qualifyReferralForUser(userId, "consumer_first_order").catch((err: unknown) => {
        req.log.error({ err, userId }, "Referral qualification after first consumer order failed");
      });
    }

    // ── Save home location anchor on the consumer's very first order ─────────
    // homeLatitude/homeLongitude are null until the first real order is placed.
    // We use the order coordinates to anchor the consumer to their municipality.
    if (user && user.homeLatitude === null && latitude != null && longitude != null) {
      db.update(usersTable)
        .set({ homeLatitude: Number(latitude), homeLongitude: Number(longitude) })
        .where(eq(usersTable.id, userId))
        .catch((err) => req.log.warn({ err }, "Failed to save home location"));
    }

    // ── Favorite-driver exclusivity ───────────────────────────────────────────
    // If the consumer has favourite drivers, check which (if any) is online.
    // Pick the oldest-added one (created_at ASC) and give them a 90-second
    // exclusive window.  If none are available fall through to the normal
    // region-wide broadcast.
    let sentToFavorite = false;
    let exclusiveExpiresAt: Date | null = null;
    let resolvedExclusiveDriverId: string | null = null;

    if (req.auth?.userType === "مستهلك") {
      try {
        const favorites = await db
          .select({ driverId: favoriteDriversTable.driverId })
          .from(favoriteDriversTable)
          .where(eq(favoriteDriversTable.userId, userId))
          .orderBy(favoriteDriversTable.createdAt); // oldest-added favourite first

        for (const { driverId: favDriverId } of favorites) {
          const [statusRow] = await db
            .select({ currentStatus: driverStatusTable.currentStatus })
            .from(driverStatusTable)
            .where(eq(driverStatusTable.driverId, favDriverId));

          if (statusRow?.currentStatus === "حاضر") {
            resolvedExclusiveDriverId = favDriverId;
            exclusiveExpiresAt        = new Date(Date.now() + 90_000);
            await db
              .update(ordersTable)
              .set({
                exclusiveDriverId: resolvedExclusiveDriverId,
                exclusiveExpiresAt,
                orderType: "favorite",
              })
              .where(eq(ordersTable.id, order.id));
            sentToFavorite = true;
            break;
          }
        }
      } catch (err) {
        req.log.warn({ err }, "Favourite-driver check failed — broadcasting normally");
      }
    }

    // ── Response ──────────────────────────────────────────────────────────────
    const responseBody: Record<string, unknown> = {
      ...mapOrder({
        ...order,
        userName: user?.name ?? null,
        userPhone: user?.phone ?? null,
      }),
    };
    if (sentToFavorite && exclusiveExpiresAt) {
      responseBody.sentToFavorite    = true;
      responseBody.exclusiveExpiresAt = exclusiveExpiresAt.toISOString();
    }
    res.status(201).json(responseBody);

    const orderPayload = {
      orderId: order.id,
      commune: user?.commune ?? "",
      wilaya:  user?.wilaya  ?? "",
      waterVolume,
      barrelCount,
    };

    if (sentToFavorite && resolvedExclusiveDriverId) {
      // ── Exclusive mode: send only to the favourite driver ─────────────────
      emitToUser(resolvedExclusiveDriverId, "new_order", orderPayload);
    } else {
      // ── Normal mode: broadcast to all drivers in the region ───────────────
      if (user?.commune && user?.wilaya) {
        emitToDriversInRegion(user.wilaya, user.commune, "new_order", orderPayload);
      }

      // ── Supabase Realtime: secondary broadcast for drivers not on Socket.io ──
      if (user?.commune && user?.wilaya) {
        broadcastNewOrder(orderPayload).catch(() => {});
      }

      // ── Web Push: alert drivers whose browser/tab is closed ────────────────
      if (user?.commune && user?.wilaya) {
        db.select({ id: driverDetailsTable.driverId })
          .from(driverDetailsTable)
          .innerJoin(usersTable, eq(usersTable.id, driverDetailsTable.driverId))
          .leftJoin(driverStatusTable, eq(driverStatusTable.driverId, driverDetailsTable.driverId))
          .where(
            and(
              eq(driverDetailsTable.wilaya,  user.wilaya),
              eq(driverDetailsTable.commune, user.commune),
              eq(usersTable.accountStatus, "approved"),
              sql`COALESCE(${driverStatusTable.currentStatus}, 'مغلق') <> 'مغلق'`,
            )
          )
          .then((drivers) => {
            const pushPayload = {
              title: "طلب جديد في منطقتك! 🔔",
              body:  `${waterVolume} — اضغط لعرض الطلبات`,
              url:   "/driver-dashboard",
            };
            for (const { id } of drivers) {
              sendPushToUser(id, pushPayload).catch(() => {});
            }
          })
          .catch(() => {});
      }
    }

    // ─── Feature 7: 5-minute timeout — auto-re-open if no driver accepts ──────
    setTimeout(async () => {
      try {
        const [check] = await db
          .select({ status: ordersTable.status })
          .from(ordersTable)
          .where(eq(ordersTable.id, order.id));
        if (check?.status === "معلق") {
          if (user?.commune && user?.wilaya) {
            emitToDriversInRegion(user.wilaya, user.commune, "new_order", orderPayload);
            await broadcastNewOrder(orderPayload);
          }
        }
      } catch { /* ignore */ }
    }, 5 * 60 * 1000);

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "خطأ في الخادم";
    res.status(400).json({ error: message });
  }
});

// GET /orders/today-count — daily order counter for the authenticated customer
router.get("/orders/today-count", async (req, res): Promise<void> => {
  const userId = req.auth!.userId;
  const { start, end, resetsAt } = algeriaDateBoundaries();

  try {
    const [{ value: used }] = await db
      .select({ value: count() })
      .from(ordersTable)
      .where(and(
        eq(ordersTable.userId, userId),
        gte(ordersTable.createdAt, start),
        lt(ordersTable.createdAt, end),
      ));

    res.json({
      used,
      remaining: Math.max(0, DAILY_ORDER_LIMIT - used),
      limit:     DAILY_ORDER_LIMIT,
      resetsAt,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "خطأ في الخادم";
    res.status(500).json({ error: message });
  }
});

// IMPORTANT: /active, /summary, and /status-poll must come BEFORE /:userId
router.get("/orders/active", async (req, res): Promise<void> => {
  // SECURITY: never trust a client-supplied driverId. Only the authenticated
  // driver's own orders-in-area may be returned.
  if (req.auth?.userType !== "سائق") {
    res.status(403).json({ error: "هذه النقطة مخصصة للسائقين فقط" });
    return;
  }
  const driverId = req.auth.userId;

  const [driverDetails] = await db
    .select({ wilaya: driverDetailsTable.wilaya, commune: driverDetailsTable.commune })
    .from(driverDetailsTable)
    .where(eq(driverDetailsTable.driverId, driverId));

  // SECURITY / CORRECTNESS: if this driver has no wilaya/commune on file yet,
  // return an empty list — NEVER fall back to showing every pending order
  // nationwide. Geographic isolation between communes must hold with no
  // exceptions.
  if (!driverDetails?.wilaya || !driverDetails?.commune) {
    res.json([]);
    return;
  }

  const consumerUsers = usersTable;

  // Priority ordering: orders from consumers who have added this driver as a
  // favourite come first (isFavoriteConsumer = 0), before regular orders
  // (isFavoriteConsumer = 1).
  // Within each group the existing newest-first order is preserved.
  // No order is hidden — every pending order in the driver's commune is returned.
  const isFavoriteConsumer = sql<number>`CASE WHEN EXISTS (
    SELECT 1 FROM ${favoriteDriversTable}
    WHERE ${favoriteDriversTable.driverId} = ${driverId}
      AND ${favoriteDriversTable.userId}   = ${ordersTable.userId}
  ) THEN 0 ELSE 1 END`;
  const isStaleOrder = sql<boolean>`(
    ${ordersTable.orderType} = 'normal'
    AND ${ordersTable.status} = 'معلق'
    AND ${ordersTable.createdAt} <= NOW() - INTERVAL '6 hours'
  )`;

  const orders = await db
    .select({
      id: ordersTable.id,
      userId: ordersTable.userId,
      driverId: ordersTable.driverId,
      userName: consumerUsers.name,
      userPhone: consumerUsers.phone,
      waterVolume: ordersTable.waterVolume,
      barrelCount: ordersTable.barrelCount,
      totalPrice: ordersTable.totalPrice,
      latitude: ordersTable.latitude,
      longitude: ordersTable.longitude,
      status: ordersTable.status,
      createdAt: ordersTable.createdAt,
      isStale: isStaleOrder,
      // 0 = consumer has this driver as favourite, 1 = not. Used for both
      // ORDER BY priority and exposing isFavoriteConsumer in the response.
      isFavoriteConsumerRank: isFavoriteConsumer,
    })
    .from(ordersTable)
    .leftJoin(consumerUsers, eq(ordersTable.userId, consumerUsers.id))
    .where(
      and(
        eq(ordersTable.status, "معلق"),
        eq(consumerUsers.wilaya, driverDetails.wilaya),
        eq(consumerUsers.commune, driverDetails.commune),
        // Hide orders that are inside an active exclusive window destined for
        // a DIFFERENT driver.  Keep the order visible if:
        //   (a) no exclusive assignment exists at all, OR
        //   (b) the exclusive window has already expired, OR
        //   (c) this driver IS the exclusive recipient.
        or(
          isNull(ordersTable.exclusiveDriverId),
          lte(ordersTable.exclusiveExpiresAt, sql`now()`),
          eq(ordersTable.exclusiveDriverId, driverId)
        )
      )
    )
    .orderBy(desc(isStaleOrder), asc(isFavoriteConsumer), desc(ordersTable.createdAt));

  res.json(orders.map(o => ({
    ...mapOrder(o),
    isFavoriteConsumer: o.isFavoriteConsumerRank === 0,
  })));
});

router.get("/orders/summary", async (req, res): Promise<void> => {
  const { userId, userType } = req.auth!;
  const isDriver = userType === "سائق";

  const [totals] = await db
    .select({
      total: count(ordersTable.id),
      totalRevenue: sql<number>`COALESCE(SUM(${ordersTable.totalPrice}), 0)`,
    })
    .from(ordersTable)
    .where(isDriver ? eq(ordersTable.driverId, userId) : undefined);

  const [pending] = await db
    .select({ cnt: count(ordersTable.id) })
    .from(ordersTable)
    .where(
      isDriver
        ? and(eq(ordersTable.driverId, userId), eq(ordersTable.status, "معلق"))
        : eq(ordersTable.status, "معلق")
    );

  const [inDelivery] = await db
    .select({ cnt: count(ordersTable.id) })
    .from(ordersTable)
    .where(
      isDriver
        ? and(eq(ordersTable.driverId, userId), eq(ordersTable.status, "قيد التوصيل"))
        : eq(ordersTable.status, "قيد التوصيل")
    );

  const [delivered] = await db
    .select({ cnt: count(ordersTable.id) })
    .from(ordersTable)
    .where(
      isDriver
        ? and(eq(ordersTable.driverId, userId), eq(ordersTable.status, "تم التوصيل"))
        : eq(ordersTable.status, "تم التوصيل")
    );

  res.json(
    GetOrdersSummaryResponse.parse({
      total: totals?.total ?? 0,
      pending: pending?.cnt ?? 0,
      inDelivery: inDelivery?.cnt ?? 0,
      delivered: delivered?.cnt ?? 0,
      totalRevenue: Number(totals?.totalRevenue ?? 0),
    })
  );
});

/**
 * Polling fallback endpoint.
 * Clients call this every few seconds when the WebSocket connection drops
 * so they can still detect order status changes without a live socket.
 * GET /api/orders/:orderId/status
 */
router.get("/orders/:orderId/status", async (req, res): Promise<void> => {
  const orderId = Array.isArray(req.params.orderId)
    ? req.params.orderId[0]
    : req.params.orderId;

  const [order] = await db
    .select({
      id: ordersTable.id,
      status: ordersTable.status,
      driverId: ordersTable.driverId,
      userId: ordersTable.userId,
    })
    .from(ordersTable)
    .where(eq(ordersTable.id, orderId));

  if (!order) {
    res.status(404).json({ error: "الطلب غير موجود" });
    return;
  }

  if (req.auth?.userId !== order.userId && req.auth?.userId !== order.driverId) {
    res.status(403).json({ error: "غير مصرح لك بالوصول إلى هذا الطلب" });
    return;
  }

  res.json({ id: order.id, status: order.status, driverId: order.driverId ?? null });
});

// ─── Cancel order (consumer only) ────────────────────────────────────────────
router.delete("/orders/:orderId", async (req, res): Promise<void> => {
  const orderId = Array.isArray(req.params.orderId)
    ? req.params.orderId[0]
    : req.params.orderId;

  // SECURITY: a consumer may only cancel their own order — never someone
  // else's, no matter how the orderId was obtained.
  const [order] = await db
    .update(ordersTable)
    .set({ status: "ملغى" })
    .where(
      and(
        eq(ordersTable.id, orderId),
        eq(ordersTable.status, "معلق"),
        eq(ordersTable.userId, req.auth!.userId),
      )
    )
    .returning();

  if (!order) {
    res.status(409).json({ error: "لا يمكن إلغاء هذا الطلب — قد يكون قيد التوصيل بالفعل" });
    return;
  }

  req.log.info({ orderId }, "Order cancelled by consumer");

  // Notify drivers the order is gone
  emitToDrivers("order_claimed", { orderId });
  broadcastOrderClaimed(orderId);

  // Notify the consumer
  emitToUser(order.userId, "order_status_changed", { orderId, status: "ملغى", driverId: null });

  res.json({ success: true, orderId });
});

router.get("/orders/:userId", async (req, res): Promise<void> => {
  // Enforce ownership: authenticated user can only fetch their own orders.
  // Ignore the :userId path param and use the verified auth identity instead.
  const userId = req.auth!.userId;

  const driverUsers = db
    .select({ id: usersTable.id, name: usersTable.name, phone: usersTable.phone })
    .from(usersTable)
    .as("driver_users");

  const orders = await db
    .select({
      id: ordersTable.id,
      userId: ordersTable.userId,
      driverId: ordersTable.driverId,
      userName: usersTable.name,
      userPhone: usersTable.phone,
      driverName: driverUsers.name,
      driverPhone: driverUsers.phone,
      waterVolume: ordersTable.waterVolume,
      barrelCount: ordersTable.barrelCount,
      totalPrice: ordersTable.totalPrice,
      latitude: ordersTable.latitude,
      longitude: ordersTable.longitude,
      status: ordersTable.status,
      createdAt: ordersTable.createdAt,
    })
    .from(ordersTable)
    .leftJoin(usersTable, eq(ordersTable.userId, usersTable.id))
    .leftJoin(driverUsers, eq(ordersTable.driverId, driverUsers.id))
    .where(eq(ordersTable.userId, userId))
    .orderBy(desc(ordersTable.createdAt));

  res.json(orders.map(mapOrder));
});

router.patch("/orders/:orderId/status", async (req, res): Promise<void> => {
  const params = UpdateOrderStatusParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateOrderStatusBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.data });
    return;
  }

  // SECURITY: only the driver actually assigned to this order may change its
  // status — never trust that the caller is who they claim just because
  // they're authenticated. A consumer, or an unrelated driver, must not be
  // able to mark someone else's order as delivered.
  const [existingOrder] = await db
    .select({ driverId: ordersTable.driverId })
    .from(ordersTable)
    .where(eq(ordersTable.id, params.data.orderId));

  if (!existingOrder) {
    res.status(404).json({ error: "الطلب غير موجود" });
    return;
  }
  if (req.auth?.userType !== "سائق" || existingOrder.driverId !== req.auth.userId) {
    res.status(403).json({ error: "غير مصرح لك بتعديل حالة هذه الطلبية" });
    return;
  }

  const [order] = await db
    .update(ordersTable)
    .set({
      status: body.data.status,
      ...(body.data.status === "تم التوصيل" ? { deliveredAt: new Date() } : {}),
    })
    .where(eq(ordersTable.id, params.data.orderId))
    .returning();

  if (!order) {
    res.status(404).json({ error: "الطلب غير موجود" });
    return;
  }

  const [user] = await db
    .select({ name: usersTable.name, phone: usersTable.phone })
    .from(usersTable)
    .where(eq(usersTable.id, order.userId));

  const result = mapOrder({
    ...order,
    userName: user?.name ?? null,
    userPhone: user?.phone ?? null,
  });

  res.json(result);

  if (order.driverId && order.status === "تم التوصيل") {
    await qualifyReferralForUser(order.driverId, "driver_completed_delivery").catch((err: unknown) => {
      req.log.error({ err, driverId: order.driverId }, "Referral qualification after completed delivery failed");
    });
  }

  // ── Socket.io: notify the specific consumer (primary) ──
  emitToUser(order.userId, "order_status_changed", {
    orderId: order.id,
    status: order.status,
    driverId: order.driverId ?? null,
  });

  // ── Supabase Realtime: secondary broadcast ──
  broadcastOrderStatusChange({ orderId: order.id, status: order.status, driverId: order.driverId }).catch(() => {});
});

// ─── Resend pending order to favourite drivers (consumer only) ────────────────
// Re-broadcasts a still-pending order to the consumer's favourite drivers.
// If at least one favourite driver is "حاضر", the order gets a 90-second
// exclusive window to that driver (same as the initial order flow).
// If no favourites exist or none are online, the order is broadcast to all
// region drivers instead.
//
// Returns:
//   200 { sentToFavorite: boolean, exclusiveExpiresAt?: string }
//   404 — order not found
//   403 — not the caller's order
//   409 — order is no longer pending
router.post("/orders/:orderId/resend", async (req, res): Promise<void> => {
  const orderId = Array.isArray(req.params.orderId) ? req.params.orderId[0] : req.params.orderId;
  const userId  = req.auth!.userId;
  const { fallbackToAll = false } = (req.body ?? {}) as { fallbackToAll?: boolean };

  const [existing] = await db
    .select({
      id:     ordersTable.id,
      status: ordersTable.status,
      userId: ordersTable.userId,
      waterVolume:  ordersTable.waterVolume,
      barrelCount:  ordersTable.barrelCount,
    })
    .from(ordersTable)
    .where(eq(ordersTable.id, orderId));

  if (!existing) {
    res.status(404).json({ error: "الطلب غير موجود" });
    return;
  }
  if (existing.userId !== userId) {
    res.status(403).json({ error: "غير مصرح لك بإعادة إرسال هذا الطلب" });
    return;
  }
  if (existing.status !== "معلق") {
    res.status(409).json({ error: "لا يمكن إعادة إرسال الطلب — لم يعد معلقاً" });
    return;
  }

  const [user] = await db
    .select({
      commune: usersTable.commune,
      wilaya:  usersTable.wilaya,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  const orderPayload = {
    orderId,
    commune:     user?.commune ?? "",
    wilaya:      user?.wilaya  ?? "",
    waterVolume: existing.waterVolume,
    barrelCount: existing.barrelCount,
  };

  // ── Read favourites and their current presence states ────────────────────
  // A missing status row is treated as "مغلق", matching the frontend fallback.
  const favorites = await db
    .select({
      driverId:      favoriteDriversTable.driverId,
      currentStatus: driverStatusTable.currentStatus,
    })
    .from(favoriteDriversTable)
    .leftJoin(driverStatusTable, eq(driverStatusTable.driverId, favoriteDriversTable.driverId))
    .where(eq(favoriteDriversTable.userId, userId))
    .orderBy(favoriteDriversTable.createdAt);

  const favoriteStatuses = favorites.map((favorite) => favorite.currentStatus ?? "مغلق");
  const hasPresentFavorite = favoriteStatuses.includes("حاضر");
  const allFavoritesClosed =
    favorites.length > 0 && favoriteStatuses.every((status) => status === "مغلق");

  // The consumer must acknowledge the offline notice before the normal
  // region-wide broadcast is allowed.
  if (allFavoritesClosed && !fallbackToAll) {
    res.json({
      success: true,
      sentToFavorite: false,
      needsFallbackConfirmation: true,
    });
    return;
  }

  // ── Try favourite-driver exclusivity ─────────────────────────────────────
  let sentToFavorite = false;
  let exclusiveExpiresAt: Date | null = null;
  let resolvedExclusiveDriverId: string | null = null;

  if (!fallbackToAll && hasPresentFavorite) {
    const favoriteDriverId = favorites.find(
      (favorite) => (favorite.currentStatus ?? "مغلق") === "حاضر",
    )?.driverId;

    if (favoriteDriverId) {
      resolvedExclusiveDriverId = favoriteDriverId;
      exclusiveExpiresAt        = new Date(Date.now() + 90_000);
      await db
        .update(ordersTable)
        .set({
          exclusiveDriverId: resolvedExclusiveDriverId,
          exclusiveExpiresAt,
          orderType: "favorite",
        })
        .where(eq(ordersTable.id, orderId));
      sentToFavorite = true;
    }
  }

  if (sentToFavorite && resolvedExclusiveDriverId) {
    emitToUser(resolvedExclusiveDriverId, "new_order", orderPayload);
  } else {
    if (user?.commune && user?.wilaya) {
      emitToDriversInRegion(user.wilaya, user.commune, "new_order", orderPayload);
      broadcastNewOrder(orderPayload).catch(() => {});
    }
  }

  req.log.info({ orderId, sentToFavorite }, "Order resent by consumer");

  const responseBody: Record<string, unknown> = { success: true, sentToFavorite };
  if (sentToFavorite && exclusiveExpiresAt) {
    responseBody.exclusiveExpiresAt = exclusiveExpiresAt.toISOString();
  }
  res.json(responseBody);
});

// ── Renew favourite-driver exclusive window (+90 s) ───────────────────────────
// Called by the consumer when "favorite_window_expired" arrives and they choose
// to give the same favourite driver another 90-second exclusive window.
router.post("/orders/:orderId/renew-favorite-window", async (req, res): Promise<void> => {
  const orderId = Array.isArray(req.params.orderId) ? req.params.orderId[0] : req.params.orderId;
  const userId  = req.auth!.userId;

  // Fetch current order state
  const [existing] = await db
    .select({
      status:            ordersTable.status,
      userId:            ordersTable.userId,
      exclusiveDriverId: ordersTable.exclusiveDriverId,
    })
    .from(ordersTable)
    .where(eq(ordersTable.id, orderId));

  if (!existing) {
    res.status(404).json({ error: "الطلب غير موجود" });
    return;
  }
  if (existing.userId !== userId) {
    res.status(403).json({ error: "غير مصرح لك بتعديل هذا الطلب" });
    return;
  }
  if (existing.status !== "معلق") {
    res.status(409).json({ error: "لا يمكن تجديد النافذة — الطلب لم يعد معلقاً" });
    return;
  }
  if (!existing.exclusiveDriverId) {
    res.status(409).json({ error: "لا توجد نافذة حصرية نشطة لهذا الطلب" });
    return;
  }

  // Re-check the favourite driver is still online
  const [statusRow] = await db
    .select({ currentStatus: driverStatusTable.currentStatus })
    .from(driverStatusTable)
    .where(eq(driverStatusTable.driverId, existing.exclusiveDriverId));

  if (statusRow?.currentStatus !== "حاضر") {
    res.status(409).json({ error: "السائق المفضل لم يعد متاحاً حالياً" });
    return;
  }

  const newExpiresAt = new Date(Date.now() + 90_000);
  await db
    .update(ordersTable)
    .set({ exclusiveExpiresAt: newExpiresAt })
    .where(eq(ordersTable.id, orderId));

  // Re-send the order exclusively to the same favourite driver
  const [user] = await db
    .select({ commune: usersTable.commune, wilaya: usersTable.wilaya })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  emitToUser(existing.exclusiveDriverId, "new_order", {
    orderId,
    commune:     user?.commune ?? "",
    wilaya:      user?.wilaya  ?? "",
    waterVolume: "", // will be fetched by the driver's client on receipt
    barrelCount: 0,
  });

  req.log.info({ orderId, exclusiveDriverId: existing.exclusiveDriverId }, "Favourite window renewed");
  res.json({ success: true, exclusiveExpiresAt: newExpiresAt.toISOString() });
});

// Atomic accept — prevents two drivers picking the same order
router.post("/orders/:orderId/accept", async (req, res): Promise<void> => {
  const orderId = Array.isArray(req.params.orderId) ? req.params.orderId[0] : req.params.orderId;

  // SECURITY: never trust a client-supplied driverId — always use the
  // authenticated identity. Otherwise any account could accept an order
  // "as" a different driver.
  if (req.auth?.userType !== "سائق") {
    res.status(403).json({ error: "فقط السائقون يمكنهم قبول الطلبيات" });
    return;
  }
  const driverId = req.auth.userId;

  // ── Single atomic UPDATE — exclusivity + accept in one statement ─────────
  //
  // Both guarantees are enforced inside the WHERE clause of a single UPDATE,
  // so Postgres row-locks the row and evaluates both conditions together.
  // This eliminates the TOCTOU race of a separate read-then-write:
  //
  //   (a) status = "معلق"           → only one driver can ever flip this
  //   (b) exclusivity window guard  → allow only if:
  //         • no exclusive driver is set, OR
  //         • the exclusive window has already expired, OR
  //         • this IS the exclusive driver
  //
  // If the UPDATE returns nothing we do a single diagnostic read to return
  // the right error code (404 / 403 / 409) — this read is only for the
  // error path and does not affect correctness.
  const [order] = await db
    .update(ordersTable)
    .set({ status: "قيد التوصيل", driverId, acceptedAt: new Date() })
    .where(
      and(
        eq(ordersTable.id, orderId),
        eq(ordersTable.status, "معلق"),
        sql`(
          ${ordersTable.exclusiveDriverId} IS NULL
          OR ${ordersTable.exclusiveExpiresAt} < now()
          OR ${ordersTable.exclusiveDriverId} = ${driverId}
        )`
      )
    )
    .returning();

  if (!order) {
    // Determine why the UPDATE matched nothing
    const [diagnostic] = await db
      .select({
        status:             ordersTable.status,
        exclusiveDriverId:  ordersTable.exclusiveDriverId,
        exclusiveExpiresAt: ordersTable.exclusiveExpiresAt,
      })
      .from(ordersTable)
      .where(eq(ordersTable.id, orderId));

    if (!diagnostic) {
      res.status(404).json({ error: "الطلب غير موجود" });
      return;
    }

    const windowStillActive =
      diagnostic.exclusiveDriverId !== null &&
      diagnostic.exclusiveExpiresAt !== null &&
      diagnostic.exclusiveExpiresAt > new Date();

    if (windowStillActive && diagnostic.exclusiveDriverId !== driverId) {
      res.status(403).json({ error: "هذا الطلب محجوز حاليًا لسائق آخر لفترة محدودة" });
      return;
    }

    res.status(409).json({ error: "الطلب تم قبوله من قِبل سائق آخر" });
    return;
  }

  const [user] = await db
    .select({ name: usersTable.name, phone: usersTable.phone })
    .from(usersTable)
    .where(eq(usersTable.id, order.userId));

  req.log.info({ orderId, driverId }, "Order accepted by driver");

  // ── Socket.io: tell all drivers this order is gone (primary) ──
  emitToDrivers("order_claimed", { orderId });

  // ── Socket.io: tell the specific consumer their order is accepted (primary) ──
  emitToUser(order.userId, "order_status_changed", {
    orderId,
    status: "قيد التوصيل",
    driverId,
  });

  // ── Supabase Realtime: secondary broadcast ──
  broadcastOrderClaimed(orderId);
  broadcastOrderStatusChange({ orderId, status: "قيد التوصيل", driverId }).catch(() => {});

  res.json(mapOrder({
    ...order,
    userName: user?.name ?? null,
    userPhone: user?.phone ?? null,
  }));
});

export default router;
