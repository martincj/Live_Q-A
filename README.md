# Live Q&A Web App

A self-hostable, real-time web app for running live Q&A sessions with moderator control and participant voting.

## Features

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

## Requirements

- Docker
- Docker Compose

## Quick Start

1. **Clone the repo**:
   ```bash
   git clone https://github.com/yourusername/live-qa-app.git
   cd live-qa-app


## Roadmap
 - [X] Initial functionality in realtime
 - [X] Add unarchive and unapprove buttons
 - [X] Add ability to set event name, URL, and Date/time in moderator view
 - [X] Persist participant ID across browser refresh unless eventName or eventDatetime has changed
 - [ ] Separate style themes for frontends and add ability to choose between themes in the moderator panel
 - [ ] Include basic how-to information for participants and moderators
 - [X] Run in docker and install on server
 - [X] How to access from guest network?
 - [ ] Can it be hosted on Bluehost?
 - [ ] Create ability to have multiple sessions of the Q&A running with separate pools of questions
