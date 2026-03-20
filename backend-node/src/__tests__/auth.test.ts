import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import jwt from 'jsonwebtoken';
import { app } from '../index';
import { User } from '../models/user.model';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  // Set up environment variables for testing
  process.env.JWT_SECRET = 'test-jwt-secret-that-is-32-bytes!';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-32-bytes!!!';
  process.env.NODE_ENV = 'test';

  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await User.deleteMany({});
});

describe('Auth Endpoints', () => {
  const validUser = {
    email: 'test@example.com',
    password: 'securePassword123',
  };

  // ───────────────────────────────────────────────
  // Test 1: Register with valid data → 201
  // ───────────────────────────────────────────────
  describe('POST /auth/register', () => {
    it('should register a new user and return tokens with tenantId (201)', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send(validUser)
        .expect(201);

      expect(res.body).toHaveProperty('accessToken');
      expect(res.body).toHaveProperty('refreshToken');
      expect(res.body).toHaveProperty('tenantId');

      // Verify the access token contains tenantId claim
      const decoded = jwt.verify(
        res.body.accessToken,
        process.env.JWT_SECRET!
      ) as jwt.JwtPayload;
      expect(decoded).toHaveProperty('tenantId');
      expect(decoded.tenantId).toBe(res.body.tenantId);
    });

    // ───────────────────────────────────────────────
    // Test 2: Register with duplicate email → 409
    // ───────────────────────────────────────────────
    it('should reject duplicate email registration (409)', async () => {
      // Register first time
      await request(app)
        .post('/auth/register')
        .send(validUser)
        .expect(201);

      // Try again with same email
      const res = await request(app)
        .post('/auth/register')
        .send(validUser)
        .expect(409);

      expect(res.body).toHaveProperty('error');
      expect(res.body).toHaveProperty('code', 'EMAIL_DUPLICATE');
    });

    // ───────────────────────────────────────────────
    // Test 3: Register with weak password → 400
    // ───────────────────────────────────────────────
    it('should reject weak password (< 8 chars) (400)', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ email: 'weak@example.com', password: 'short' })
        .expect(400);

      expect(res.body).toHaveProperty('error');
      expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(async () => {
      // Register a user first
      await request(app).post('/auth/register').send(validUser);
    });

    // ───────────────────────────────────────────────
    // Test 4: Login with correct credentials → 200
    // ───────────────────────────────────────────────
    it('should login with correct credentials and return tokens (200)', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send(validUser)
        .expect(200);

      expect(res.body).toHaveProperty('accessToken');
      expect(res.body).toHaveProperty('refreshToken');
    });

    // ───────────────────────────────────────────────
    // Test 5: Login with wrong password → 401
    // ───────────────────────────────────────────────
    it('should reject login with wrong password (401)', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: validUser.email, password: 'wrongpassword' })
        .expect(401);

      expect(res.body).toHaveProperty('error', 'Invalid credentials');
      expect(res.body).toHaveProperty('code', 'INVALID_CREDENTIALS');
    });
  });

  // ───────────────────────────────────────────────
  // Test 6: Refresh with valid token → 200, rotation
  // ───────────────────────────────────────────────
  describe('POST /auth/refresh', () => {
    it('should rotate tokens on valid refresh (200)', async () => {
      // Register and get initial tokens
      const registerRes = await request(app)
        .post('/auth/register')
        .send(validUser)
        .expect(201);

      const oldRefreshToken = registerRes.body.refreshToken;

      // Refresh with the initial refresh token
      const refreshRes = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: oldRefreshToken })
        .expect(200);

      expect(refreshRes.body).toHaveProperty('accessToken');
      expect(refreshRes.body).toHaveProperty('refreshToken');

      // New tokens should be different
      expect(refreshRes.body.refreshToken).not.toBe(oldRefreshToken);

      // Old refresh token should no longer work (rotation)
      await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: oldRefreshToken })
        .expect(401);
    });
  });

  // ───────────────────────────────────────────────
  // Test 7: Protected route without token → 401
  // ───────────────────────────────────────────────
  describe('Protected Routes', () => {
    it('should reject access to protected route without token (401)', async () => {
      const res = await request(app)
        .get('/protected/profile')
        .expect(401);

      expect(res.body).toHaveProperty('error', 'Missing token');
      expect(res.body).toHaveProperty('code', 'UNAUTHORIZED');
    });

    // ───────────────────────────────────────────────
    // Test 8: Protected route with valid token → tenantId correct
    // ───────────────────────────────────────────────
    it('should populate req.tenantId from JWT on protected route (200)', async () => {
      // Register to get an access token
      const registerRes = await request(app)
        .post('/auth/register')
        .send(validUser)
        .expect(201);

      const { accessToken, tenantId } = registerRes.body;

      // Access protected route
      const res = await request(app)
        .get('/protected/profile')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.tenantId).toBe(tenantId);
    });

    // ───────────────────────────────────────────────
    // Test 9 (CRITICAL): tenantId from body is IGNORED,
    //   JWT tenantId is used instead
    // ───────────────────────────────────────────────
    it('should use JWT tenantId, NOT body tenantId — security boundary test', async () => {
      // Register to get a valid token
      const registerRes = await request(app)
        .post('/auth/register')
        .send(validUser)
        .expect(201);

      const { accessToken, tenantId: jwtTenantId } = registerRes.body;

      // Attempt to send a FAKE tenantId in request body
      const fakeTenantId = 'malicious-fake-tenant-id-12345';

      // Access a protected route with a body containing the fake tenantId
      const res = await request(app)
        .get('/protected/profile')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ tenantId: fakeTenantId })
        .expect(200);

      // The tenantId in the response MUST be from the JWT, NOT the body
      expect(res.body.tenantId).toBe(jwtTenantId);
      expect(res.body.tenantId).not.toBe(fakeTenantId);
    });
  });
});
