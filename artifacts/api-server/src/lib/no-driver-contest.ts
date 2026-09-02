import { and, count, eq, gte, isNull, isNotNull, sql } from "drizzle-orm";
import {
  db,
  referralsTable,
  usersTable,
} from "@workspace/db";
import { grantWheelSpin } from "./wheel-spins";
import { emitToUser } from "./socket-server";

export const NO_DRIVER_CONTEST_SOURCE = "consumer_no_driver_contest";
export const NO_DRIVER_CONTEST_REQUIRED_DRIVERS = 2;

export type NoDriverContestStatus =
  | "available"
  | "active"
  | "completed"
  | "cancelled"
  | "already_used"
  | "unavailable";

export interface NoDriverContestSnapshot {
  status: NoDriverContestStatus;
  name: string;
  qualifiedDrivers: number;
  requiredDrivers: number;
  referralCode: string | null;
  startedAt: string | null;
}

type DbExecutor = Pick<typeof db, "select" | "update" | "execute">;

export async function countApprovedDrivers(
  executor: DbExecutor,
  wilaya: string,
  commune: string,
): Promise<number> {
  const [row] = await executor
    .select({ count: count() })
    .from(usersTable)
    .where(and(
      eq(usersTable.userType, "سائق"),
      eq(usersTable.accountStatus, "approved"),
      eq(usersTable.wilaya, wilaya),
      eq(usersTable.commune, commune),
    ))
  return Number(row?.count ?? 0);
}

async function qualifiedContestDrivers(
  executor: DbExecutor,
  userId: string,
  startedAt: Date | null,
): Promise<number> {
  if (!startedAt) return 0;

  const [row] = await executor
    .select({ count: count() })
    .from(referralsTable)
    .where(and(
      eq(referralsTable.referrerId, userId),
      eq(referralsTable.referredRole, "سائق"),
      eq(referralsTable.status, "qualified"),
      gte(referralsTable.createdAt, startedAt),
    ));
  return Number(row?.count ?? 0);
}

/**
 * Atomically marks the lifetime contest as used when an order attempt finds
 * no registered driver in the consumer's municipality. The order route calls
 * this before creating an order, so no order is created while the contest
 * gate is active.
 */
export async function beginNoDriverContest(userId: string): Promise<{
  noDriver: boolean;
  alreadyUsed: boolean;
  contest: NoDriverContestSnapshot | null;
}> {
  const [user] = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      userType: usersTable.userType,
      wilaya: usersTable.wilaya,
      commune: usersTable.commune,
      referralCode: usersTable.referralCode,
      noDriverContestUsed: usersTable.noDriverContestUsed,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!user || user.userType !== "مستهلك") {
    return { noDriver: false, alreadyUsed: false, contest: null };
  }

  const approvedDriverCount = await countApprovedDrivers(db, user.wilaya, user.commune);
  if (approvedDriverCount > 0) {
    return { noDriver: false, alreadyUsed: false, contest: null };
  }

  if (!user.noDriverContestUsed) {
    await db
      .update(usersTable)
      .set({
        noDriverContestUsed: true,
        noDriverContestStartedAt: sql`COALESCE(${usersTable.noDriverContestStartedAt}, NOW())`,
      })
      .where(and(
        eq(usersTable.id, userId),
        eq(usersTable.noDriverContestUsed, false),
      ));
  }

  const contest = await getNoDriverContestStatus(userId);
  return {
    noDriver: true,
    alreadyUsed: user.noDriverContestUsed,
    contest,
  };
}

/**
 * Reads the current state and re-checks the municipality every time. This
 * makes the UI hide the contest even if the socket event was missed.
 */
