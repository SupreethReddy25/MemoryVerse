import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  registerUser,
  loginUser,
  refreshTokens,
  logoutUser,
} from '../services/auth.service';
import { verifyAccessToken } from '../utils/jwt.utils';

const router = Router();

// Zod schemas
const registerSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

// POST /auth/register
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const validation = registerSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: validation.error.errors[0].message,
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const { email, password } = validation.data;
    const result = await registerUser(email, password);

    res.status(201).json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      tenantId: result.tenantId,
    });
  } catch (err: unknown) {
    const error = err as Error & { statusCode?: number; code?: string };
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      error: error.message,
      code: error.code || 'INTERNAL_ERROR',
    });
  }
});

// POST /auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const validation = loginSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: validation.error.errors[0].message,
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const { email, password } = validation.data;
    const result = await loginUser(email, password);

    res.status(200).json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  } catch (err: unknown) {
    const error = err as Error & { statusCode?: number; code?: string };
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      error: error.message,
      code: error.code || 'INTERNAL_ERROR',
    });
  }
});

// POST /auth/refresh
router.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  try {
    const validation = refreshSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: validation.error.errors[0].message,
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const { refreshToken } = validation.data;
    const result = await refreshTokens(refreshToken);

    res.status(200).json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  } catch (err: unknown) {
    const error = err as Error & { statusCode?: number; code?: string };
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      error: error.message,
      code: error.code || 'INTERNAL_ERROR',
    });
  }
});

// DELETE /auth/logout
router.delete('/logout', async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Missing token',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);

    await logoutUser(decoded.sub);

    res.status(204).send();
  } catch (err: unknown) {
    const error = err as Error & { statusCode?: number; code?: string };
    res.status(401).json({
      error: 'Invalid token',
      code: 'UNAUTHORIZED',
    });
  }
});

export default router;
