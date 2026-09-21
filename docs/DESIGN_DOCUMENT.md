# Chess Coach - Design Document

**Version:** 1.0  
**Last Updated:** September 2026  
**Project Name:** Chess Sensei

## Table of Contents
1. [Introduction](#introduction)
2. [System Architecture](#system-architecture)
3. [Key Design Decisions](#key-design-decisions)
4. [Component Design](#component-design)
5. [Data Flow](#data-flow)
6. [Security Design](#security-design)
7. [Performance Considerations](#performance-considerations)
8. [Error Handling](#error-handling)

---

## Introduction

### Vision
Create an AI chess coach that teaches through discovery rather than direct instruction, helping players internalize chess principles by guiding them to find their own mistakes.

### Core Design Philosophy

**1. Verification Over Generation**
- Never let AI hallucinate board positions
- All chess facts computed and verified by chess.js or Stockfish
- AI's role: explain verified facts, not calculate positions

**2. Socratic Teaching**
- Questions before answers
- Progressive hint escalation
- Player discovery prioritized
- Warm, encouraging tone

**3. Pattern Recognition**
- Mistakes grouped by underlying principle
- Recurring patterns highlighted
- Personalized learning path

**4. Progressive Disclosure**
- Simple onboarding (optional rating only)
- Features revealed as needed
- Complexity hidden until relevant

---

## System Architecture

### Architectural Style
**Monolithic backend with SPA frontend** - chosen for:
- Simplicity in initial deployment
- Single codebase for business logic
- Easier state management
- Fast iteration speed

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                     FRONTEND (React)                     │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │  Dashboard  │  │  GameReview  │  │   Coaching    │ │
│  └─────────────┘  └──────────────┘  └───────────────┘ │
│                                                          │
│  ┌─────────────────────────────────────────────────┐   │
│  │          Shared Context Providers                │   │
│  │  • AuthContext  • AnalysisContext                │   │
│  └─────────────────────────────────────────────────┘   │
└──────────────────────┬───────────────────────────────────┘
                       │ REST API (HTTPS)
┌──────────────────────▼───────────────────────────────────┐
│                   BACKEND (Express)                       │
│                                                           │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐            │
│  │  Routes  │  │ Business │  │ Middleware │            │
│  │  /games  │  │  Logic   │  │   (auth,   │            │
│  │  /coach  │  │          │  │   admin)   │            │
│  └──────────┘  └──────────┘  └────────────┘            │
│                                                           │
│  ┌─────────────────────────────────────────────────┐    │
│  │            Core Services                         │    │
│  │  • analysis.js    • coaching-prompt.js          │    │
│  │  • engine.js      • position-facts.js           │    │
│  │  • profile-service.js                           │    │
│  └─────────────────────────────────────────────────┘    │
└───────────┬────────────┬──────────────┬─────────────────┘
            │            │              │
    ┌───────▼──────┐ ┌──▼─────────┐ ┌─▼──────────────┐
    │  PostgreSQL  │ │ Stockfish  │ │  Claude API    │
    │   Database   │ │   Engine   │ │ (Anthropic)    │
    └──────────────┘ └────────────┘ └────────────────┘
```

### Component Boundaries

**Frontend Responsibilities:**
- User interaction and presentation
- Client-side chessboard rendering
- Local Stockfish for immediate visual feedback
- Routing and navigation
- Session state management

**Backend Responsibilities:**
- Game storage and retrieval
- Authoritative game analysis (server Stockfish)
- AI coaching orchestration
- User authentication
- Profile computation
- Pattern analysis

**Why This Split?**
- Server analysis is authoritative (client just for preview)
- Coaching requires API keys (must be server-side)
- Database operations centralized
- Client stays lightweight

---

## Key Design Decisions

### 1. Verified Facts Architecture

**Problem:** LLMs hallucinate chess positions (e.g., claiming a light-squared bishop can reach a dark square).

**Solution:**
- Build structured "verified facts" block for every position
- Include only chess.js-computed or Stockfish-verified information
- Enforce "concrete claims boundary": AI cannot describe positions >1 ply away without demonstration
- All demonstrations validated before sending to AI

**Trade-off:**
- ✅ Eliminates board hallucinations
- ✅ Coaching becomes trustworthy
- ❌ More complex prompt construction
- ❌ Larger prompts (facts block is verbose)

### 2. Single Stockfish Process with Queue

**Problem:** Multiple concurrent Stockfish processes consume excessive memory.

**Solution:**
- One long-lived Stockfish process
- Incoming requests queued
- Sequential evaluation
- In-process FEN cache for transpositions

**Trade-off:**
- ✅ Low memory footprint (~50MB)
- ✅ Free Railway tier compatible
- ✅ Simple process management
- ❌ Serial bottleneck (one evaluation at a time)
- ❌ Not suitable for high concurrency

**When to Reconsider:** If traffic exceeds ~10 concurrent users, move to worker pool.

### 3. Socratic Turn Limit

**Problem:** Infinite back-and-forth is expensive and can frustrate users.

**Solution:**
- Hard limit of 5 turns per mistake by default
- Automatic escalation to "give answer" at final turn
- Optional force-answer via give-up detection

**Trade-off:**
- ✅ Cost predictable
- ✅ Prevents frustration
- ✅ Ensures every session concludes with learning
- ❌ Some nuanced positions deserve more exploration

**Tuning:** Adjustable per user level in future (beginners: 4 turns, advanced: 7 turns).

### 4. Engine Consultation Budget

**Problem:** Allowing unlimited on-demand engine queries during coaching creates unbounded cost.

**Solution:**
- Three-tier system: LOW, MED, HIGH
- LOW: Only respond to direct tactical challenges
- MED: Also handle user proposals
- HIGH: Unrestricted (future: paid tier)
- One query per conversation regardless of level

**Trade-off:**
- ✅ Cost controlled
- ✅ Forces AI to use existing facts first
- ❌ Some legitimate student questions go unanswered
- ❌ Adds complexity to prompt logic

### 5. Client-Side Stockfish for Preview Only

**Problem:** Server analysis takes time (0.5s per position × 50 moves = 25s per game).

**Solution:**
- Client runs lightweight Stockfish for immediate visual feedback
- Server analysis remains authoritative
- Client displays "analyzing..." then updates when server completes

**Trade-off:**
- ✅ Feels instant to user
- ✅ No waiting on game upload
- ❌ Two Stockfish implementations to maintain
- ❌ Potential inconsistency if versions drift

**Mitigation:** Use same Stockfish major version on both sides.

### 6. PGN as Source of Truth

**Problem:** How to store games—FEN snapshots vs. reconstructible PGN?

**Solution:**
- Store only PGN in database
- Reconstruct positions on demand via chess.js
- Moves table stores derived FENs for query efficiency

**Trade-off:**
- ✅ Compact storage
- ✅ Human-readable format
- ✅ Easy export/import
- ❌ Reconstruction cost on every load (mitigated by caching in client)

### 7. PostgreSQL Over SQLite

**Initial implementation used SQLite (still visible in `/server/evals/`), but production uses PostgreSQL.**

**Why Switch?**
- Railway/Heroku require persistent storage
- SQLite doesn't survive container restarts
- PostgreSQL session store needed for distributed sessions
- Native JSON operators for profile data

**Migration:** One-time backfill script moved data from SQLite to PostgreSQL.

### 8. Principle-Based Pattern Matching

**Problem:** How to group mistakes into learnable patterns?

**Solution:**
- Curated list of 83 chess principles
- Each principle tagged with themes (e.g., "pin", "fork", "endgame")
- Heuristic matching algorithm:
  - Engine reason keywords
  - Theme overlap with position
  - Centipawn loss magnitude
  - Move classification
- Best match stored with each mistake

**Trade-off:**
- ✅ Human-curated principles = quality
- ✅ Enables pattern aggregation
- ❌ Not all mistakes map cleanly to a principle
- ❌ Matching heuristics need tuning

**Future:** Use embedding similarity for better matching.

---

## Component Design

### Backend Components

#### 1. `server.js` - Application Bootstrap
**Responsibilities:**
- Load environment variables
- Initialize Express app
- Configure middleware (CORS, sessions, auth)
- Mount route handlers
- Start server

**Dependencies:**
- `dotenv` for config
- `express-session` with PostgreSQL store
- `passport` for OAuth

#### 2. `db.js` - Database Abstraction
**Responsibilities:**
- Connection pool management
- Query helper functions
- Schema initialization (idempotent DDL)
- Transaction support
- Principle seed data

**Design Pattern:** Module singleton with exported functions.

**Key Functions:**
- `query(sql, params)` - Parameterized query
- `withTransaction(fn)` - Transaction wrapper
- `initDb()` - Schema setup

#### 3. `engine.js` - Stockfish Integration
**Responsibilities:**
- Manage long-lived Stockfish process
- UCI protocol communication
- Request queuing
- Position evaluation
- FEN-based caching
- PV (principal variation) extraction

**State Machine:**
```
init → idle ⇄ searching
         ↓
      (on crash)
         ↓
     (5s delay)
         ↓
       init
```

**Key Functions:**
- `evaluateFen(fen)` → `{ok, evalCp, bestMove, pvUci, mateIn}`
- `getEnginePv(fen)` → SAN move array (up to 4 plies)
- `isEngineAvailable()` → boolean

**Configuration:**
- `ENGINE_DEPTH = 12`
- `ENGINE_MOVETIME_MS = 500`
- `ENGINE_TIMEOUT_MS = 8000`
- `ENGINE_HASH_MB = 32`

#### 4. `analysis.js` - Game Analysis
**Responsibilities:**
- Parse PGN into positions
- Evaluate all positions with Stockfish (sequential)
- Classify moves by centipawn loss
- Filter to user's color
- Store results in moves table

**Algorithm:**
```javascript
1. Load game PGN from database
2. Check if already analyzed (idempotent)
3. Parse PGN → positions array + moves array
4. For each position:
   - Evaluate with Stockfish
   - Normalize to white-POV centipawns
5. For each move:
   - Compute rawLoss = evalBefore - evalAfter
   - Classify: good / inaccuracy / mistake / blunder
6. Filter to user's color moves only
7. Insert into moves table
```

**Performance:** ~0.5s per position → ~25s for 50-move game.

#### 5. `coaching-prompt.js` - Prompt Construction
**Responsibilities:**
- Build verified facts block
- Format response requirements
- Construct Socratic escalation instructions
- Handle degraded mode (when facts unavailable)

**Key Functions:**
- `buildVerifiedFactsPrompt({facts, profile, ...})` → full system prompt string
- `buildDegradedPrompt({...})` → conceptual-only fallback
- `formatProfileForPrompt(profile)` → player level section
- `buildResponseFormatSection(...)` → JSON schema + demo rules

**Verified Facts Structure:**
```
- Side to move
- Piece positions (ASCII board)
- Legal moves
- Move under review
- Engine evals (before/after)
- Centipawn swing
- Best move
- Principal variation
- Principle violated
- Student's stated intent (optional)
- Prior demonstrations (optional)
```

#### 6. `position-facts.js` - Facts Builder
**Responsibilities:**
- Reconstruct position before played move
- Extract chess.js facts (legal moves, piece map, side to move)
- Validate played move legality
- Describe move effects (capture, check, castle, etc.)
- Fetch engine data
- Format engine reason for human readability

**Key Function:**
```javascript
buildPositionFacts({pgn, moveIndex, engineData, playedMove})
  → {
      sideToMove, pieceMap, legalMoves,
      playedMoveSan, playedMoveValid, playedMoveDetails,
      engine: {evalBefore, evalAfter, centipawnSwing, bestMove, engineReason}
    }
```

**Error Handling:** Returns `null` if position cannot be reconstructed (triggers degraded mode).

#### 7. `profile-service.js` - Profile Computation
**Responsibilities:**
- Aggregate move statistics
- Compute player level (beginner/intermediate/advanced)
- Calculate average centipawn loss
- Calculate blunder rate
- Identify top violated principles
- (Future: Generate conceptual profile with AI)

**Level Determination Logic:**
```javascript
if (avgCpLoss > 100) return 'beginner';
if (avgCpLoss > 50)  return 'intermediate';
return 'advanced';
```

**Profile Update Trigger:** After each game analysis completes.

#### 8. `principle-candidates.js` - Pattern Matching
**Responsibilities:**
- Match mistake to best principle
- Use theme overlap + keyword matching
- Score candidates
- Return top match with confidence

**Matching Heuristics:**
- Engine reason contains principle keywords
- Principle themes overlap with position themes
- Classification severity matches principle difficulty

#### 9. Route Handlers (`/routes`)

**`auth.js`** - Authentication
- `GET /google` - OAuth initiate
- `GET /google/callback` - OAuth return
- `GET /me` - Session check
- `POST /logout` - Session destroy

**`games.js`** - Game Management
- `GET /` - List games
- `POST /` - Upload PGN
- `GET /:id` - Game details
- `POST /:id/moves` - Store analysis
- `GET /:id/moves` - Retrieve moves
- `POST /chesscom` - Bulk Chess.com import

**`coach.js`** - Coaching Conversations
- `POST /start` - Begin conversation
- `POST /:id/message` - User message
- `GET /:id` - Conversation history
- `POST /:id/evaluate` - Engine tool invocation

**`profile.js`** - User Profile
- `GET /` - Fetch profile
- `POST /` - Update profile
- `GET /stats` - Aggregated stats

**`principles.js`** - Principles (public)
- `GET /` - List all principles

**`admin.js`** - Admin Panel
- `GET /users` - User list
- `POST /users/:id/role` - Role change
- `GET /health` - System health

#### 10. Middleware

**`auth.js`** - `isAuthenticated`
- Check `req.isAuthenticated()` from Passport
- Return 401 if not logged in

**`admin.js`** - `isAdmin`
- Check `req.user.role === 'admin'`
- Return 403 if not admin

---

### Frontend Components

#### 1. `App.jsx` - Application Root
**Responsibilities:**
- Route definition
- Context provider wrapping
- Shell layout (header, navigation)
- Authentication gating

**Structure:**
```jsx
<BrowserRouter>
  <AuthProvider>
    <AnalysisProvider>
      <Shell>
        <RequireAuth>
          <OnboardingGate>
            <Routes>
              {/* All routes */}
            </Routes>
          </OnboardingGate>
        </RequireAuth>
      </Shell>
    </AnalysisProvider>
  </AuthProvider>
</BrowserRouter>
```

#### 2. `AuthContext.jsx` - Authentication State
**Responsibilities:**
- Call `/api/auth/me` on mount
- Store user object in context
- Provide `login`, `logout` functions
- Expose `loading` state

**Usage:** Any component can `const {user, logout} = useAuth()`.

#### 3. `AnalysisContext.jsx` - Analysis State
**Responsibilities:**
- Store currently analyzed game
- Share analysis results across pages
- Avoid redundant API calls

#### 4. `Dashboard.jsx` - Game List
**Responsibilities:**
- Fetch user's games via `/api/games`
- Display game cards with metadata
- Show mistake count per game
- Trigger Chess.com import
- Navigate to game review

**UI Elements:**
- Game card: opponent, result, date, mistake count
- "Import from Chess.com" button
- Create game button (manual PGN)

#### 5. `GameReview.jsx` - Move-by-Move View
**Responsibilities:**
- Fetch game via `/api/games/:id`
- Fetch moves via `/api/games/:id/moves`
- Render chessboard with current position
- Display move list with quality indicators
- Navigate between moves
- Link mistakes to coaching

**State:**
- `currentMoveIndex` - Position in game
- `game` - Game object
- `moves` - Analyzed moves array

**Chessboard Library:** `react-chessboard`

#### 6. `Coaching.jsx` - Conversation UI
**Responsibilities:**
- Start conversation via `/api/coach/start`
- Display message history
- Handle user input
- Send messages via `/api/coach/:id/message`
- Render board demonstrations
- Show engine tool results

**Message Types:**
- User text message
- User line submission (move sequence)
- Assistant response with optional demos
- Engine evaluation results

**Demo Playback:**
- Animated or step-through
- Shows resulting position
- Labels origin ("original" vs "userLine")

#### 7. `PatternAnalysis.jsx` - Aggregated Patterns
**Responsibilities:**
- Fetch profile stats via `/api/profile/stats`
- Group mistakes by principle
- Display frequency chart
- Link to representative positions

#### 8. `Progression.jsx` - Progress Charts
**Responsibilities:**
- Display game count
- Show win/loss record
- Plot mistake trends over time
- (Future: ELO progression)

#### 9. `Onboarding.jsx` - Initial Setup
**Responsibilities:**
- Prompt for chess rating
- Submit to `/api/profile`
- Set `localStorage` flag
- Redirect to dashboard

#### 10. `Admin.jsx` - Admin Panel
**Responsibilities:**
- List all users via `/api/admin/users`
- Promote/demote admin roles
- Display system health
- Monitor cache size

---

## Data Flow

### Game Import & Analysis Flow

```
User uploads PGN
    ↓
Frontend → POST /api/games {pgn}
    ↓
Server validates PGN format
    ↓
Server stores game in DB
    ↓
Server calls analyzeGame(gameId)
    ↓
    For each position:
        Stockfish evaluates FEN
        Cache result
    ↓
    For each move:
        Classify by centipawn loss
        Match to principle
        Store in moves table
    ↓
Server updates player profile
    ↓
Server returns game ID
    ↓
Frontend redirects to /game/:id
```

### Coaching Conversation Flow

```
User clicks mistake → Navigate to /game/:id/move/:moveId
    ↓
Frontend → POST /api/coach/start {moveId}
    ↓
Server creates conversation record
    ↓
Server fetches move + game data
    ↓
Server builds verified facts block
    ↓
Server constructs Socratic prompt
    ↓
Server → Claude API (streaming or single response)
    ↓
Claude generates JSON {text, demonstrations}
    ↓
Server validates demonstrations (chess.js)
    ↓
Server stores message + demos
    ↓
Server returns to frontend
    ↓
Frontend renders message + plays demos on board
    ↓
User types response
    ↓
Frontend → POST /api/coach/:id/message {content, lineSubmission?}
    ↓
Server appends user message
    ↓
Server increments turn counter
    ↓
Server checks bailout triggers (forceAnswer, finalTurn)
    ↓
Server updates facts block (includes prior demos if any)
    ↓
Server → Claude API
    ↓
... (loop until conversation ends)
```

### Engine Tool Flow (During Coaching)

```
Claude decides to call evaluate_alternative_move tool
    ↓
Server receives function call request
    ↓
Server validates:
    - Situation matches engine level
    - Budget not exceeded
    - Moves are <= 2 plies
    ↓
Server reconstructs position
    ↓
Server applies moves via chess.js
    ↓
Server checks legality
    ↓
Server → Stockfish evaluates final FEN
    ↓
Server returns {legal, evalCp, note}
    ↓
Claude incorporates result into coaching response
```

---

## Security Design

### Authentication & Authorization

**OAuth 2.0 with Google**
- Server-side flow only (no client-side tokens)
- Session-based authentication (not JWT)
- Session stored in PostgreSQL (persistent across restarts)
- `httpOnly` cookies (no JS access)
- `sameSite: 'lax'` (CSRF protection)
- `secure: true` in production (HTTPS-only)

**Role-Based Access Control**
- Two roles: `user`, `admin`
- Admin seeded via `ADMIN_EMAIL` environment variable
- Admin can grant/revoke admin to others
- Middleware checks role before admin routes

### Data Access Control

**Row-Level Security (Application Layer):**
- All game/move queries filtered by `user_id`
- User can only see their own games
- Profile queries scoped to authenticated user

**No Direct DB Exposure:**
- API is sole interface to data
- PostgreSQL not publicly accessible
- Credentials in environment variables only

### Secrets Management

**Environment Variables:**
- Never committed to Git (`.env` in `.gitignore`)
- Deployed via Railway/Vercel environment config
- Rotation: Manual (should move to Vault)

**API Keys:**
- Anthropic API key server-side only
- Rate limiting via Anthropic's native throttling

### Input Validation

**PGN Uploads:**
- Validated by chess.js parser (rejects malformed PGN)
- No SQL injection (parameterized queries only)
- Length limit: 50KB per PGN

**Move Submissions:**
- All moves validated by chess.js before storage
- Illegal moves rejected
- SAN notation only (no eval injection)

**SQL Injection Prevention:**
- All queries use parameterized placeholders (`$1`, `$2`, ...)
- No string concatenation in SQL

---

## Performance Considerations

### Bottlenecks & Mitigations

#### 1. Stockfish Evaluation Speed
**Problem:** 0.5s per position × 50 positions = 25s per game

**Mitigations:**
- Depth limited to 12 (shallow but fast)
- Movetime capped at 500ms
- Client-side preview (instant feedback)
- Background analysis (async, non-blocking)

**Future:** 
- Batch evaluation of multiple positions (if Stockfish API allows)
- GPU-accelerated neural network engine (Lc0)

#### 2. Claude API Latency
**Problem:** 2-5s per coaching response

**Mitigations:**
- Streaming responses (future)
- Client shows "thinking..." indicator
- Keep prompts concise (<4000 tokens)

**Future:**
- Cache common responses for identical positions
- Prefetch next likely question

#### 3. Database Query Performance
**Current State:** No indexes beyond primary keys

**Future Indexes Needed:**
- `moves(game_id, classification)` - Filter mistakes
- `games(user_id, played_at)` - Recent games
- `conversations(user_id, created_at)` - Conversation history
- `principle_themes(theme)` - Pattern lookup

#### 4. Profile Computation
**Current:** Recompute entire profile on every game add

**Optimization:** Incremental update:
```javascript
newAvgCpLoss = (oldAvg * oldCount + newGameCpLoss) / (oldCount + 1)
```

#### 5. Memory Usage
**Current Footprint:**
- Node process: ~100MB
- Stockfish: ~50MB
- PostgreSQL: ~100MB (Railway free tier)

**Limits:** Free tier = 512MB RAM total (comfortable)

**If Scaling:**
- Move Stockfish to separate container
- Use Redis for eval cache (shared across instances)

---

## Error Handling

### Client-Side

**Network Errors:**
```javascript
try {
  const response = await api.get('/games');
  setGames(response.data);
} catch (error) {
  if (error.response?.status === 401) {
    // Redirect to login
  } else {
    setError('Failed to load games. Please try again.');
  }
}
```

**Invalid PGN:**
- Display validation error inline
- Highlight problematic lines
- Suggest correction

**Session Expiration:**
- `/api/auth/me` check on app load
- Redirect to login if session expired
- Preserve current URL for post-login redirect

### Server-Side

**Stockfish Crashes:**
- Process exit handler restarts engine after 5s backoff
- In-flight requests rejected with error
- Queue drained with failure responses

**Claude API Failures:**
- Retry with exponential backoff (3 attempts)
- If still fails, return graceful message: "Coaching unavailable, please try again"
- Log error for investigation

**Database Connection Loss:**
- Connection pool auto-reconnects
- Query timeout: 30s
- Transaction rollback on error

**PGN Parse Failures:**
- Return 400 with specific error message
- Log malformed PGN for investigation
- Do not store invalid game

**Move Validation Failures:**
- Return 400 with "Move X is illegal in this position"
- Do not create conversation

### Degraded Mode

**When Position Facts Cannot Be Built:**
- Trigger degraded prompt (conceptual only)
- Display warning to user: "Limited coaching available for this position"
- Still deliver value (principle-based teaching)

**When Engine Unavailable:**
- Queue requests until engine returns
- If timeout, return cached analysis only
- Display "Engine offline" in admin panel

---

## Monitoring & Observability

### Current Logging

**Console Logging:**
- Engine startup/shutdown events
- Query errors (SQL)
- Authentication events (login, logout)
- Game analysis completion

**Log Levels:** Info, Warn, Error (no structured logging yet)

### Future Enhancements

**Structured Logging:**
- Use `winston` or `pino`
- Include request ID, user ID, timestamp
- Ship to centralized logging (e.g., Datadog, Logtail)

**Metrics:**
- Request latency per endpoint
- Stockfish evaluation time distribution
- Claude API success rate
- Active conversations count

**Alerts:**
- Engine down for >5 minutes
- Database connection pool exhausted
- API error rate >5%

---

## Deployment Architecture

### Hosting

**Current:**
- **Frontend**: Vercel (static SPA)
- **Backend**: Railway (Docker container)
- **Database**: Railway PostgreSQL add-on

**Why Railway?**
- Free tier includes PostgreSQL
- One-command deploy (`railway up`)
- Automatic HTTPS
- Environment variable management

### Build Process

**Frontend:**
```bash
npm run build   # Vite → dist/
```
Output: Static HTML, CSS, JS → Vercel

**Backend:**
```bash
# Railway uses Dockerfile
FROM node:18
COPY package*.json ./
RUN npm ci --production
COPY . .
CMD ["node", "server.js"]
```

### Environment Configuration

**Development:**
- `.env` file (local)
- `CLIENT_URL=http://localhost:5173`
- `SERVER_URL=http://localhost:3001`

**Production:**
- Railway environment variables
- `CLIENT_URL=https://chess-coach.vercel.app`
- `SERVER_URL=https://chess-coach.up.railway.app`
- `NODE_ENV=production`

### Database Migration Strategy

**Current:** Idempotent DDL in `db.js/initDb()`
- `CREATE TABLE IF NOT EXISTS`
- `ALTER TABLE ADD COLUMN IF NOT EXISTS` (PostgreSQL 9.6+)

**Trade-off:**
- ✅ Simple (no migration tool)
- ✅ Safe (can rerun)
- ❌ No version tracking
- ❌ No rollback

**Future:** Migrate to `node-pg-migrate` or `knex` for version-controlled migrations.

---

## Testing Strategy

### Current State
**No automated tests yet** (technical debt).

### Recommended Test Coverage

**Unit Tests (Jest):**
- `parsePgn()` - PGN parsing edge cases
- `classifyLoss()` - Classification thresholds
- `buildVerifiedFactsPrompt()` - Prompt construction
- `uciToSan()` - Move notation conversion

**Integration Tests:**
- Game upload → analysis → retrieve moves
- Coaching conversation full flow
- Profile computation after game addition

**End-to-End Tests (Playwright):**
- User login → upload game → view analysis → start coaching
- Admin panel access control

**Regression Tests:**
- Known failing PGNs (from bug reports)
- Coaching hallucination cases (verified facts enforcement)

---

## Known Issues & Technical Debt

### Current Bugs
- See `/docs/bugs/coach-line-legality-dispute.txt`

### Technical Debt

**High Priority:**
1. Add automated tests (especially position-facts logic)
2. Implement database indexes for query performance
3. Add rate limiting on coaching endpoints (prevent abuse)
4. Structured logging with request tracing

**Medium Priority:**
5. Replace idempotent DDL with proper migrations
6. Add Stockfish health check endpoint
7. Implement Claude response streaming (UX improvement)
8. Add Redis for eval cache (enable horizontal scaling)

**Low Priority:**
9. Separate Stockfish into microservice
10. Add Prometheus metrics
11. Implement GraphQL API (reduce over-fetching)

---

## Future Architecture Considerations

### When to Scale Out

**Triggers:**
- Concurrent users exceed 20
- Stockfish queue depth regularly >5
- Average response time >10s
- Database connection pool saturated

**Scaling Path:**
1. **Vertical:** Increase Railway plan (more RAM/CPU)
2. **Horizontal:** Multiple backend instances + load balancer
3. **Service Split:** Extract Stockfish into dedicated worker pool
4. **Caching:** Add Redis for eval cache + session store
5. **CDN:** Move frontend to CDN (already on Vercel)

### Microservice Candidates

If splitting monolith:
1. **Analysis Service** - Game analysis only (Stockfish)
2. **Coaching Service** - AI conversation logic (Claude API)
3. **Profile Service** - Aggregations and stats
4. **Gateway** - API composition layer

**Don't split yet:** Current monolith is maintainable at current scale.

---

## Appendix: Design Patterns Used

### Backend Patterns

**1. Repository Pattern** (`db.js`)
- Abstracts database access
- Single source for SQL queries

**2. Service Layer** (`analysis.js`, `profile-service.js`)
- Business logic separate from routes
- Reusable functions

**3. Middleware Chain** (Express)
- `isAuthenticated` → `isAdmin` → route handler
- Separation of concerns

**4. Singleton** (`engine.js`)
- One Stockfish process shared globally

**5. Queue** (engine request queue)
- FIFO processing of eval requests

**6. Strategy Pattern** (coaching escalation)
- Different rung strategies (open question → answer)

### Frontend Patterns

**1. Context API** (React)
- Global state without prop drilling
- `AuthContext`, `AnalysisContext`

**2. Custom Hooks**
- `useAuth()`, `useAnalysis()`

**3. Higher-Order Component** (`RequireAuth`, `OnboardingGate`)
- Wrapper components for access control

**4. Presentational/Container Split**
- Container: `Dashboard.jsx` (data fetching)
- Presentational: Game card (pure rendering)

---

**Document Status:** Living document, updated as architecture evolves.
