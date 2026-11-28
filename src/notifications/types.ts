export const NOTIFICATION_EVENT_TYPES = [
  'stream_created',
  'stream_withdrawn',
  'stream_cancelled',
  'stream_running_low',
  'ngo_registered',
  'ngo_approved',
  'ngo_revoked',
  'application_submitted',
  'application_reviewed',
] as const;

export type NotificationEvent =
  | {
      type: 'stream_created';
      streamId: string;
      donorAddress: string;
      ngoId: string;
      eventId?: string;
    }
  | {
      type: 'stream_running_low';
      streamId: string;
      donorAddress: string;
      ngoId: string;
      remainingSeconds: string;
      eventId: string;
    }
  | { type: 'stream_withdrawn'; streamId: string; amount: string; eventId?: string }
  | {
      type: 'stream_cancelled';
      streamId: string;
      settledToNgo: string;
      refundToDonor: string;
      eventId?: string;
    }
  | { type: 'ngo_registered'; ownerAddress: string; ngoId: string; eventId?: string }
  | { type: 'ngo_approved'; ownerAddress: string; ngoId: string; eventId?: string }
  | { type: 'ngo_revoked'; ownerAddress: string; ngoId: string; eventId?: string }
  | {
      type: 'application_submitted';
      applicationId: string;
      ownerAddress: string;
      name: string;
      eventId?: string;
    }
  | {
      type: 'application_reviewed';
      applicationId: string;
      ownerAddress: string;
      status: 'APPROVED' | 'REJECTED';
      reviewNote?: string;
      eventId?: string;
    };
