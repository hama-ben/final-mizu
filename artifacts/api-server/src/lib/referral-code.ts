import crypto from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

const CODE_LENGTH = 4;
const CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function referralPrefix(name: string): string {
  const latinPrefix = name
    .normalize("NFKD")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 3);

  return latinPrefix ? latinPrefix.padEnd(3, "X") : "MIZ";
}

export function generateReferralCode(name: string): string {
  let suffix = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    suffix += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return `${referralPrefix(name)}${suffix}`;
}

export async function ensureReferralCode(userId: string, name: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const [existing] = await db
      .select({ referralCode: usersTable.referralCode })
      .from(usersTable)
      .where(eq(usersTable.id, userId));

    if (!existing) {
      throw new Error("User not found while creating referral code");
    }
    if (existing.referralCode) {
      return existing.referralCode;
    }

    const candidate = generateReferralCode(name);
    try {
      const [updated] = await db
        .update(usersTable)
        .set({ referralCode: candidate })
        .where(and(eq(usersTable.id, userId), isNull(usersTable.referralCode)))
        .returning({ referralCode: usersTable.referralCode });

      if (updated?.referralCode) {
        return updated.referralCode;
      }
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const constraint = String((error as { constraint?: string })?.constraint ?? "");
      if (code === "23505" && constraint.includes("referral")) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("Unable to allocate a unique referral code");
}