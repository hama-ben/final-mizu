/**
 * Generic account-status endpoint.
 *
 * GET /account/:userId/status
 *   Protected by requireAuth (caller must be authenticated).
 *   A user may only fetch their own status (req.auth.userId === params.userId).
 *   Returns { accountStatus, userType, suspensionSource } — the same shape
 *   used by the frontend AccountStatusGate to decide which blocking overlay
 *   to show.
 *
 *   This endpoint is also allowlisted in blockFrozenAccounts so that frozen
 *   users can still poll their own status (which is exactly when they need it).
 */

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, driverDetailsTable, usersTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/account/:userId/status", async (req, res): Promise<void> => {
  const callerId = req.auth?.userId;
  if (!callerId) {
    res.status(401).json({ error: "غير مصرح" });
    return;
  }

  if (callerId !== req.params.userId) {
    res.status(403).json({ error: "لا يمكنك الاطلاع على حالة حساب مستخدم آخر" });
    return;
  }

  const [user] = await db
    .select({ accountStatus: usersTable.accountStatus, userType: usersTable.userType })
    .from(usersTable)
    .where(eq(usersTable.id, callerId));

  if (!user) {
    res.status(404).json({ error: "المستخدم غير موجود" });
    return;
  }

  // Driver-request suspensions are stored on driver_details, while
  // admin-initiated suspensions are stored on users. Expose both the
  // effective status and its source so the frontend can show the correct
  // action: lift-request for the former, support-only for the latter.
  let accountStatus = user.accountStatus;
  let suspensionSource: "admin" | "driver_request" | null =
    user.accountStatus === "suspended" ? "admin" : null;
  if (user.userType === "سائق") {
    const [driverDetails] = await db
      .select({ isSuspended: driverDetailsTable.isSuspended })
      .from(driverDetailsTable)
      .where(eq(driverDetailsTable.driverId, callerId));
    if (driverDetails?.isSuspended === true && user.accountStatus !== "suspended") {
      accountStatus = "suspended";
      suspensionSource = "driver_request";
    }
  }

  res.json({ accountStatus, userType: user.userType, suspensionSource });
});

export default router;
