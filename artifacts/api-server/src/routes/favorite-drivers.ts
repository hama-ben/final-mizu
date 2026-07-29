/**
 * Favourite-driver CRUD routes.
 *
 * Consumers can save up to 3 trusted drivers.  Drivers can query their own
 * fan list.  All routes require a valid session (registered behind requireAuth
 * in routes/index.ts).
 *
 * Route order matters: /fan-count and /fans are registered before /:driverId
 * so Express does not swallow them as a path parameter.
 */

import { Router, type IRouter } from "express";
import { eq, and, count, sql } from "drizzle-orm";
import {
  db,
  favoriteDriversTable,
  ordersTable,
  usersTable,
  driverStatusTable,
} from "@workspace/db";

const router: IRouter = Router();

const MAX_FAVORITES = 3;

// ── POST /favorite-drivers ────────────────────────────────────────────────────
// Add a driver to the authenticated consumer's favourites list.
// Preconditions:
//   • caller must have < 3 existing favourites
//   • at least one delivered order between this consumer and this driver must exist
//   • driverId must not already be in the list (unique constraint)
router.post("/favorite-drivers", async (req, res): Promise<void> => {
  const userId   = req.auth!.userId;
  const { driverId } = req.body as { driverId?: string };

  if (!driverId || typeof driverId !== "string") {
    res.status(400).json({ error: "driverId مطلوب" });
    return;
  }

  // Guard: driverId must belong to an approved driver account — not a consumer
  const [driverUser] = await db
    .select({ userType: usersTable.userType, accountStatus: usersTable.accountStatus })
    .from(usersTable)
    .where(eq(usersTable.id, driverId));

  if (!driverUser) {
    res.status(404).json({ error: "السائق غير موجود" });
    return;
  }
  if (driverUser.userType !== "سائق") {
    res.status(400).json({ error: "المعرف المُدخل لا ينتمي لحساب سائق" });
    return;
  }

  // Guard: max 3 favourites per consumer
  const [{ value: existingCount }] = await db
    .select({ value: count() })
    .from(favoriteDriversTable)
    .where(eq(favoriteDriversTable.userId, userId));

  if (existingCount >= MAX_FAVORITES) {
    res.status(400).json({
      error: `لا يمكنك إضافة أكثر من ${MAX_FAVORITES} سائقين مفضلين`,
    });
    return;
  }

  // Guard: must have at least one delivered order with this specific driver
  const [deliveredOrder] = await db
    .select({ id: ordersTable.id })
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.userId,   userId),
        eq(ordersTable.driverId, driverId),
        eq(ordersTable.status,   "تم التوصيل"),
      )
    )
    .limit(1);

  if (!deliveredOrder) {
    res.status(403).json({
      error: "لا يمكن إضافة هذا السائق كمفضل — لا يوجد طلب مكتمل سابق بينكما",
    });
    return;
  }

  // Insert — unique constraint (userId, driverId) handles duplicates
  try {
    const [record] = await db
      .insert(favoriteDriversTable)
      .values({ userId, driverId })
      .returning();

    res.status(201).json({ id: record.id, driverId, createdAt: record.createdAt });
  } catch (err: unknown) {
    const pgCode = (err as { code?: string })?.code;
    if (pgCode === "23505") {
      res.status(409).json({ error: "هذا السائق موجود بالفعل في قائمة مفضليك" });
      return;
    }
    throw err;
  }
});

// ── GET /favorite-drivers/fan-count ──────────────────────────────────────────
// Driver endpoint: how many consumers have added me as a favourite?
// Must be registered BEFORE /:driverId to avoid being matched as a param route.
router.get("/favorite-drivers/fan-count", async (req, res): Promise<void> => {
  const driverId = req.auth!.userId;

  const [{ value: fanCount }] = await db
    .select({ value: count() })
    .from(favoriteDriversTable)
    .where(eq(favoriteDriversTable.driverId, driverId));

  res.json({ fanCount });
});

// ── GET /favorite-drivers/fans ────────────────────────────────────────────────
// Driver endpoint: names (only) of consumers who added me as a favourite.
// Returns no contact information — no phone, no email.
router.get("/favorite-drivers/fans", async (req, res): Promise<void> => {
  const driverId = req.auth!.userId;

  const fans = await db
    .select({ name: usersTable.name })
    .from(favoriteDriversTable)
    .innerJoin(usersTable, eq(usersTable.id, favoriteDriversTable.userId))
    .where(eq(favoriteDriversTable.driverId, driverId))
    .orderBy(favoriteDriversTable.createdAt);

  res.json({ fans: fans.map((f) => f.name) });
});

// ── GET /favorite-drivers ─────────────────────────────────────────────────────
// Consumer endpoint: list my favourite drivers (max 3) with their current status.
// Returns no driver contact details — name + currentStatus only.
router.get("/favorite-drivers", async (req, res): Promise<void> => {
  const userId = req.auth!.userId;

  const rows = await db
    .select({
      id:            favoriteDriversTable.id,
      driverId:      favoriteDriversTable.driverId,
      driverName:    usersTable.name,
      currentStatus: driverStatusTable.currentStatus,
      createdAt:     favoriteDriversTable.createdAt,
    })
    .from(favoriteDriversTable)
    .innerJoin(usersTable,       eq(usersTable.id,       favoriteDriversTable.driverId))
    .leftJoin(driverStatusTable, eq(driverStatusTable.driverId, favoriteDriversTable.driverId))
    .where(eq(favoriteDriversTable.userId, userId))
    .orderBy(favoriteDriversTable.createdAt);

  res.json(
    rows.map((r) => ({
      id:            r.id,
      driverId:      r.driverId,
      driverName:    r.driverName,
      currentStatus: r.currentStatus ?? "مغلق",
      createdAt:     r.createdAt.toISOString(),
    }))
  );
});

// ── DELETE /favorite-drivers/:driverId ────────────────────────────────────────
// Remove a specific favourite.  IDOR-safe: the WHERE clause enforces that
// the record belongs to the authenticated consumer — a driverId from another
// user's list cannot be deleted here, even if the UUID is known.
router.delete("/favorite-drivers/:driverId", async (req, res): Promise<void> => {
  const userId   = req.auth!.userId;
  const driverId = Array.isArray(req.params.driverId)
    ? req.params.driverId[0]
    : req.params.driverId;

  const [deleted] = await db
    .delete(favoriteDriversTable)
    .where(
      and(
        eq(favoriteDriversTable.userId,   userId),   // IDOR guard
        eq(favoriteDriversTable.driverId, driverId),
      )
    )
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "السائق غير موجود في قائمة مفضليك" });
    return;
  }

  res.json({ success: true, driverId });
});

export default router;
