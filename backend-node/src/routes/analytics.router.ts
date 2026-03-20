import { Router, Request, Response } from 'express';
import { AuditLog } from '../models/audit-log.model';

const router = Router();

// GET /analytics/summary
router.get('/summary', async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(401).json({ error: 'Missing tenant context', code: 'UNAUTHORIZED' });
      return;
    }

    const queryTypes = ['rag_query', 'cache_hit'];

    const [totalQueries, cacheHits, avgLatencyResult] = await Promise.all([
      AuditLog.countDocuments({ tenantId, eventType: { $in: queryTypes } }),
      AuditLog.countDocuments({ tenantId, eventType: 'cache_hit' }),
      AuditLog.aggregate([
        { $match: { tenantId, eventType: { $in: queryTypes } } },
        { $group: { _id: null, avgLatency: { $avg: '$responseTimeMs' } } },
      ]),
    ]);

    const cacheHitRate = totalQueries > 0 ? (cacheHits / totalQueries) * 100 : 0;
    const avgLatencyMs = avgLatencyResult.length > 0 ? avgLatencyResult[0].avgLatency : 0;

    res.status(200).json({
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      avgLatencyMs: Math.round(avgLatencyMs * 100) / 100,
      queryCount: totalQueries,
    });
  } catch {
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// GET /analytics/daily
router.get('/daily', async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(401).json({ error: 'Missing tenant context', code: 'UNAUTHORIZED' });
      return;
    }

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const queryTypes = ['rag_query', 'cache_hit'];

    const dailyCounts = await AuditLog.aggregate([
      {
        $match: {
          tenantId,
          eventType: { $in: queryTypes },
          createdAt: { $gte: sevenDaysAgo },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', count: 1 } },
    ]);

    res.status(200).json(dailyCounts);
  } catch {
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// GET /analytics/intents
router.get('/intents', async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(401).json({ error: 'Missing tenant context', code: 'UNAUTHORIZED' });
      return;
    }

    const intentCounts = await AuditLog.aggregate([
      { $match: { tenantId } },
      { $group: { _id: '$eventType', count: { $sum: 1 } } },
    ]);

    const result: Record<string, number> = {};
    for (const item of intentCounts) {
      result[item._id as string] = item.count as number;
    }

    res.status(200).json(result);
  } catch {
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

export default router;
