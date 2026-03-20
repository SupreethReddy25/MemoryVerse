import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

interface AccessTokenPayload {
  sub: string;
  tenantId: string;
  iat: number;
  exp: number;
}

interface RefreshTokenPayload {
  sub: string;
  iat: number;
  exp: number;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set');
  }
  return secret;
}

function getJwtRefreshSecret(): string {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) {
    throw new Error('JWT_REFRESH_SECRET environment variable is not set');
  }
  return secret;
}

export function signAccessToken(userId: string, tenantId: string): string {
  return jwt.sign(
    { sub: userId, tenantId, jti: uuidv4() },
    getJwtSecret(),
    { expiresIn: '15m' }
  );
}

export function signRefreshToken(userId: string): string {
  return jwt.sign(
    { sub: userId, jti: uuidv4() },
    getJwtRefreshSecret(),
    { expiresIn: '7d' }
  );
}

export function verifyAccessToken(token: string): { sub: string; tenantId: string } {
  const decoded = jwt.verify(token, getJwtSecret()) as AccessTokenPayload;
  return { sub: decoded.sub, tenantId: decoded.tenantId };
}

export function verifyRefreshToken(token: string): { sub: string } {
  const decoded = jwt.verify(token, getJwtRefreshSecret()) as RefreshTokenPayload;
  return { sub: decoded.sub };
}
