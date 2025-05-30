// Simple backend using Node.js, Express, and Socket.IO with SQLite and moderator password
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3').verbose();
const os = require('os'); // Added os module
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
    participant_id TEXT,
    status TEXT NOT NULL,
    upvotes INTEGER DEFAULT 0,
    created_at INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS votes (
    question_id TEXT,
    socket_id TEXT,
    PRIMARY KEY (question_id, socket_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS archived_questions (
    id TEXT PRIMARY KEY,
    username TEXT,
    text TEXT NOT NULL,
    participant_id TEXT,
    status TEXT NOT NULL,
    upvotes INTEGER DEFAULT 0,
    created_at INTEGER,
    archived_at INTEGER
  )`);
});

// Function to get the local network IP address
function getLocalNetworkIP() {
  const interfaces = os.networkInterfaces();
  for (const name in interfaces) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address; // Return the first non-internal IPv4 address
      }
    }
  }
  return 'localhost'; // Fallback to localhost if no network IP is found
}

// Add an endpoint to fetch sorted questions
app.get('/questions', (req, res) => {
  const { sortBy } = req.query;

  let orderByClause = 'created_at DESC'; // Default: sort by recency
  if (sortBy === 'votes') {
    orderByClause = 'upvotes DESC';
  } else if (sortBy === 'status') {
    orderByClause = 'status ASC, created_at DESC';
  }

  db.all(`SELECT * FROM questions ORDER BY ${orderByClause}`, [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: 'Failed to fetch questions' });
    } else {
      console.log('Questions retrieved from database:', rows); // debugging to verify that the participant_id is included in the rows arrage retriecved from the database
      res.json(rows);
    }
  });
});

// Add an endpoint to serve the live page
app.get('/live', (req, res) => {
  res.sendFile(__dirname + '/public/live.html');
});

// Add an endpoint to serve the live page
app.get('/moderator', (req, res) => {
  res.sendFile(__dirname + '/public/moderator.html');
});

// WebSocket logic
let currentEventName = 'VBC Event'; // Store the event name in memory
let currentEventDatetime = ''; // Store the event datetime in memory

io.on('connection', (socket) => {
  console.log('a user connected:', socket.id);

  const networkIP = getLocalNetworkIP(); // Get the local network IP
  socket.emit('network_ip', networkIP); // Emit the network IP to the client

  db.all("SELECT * FROM questions WHERE status = 'approved'", [], (err, rows) => {
    if (!err) {
      console.log('Questions retrieved from database:', rows); // Debugging
      socket.emit('approved_questions', rows); // Send the questions to the client
    } else {
      console.error('Error retrieving questions:', err.message);
    }
  });
  db.get("SELECT * FROM questions WHERE status = 'live'", [], (err, row) => {
    if (!err) socket.emit('live_question', row);
  });

  let submittedQuestionIds = new Set();

  socket.on('submit_question', ({ username, text, participantID }) => {
    const id = uuidv4(); // Generate a unique ID for the question
    const created_at = Date.now();
    const status = 'submitted'; // Define the status for clarity
      // Log the details of the submitted question
    console.log('New Question Submitted:', {
      id,
      username,
      text,
      participant_id: participantID,
      status,
      created_at,
    });
    const stmt = db.prepare("INSERT INTO questions (id, username, text, participant_id, status, created_at) VALUES (?, ?, ?, ?, 'submitted', ?)");
    stmt.run(id, username, text, participantID, created_at, (err) => {
      if (!err) {
        // Emit the updated list of all questions to moderators
        db.all("SELECT * FROM questions", [], (err, rows) => {
          if (!err) io.to('moderators').emit('all_questions', rows);
        });
      }
    });
    stmt.finalize();
  });

  socket.on('join_moderator', (password) => {
    if (password !== MODERATOR_PASSWORD) return;
    socket.join('moderators');
    db.all("SELECT * FROM questions", [], (err, rows) => {
      if (!err) socket.emit('all_questions', rows);
    });
  });

  socket.on('moderator_login', (password) => {
    if (password !== MODERATOR_PASSWORD) return;
    socket.join('moderators');
    db.all("SELECT * FROM questions", [], (err, rows) => {
      if (!err) socket.emit('all_questions', rows);
    });
  });

  socket.on('moderator_action', ({ id, action, password }) => {
    if (password !== MODERATOR_PASSWORD) return;

    if (action === 'questiondeleted') {
      db.run("DELETE FROM questions WHERE id = ?", [id], (err) => {
        if (!err) {
          // Emit the updated list of all questions to moderators
          db.all("SELECT * FROM questions", [], (err, rows) => {
            if (!err) io.emit('all_questions', rows);
          });
        }
      });
    }

    else if (action === 'approved') {
      db.run("UPDATE questions SET status = 'approved' WHERE id = ?", [id], (err) => {
        if (!err) {
          // Emit the updated list of all questions to moderators
          db.all("SELECT * FROM questions", [], (err, rows) => {
            if (!err) io.to('moderators').emit('all_questions', rows);
          });
        }
      });
    }

    else if (action === 'live') {
      db.run("UPDATE questions SET status = 'approved' WHERE status = 'live'");
      db.run("UPDATE questions SET status = 'live' WHERE id = ?", [id], function (err) {
        if (!err) {
          db.get("SELECT * FROM questions WHERE id = ?", [id], (err, row) => {
            if (!err) {
              io.emit('live_question', row); // Emit the live question to all clients

              // Fetch the updated list of all questions
              db.all("SELECT * FROM questions", [], (err, rows) => {
                if (!err) {
                  io.to('moderators').emit('all_questions', rows); // Emit the updated list of all questions to moderators
                }
              });
            }
          });
        }
      });
    } 
    
    else if (action === 'archive') {
      // Move the question to the archived_questions table
      db.get("SELECT * FROM questions WHERE id = ?", [id], (err, question) => {
        if (!err && question) {
          const archivedAt = Date.now();
          db.run(
            `INSERT INTO archived_questions (id, username, text, status, upvotes, archived_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [question.id, question.username, question.text, question.status, question.upvotes, archivedAt],
            (err) => {
              if (!err) {
                // Delete the question from the questions table
                db.run("DELETE FROM questions WHERE id = ?", [id], (err) => {
                  if (!err) {
                    // Emit the updated list of all questions to moderators
                    db.all("SELECT * FROM questions", [], (err, rows) => {
                      if (!err) io.to('moderators').emit('all_questions', rows);
                    });
                    // Emit the updated list of archived questions
                    db.all("SELECT * FROM archived_questions", [], (err, rows) => {
                      if (!err) socket.emit('archived_questions', rows);
                    });
                  }
                });
              }
            }
          );
        }
      });
    } 
    else if (action === 'unarchive') {
      // Fetch the question from the archived_questions table
      db.get("SELECT * FROM archived_questions WHERE id = ?", [id], (err, question) => {
        if (!err && question) {
          // Insert the question back into the questions table
          db.run(
            `INSERT INTO questions (id, username, text, status, upvotes, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [question.id, question.username, question.text, 'submitted', question.upvotes, Date.now()],
            (err) => {
              if (!err) {
                // Delete the question from the archived_questions table
                db.run("DELETE FROM archived_questions WHERE id = ?", [id], (err) => {
                  if (!err) {
                    // Emit the updated archived questions list
                    db.all("SELECT * FROM archived_questions", [], (err, rows) => {
                      if (!err) socket.emit('archived_questions', rows);
                    });
  
                    // Emit the updated all questions list to moderators
                    db.all("SELECT * FROM questions", [], (err, rows) => {
                      if (!err) io.to('moderators').emit('all_questions', rows);
                    });
                  }
                });
              }
            }
          );
        }
      });
    }

    else if (action === 'unapprove') {
      db.run("UPDATE questions SET status = 'submitted' WHERE id = ?", [id], (err) => {
        if (!err) {
          // Emit the updated list of all questions to moderators
          db.all("SELECT * FROM questions", [], (err, rows) => {
            if (!err) io.to('moderators').emit('all_questions', rows);
          });
        }
      });
    }

    else if (action === 'cancel_live') {
      db.run("UPDATE questions SET status = 'approved' WHERE id = ?", [id], (err) => {
        if (!err) {
          // Emit the updated list of all questions to moderators
          db.all("SELECT * FROM questions", [], (err, rows) => {
            if (!err) io.to('moderators').emit('all_questions', rows);
          });

          // Notify the live view that there is no active live question
          io.emit('live_question', null);
        }
      });
    }
    
    else {
      db.run("UPDATE questions SET status = ? WHERE id = ?", [action, id]);
    }

    // Emit the updated list of approved questions
    db.all("SELECT * FROM questions WHERE status = 'approved'", [], (err, rows) => {
      if (!err) io.emit('approved_questions', rows);
    });
  });

  socket.on('upvote', (questionId) => {
    // Prevent upvoting own question or multiple votes
    db.get("SELECT * FROM questions WHERE id = ?", [questionId], (err, question) => {
      if (!err && question && question.status === 'approved') {
        db.get("SELECT * FROM votes WHERE question_id = ? AND socket_id = ?", [questionId, socket.id], (err, row) => {
          if (!row) {
            db.run("INSERT INTO votes (question_id, socket_id) VALUES (?, ?)", [questionId, socket.id], () => {
              db.run("UPDATE questions SET upvotes = upvotes + 1 WHERE id = ?", [questionId], () => {
                // Emit the updated question to participants
                db.get("SELECT * FROM questions WHERE id = ?", [questionId], (err, updatedQuestion) => {
                  if (!err) {
                    io.emit('question_upvoted', [updatedQuestion]); // Send updated question to participants
                    io.to('moderators').emit('update_vote', updatedQuestion); // Send updated question to moderators
                  }
                });
              });
            });
          }
        });
      }
    });
  });

  socket.on('request_questions', ({ sortBy }) => {
    let orderByClause = 'created_at DESC'; // Default: sort by recency
    if (sortBy === 'votes') {
      orderByClause = 'upvotes DESC';
    } else if (sortBy === 'approved') {
      orderByClause = "CASE WHEN status = 'approved' THEN 1 ELSE 2 END, created_at DESC";
    }

    db.all(`SELECT * FROM questions ORDER BY ${orderByClause}`, [], (err, rows) => {
      if (!err) {
        socket.emit('all_questions', rows); // Send the sorted questions back to the client
      }
    });
  });

  // display archived questions to moderators when button is clicked
  socket.on('request_archived_questions', () => {
    db.all("SELECT * FROM archived_questions", [], (err, rows) => {
      if (!err) {
        socket.emit('archived_questions', rows);
      }
    });
  });

  socket.on('request_approved_questions', () => {
    db.all("SELECT * FROM questions WHERE status = 'approved'", [], (err, rows) => {
      if (!err) {
        socket.emit('approved_questions', rows); // Send the updated list to the client
      }
    });
  });

  // Send notifications of updates when an update event button is clicked.
  socket.on('save_event_config', ({ eventName, eventURL, eventDatetime }) => { // Key: eventDatetime
    console.log('Received eventDatetime from moderator:', eventDatetime); // Debugging
    currentEventName = eventName; // Update the stored event name
    currentEventDatetime = eventDatetime; // Update the stored event datetime
    console.log('Event updated:', eventName, eventURL, eventDatetime);
    io.emit('event_name_updated', { eventName });
    io.emit('event_ip_updated', { eventURL });
    io.emit('event_datetime_updated', { eventDatetime });
  });

  // Send the current event configuration to participants when they connect
  socket.emit('event_name_updated', { eventName: currentEventName });
  socket.emit('event_datetime_updated', { eventDatetime: currentEventDatetime });
});

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
