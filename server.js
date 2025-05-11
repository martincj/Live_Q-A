// Simple backend using Node.js, Express, and Socket.IO with SQLite and moderator password
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const MODERATOR_PASSWORD = process.env.MODERATOR_PASSWORD || 'mod123';

app.use(express.json());
app.use(express.static('public'));

const db = new sqlite3.Database('./questions.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    username TEXT,
    text TEXT NOT NULL,
    status TEXT NOT NULL,
    upvotes INTEGER DEFAULT 0,
    created_at INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS votes (
    question_id TEXT,
    socket_id TEXT,
    PRIMARY KEY (question_id, socket_id)
  )`);
});

// WebSocket logic
io.on('connection', (socket) => {
  console.log('a user connected:', socket.id);

  db.all("SELECT * FROM questions WHERE status = 'approved'", [], (err, rows) => {
    if (!err) socket.emit('approved_questions', rows);
  });
  db.get("SELECT * FROM questions WHERE status = 'live'", [], (err, row) => {
    if (!err) socket.emit('live_question', row);
  });

  let submittedQuestionIds = new Set();

  socket.on('submit_question', ({ username, text }) => {
    const id = uuidv4();
    const created_at = Date.now();
    submittedQuestionIds.add(id);
    const stmt = db.prepare("INSERT INTO questions (id, username, text, status, created_at) VALUES (?, ?, ?, 'submitted', ?)");
    stmt.run(id, username, text, created_at);
    stmt.finalize(() => {
      db.get("SELECT * FROM questions WHERE id = ?", [id], (err, row) => {
        if (!err) io.to('moderators').emit('new_question', row);
      });
    });
  });

  socket.on('join_moderator', (password) => {
    if (password !== MODERATOR_PASSWORD) return;
    socket.join('moderators');
    db.all("SELECT * FROM questions", [], (err, rows) => {
      if (!err) socket.emit('all_questions', rows);
    });
  });

  socket.on('moderator_action', ({ id, action, password }) => {
    if (password !== MODERATOR_PASSWORD) return;
    if (action === 'live') {
      db.run("UPDATE questions SET status = 'approved' WHERE status = 'live'");
      db.run("UPDATE questions SET status = 'live' WHERE id = ?", [id]);
    } else {
      db.run("UPDATE questions SET status = ? WHERE id = ?", [action, id]);
    }
    db.all("SELECT * FROM questions WHERE status = 'approved'", [], (err, rows) => {
      if (!err) io.emit('approved_questions', rows);
    });
    db.get("SELECT * FROM questions WHERE status = 'live'", [], (err, row) => {
      if (!err) io.emit('live_question', row);
    });
    db.all("SELECT * FROM questions", [], (err, rows) => {
      if (!err) io.to('moderators').emit('all_questions', rows);
    });
  });

  socket.on('upvote', (questionId) => {
    // prevent upvoting own question or multiple votes
    db.get("SELECT * FROM questions WHERE id = ?", [questionId], (err, question) => {
      if (!err && question && question.status === 'approved') {
        db.get("SELECT * FROM votes WHERE question_id = ? AND socket_id = ?", [questionId, socket.id], (err, row) => {
          if (!row) {
            db.run("INSERT INTO votes (question_id, socket_id) VALUES (?, ?)", [questionId, socket.id], () => {
              db.run("UPDATE questions SET upvotes = upvotes + 1 WHERE id = ?", [questionId], () => {
                db.all("SELECT * FROM questions WHERE status = 'approved'", [], (err, rows) => {
                  if (!err) io.emit('approved_questions', rows);
                });
              });
            });
          }
        });
      }
    });
  });
});

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
