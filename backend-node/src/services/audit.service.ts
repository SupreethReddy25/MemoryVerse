import crypto from 'crypto';
import { AuditLog } from '../models/audit-log.model';

/**
 * Log an audit event. Fire-and-forget — never let audit logging
 * slow down the response or propagate errors.
 *
 * CRITICAL: queryText is SHA256-hashed before storage.
 * Raw query text is NEVER persisted.
 */
export async function logEvent(
  tenantId: string,
  eventType: string,
  queryText: string,
  responseTimeMs: number
): Promise<void> {
  try {
    const queryHash = crypto
      .createHash('sha256')
      .update(queryText)
      .digest('hex');

    await AuditLog.create({
      tenantId,
      eventType,
      queryHash,
      responseTimeMs,
    });
  } catch {
    // Swallow errors — audit logging must never break the request
    console.error('Audit log write failed');
  }
}
