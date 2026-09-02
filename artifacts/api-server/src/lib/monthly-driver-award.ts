/**
 * Monthly top-driver award.
 *
 * On the first day of each month, calculate the previous calendar month's
 * consumer-rated completed deliveries per driver and municipality. The
 * unique award row is claimed before granting the spin, making restarts and
 * multiple server instances safe.
 */

import { and, eq, sql } from "drizzle-orm";
import {
  db,
  driverDetailsTable,
  monthlyDriverAwardsTable,
  ordersTable,
  ratingsTable,
  usersTable,
} from "@workspace/db";
import { grantWheelSpin } from "./wheel-spins";
import { emitToUser } from "./socket-server";
import { sendPushToUser } from "./web-push";
import { logger } from "./logger";

export const MONTHLY_DRIVER_AWARD_SOURCE = "monthly_top_driver";
export const MONTHLY_DRIVER_AWARD_MESSAGE = "مبروك! أنت سائق الشهر في بلديتك 🏆";

const ALGIERS_TIME_ZONE = "Africa/Algiers";
const ALGIERS_UTC_OFFSET_MS = 60 * 60 * 1000;
const JOB_INTERVAL_MS = 60 * 60 * 1000;

type AlgiersDateParts = {
  year: number;
  month: number;
  day: number;
};

function getAlgiersDateParts(now: Date): AlgiersDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ALGIERS_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);

  const value = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value);

  return { year: value("year"), month: value("month"), day: value("day") };
}

function previousMonthWindow(now: Date): {
  monthStart: Date;
  monthEnd: Date;
  label: string;
} {
  const current = getAlgiersDateParts(now);
  const currentMonthUtc = Date.UTC(current.year, current.month - 1, 1);
  const previousMonthUtc = Date.UTC(current.year, current.month - 2, 1);

  return {
    monthStart: new Date(previousMonthUtc - ALGIERS_UTC_OFFSET_MS),
    monthEnd: new Date(currentMonthUtc - ALGIERS_UTC_OFFSET_MS),
    label: `${current.year}-${String(current.month - 1 || 12).padStart(2, "0")}`,
  };
}

type Candidate = {
  driverId: string;
  wilaya: string;
  commune: string;
  completedDeliveries: number;
  averageStars: string;
  averageDeliverySeconds: string;
  rank: number;
};

async function findMonthlyWinners(monthStart: Date, monthEnd: Date): Promise<Candidate[]> {
  const completionAt = sql`
    COALESCE(${ordersTable.deliveredAt}, ${ratingsTable.createdAt})
  `;
  const deliverySeconds = sql`
    EXTRACT(EPOCH FROM (
      COALESCE(${ordersTable.deliveredAt}, ${ratingsTable.createdAt})
      - COALESCE(${ordersTable.acceptedAt}, ${ordersTable.createdAt})
    ))
  `;
  const completedCount = sql`COUNT(DISTINCT ${ordersTable.id})`;
  const averageStars = sql`AVG(${ratingsTable.stars})`;
  const averageDeliverySeconds = sql`AVG(${deliverySeconds})`;

  const rows = await db
    .select({
      driverId: ordersTable.driverId,
      wilaya: driverDetailsTable.wilaya,
      commune: driverDetailsTable.commune,
      completedDeliveries: sql<number>`${completedCount}::int`,
      averageStars: sql<string>`${averageStars}`,
      averageDeliverySeconds: sql<string>`${averageDeliverySeconds}`,
      rank: sql<number>`ROW_NUMBER() OVER (
        PARTITION BY ${driverDetailsTable.wilaya}, ${driverDetailsTable.commune}
        ORDER BY
          ${averageStars} DESC,
          ${averageDeliverySeconds} ASC,
          ${completedCount} DESC,
          ${ordersTable.driverId} ASC
      )`,
    })
    .from(ordersTable)
    .innerJoin(
      ratingsTable,
      and(
        eq(ratingsTable.orderId, ordersTable.id),
        eq(ratingsTable.ratedUserId, ordersTable.driverId),
        eq(ratingsTable.raterType, "consumer"),
      ),
    )
    .innerJoin(driverDetailsTable, eq(driverDetailsTable.driverId, ordersTable.driverId))
    .innerJoin(usersTable, eq(usersTable.id, ordersTable.driverId))
    .where(and(
      eq(ordersTable.status, "تم التوصيل"),
      eq(usersTable.userType, "سائق"),
      sql`${completionAt} >= ${monthStart}`,
      sql`${completionAt} < ${monthEnd}`,
      sql`${driverDetailsTable.wilaya} <> ''`,
      sql`${driverDetailsTable.commune} <> ''`,
    ))
    .groupBy(
      ordersTable.driverId,
      driverDetailsTable.wilaya,
      driverDetailsTable.commune,
    )
    .having(sql`${completedCount} >= 30`);

  return rows
    .map((row) => ({
      driverId: row.driverId!,
      wilaya: row.wilaya,
      commune: row.commune,
      completedDeliveries: Number(row.completedDeliveries),
      averageStars: String(row.averageStars),
      averageDeliverySeconds: String(row.averageDeliverySeconds),
      rank: Number(row.rank),
    }))
    .filter((row) => row.rank === 1);
}