export async function getNoDriverContestStatus(
  userId: string,
  executor: DbExecutor = db,
): Promise<NoDriverContestSnapshot> {
  const [user] = await executor
    .select({
      name: usersTable.name,
      userType: usersTable.userType,
      wilaya: usersTable.wilaya,
      commune: usersTable.commune,
      referralCode: usersTable.referralCode,
      noDriverContestUsed: usersTable.noDriverContestUsed,
      noDriverContestStartedAt: usersTable.noDriverContestStartedAt,
      noDriverContestRewardedAt: usersTable.noDriverContestRewardedAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!user || user.userType !== "مستهلك") {
    return {
      status: "unavailable",
      name: user?.name ?? "",
      qualifiedDrivers: 0,
      requiredDrivers: NO_DRIVER_CONTEST_REQUIRED_DRIVERS,
      referralCode: user?.referralCode ?? null,
      startedAt: null,
    };
  }

  const qualifiedDrivers = await qualifiedContestDrivers(
    executor,
    userId,
    user.noDriverContestStartedAt,
  );

  if (user.noDriverContestRewardedAt) {
    return {
      status: "completed",
      name: user.name,
      qualifiedDrivers: Math.min(qualifiedDrivers, NO_DRIVER_CONTEST_REQUIRED_DRIVERS),
      requiredDrivers: NO_DRIVER_CONTEST_REQUIRED_DRIVERS,
      referralCode: user.referralCode,
      startedAt: user.noDriverContestStartedAt?.toISOString() ?? null,
    };
  }

  if (!user.noDriverContestUsed) {
    const approvedDriverCount = await countApprovedDrivers(executor, user.wilaya, user.commune);
    return {
      status: approvedDriverCount > 0 ? "unavailable" : "available",
      name: user.name,
      qualifiedDrivers: 0,
      requiredDrivers: NO_DRIVER_CONTEST_REQUIRED_DRIVERS,
      referralCode: user.referralCode,
      startedAt: null,
    };
  }

  if (!user.noDriverContestStartedAt) {
    return {
      status: "already_used",
      name: user.name,
      qualifiedDrivers,
      requiredDrivers: NO_DRIVER_CONTEST_REQUIRED_DRIVERS,
      referralCode: user.referralCode,
      startedAt: null,
    };
  }

  if (qualifiedDrivers >= NO_DRIVER_CONTEST_REQUIRED_DRIVERS) {
    await completeNoDriverContest(userId, db);
    return {
      status: "completed",
      name: user.name,
      qualifiedDrivers: NO_DRIVER_CONTEST_REQUIRED_DRIVERS,
      requiredDrivers: NO_DRIVER_CONTEST_REQUIRED_DRIVERS,
      referralCode: user.referralCode,
      startedAt: user.noDriverContestStartedAt.toISOString(),
    };
  }

  return {
    status:
      (await countApprovedDrivers(executor, user.wilaya, user.commune)) >= 4
        ? "cancelled"
        : "active",
    name: user.name,
    qualifiedDrivers,
    requiredDrivers: NO_DRIVER_CONTEST_REQUIRED_DRIVERS,
    referralCode: user.referralCode,
    startedAt: user.noDriverContestStartedAt.toISOString(),
  };
}

/**
 * Called inside the qualification transaction. The update predicate is the
 * idempotency guard; the spin grant and the marker share the same transaction.
 */
export async function completeNoDriverContest(
  consumerId: string,
  executor: DbExecutor = db,
): Promise<string | null> {
  if (executor === db) {
    return db.transaction((tx) => completeNoDriverContest(consumerId, tx));
  }

  const [consumer] = await executor
    .select({
      wilaya: usersTable.wilaya,
      commune: usersTable.commune,
      startedAt: usersTable.noDriverContestStartedAt,
    })
    .from(usersTable)
    .where(and(
      eq(usersTable.id, consumerId),
      eq(usersTable.userType, "مستهلك"),
      eq(usersTable.noDriverContestUsed, true),
      isNotNull(usersTable.noDriverContestStartedAt),
      isNull(usersTable.noDriverContestRewardedAt),
    ));

  if (!consumer?.startedAt) return null;

  const qualifiedDrivers = await qualifiedContestDrivers(executor, consumerId, consumer.startedAt);
  if (qualifiedDrivers < NO_DRIVER_CONTEST_REQUIRED_DRIVERS) return null;

  const [claimed] = await executor
    .update(usersTable)
    .set({ noDriverContestRewardedAt: new Date() })
    .where(and(
      eq(usersTable.id, consumerId),
      isNull(usersTable.noDriverContestRewardedAt),
    ))
    .returning({ id: usersTable.id });

  if (!claimed) return null;
  return grantWheelSpin(consumerId, NO_DRIVER_CONTEST_SOURCE, executor);
}

/**
 * Four approved drivers are enough to close every active contest in the
 * municipality. The status is also derived from the same approved-driver
 * threshold in getNoDriverContestStatus(), so a missed socket event cannot
 * leave the UI showing an active contest.
 */
export async function closeContestsForApprovedDriverThreshold(
  wilaya: string,
  commune: string,
): Promise<void> {
  if (!wilaya || !commune) return;

  const approvedDriverCount = await countApprovedDrivers(db, wilaya, commune);
  if (approvedDriverCount < 4) return;

  const rows = await db.execute(sql`
    SELECT "id"
    FROM "users"
    WHERE "user_type" = 'مستهلك'
      AND "wilaya" = ${wilaya}
      AND "commune" = ${commune}
      AND "no_driver_contest_used" = true
      AND "no_driver_contest_started_at" IS NOT NULL
      AND "no_driver_contest_rewarded_at" IS NULL
  `);

  for (const row of rows.rows as Array<{ id?: string }>) {
    if (row.id) {
      emitToUser(row.id, "no_driver_contest_cancelled", {
        wilaya,
        commune,
        message: "تم إغلاق المسابقة لاكتمال أربعة سائقين معتمدين في بلديتك.",
      });
    }
  }
}