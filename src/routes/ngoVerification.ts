/**
 * Whether an NGO counts as verified at `now`. The registry can let a
 * verification expire (and renew it later), so the stored `verified` flag is
 * only true while `verifiedUntil` is unset or still in the future; the expiry
 * instant itself is already expired.
 */
export function isVerifiedAt(
  ngo: { verified: boolean; verifiedUntil?: Date | null },
  now: Date = new Date(),
): boolean {
  if (!ngo.verified) return false;
  return !ngo.verifiedUntil || ngo.verifiedUntil.getTime() > now.getTime();
}
