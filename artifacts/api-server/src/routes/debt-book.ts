import { Router, type IRouter, type Request } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  debtAccountsTable,
  debtEntriesTable,
  favoriteDriversTable,
  ordersTable,
  usersTable,
} from "@workspace/db";

const router: IRouter = Router();

function isDriver(req: Request): boolean {
  return req.auth?.userType === "سائق";
}

// Driver: current debt accounts managed by this driver.
router.get("/debt-book", async (req, res): Promise<void> => {
  if (!isDriver(req)) {
    res.status(403).json({ error: "دفتر الديون مخصص للسائقين فقط" });
    return;
  }

  const accounts = await db
    .select({
      id: debtAccountsTable.id,
      consumerId: debtAccountsTable.consumerId,
      debtCeiling: debtAccountsTable.debtCeiling,
      balance: debtAccountsTable.balance,
      status: debtAccountsTable.status,
      createdAt: debtAccountsTable.createdAt,
      updatedAt: debtAccountsTable.updatedAt,
      consumerName: usersTable.name,
      consumerPhone: usersTable.phone,
    })
    .from(debtAccountsTable)
    .innerJoin(usersTable, eq(usersTable.id, debtAccountsTable.consumerId))
    .where(eq(debtAccountsTable.driverId, req.auth!.userId))
    .orderBy(desc(debtAccountsTable.updatedAt));

  res.json(
    accounts.map((account) => ({
      ...account,
      debtCeiling: Number(account.debtCeiling),
      balance: Number(account.balance),
      createdAt: account.createdAt.toISOString(),
      updatedAt: account.updatedAt.toISOString(),
    })),
  );
});

// Driver: only consumers this driver has actually delivered an order to.
router.get("/debt-book/consumers", async (req, res): Promise<void> => {
  if (!isDriver(req)) {
    res.status(403).json({ error: "هذه القائمة مخصصة للسائقين فقط" });
    return;
  }

  const rows = await db
    .select({
      consumerId: ordersTable.userId,
      consumerName: usersTable.name,
      consumerPhone: usersTable.phone,
      latestDeliveryAt: ordersTable.deliveredAt,
      accountId: debtAccountsTable.id,
      balance: debtAccountsTable.balance,
      debtCeiling: debtAccountsTable.debtCeiling,
    })
    .from(ordersTable)
    .innerJoin(usersTable, eq(usersTable.id, ordersTable.userId))
    .leftJoin(
      debtAccountsTable,
      and(
        eq(debtAccountsTable.driverId, req.auth!.userId),
        eq(debtAccountsTable.consumerId, ordersTable.userId),
      ),
    )
    .where(
      and(
        eq(ordersTable.driverId, req.auth!.userId),
        eq(ordersTable.status, "تم التوصيل"),
        eq(usersTable.userType, "مستهلك"),
      ),
    )
    .orderBy(desc(ordersTable.deliveredAt), desc(ordersTable.createdAt));

  const seen = new Set<string>();
  const consumers = rows
    .filter((row) => {
      if (seen.has(row.consumerId)) return false;
      seen.add(row.consumerId);
      return true;
    })
    .map((row) => ({
      consumerId: row.consumerId,
      consumerName: row.consumerName,
      consumerPhone: row.consumerPhone,
      latestDeliveryAt: (row.latestDeliveryAt ?? new Date()).toISOString(),
      isInDebtBook: Boolean(row.accountId),
      balance: row.balance === null ? 0 : Number(row.balance),
      debtCeiling: row.debtCeiling === null ? null : Number(row.debtCeiling),
    }));

  res.json({ consumers });
});

