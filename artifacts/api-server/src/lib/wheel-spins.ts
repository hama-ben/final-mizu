import { db, wheelSpinsTable } from "@workspace/db";

/**
 * Server-side grant point for later reward phases. No client route can grant
 * a spin; callers should invoke this from their own server transaction.
 */
export async function grantWheelSpin(
  userId: string,
  source: string,
  executor: any = db,
): Promise<string> {
  const [spin] = await executor
    .insert(wheelSpinsTable)
    .values({ userId, source })
    .returning({ id: wheelSpinsTable.id });
  if (!spin) throw new Error("WHEEL_SPIN_NOT_GRANTED");
  return spin.id;
}