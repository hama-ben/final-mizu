import { pgTable, text, integer, numeric, timestamp, boolean, jsonb, doublePrecision, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const usersTable = pgTable("users", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  phone: text("phone").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  userType: text("user_type").notNull(),
  wilaya: text("wilaya").notNull().default(""),
  commune: text("commune").notNull().default(""),
  accountStatus: text("account_status").notNull().default("pending"),
  subscriptionExpiresAt: timestamp("subscription_expires_at"),
  freeTrialClaimed: boolean("free_trial_claimed").notNull().default(false),
  firstApprovalGranted: boolean("first_approval_granted").notNull().default(false),
  referralCode: text("referral_code").unique(),
  // The database bootstrap adds the FK; keeping this field untyped here avoids
  // a circular self-reference in Drizzle's inferred table type.
  referredBy: text("referred_by"),
  noDriverContestUsed: boolean("no_driver_contest_used").notNull().default(false),
  noDriverContestStartedAt: timestamp("no_driver_contest_started_at"),
  noDriverContestRewardedAt: timestamp("no_driver_contest_rewarded_at"),
  createdAt: timestamp("created_at"),
  // Geographic anchor recorded automatically from the consumer's first real order.
  // Used later to verify the consumer is still within their registered region.
  homeLatitude: doublePrecision("home_latitude"),
  homeLongitude: doublePrecision("home_longitude"),
});

export const referralsTable = pgTable(
  "referrals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referrerId: text("referrer_id").notNull().references(() => usersTable.id),
    referredId: text("referred_id").notNull().references(() => usersTable.id),
    referredRole: text("referred_role").notNull(),
    source: text("source").notNull().default("referral"),
    status: text("status").notNull().default("pending"),
    qualifiedAt: timestamp("qualified_at"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    unique("referrals_referrer_referred_unique").on(table.referrerId, table.referredId),
  ],
);

export const referralRewardsTable = pgTable(
  "referral_rewards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referrerId: text("referrer_id").notNull().references(() => usersTable.id),
    milestone: integer("milestone").notNull(),
    rewardType: text("reward_type").notNull(),
    wheelSpinId: uuid("wheel_spin_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    unique("referral_rewards_referrer_milestone_unique").on(table.referrerId, table.milestone),
  ],
);

export const referralRewardsPendingAdminTable = pgTable(
  "referral_rewards_pending_admin",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    driverId: text("driver_id").notNull().references(() => usersTable.id),
    thresholdReached: integer("threshold_reached").notNull().default(10),
    reachedAt: timestamp("reached_at", { withTimezone: true }).notNull().default(sql`now()`),
    rewardGranted: boolean("reward_granted").notNull().default(false),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    grantedBy: text("granted_by").references(() => usersTable.id),
  },
  (table) => [
    unique("referral_rewards_pending_admin_driver_threshold_unique").on(
      table.driverId,
      table.thresholdReached,
    ),
  ],
);