// Driver: add a consumer to this driver's private debt book.
router.post("/debt-book", async (req, res): Promise<void> => {
  if (!isDriver(req)) {
    res.status(403).json({ error: "دفتر الديون مخصص للسائقين فقط" });
    return;
  }

  const consumerId = typeof req.body?.consumerId === "string" ? req.body.consumerId.trim() : "";
  const debtCeiling = Number(req.body?.debtCeiling);
  if (!consumerId || !Number.isFinite(debtCeiling) || debtCeiling <= 0) {
    res.status(400).json({ error: "يجب تحديد المستهلك وسقف دين صحيح أكبر من صفر" });
    return;
  }

  const [consumer] = await db
    .select({ id: usersTable.id, userType: usersTable.userType })
    .from(usersTable)
    .where(eq(usersTable.id, consumerId));
  if (!consumer || consumer.userType !== "مستهلك") {
    res.status(404).json({ error: "المستهلك غير موجود" });
    return;
  }

  const [deliveredOrder] = await db
    .select({ id: ordersTable.id })
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.driverId, req.auth!.userId),
        eq(ordersTable.userId, consumerId),
        eq(ordersTable.status, "تم التوصيل"),
      ),
    )
    .limit(1);
  if (!deliveredOrder) {
    res.status(403).json({ error: "يمكنك إضافة المستهلكين الذين أوصلت طلباتهم فقط" });
    return;
  }

  try {
    const account = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(debtAccountsTable)
        .values({
          driverId: req.auth!.userId,
          consumerId,
          debtCeiling: String(debtCeiling),
        })
        .returning();

      await tx
        .insert(favoriteDriversTable)
        .values({ userId: consumerId, driverId: req.auth!.userId })
        .onConflictDoNothing();

      return created;
    });

    res.status(201).json({
      id: account.id,
      consumerId: account.consumerId,
      debtCeiling: Number(account.debtCeiling),
      balance: Number(account.balance),
      status: account.status,
    });
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "23505") {
      res.status(409).json({ error: "هذا المستهلك موجود بالفعل في دفتر الديون" });
      return;
    }
    throw err;
  }
});

// Consumer: every debt account belonging to the authenticated consumer.
router.get("/debts", async (req, res): Promise<void> => {
  if (req.auth?.userType !== "مستهلك") {
    res.status(403).json({ error: "هذه الصفحة مخصصة للمستهلكين فقط" });
    return;
  }

  const accounts = await db
    .select({
      id: debtAccountsTable.id,
      driverId: debtAccountsTable.driverId,
      debtCeiling: debtAccountsTable.debtCeiling,
      balance: debtAccountsTable.balance,
      status: debtAccountsTable.status,
      updatedAt: debtAccountsTable.updatedAt,
    })
    .from(debtAccountsTable)
    .where(eq(debtAccountsTable.consumerId, req.auth.userId))
    .orderBy(desc(debtAccountsTable.updatedAt));

  const driverIds = accounts.map((account) => account.driverId);
  const drivers =
    driverIds.length === 0
      ? []
      : await db
          .select({ id: usersTable.id, name: usersTable.name, phone: usersTable.phone })
          .from(usersTable)
          .where(inArray(usersTable.id, driverIds));
  const driverById = new Map(drivers.map((driver) => [driver.id, driver]));
  const entries =
    accounts.length === 0
      ? []
      : await db
          .select({
            accountId: debtEntriesTable.accountId,
            orderId: debtEntriesTable.orderId,
            amount: debtEntriesTable.amount,
            createdAt: debtEntriesTable.createdAt,
            waterVolume: ordersTable.waterVolume,
            barrelCount: ordersTable.barrelCount,
          })
          .from(debtEntriesTable)
          .innerJoin(ordersTable, eq(ordersTable.id, debtEntriesTable.orderId))
          .where(inArray(debtEntriesTable.accountId, accounts.map((account) => account.id)))
          .orderBy(desc(debtEntriesTable.createdAt));
  const entriesByAccount = new Map<string, typeof entries>();
  for (const entry of entries) {
    const accountEntries = entriesByAccount.get(entry.accountId) ?? [];
    accountEntries.push(entry);
    entriesByAccount.set(entry.accountId, accountEntries);
  }

  res.json(
    accounts.map((account) => ({
      id: account.id,
      driverId: account.driverId,
      driverName: driverById.get(account.driverId)?.name ?? "السائق",
      driverPhone: driverById.get(account.driverId)?.phone ?? null,
      debtCeiling: Number(account.debtCeiling),
      balance: Number(account.balance),
      status: account.status,
      updatedAt: account.updatedAt.toISOString(),
      purchases: (entriesByAccount.get(account.id) ?? []).map((entry) => ({
        orderId: entry.orderId,
        amount: Number(entry.amount),
        waterVolume: entry.waterVolume,
        barrelCount: entry.barrelCount,
        createdAt: entry.createdAt.toISOString(),
      })),
    })),
  );
});

export default router;