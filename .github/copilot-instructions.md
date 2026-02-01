# Live Q&A Codebase Instructions

## Project Overview

**Live Q&A** is a self-hostable, real-time web application for managing Q&A sessions at live events. It uses Node.js/Express backend with WebSocket (Socket.IO) for real-time communication, SQLite for persistence, and vanilla JavaScript frontends for different user roles.

**Key Architecture**: Server-driven state management through Socket.IO events with three user roles—participants (public), moderators (authenticated), and presenters (projection display).

## Core Architecture & Components

### Database Schema (`./database/questions.db`)
Three main tables govern the application:

- **`questions`**: Active questions with status (submitted, approved, live, next_up) and upvote tracking
- **`votes`**: Prevents duplicate voting (composite PK: question_id + socket_id)
- **`archived_questions`**: Questions marked as answered, kept for record-keeping

**Status Flow**: `submitted` → `approved` → `live` (or `next_up`) → archive

### Backend Architecture (`server.js`)

**Express Routes**:
- `/` → Participant Q&A interface (index.html)
- `/live` → Projection display for events (live.html)
- `/presenter` → Alternative presentation view (presenter.html)
- `/moderator_login` → Password authentication gateway
- `/moderator` → Authenticated admin panel (requires session)
- `/questions` → API endpoint for fetching questions (supports query param `sortBy`: recency|votes|status)

**WebSocket Channels** (Socket.IO):
- `connection` → Emits timer state, network IP, and current questions to all clients
- `moderators` → Room for authenticated moderators only; receives all_questions updates
- All clients receive: `approved_questions`, `live_question`, `next_up_question`, timer events

**Key Socket Events**:
- **Client→Server**: `submit_question`, `upvote`, `moderator_action`, `start_timer`, `stop_timer`, `save_event_config`, `request_export_data`
- **Server→Client**: `all_questions`, `approved_questions`, `live_question`, `next_up_question`, `timer_state`, `event_name_updated`

### Frontend Structure (`./public/`)

| File | Role | Purpose |
|------|------|---------|
| `index.html` | Participants | Submit questions, browse approved questions, vote in real-time |
| `live.html` | Presentation | Display single live question + next_up for projection |
| `moderator.html` | Admin | Approve/archive/edit questions, manage timer and event config |
| `presenter.html` | Alt-presenter | Alternative presentation view |

All frontends use vanilla JS with Socket.IO client to communicate with server.

## Critical Workflows

### Question Lifecycle (Moderator Control)
1. **Submit** (`submit_question` event) → Inserted as `submitted` status
2. **Approve** (`moderator_action` with action=`approved`) → Participants see it, can upvote
3. **Go Live** (`moderator_action` with action=`live`) → Displays on live.html, timer starts
4. **Archive** (`moderator_action` with action=`archive`) → Moves to archived_questions table, removes from active

**Moderator Actions** (in `moderator_action` handler):
- `approved`, `live`, `next_up`, `cancel_next_up`, `archive`, `unarchive`, `unapprove`, `cancel_live`, `edit`, `questiondeleted`

### Voting & Participation Rules
- Only authenticated socket.id + question_id prevents duplicate votes (checked in votes table)
- Participants **cannot vote on their own questions** (enforced client-side; relies on participant_id tracking)
- Upvotes increment only on `approved` questions, synced via `question_upvoted` event

### Broadcasting Pattern
Every moderator action triggers `emitAllQuestions()` which:
1. Calls `getSortedQuestions(sortBy, callback)`
2. Emits `all_questions` only to moderators room
3. Fetches and emits `approved_questions` to all clients
4. Prevents moderators and participants seeing the same question set

## Environment & Deployment

**Environment Variables**:
- `MODERATOR_PASSWORD` (default: `mod123`) — Session authentication gateway
- `SERVER_IP` (default: `localhost`) — Used for network discovery
- `PORT` (default: `3000`)

**Docker Setup**:
- Multi-stage Dockerfile (node:24-alpine) with production deps only
- Volume mount: `liveqa_data:/app/database` — Persists SQLite database across container restarts
- Compose service: `vbc_liveqa` on port 3000

**Running Locally**: `npm start` (starts Express server on port 3000; SQLite auto-initializes tables on first run)

## Common Patterns & Conventions

### Session & Authentication
- `express-session` middleware wraps both Express and Socket.IO
- Only `/moderator` route checks `req.session.isAuthenticated`
- Socket connections check `socket.request.session.isAuthenticated` to join `moderators` room
- **No JWT/token-based auth** — relies on session cookies

### Real-Time Sync
- On every client connection, server emits: current timer state, event name/datetime, network IP
- Questions fetched on-demand per role (all moderators, approved+top5 for participants)
- **No client-side persistence** except participant ID (stored in sessionStorage per event)

### Sorting
- `getSortedQuestions(sortBy)` handles: `recency` (default), `votes`, `approved` (approved first, then recency)
- Used in `/questions` API and moderator views

### Timer (Presenter Feature)
- Global `timerState` object managed server-side
- `start_timer` resets counter to 0, increments every second
- `stop_timer` halts and broadcasts final state
- Synced to all connected clients on socket events

## File Locations for Key Patterns

- **Session config**: [server.js#L17-L23](server.js#L17-L23)
- **Question lifecycle actions**: [server.js#L250-L350](server.js#L250-L350)
- **Voting logic**: [server.js#L380-L400](server.js#L380-L400)
- **Database init**: [server.js#L32-L50](server.js#L32-L50)
- **Frontend Socket listeners**: [public/index.html](public/index.html) (vanilla JS event handlers)

## Testing & Debugging

- **Logs**: Server logs all question submissions, moderator actions, and connection events to console
- **Database debugging**: Query `./database/questions.db` directly with any SQLite CLI tool
- **Network discovery**: Fetches local IPv4 from `os.networkInterfaces()` and emits via `network_ip` event for LAN access
- **No formal test suite** — manual testing recommended via browser DevTools + server console

## Deployment Checklist

- [ ] Set `MODERATOR_PASSWORD` to strong value in production (env var or secrets manager)
- [ ] Mount persistent volume for `./database` to survive container restarts
- [ ] Verify Socket.IO connection works across network (test from different machines)
- [ ] Configure HTTPS if exposing externally (set `cookie.secure: true` in session config)
- [ ] Database auto-initializes; no migration scripts needed for first deployment

## Future Considerations (from Roadmap)

- Separate style themes for frontends and add ability to choose between themes in the moderator panel
- Guest network access documentation needed
- Bluehost hosting compatibility unknown
- No persistent session store — currently uses memory (fine for single-instance deployments)
- Create ability to have multiple sessions of the Q&A running with separate pools of questions