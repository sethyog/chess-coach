# Chess Coach - Functional Specification

**Version:** 1.0  
**Last Updated:** September 2026  
**Project Name:** Chess Sensei

## Table of Contents
1. [Overview](#overview)
2. [System Architecture](#system-architecture)
3. [Core Features](#core-features)
4. [User Flows](#user-flows)
5. [Data Models](#data-models)
6. [API Endpoints](#api-endpoints)
7. [Chess Engine Integration](#chess-engine-integration)
8. [AI Coaching System](#ai-coaching-system)

---

## Overview

### Purpose
Chess Sensei is an AI-powered chess coaching platform that provides Socratic-style coaching to help players improve their game through pattern recognition, move analysis, and personalized feedback.

### Key Capabilities
- **Automated Game Analysis**: Import games from Chess.com or manual PGN input
- **Socratic Coaching**: AI-powered conversational coaching that guides players to discover their mistakes
- **Pattern Recognition**: Identifies recurring mistakes and violated chess principles
- **Progress Tracking**: Monitors improvement over time with detailed statistics
- **Multi-level Learning**: Adapts coaching style to beginner, intermediate, and advanced levels

### Tech Stack
- **Frontend**: React 19, Vite, React Router, react-chessboard
- **Backend**: Node.js, Express 5
- **Database**: PostgreSQL
- **Chess Engine**: Stockfish 18
- **AI**: Anthropic Claude (via API)
- **Authentication**: Google OAuth 2.0

---

## System Architecture

### High-Level Components

```
┌─────────────────┐
│   React Client  │ ← User Interface
└────────┬────────┘
         │ HTTPS/REST
┌────────▼────────┐
│  Express Server │ ← Business Logic
└────┬────────┬───┘
     │        │
     │        └──────────┐
     │                   │
┌────▼────────┐   ┌─────▼──────┐   ┌──────────────┐
│ PostgreSQL  │   │ Stockfish  │   │ Claude API   │
│  Database   │   │   Engine   │   │  (Coaching)  │
└─────────────┘   └────────────┘   └──────────────┘
```

### Technology Layers

**Presentation Layer** (Client)
- React components for UI
- Chessboard visualization
- Real-time coaching interface
- Dashboard and analytics views

**Application Layer** (Server)
- RESTful API endpoints
- Session management
- Authentication middleware
- Request validation

**Business Logic Layer**
- Game analysis algorithms
- Move classification (blunder, mistake, inaccuracy, good)
- Pattern matching engine
- Profile computation
- Coaching prompt construction

**Data Layer**
- PostgreSQL for persistent storage
- In-process caching for engine evaluations
- Session storage

**External Services**
- Stockfish: Position evaluation and best move calculation
- Claude API: Natural language coaching responses
- Google OAuth: User authentication

---

## Core Features

### 1. User Authentication
- Google OAuth 2.0 integration
- Session-based authentication with PostgreSQL storage
- Role-based access (user, admin)
- Automatic profile creation on first login

### 2. Game Import & Analysis

#### Chess.com Import
- Fetch games via Chess.com public API
- Automatic deduplication using external game IDs
- Batch import support

#### Manual PGN Upload
- Standard PGN format support
- Validation and parsing
- Error handling for malformed PGN

#### Automated Analysis
- Sequential Stockfish evaluation of every position
- Move classification:
  - **Good**: Loss < 50 centipawns
  - **Inaccuracy**: Loss 50-99 centipawns
  - **Mistake**: Loss 100-199 centipawns
  - **Blunder**: Loss ≥ 200 centipawns
- Best move identification
- Position evaluation storage

### 3. Socratic Coaching System

#### Coaching Conversation
- Turn-based dialogue system (default: 5 exchanges max)
- Four-rung escalation ladder:
  - **Rung 1**: Open question ("What were you trying to do?")
  - **Rung 2**: Pointed hint (directs attention without giving answer)
  - **Rung 3**: Strong hint (names the weakness, asks final step)
  - **Rung 4**: Direct answer + underlying principle

#### Verified Facts Architecture
- Chess.js validation of all board states
- No hallucination: AI cannot invent board positions
- Concrete claims limited to verified positions only
- Demonstration system for multi-move sequences

#### Line Exploration
- Students can submit alternative move sequences
- Engine evaluates proposed lines
- AI compares student's reasoning with engine reality

#### Engine Consultation Budget
- Three-tier system: LOW, MED, HIGH
- Limits on-demand engine queries during coaching
- Prevents excessive API costs

### 4. Pattern Analysis

#### Principle Violation Detection
- 83 chess principles across beginner, intermediate, and advanced levels
- Categories: opening, middlegame, endgame, tactics, king safety, pawn structure
- Automatic principle matching to mistakes
- Theme-based clustering (e.g., "kingsideAttack", "pin", "hangingPiece")

#### Pattern Recognition
- Identifies recurring mistake patterns
- Groups similar violations
- Tracks frequency over time

### 5. Player Profile System

#### Computed Metrics
- Player level: beginner, intermediate, advanced
- Average centipawn loss per game
- Blunder rate (blunders per game)
- Most violated principles

#### Conceptual Profile
- Natural language summary of playing style
- Common strengths and weaknesses
- AI-generated based on game history

#### Onboarding
- Self-reported rating collection
- Initial profile setup
- Skippable for quick start

### 6. Progress Tracking

#### Statistics Dashboard
- Games played count
- Win/loss/draw record
- Improvement trends over time
- Mistake distribution charts

#### Game History
- Chronological game list
- Quick access to reviews
- Filtering and search (planned)

### 7. Admin Panel

#### User Management
- View all users
- Grant/revoke admin privileges
- User activity monitoring

#### System Health
- Engine status monitoring
- Cache statistics
- Database metrics

---

## User Flows

### Primary Flow: Reviewing a Mistake

1. **User logs in** via Google OAuth
2. **Imports games** from Chess.com or uploads PGN
3. **Server analyzes** each game automatically:
   - Evaluates all positions with Stockfish
   - Classifies each move
   - Identifies mistakes/blunders
4. **User views dashboard** showing all games with mistake counts
5. **User selects a game** to review
6. **Game review page displays**:
   - Interactive chessboard
   - Move list with quality indicators
   - Highlighted mistakes
7. **User clicks on a mistake** to start coaching
8. **Coaching conversation begins**:
   - AI asks Socratic question (Rung 1)
   - User responds with their reasoning
   - AI escalates through rungs based on response quality
   - Board demonstrations show key variations
   - Conversation concludes with principle explanation (Rung 4)
9. **User can explore alternative lines**:
   - Submit move sequences
   - Engine evaluates proposed alternatives
   - AI explains why the alternative succeeds or fails
10. **User returns to game review** to examine next mistake

### Secondary Flow: Pattern Analysis

1. User navigates to **Pattern Analysis** page
2. System aggregates all mistakes by principle
3. Display shows:
   - Most frequently violated principles
   - Example positions for each pattern
   - Trend over recent games
4. User can drill into specific principle to see all instances
5. User can start coaching session on representative mistake

### Onboarding Flow

1. New user logs in for first time
2. System creates user account and default profile
3. User redirected to **Onboarding** page
4. User enters approximate chess rating
5. System calibrates initial difficulty level
6. User redirected to dashboard

---

## Data Models

### Users
```sql
users (
  id SERIAL PRIMARY KEY,
  google_id TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  role TEXT DEFAULT 'user',  -- 'user' | 'admin'
  created_at TIMESTAMPTZ DEFAULT NOW()
)
```

### Games
```sql
games (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  pgn TEXT NOT NULL,
  opponent TEXT,
  result TEXT,  -- '1-0' | '0-1' | '1/2-1/2'
  user_color TEXT,  -- 'white' | 'black'
  time_control TEXT,
  format TEXT,  -- 'classical' | 'rapid' | 'bullet' | 'unknown'
  played_at TIMESTAMPTZ DEFAULT NOW(),
  source TEXT DEFAULT 'manual',  -- 'manual' | 'chesscom'
  external_id TEXT,
  chesscom_username TEXT,
  UNIQUE(user_id, external_id)
)
```

### Moves
```sql
moves (
  id SERIAL PRIMARY KEY,
  game_id INTEGER REFERENCES games(id),
  move_number INTEGER NOT NULL,
  move TEXT NOT NULL,  -- SAN notation
  fen TEXT NOT NULL,
  classification TEXT,  -- 'good' | 'inaccuracy' | 'mistake' | 'blunder'
  principle_violated TEXT REFERENCES principles(id),
  centipawn_loss INTEGER,
  best_move TEXT,  -- SAN notation
  eval_before INTEGER,  -- centipawns (white POV)
  eval_after INTEGER
)
```

### Principles
```sql
principles (
  id TEXT PRIMARY KEY,  -- 'P01', 'P02', etc.
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  level TEXT NOT NULL,  -- 'beginner' | 'intermediate' | 'advanced'
  category TEXT NOT NULL,
  examples TEXT
)
```

### Principle Themes
```sql
principle_themes (
  id SERIAL PRIMARY KEY,
  principle_id TEXT REFERENCES principles(id),
  theme TEXT NOT NULL  -- 'pin', 'fork', 'endgame', etc.
)
```

### Player Profile
```sql
player_profile (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id),
  reported_rating INTEGER,
  computed_level TEXT,  -- 'beginner' | 'intermediate' | 'advanced'
  avg_centipawn_loss REAL,
  blunder_rate REAL,
  conceptual_profile TEXT,
  top_principles JSONB,
  profile_updated_at TIMESTAMPTZ
)
```

### Conversations
```sql
conversations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  move_id INTEGER REFERENCES moves(id),
  current_turn INTEGER DEFAULT 1,
  max_turns INTEGER DEFAULT 5,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  engine_level TEXT DEFAULT 'LOW'  -- 'LOW' | 'MED' | 'HIGH'
)
```

### Messages
```sql
messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id),
  turn INTEGER NOT NULL,
  role TEXT NOT NULL,  -- 'user' | 'assistant'
  content TEXT NOT NULL,
  demonstrations JSONB,  -- Array of {from, moves}
  created_at TIMESTAMPTZ DEFAULT NOW()
)
```

---

## API Endpoints

### Authentication
- `GET /api/auth/google` - Initiate Google OAuth flow
- `GET /api/auth/google/callback` - OAuth callback handler
- `GET /api/auth/me` - Get current user session
- `POST /api/auth/logout` - End user session

### Games
- `GET /api/games` - List all user's games
- `POST /api/games` - Create game from PGN
- `GET /api/games/:id` - Get specific game details
- `POST /api/games/:id/moves` - Store analyzed moves for game
- `GET /api/games/:id/moves` - Get all moves for game
- `POST /api/games/chesscom` - Batch import from Chess.com

### Coaching
- `POST /api/coach/start` - Start coaching conversation for a move
- `POST /api/coach/:conversationId/message` - Send message in conversation
- `GET /api/coach/:conversationId` - Get conversation history
- `POST /api/coach/:conversationId/evaluate` - Use engine tool during coaching

### Profile
- `GET /api/profile` - Get user profile
- `POST /api/profile` - Update profile (e.g., reported rating)
- `GET /api/profile/stats` - Get aggregated statistics

### Principles
- `GET /api/principles` - Get all principles (public, no auth required)

### Admin
- `GET /api/admin/users` - List all users
- `POST /api/admin/users/:id/role` - Change user role
- `GET /api/admin/health` - System health metrics

---

## Chess Engine Integration

### Stockfish Configuration
- **Version**: Stockfish 18 (lite variant for client-side)
- **Depth**: 12 plies (server)
- **Move time**: 500ms per position (server)
- **Timeout**: 8 seconds per request
- **Hash**: 32MB (optimized for Railway deployment)
- **Threads**: 1

### Engine Operations

#### Position Evaluation
```javascript
evaluateFen(fen) → {
  ok: true,
  evalCp: -125,          // Side-to-move perspective
  bestMove: "Nf3",       // SAN notation
  bestMoveUci: "g1f3",   // UCI notation
  pvUci: ["g1f3", "d7d5", ...],  // Principal variation
  mateIn: null           // Number if mate is detected
}
```

#### Caching Strategy
- In-process Map cache for evaluated positions
- Keyed by FEN string
- Transpositions automatically cached
- No expiration (survives server lifetime)
- Cache size monitoring via admin panel

#### Engine Process Management
- Single long-lived Stockfish process
- Concurrent requests queued (not parallel)
- Automatic restart on crash with 5s backoff
- UCI protocol communication

---

## AI Coaching System

### Prompt Architecture

#### Verified Facts Block
Every coaching prompt includes a structured facts section:
- Side to move
- Piece positions (ASCII board representation)
- Legal moves available
- Move under review and its effects
- Engine evaluations (before/after)
- Centipawn loss
- Engine's recommended move
- Engine's principal variation (up to 4 plies)
- Principle violated
- Student's stated intent (when provided)

#### Response Format Requirements
AI must respond with valid JSON:
```json
{
  "text": "Coaching message (≤3 sentences)",
  "demonstrations": [
    {"from": "original", "moves": ["Qd8+", "Kh7"]},
    {"from": "userLine", "moves": ["Nxf7"]}
  ]
}
```

#### Demonstration System
- **"original"**: Play from position before flagged move
- **"userLine"**: Play from end of student's submitted line
- All moves validated by chess.js before display
- Shows tactical sequences on board

#### Concrete Claims Boundary
- AI can only make specific claims about current verified position
- Claims about positions >1 ply away must use demonstrations
- Prevents "color-bound bishop" class of hallucinations
- Enforced via prompt instruction

### Socratic Escalation

#### Rung Progression
System tracks `currentTurn` (1-based) and `maxTurns` (typically 5):
- **Turn 1-2**: Usually Rung 1 (open questions)
- **Turn 3**: Escalate to Rung 2 if not progressing
- **Turn 4**: Escalate to Rung 3 if still stuck
- **Turn 5** (final): Force Rung 4 (give answer)

#### Bailout Triggers
- `forceAnswer=true`: Student explicitly gave up or asked for answer
- `finalTurn=true`: Reached maxTurns
- Either trigger → immediate Rung 4

#### Player Level Calibration
- **Beginner**: Faster descent (more forgiving)
- **Intermediate**: Standard pace
- **Advanced**: Slower descent (push harder for self-discovery)

### Engine Consultation Tool

Available to AI during coaching via function calling:

```javascript
evaluate_alternative_move({
  moves: ["Qd8", "Rxd8"],  // Max 2 plies, SAN notation
  situation: "DIRECT_CHALLENGE"  // or "USER_PROPOSAL"
})
```

#### Consultation Budget
- **LOW** (default): Only DIRECT_CHALLENGE allowed
- **MED**: DIRECT_CHALLENGE + USER_PROPOSAL
- **HIGH**: All situations
- One-time per conversation (no repeated queries)

#### Use Cases
- **DIRECT_CHALLENGE**: "But doesn't Qxd8 just win?"
- **USER_PROPOSAL**: "What if I'd played Nb5 instead?"

### Degraded Mode
When position facts cannot be built (PGN reconstruction failure):
- AI receives limited facts only (move, classification, centipawn loss, principle)
- Cannot make specific board claims
- Stays conceptual (principle-based coaching)
- Demonstration system disabled

---

## Deployment Notes

### Environment Variables Required
```bash
# Database
DATABASE_URL=postgresql://...

# Authentication
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SESSION_SECRET=...

# AI
ANTHROPIC_API_KEY=...

# URLs
CLIENT_URL=http://localhost:5173
SERVER_URL=http://localhost:3001

# Admin
ADMIN_EMAIL=admin@example.com

# Optional
STOCKFISH_PATH=/usr/local/bin/stockfish
NODE_ENV=production
```

### Startup Sequence
1. Load environment variables
2. Initialize database (create tables if needed, run migrations)
3. Start Stockfish engine process
4. Configure Express middleware
5. Mount route handlers
6. Begin listening on PORT

### Health Checks
- `GET /api/admin/health` returns:
  - Engine availability
  - Cache size
  - Database connection status
  - Uptime

---

## Future Enhancements

### Planned Features
- Opening repertoire training
- Tactical puzzle generation from mistakes
- Spaced repetition for patterns
- Video coaching (voice synthesis)
- Mobile app
- Multiplayer coaching sessions
- Integration with Lichess

### Technical Debt
- Add automated tests (especially for coaching prompt construction)
- Implement rate limiting on coaching API
- Add request tracing/logging
- Database query optimization (add indexes)
- Frontend error boundary improvements
- Websocket support for real-time coaching

---

## Appendices

### Glossary
- **SAN**: Standard Algebraic Notation (e.g., "Nf3", "Qxe5+")
- **UCI**: Universal Chess Interface (e.g., "g1f3", "d8e5")
- **FEN**: Forsyth-Edwards Notation (position representation)
- **PGN**: Portable Game Notation (game recording format)
- **Centipawn**: 1/100th of a pawn (eval unit)
- **Ply**: Half-move (one player's turn)

### Principle Categories
- Opening principles (P04, P06, P08, P36-P40)
- King safety (P01, P24, P41-P43, P70, P72)
- Pawn structure (P03, P15, P20, P25, P58-P60, P63, P82)
- Piece activity (P02, P09, P10, P13, P19, P21, P23, P61, P69, P83)
- Endgame technique (P11, P18, P48-P54, P81)
- Tactical awareness (P12, P16, P17, P71, P73-P80)

### Classification Thresholds
```javascript
function classifyLoss(cpLoss) {
  if (cpLoss > 200)  return 'blunder';
  if (cpLoss >= 100) return 'mistake';
  if (cpLoss >= 50)  return 'inaccuracy';
  return 'good';
}
```

---

**Document Status**: Living document, updated as features evolve.
