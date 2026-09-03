/**
 * Route registry.
 *
 * Order matters for middleware scoping:
 *  1. Public routers (health probes, all /auth/* endpoints) are registered
 *     FIRST so they are never touched by requireAuth.
 *  2. requireAuth middleware is inserted next.  Every router registered after
 *     this point requires a valid Supabase JWT in the Authorization header.
 *  3. blockFrozenAccounts runs immediately after requireAuth.  It rejects
 *     suspended/banned users on all protected routes EXCEPT the allowlisted
 *     paths (status polling, appeal, support thread) — see middleware file.
 *  4. Protected routers follow.
 *
 * Adding a new protected router is a single router.use() call in section 4.
 */

import { Router, type IRouter } from "express";
import { requireAuth }          from "../middlewares/require-auth";
import { blockFrozenAccounts }  from "../middlewares/block-frozen-accounts";

import healthRouter                                          from "./health";
import authRouter, { authProtectedRouter }                   from "./auth";
import { pushPublicRouter, pushProtectedRouter }             from "./push";
import adminRouter                                           from "./admin";
import driverRouter                                          from "./driver";
import ordersRouter                                          from "./orders";
import ratingsRouter                                         from "./ratings";
import announcementsRouter                                   from "./announcements";
import locationsRouter                                       from "./locations";
import { supportPublicRouter, supportProtectedRouter }       from "./support";
import accountRouter                                         from "./account";
import appealsRouter                                         from "./appeals";
import favoriteDriversRouter                                 from "./favorite-drivers";
import referralsRouter                                       from "./referrals";
import wheelRouter                                           from "./wheel";
import giftsRouter                                           from "./gifts";
import debtBookRouter                                        from "./debt-book";
import { getNoDriverContestStatus }                           from "../lib/no-driver-contest";

const router: IRouter = Router();

// ── 1. Public (no session required) ──────────────────────────────────────────
router.use(healthRouter);         // GET /  GET /healthz
router.use(authRouter);           // POST /auth/login  /auth/register-request  etc.
router.use(pushPublicRouter);     // GET /push/vapid-public-key (public key is not a secret)
router.use(adminRouter);          // POST /admin/drivers/:id/approve  etc. (X-Admin-Key auth)
router.use(supportPublicRouter);  // POST /support/message (public anon) + /support/contact

// ── 2. Session validation gate ────────────────────────────────────────────────
// All routes registered after this line require a valid Supabase JWT.
router.use(requireAuth);

// ── 3. Account freeze gate ────────────────────────────────────────────────────
// Rejects suspended/banned users on most protected routes (see allowlist in
// middlewares/block-frozen-accounts.ts for the exemptions).
router.use(blockFrozenAccounts);

// ── 4. Protected routes ───────────────────────────────────────────────────────
router.use(authProtectedRouter);    // GET|DELETE /auth/devices
router.use(accountRouter);        // GET /account/:userId/status
router.use(appealsRouter);        // GET /appeal  POST /appeal
router.use(pushProtectedRouter);  // POST /push/subscribe (auth userId enforced)
router.use(driverRouter);
router.use(ordersRouter);
router.use(ratingsRouter);
router.use(announcementsRouter);
router.use(locationsRouter);
router.use(favoriteDriversRouter);  // GET|POST /favorite-drivers  DELETE /favorite-drivers/:driverId  GET /favorite-drivers/fan-count  GET /favorite-drivers/fans
router.use(supportProtectedRouter); // GET /support/thread  POST /support/thread/send
router.use(referralsRouter);        // GET /referrals/me
router.use(wheelRouter);             // GET|POST /wheel-spins, GET /coupons
router.use(giftsRouter);             // GET /gifts/drivers, POST /gifts/*
router.use(debtBookRouter);          // Driver debt books + consumer debts

router.get("/no-driver-contest", async (req, res): Promise<void> => {
  try {
    res.json(await getNoDriverContestStatus(req.auth!.userId));
  } catch (err) {
    req.log.error({ err, userId: req.auth!.userId }, "no-driver-contest status failed");
    res.status(500).json({ error: "تعذر تحميل حالة المسابقة" });
  }
});

export default router;
