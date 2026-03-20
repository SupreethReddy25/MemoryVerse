# MemoryVerse — Agent Context File
# READ THIS BEFORE WRITING ANY CODE IN THIS PROJECT.
# This file is the source of truth for all architectural decisions.

---

## PROJECT OVERVIEW

**Name:** MemoryVerse Contextual AI Keyboard
**What it does:** A privacy-first Android keyboard that reads incoming messages and suggests replies generated from the user's personal data corpus (WhatsApp exports, PDFs, university schedules) using a local RAG pipeline.
**Core constraint:** Reply suggestion chip must appear in < 300ms from when the user opens the reply field.

---

## MONOREPO STRUCTURE

```
memoryverse/
├── backend-node/          # Express API gateway (auth, routing, SSE relay)
├── backend-python/        # FastAPI ML service (embeddings, RAG, ingestion)
├── frontend/              # React web dashboard (Vite)
├── android/               # Kotlin Android keyboard app
├── CONTEXT.md             # THIS FILE — always read first
└── docker-compose.yml     # Local dev orchestration
```

---

## SERVICE RESPONSIBILITIES — NEVER MIX THESE

| Service | Owns | Does NOT own |
|---|---|---|
| backend-node | Auth, JWT, routing, SSE relay, audit logs | Embeddings, vector search, LLM calls |
| backend-python | Embeddings, RAG pipeline, ingestion, ONNX model serving | Auth, user management, dashboard API |
| frontend | Dashboard UI, file upload, query playground | Any ML logic |
| android | Keyboard UI, on-device intent classification, suggestion chip | Any backend auth logic beyond token storage |

---

## TECH STACK — LOCKED, DO NOT SUBSTITUTE

| Component | Technology | Version / Notes |
|---|---|---|
| API Gateway | Node.js + Express | v20 LTS |
| ML Service | Python + FastAPI | Python 3.11 |
| Web Dashboard | React + Vite | No Next.js — plain Vite |
| Android Keyboard | Kotlin + InputMethodService | minSdk 26, targetSdk 34 |
| Primary DB | MongoDB | Via Mongoose ODM |
| Vector DB | Pinecone | Use namespace isolation — see Security section |
| Cache | Redis | Upstash REST API for cloud, local Redis for dev |
| Embeddings | sentence-transformers all-MiniLM-L6-v2 | 384 dimensions |
| LLM | Google Gemini API | gemini-2.0-flash for speed, streaming mode |
| On-device ML | ONNX Runtime for Android | INT8 quantized MiniLM model |
| Streaming | Server-Sent Events (SSE) | NOT WebSockets |
| Auth | JWT | Access token (15min) + refresh token (7d) |

---

## DATABASE SCHEMA

### MongoDB Collections (backend-node)

```javascript
// users collection
{
  _id: ObjectId,
  email: String,          // unique, indexed
  passwordHash: String,   // bcrypt, 12 rounds
  tenantId: String,       // UUID v4, generated at registration, NEVER changes
  createdAt: Date,
  refreshTokenHash: String // hashed refresh token for rotation
}

// documents collection
{
  _id: ObjectId,
  tenantId: String,       // indexed — foreign key to users.tenantId
  originalFilename: String,
  fileType: "whatsapp" | "pdf" | "calendar",
  chunkCount: Number,
  status: "processing" | "ready" | "error",
  createdAt: Date,
  updatedAt: Date,
  pineconeNamespace: String  // always = `user_${tenantId}` — derived, stored for clarity
}

// audit_logs collection
{
  _id: ObjectId,
  tenantId: String,
  eventType: "rag_query" | "cache_hit" | "gps_query" | "upload" | "delete",
  queryHash: String,      // SHA256 of query text — never store raw queries
  responseTimeMs: Number,
  createdAt: Date
}
```

### Pinecone Namespace Convention
```
namespace = `user_${tenantId}`
```
CRITICAL: Every Pinecone query MUST include the namespace derived from the verified JWT tenantId.
NEVER use a default namespace. NEVER accept namespace from client request body.

### Redis Key Convention
```
cache:{tenantId}:{queryClusterHash}   TTL: 3600s
```
queryClusterHash = SHA256 of (sorted top-5 doc IDs + query embedding centroid bucket)

---

## API CONTRACTS

### backend-node base URL: http://localhost:3001

```
POST   /auth/register          Body: { email, password }
POST   /auth/login             Body: { email, password }
POST   /auth/refresh           Body: { refreshToken }
DELETE /auth/logout            Header: Authorization: Bearer <token>

POST   /documents/upload       Header: Bearer | Body: multipart form-data (file)
GET    /documents              Header: Bearer | Returns: array of document objects
DELETE /documents/:id          Header: Bearer | Cascades delete to Pinecone namespace entries

POST   /query/suggest          Header: Bearer | Body: { text: string, intentHint?: string }
                               Returns: SSE stream of tokens

GET    /analytics/summary      Header: Bearer | Returns: { cacheHitRate, avgLatencyMs, queryCount }
```

### backend-python base URL: http://localhost:8000
(Called internally by backend-node ONLY — never directly from frontend or Android)