async function awardWinner(winner: Candidate, monthStart: Date, monthEnd: Date): Promise<boolean> {
  const spinId = await db.transaction(async (tx) => {
    const [award] = await tx
      .insert(monthlyDriverAwardsTable)
      .values({
        driverId: winner.driverId,
        wilaya: winner.wilaya,
        commune: winner.commune,
        monthStart,
        monthEnd,
        completedDeliveries: winner.completedDeliveries,
        averageStars: winner.averageStars,
        averageDeliverySeconds: winner.averageDeliverySeconds,
      })
      .onConflictDoNothing({
        target: [
          monthlyDriverAwardsTable.wilaya,
          monthlyDriverAwardsTable.commune,
          monthlyDriverAwardsTable.monthStart,
        ],
      })
      .returning({ id: monthlyDriverAwardsTable.id });

    if (!award) return null;

    const wheelSpinId = await grantWheelSpin(
      winner.driverId,
      MONTHLY_DRIVER_AWARD_SOURCE,
      tx,
    );

    await tx
      .update(monthlyDriverAwardsTable)
      .set({ wheelSpinId })
      .where(eq(monthlyDriverAwardsTable.id, award.id));

    return wheelSpinId;
  });

  if (!spinId) return false;

  emitToUser(winner.driverId, "monthly_driver_award", {
    source: MONTHLY_DRIVER_AWARD_SOURCE,
    message: MONTHLY_DRIVER_AWARD_MESSAGE,
    wilaya: winner.wilaya,
    commune: winner.commune,
    completedDeliveries: winner.completedDeliveries,
    averageStars: winner.averageStars,
  });
  await sendPushToUser(winner.driverId, {
    title: "سائق الشهر 🏆",
    body: MONTHLY_DRIVER_AWARD_MESSAGE,
    url: "/driver-dashboard",
  });

  return true;
}

export async function runMonthlyDriverAwards(now = new Date()): Promise<number> {
  const current = getAlgiersDateParts(now);
  if (current.day !== 1) return 0;

  const { monthStart, monthEnd, label } = previousMonthWindow(now);
  const winners = await findMonthlyWinners(monthStart, monthEnd);
  let awarded = 0;

  for (const winner of winners) {
    try {
      if (await awardWinner(winner, monthStart, monthEnd)) awarded += 1;
    } catch (err) {
      logger.error(
        { err, driverId: winner.driverId, wilaya: winner.wilaya, commune: winner.commune },
        "Monthly driver award failed",
      );
    }
  }

  logger.info({ month: label, eligibleMunicipalities: winners.length, awarded }, "Monthly driver awards sweep completed");
  return awarded;
}

export function startMonthlyDriverAwardsJob(): void {
  void runMonthlyDriverAwards().catch((err) => {
    logger.error({ err }, "Initial monthly driver awards sweep failed");
  });

  setInterval(() => {
    runMonthlyDriverAwards().catch((err) => {
      logger.error({ err }, "Monthly driver awards sweep failed");
    });
  }, JOB_INTERVAL_MS);

  logger.info({ intervalMs: JOB_INTERVAL_MS, timeZone: ALGIERS_TIME_ZONE }, "Monthly driver awards job started");
}
