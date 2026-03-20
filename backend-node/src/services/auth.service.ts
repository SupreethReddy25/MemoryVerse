import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import { User, IUser } from '../models/user.model';
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../utils/jwt.utils';

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

interface RegisterResult extends AuthTokens {
  tenantId: string;
}

// SHA256 pre-hash to avoid bcrypt's 72-byte truncation.
// JWT tokens share identical base64 headers, so bcrypt would
// treat different tokens as identical without this step.
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function registerUser(
  email: string,
  password: string
): Promise<RegisterResult> {
  // Check if email already in use
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    const error = new Error('Email already in use');
    (error as Error & { statusCode: number; code: string }).statusCode = 409;
    (error as Error & { statusCode: number; code: string }).code = 'EMAIL_DUPLICATE';
    throw error;
  }

  // Hash password with bcrypt 12 rounds
  const passwordHash = await bcrypt.hash(password, 12);

  // Generate tenantId
  const tenantId = uuidv4();

  // Save user
  const user = new User({
    email: email.toLowerCase(),
    passwordHash,
    tenantId,
  });

  // Generate tokens
  const userId = (user._id as mongoose.Types.ObjectId).toString();
  const accessToken = signAccessToken(userId, tenantId);
  const refreshToken = signRefreshToken(userId);

  // Hash refresh token (10 rounds) and save
  const refreshTokenHash = await bcrypt.hash(hashToken(refreshToken), 10);
  user.refreshTokenHash = refreshTokenHash;

  await user.save();

  return { accessToken, refreshToken, tenantId };
}

export async function loginUser(
  email: string,
  password: string
): Promise<AuthTokens> {
  // Find user — do not reveal which field is wrong
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    const error = new Error('Invalid credentials');
    (error as Error & { statusCode: number; code: string }).statusCode = 401;
    (error as Error & { statusCode: number; code: string }).code = 'INVALID_CREDENTIALS';
    throw error;
  }

  // Compare password
  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) {
    const error = new Error('Invalid credentials');
    (error as Error & { statusCode: number; code: string }).statusCode = 401;
    (error as Error & { statusCode: number; code: string }).code = 'INVALID_CREDENTIALS';
    throw error;
  }

  // Generate new tokens
  const userId = (user._id as mongoose.Types.ObjectId).toString();
  const accessToken = signAccessToken(userId, user.tenantId);
  const refreshToken = signRefreshToken(userId);

  // Hash new refresh token and save
  const refreshTokenHash = await bcrypt.hash(hashToken(refreshToken), 10);
  user.refreshTokenHash = refreshTokenHash;
  await user.save();

  return { accessToken, refreshToken };
}

export async function refreshTokens(incomingRefreshToken: string): Promise<AuthTokens> {
  // Verify JWT signature and expiry
  let payload: { sub: string };
  try {
    payload = verifyRefreshToken(incomingRefreshToken);
  } catch {
    const error = new Error('Invalid refresh token');
    (error as Error & { statusCode: number; code: string }).statusCode = 401;
    (error as Error & { statusCode: number; code: string }).code = 'INVALID_TOKEN';
    throw error;
  }

  // Find user
  const user = await User.findById(payload.sub);
  if (!user) {
    const error = new Error('User not found');
    (error as Error & { statusCode: number; code: string }).statusCode = 401;
    (error as Error & { statusCode: number; code: string }).code = 'USER_NOT_FOUND';
    throw error;
  }

  // Compare incoming refresh token against stored hash
  if (!user.refreshTokenHash) {
    const error = new Error('Refresh token revoked');
    (error as Error & { statusCode: number; code: string }).statusCode = 401;
    (error as Error & { statusCode: number; code: string }).code = 'TOKEN_REVOKED';
    throw error;
  }

  const isMatch = await bcrypt.compare(hashToken(incomingRefreshToken), user.refreshTokenHash);
  if (!isMatch) {
    const error = new Error('Refresh token mismatch');
    (error as Error & { statusCode: number; code: string }).statusCode = 401;
    (error as Error & { statusCode: number; code: string }).code = 'TOKEN_MISMATCH';
    throw error;
  }

  // Generate new token pair (ROTATE)
  const userId = (user._id as mongoose.Types.ObjectId).toString();
  const accessToken = signAccessToken(userId, user.tenantId);
  const refreshToken = signRefreshToken(userId);

  // Hash new refresh token and save — old one is now invalid
  const refreshTokenHash = await bcrypt.hash(hashToken(refreshToken), 10);
  user.refreshTokenHash = refreshTokenHash;
  await user.save();

  return { accessToken, refreshToken };
}

export async function logoutUser(userId: string): Promise<void> {
  await User.findByIdAndUpdate(userId, { refreshTokenHash: null });
}