```
POST   /embed                  Body: { text: string } → { vector: float[] }
POST   /ingest                 Body: { tenantId, documentId, chunks: string[] } → { status }
POST   /rag                    Body: { tenantId, queryVector: float[], topK: int } → SSE stream
DELETE /namespace              Body: { tenantId } → { deleted: int }
```

---

## SECURITY RULES — ENFORCE ON EVERY ENDPOINT

### JWT Payload Structure
```json
{
  "sub": "<userId>",
  "tenantId": "<uuid>",
  "iat": 1234567890,
  "exp": 1234568790
}
```

### Tenant Middleware (backend-node) — Apply to ALL protected routes
```javascript
// Every request touching DB or Python service must pass through this
const tenantMiddleware = (req, res, next) => {
  const decoded = verifyJWT(req.headers.authorization);
  req.tenantId = decoded.tenantId;  // from signed token only
  req.userId = decoded.sub;
  next();
};

// Then in every DB query:
// ALWAYS filter: { tenantId: req.tenantId }
// NEVER trust tenantId from req.body or req.params
```

### Pinecone — Always namespace-scoped
```javascript
// CORRECT
await pinecone.index('memoryverse').namespace(`user_${req.tenantId}`).query(...)

// WRONG — never do this
await pinecone.index('memoryverse').query({ filter: { tenantId: req.tenantId }, ... })
```

---

## ANDROID ARCHITECTURE

### Package Structure
```
com.memoryverse.keyboard/
├── MemoryVerseIME.kt          # InputMethodService — entry point
├── ui/
│   └── SuggestionChipView.kt  # Custom view rendered above keyboard
├── ml/
│   └── IntentClassifier.kt    # ONNX Runtime inference
├── network/
│   ├── ApiClient.kt           # Retrofit client
│   └── SseListener.kt         # SSE token stream handler
├── data/
│   └── TokenStore.kt          # EncryptedSharedPreferences for JWT
└── utils/
    └── ContextExtractor.kt    # Reads incoming message text
```

### Intent Classes (on-device classifier output)
```
GPS_QUERY      → resolve locally with LocationManager, no API call
SCHEDULE_QUERY → resolve locally from ContentProvider calendar, no API call
RAG_QUERY      → fire API call to /query/suggest
GENERAL_LLM    → fire API call to /query/suggest (same endpoint, no RAG context)
CHITCHAT       → do not show suggestion chip
```

### Speculative Pre-fetch Logic
```kotlin
// Trigger pre-fetch when incoming message text length > 40 characters
// AND user has not yet tapped the reply field
// Fire in a background coroutine, cache result locally on device
// When user taps reply field, chip should already be populated
```

---

## CHUNKING STRATEGY (backend-python)

```python
# WhatsApp parser — strip these patterns before chunking:
# - Timestamps: \[\d{1,2}/\d{1,2}/\d{2,4}, \d{1,2}:\d{2}.*?\]
# - System messages: "Messages and calls are end-to-end encrypted"
# - Media omissions: "<Media omitted>"
# - Sender prefix: "Author Name: "

# Chunk config:
CHUNK_SIZE = 400        # tokens
CHUNK_OVERLAP = 80      # tokens
MIN_CHUNK_SIZE = 50     # discard chunks below this

# PDF parser:
# Use PyMuPDF (fitz) — NOT pdfplumber (too slow for large files)
# Extract text page by page, then apply same chunking
```

---

## ENVIRONMENT VARIABLES

### backend-node (.env)
```
PORT=3001
MONGODB_URI=mongodb://localhost:27017/memoryverse
JWT_SECRET=<32-byte-random-hex>
JWT_REFRESH_SECRET=<different-32-byte-random-hex>
PYTHON_SERVICE_URL=http://localhost:8000
REDIS_URL=redis://localhost:6379
```

### backend-python (.env)
```
PORT=8000
PINECONE_API_KEY=<key>
PINECONE_INDEX_NAME=memoryverse
GEMINI_API_KEY=<key>
REDIS_URL=redis://localhost:6379
EMBEDDING_MODEL=all-MiniLM-L6-v2
```

### frontend (.env)
```
VITE_API_URL=http://localhost:3001
```

---

## CRITICAL RULES FOR THE AGENT

1. **Read this file at the start of every session.** Do not rely on memory from previous sessions.
2. **Never add a new dependency** without a clear reason. Every added package = maintenance cost.
3. **Never store raw query text** in logs or cache. Always SHA256 hash it first.
4. **Never accept tenantId from request body.** Always derive it from the verified JWT.
5. **Never use a shared/default Pinecone namespace.** Always use `user_${tenantId}`.
6. **Never mix MongoDB queries** across tenants. Every query must include `{ tenantId: req.tenantId }`.
7. **Streaming first, not polling.** All LLM responses use SSE. Never buffer the full response.
8. **Test file must accompany every module.** Name convention: `module.test.ts` / `test_module.py`.
9. **TypeScript for backend-node.** Use strict mode. No `any` types.
10. **Error responses** must always return `{ error: string, code: string }` — never raw error objects.
