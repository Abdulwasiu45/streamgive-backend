import { prisma } from '../db.js';

type AuditWriter = Pick<typeof prisma, 'adminAuditLog'>;

export async function recordAdminAction(
  writer: AuditWriter,
  adminAddress: string,
  action: string,
  targetId: string,
  summary: string,
): Promise<void> {
  await writer.adminAuditLog.create({
    data: { adminAddress, action, targetId, summary },
  });
}
