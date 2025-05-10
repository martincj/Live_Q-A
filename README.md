# 🟢 Live Q&A Web App

A self-hostable, real-time web app for running live Q&A sessions with moderator control and participant voting.

## ✨ Features

- Participants can:
  - Submit questions anonymously or with a username
  - View and vote on approved questions (cannot vote on their own questions, and can only vote once on other participants' questions
  - See real-time updates

- Moderators can:
  - Approve submitted questions
  - Mark a question as “live” to activate a live view for projection
  - Archive (answer) questions
  - Require a password to access moderator tools

- Real-time updates via WebSockets
- Live display view for projection
- SQLite persistence
- Easy Docker-based deployment

## 📦 Requirements

- Docker
- Docker Compose

## 🚀 Quick Start

1. **Clone the repo**:
   ```bash
   git clone https://github.com/yourusername/live-qa-app.git
   cd live-qa-app