export const wheelSpinsTable = pgTable("wheel_spins", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  source: text("source").notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  resultPercentage: integer("result_percentage"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export const monthlyDriverAwardsTable = pgTable(
  "monthly_driver_awards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    driverId: text("driver_id").notNull().references(() => usersTable.id),
    wilaya: text("wilaya").notNull(),
    commune: text("commune").notNull(),
    monthStart: timestamp("month_start").notNull(),
    monthEnd: timestamp("month_end").notNull(),
    completedDeliveries: integer("completed_deliveries").notNull(),
    averageStars: numeric("average_stars").notNull(),
    averageDeliverySeconds: numeric("average_delivery_seconds").notNull(),
    wheelSpinId: uuid("wheel_spin_id"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    unique("monthly_driver_awards_region_month_unique").on(
      table.wilaya,
      table.commune,
      table.monthStart,
    ),
  ],
);

export const subscriptionPaymentsTable = pgTable("subscription_payments", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  driverId: text("driver_id").notNull(),
  receiptImage: text("receipt_image").notNull(),
  months: integer("months").notNull().default(1),
  status: text("status").notNull().default("pending"),
  adminNotes: text("admin_notes"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  reviewedAt: timestamp("reviewed_at"),
});

export const couponsTable = pgTable("coupons", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  discountPercentage: integer("discount_percentage").notNull(),
  maxDiscountAmount: integer("max_discount_amount"),
  wonAt: timestamp("won_at", { withTimezone: true }).notNull().default(sql`now()`),
  activationTriggerAt: timestamp("activation_trigger_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  usedAt: timestamp("used_at", { withTimezone: true }),
  appliedToPaymentId: text("applied_to_payment_id").references(
    () => subscriptionPaymentsTable.id,
    { onDelete: "set null" },
  ),
  appliedAmountDzd: integer("applied_amount_dzd"),
});

export const driverStatusTable = pgTable("driver_status", {
  driverId: text("driver_id").primaryKey(),
  currentStatus: text("current_status").notNull().default("مغلق"),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

export const driverDetailsTable = pgTable("driver_details", {
  driverId: text("driver_id").primaryKey(),
  wilaya: text("wilaya").notNull().default(""),
  commune: text("commune").notNull().default(""),
  truckFrontPhotoUrl: text("truck_front_photo_url"),
  driverLicenseUrl: text("driver_license_url"),
  truckVideoUrl: text("truck_video_url"),
  truckSidePhotoUrl: text("truck_side_photo_url"),
  isLegacyDriver: boolean("is_legacy_driver").notNull().default(false),
  trialGrantedAt: timestamp("trial_granted_at"),
  isSuspended: boolean("is_suspended").notNull().default(false),
  suspensionReason: text("suspension_reason"),
});

export const ordersTable = pgTable("orders", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: text("user_id").notNull(),
  driverId: text("driver_id"),
  waterVolume: text("water_volume").notNull(),
  barrelCount: integer("barrel_count").notNull().default(0),
  totalPrice: numeric("total_price").notNull(),
  latitude: text("latitude"),
  longitude: text("longitude"),
  status: text("status").notNull().default("معلق"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  acceptedAt: timestamp("accepted_at"),
  deliveredAt: timestamp("delivered_at"),
  paymentMethod: text("payment_method").notNull().default("cash"),
  orderType: text("order_type").notNull().default("normal"),
  staleNoticeSentAt: timestamp("stale_notice_sent_at"),
  // Favorite-driver exclusivity: set when a consumer has a favourite driver who is online.
  // The order is sent only to this driver until exclusiveExpiresAt passes.
  exclusiveDriverId: text("exclusive_driver_id"),
  exclusiveExpiresAt: timestamp("exclusive_expires_at"),
});

export const ratingsTable = pgTable("ratings", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  orderId: text("order_id").notNull(),
  raterUserId: text("rater_user_id").notNull(),
  ratedUserId: text("rated_user_id").notNull(),
  raterType: text("rater_type").notNull(),
  stars: integer("stars").notNull(),
  comment: text("comment"),
  disputeReason: text("dispute_reason"),
  isDisputed: boolean("is_disputed").notNull().default(false),
  disputeCount: integer("dispute_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const savedLocationsTable = pgTable("saved_locations", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: text("user_id").notNull(),
  label: text("label").notNull(),
  latitude: text("latitude").notNull(),
  longitude: text("longitude").notNull(),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const announcementsTable = pgTable("announcements", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  content: text("content").notNull(),
  targetAudience: text("target_audience").notNull().default("all"),
  badgeText: text("badge_text"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const announcementReadsTable = pgTable("announcement_reads", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  announcementId: text("announcement_id").notNull(),
  userId: text("user_id").notNull(),
  userType: text("user_type").notNull(),
  readAt: timestamp("read_at").notNull().default(sql`now()`),
});

export const supportMessagesTable = pgTable("support_messages", {
  id:          text("id").primaryKey().default(sql`gen_random_uuid()`),
  userId:      text("user_id"),
  message:     text("message").notNull(),
  senderType:  text("sender_type").notNull().default("user"),
  adminId:     text("admin_id"),
  status:      text("status").notNull().default("pending"),
  createdAt:   timestamp("created_at").notNull().default(sql`now()`),
});

export const userDevicesTable = pgTable("user_devices", {
  id:          text("id").primaryKey().default(sql`gen_random_uuid()`),
  userId:      text("user_id").notNull(),
  deviceId:    text("device_id").notNull(),
  deviceLabel: text("device_label").notNull().default(""),
  firstSeenAt: timestamp("first_seen_at").notNull().default(sql`now()`),
  lastSeenAt:  timestamp("last_seen_at").notNull().default(sql`now()`),
});

/**
 * user_appeals — formerly driver-only but now used for both drivers ("rejected")
 * and any user type ("banned").
 *
 * Table/column names kept as driver_appeals / driver_id to avoid a risky
 * rename migration while data exists.  The driver_id column stores any user's
 * id — not exclusively drivers.
 *
 * reason: "rejected" | "banned" — set at submission time so the admin panel
 * can distinguish document-rejection appeals from ban appeals.
 */
export const driverAppealsTable = pgTable("driver_appeals", {
  id:            text("id").primaryKey().default(sql`gen_random_uuid()`),
  driverId:      text("driver_id").notNull(), // stores any user's id (driver or consumer)
  message:       text("message").notNull(),
  status:        text("status").notNull().default("pending"),
  adminResponse: text("admin_response"),
  createdAt:     timestamp("created_at").notNull().default(sql`now()`),
  reviewedAt:    timestamp("reviewed_at"),
  reason:        text("reason"),              // "rejected" | "banned" — nullable for legacy rows
});

export const driverSuspensionRequestsTable = pgTable("driver_suspension_requests", {
  id:          uuid("id").primaryKey().defaultRandom(),
  driverId:    text("driver_id").notNull(),
  requestType: text("request_type").notNull(),
  reason:      text("reason").notNull(),
  reasonText:  text("reason_text"),
  status:      text("status").notNull().default("pending"),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  reviewedAt:  timestamp("reviewed_at", { withTimezone: true }),
  reviewedBy:  uuid("reviewed_by"),
});

export const pushSubscriptionsTable = pgTable("push_subscriptions", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: text("user_id").notNull(),
  subscription: jsonb("subscription").notNull(),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

/**
 * favorite_drivers — consumers can save up to 3 drivers they trust.
 * Used to route new orders exclusively to a favourite driver for 90 s
 * before falling back to the normal region-wide broadcast.
 */
export const favoriteDriversTable = pgTable(
  "favorite_drivers",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),   // consumer
    driverId: text("driver_id").notNull(), // driver
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    unique("favorite_drivers_user_driver_unique").on(table.userId, table.driverId),
  ]
);

/**
 * debt_accounts — one private credit account per driver/consumer pair.
 * A driver can only create an account after delivering an order to that
 * consumer. Creating an account also adds the driver to the consumer's
 * favourites in the API transaction.
 */
export const debtAccountsTable = pgTable(
  "debt_accounts",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    driverId: text("driver_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    consumerId: text("consumer_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    debtCeiling: numeric("debt_ceiling").notNull(),
    balance: numeric("balance").notNull().default("0"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  },
  (table) => [
    unique("debt_accounts_driver_consumer_unique").on(table.driverId, table.consumerId),
  ],
);

/**
 * debt_entries — immutable debit records tied to a delivered order.
 * orderId is unique so retrying the completion request can never double-charge.
 */
export const debtEntriesTable = pgTable(
  "debt_entries",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    accountId: text("account_id").notNull().references(() => debtAccountsTable.id, { onDelete: "cascade" }),
    orderId: text("order_id").notNull().references(() => ordersTable.id, { onDelete: "cascade" }),
    amount: numeric("amount").notNull(),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    unique("debt_entries_order_unique").on(table.orderId),
  ],
);

/**
 * One row per driver — always their most recent GPS position.
 * Upserted by the driver frontend every 5 s while actively delivering.
 * Read by the consumer frontend via Supabase Realtime postgres_changes.
 */
export const driverLocationsTable = pgTable("driver_locations", {
  driverId: text("driver_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  latitude: doublePrecision("latitude").notNull(),
  longitude: doublePrecision("longitude").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
});
