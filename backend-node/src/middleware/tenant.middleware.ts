import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt.utils';

// Extend Express Request to include tenantId and userId
declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      userId?: string;
    }
  }
}

export const tenantMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Missing token',
      code: 'UNAUTHORIZED',
    });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = verifyAccessToken(token);

    // CRITICAL: tenantId comes from the verified JWT ONLY.
    // NEVER trust tenantId from req.body, req.query, or req.params.
    req.tenantId = decoded.tenantId;
    req.userId = decoded.sub;

    next();
  } catch {
    res.status(401).json({
      error: 'Invalid or expired token',
      code: 'UNAUTHORIZED',
    });
  }
};
