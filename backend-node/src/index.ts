import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import authRouter from './routes/auth.router';
import queryRouter from './routes/query.router';
import documentsRouter from './routes/documents.router';
import analyticsRouter from './routes/analytics.router';
import { tenantMiddleware } from './middleware/tenant.middleware';

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// ─── Rate Limiters ──────────────────────────────────────────

// Auth rate limiter — stricter, prevent brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many attempts', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
});

// API rate limiter — general, per userId
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  keyGenerator: (req) => req.userId || 'anonymous',
  message: { error: 'Rate limit exceeded', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Public routes ──────────────────────────────────────────

// Apply auth rate limiter to login and register only (skip in test mode)
if (process.env.NODE_ENV !== 'test') {
  app.use('/auth/login', authLimiter);
  app.use('/auth/register', authLimiter);
}
app.use('/auth', authRouter);

// ─── Protected routes ───────────────────────────────────────

// Tenant middleware applied to everything below
app.use(tenantMiddleware);

// Apply API rate limiter to query/suggest
app.use('/query/suggest', apiLimiter);

// Mount protected routers
app.use('/query', queryRouter);
app.use('/documents', documentsRouter);
app.use('/analytics', analyticsRouter);

// Example protected route (for testing tenant isolation)
app.get('/protected/profile', (req, res) => {
  res.status(200).json({
    tenantId: req.tenantId,
    userId: req.userId,
  });
});

// MongoDB connection and server start
const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/memoryverse';

const startServer = async (): Promise<void> => {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Only start server if not in test mode
if (process.env.NODE_ENV !== 'test') {
  startServer();
}

export { app };
