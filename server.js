const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3').verbose();
const os = require('os');
const session = require('express-session');
const bodyParser = require('body-parser');

const SERVER_IP = process.env.SERVER_IP || 'localhost';
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const MODERATOR_PASSWORD = process.env.MODERATOR_PASSWORD || 'mod123';

// Configure session middleware
const sessionMiddleware = session({
  secret: 'your_secret_key', // Replace with a strong, random secret key
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using HTTPS
});

app.use(sessionMiddleware);
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

const db = new sqlite3.Database('./database/questions.db');

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

// Function to get sorted questions
function getSortedQuestions(sortBy, callback) {
  let orderByClause = 'created_at DESC'; // Default: sort by recency
  if (sortBy === 'votes') {
    orderByClause = 'upvotes DESC';
  } else if (sortBy === 'approved') {
    orderByClause = "CASE WHEN status = 'approved' THEN 1 ELSE 2 END, created_at DESC";
  }

  db.all(`SELECT * FROM questions ORDER BY ${orderByClause}`, [], callback);
}

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
      console.log('Questions retrieved from database:', rows);
      res.json(rows);
    }
  });
});

// Add an endpoint to serve the live page
app.get('/live', (req, res) => {
  res.sendFile(__dirname + '/public/live.html');
});

// Moderator login page
app.get('/moderator_login', (req, res) => {
  res.sendFile(__dirname + '/public/moderator_login.html');
});

// Handle moderator login
app.post('/moderator_login', (req, res) => {
  const { password } = req.body;
  if (password === MODERATOR_PASSWORD) {
    req.session.isAuthenticated = true;
    res.redirect('/moderator');
  } else {
    res.redirect('/moderator_login?error=1');
  }
});

// Logout route
app.get('/moderator_logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.redirect('/moderator');
    }
    res.redirect('/moderator_login');
  });
});

// Protect the moderator route
app.get('/moderator', (req, res) => {
  if (req.session.isAuthenticated) {
    res.sendFile(__dirname + '/public/moderator.html');
  } else {
    res.redirect('/moderator_login');
  }
});

app.get('/presenter', (req, res) => {
  res.sendFile(__dirname + '/public/presenter.html');
});

// Use the session middleware with Socket.IO
io.engine.use(sessionMiddleware);

// WebSocket logic
let currentEventName = 'VBC Event';
let currentEventDatetime = '';

io.on('connection', (socket) => {
  console.log('a user connected:', socket.id);

  // Check if the user is authenticated as a moderator
  if (socket.request.session.isAuthenticated) {
    socket.join('moderators');
    getSortedQuestions('recency', (err, rows) => {
      if (!err) socket.emit('all_questions', rows);
    });
  }

  const networkIP = getLocalNetworkIP();
  socket.emit('network_ip', networkIP);

  db.all("SELECT * FROM questions WHERE status = 'approved'", [], (err, rows) => {
    if (!err) {
      console.log('Questions retrieved from database:', rows);
      io.emit('approved_questions', rows);
    } else {
      console.error('Error retrieving questions:', err.message);
    }
  });
  db.get("SELECT * FROM questions WHERE status = 'live'", [], (err, row) => {
    if (!err) io.emit('live_question', row);
  });
  db.get("SELECT * FROM questions WHERE status = 'next_up'", [], (err, row) => {
    if (!err) io.emit('next_up_question', row);
  });

  let submittedQuestionIds = new Set();

  socket.on('submit_question', ({ username, text, participantID }) => {
    const id = uuidv4();
    const created_at = Date.now();
    const status = 'submitted';
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
        getSortedQuestions('recency', (err, rows) => {
          if (!err) io.to('moderators').emit('all_questions', rows);
        });
      }
    });
    stmt.finalize();
  });

  socket.on('moderator_action', ({ id, action, sortBy, newText }) => {
    if (!socket.request.session.isAuthenticated) return;

    const emitAllQuestions = () => {
      getSortedQuestions(sortBy, (err, rows) => {
        if (!err) {
          io.to('moderators').emit('all_questions', rows);
        }
      });
    };

    if (action === 'questiondeleted') {
      db.run("DELETE FROM questions WHERE id = ?", [id], (err) => {
        if (!err) {
          emitAllQuestions();
        }
      });
    }

    else if (action === 'approved') {
      db.run("UPDATE questions SET status = 'approved' WHERE id = ?", [id], (err) => {
        if (!err) {
          emitAllQuestions();
        }
      });
    }

    else if (action === 'live') {
      db.run("UPDATE questions SET status = 'approved' WHERE status = 'live'");
      db.run("UPDATE questions SET status = 'live' WHERE id = ?", [id], function (err) {
        if (!err) {
          db.get("SELECT * FROM questions WHERE id = ?", [id], (err, row) => {
            if (!err) {
              io.emit('live_question', row);
              io.emit('next_up_question', null); // Clear the next up question
              emitAllQuestions();
            }
          });
        }
      });
    }

    else if (action === 'next_up') {
      // Clear any existing next_up question
      db.run("UPDATE questions SET status = 'submitted' WHERE status = 'next_up'", [], (err) => {
        if (!err) {
          db.run("UPDATE questions SET status = 'next_up' WHERE id = ?", [id], function (err) {
            if (!err) {
              db.get("SELECT * FROM questions WHERE id = ?", [id], (err, row) => {
                if (!err) {
                  io.emit('next_up_question', row);
                  emitAllQuestions();
                }
              });
            }
          });
        }
      });
    }

    else if (action === 'cancel_next_up') {
      db.run("UPDATE questions SET status = 'submitted' WHERE id = ?", [id], (err) => {
        if (!err) {
          io.emit('next_up_question', null);
          emitAllQuestions();
        }
      });
    }
    
    else if (action === 'archive') {
      db.get("SELECT * FROM questions WHERE id = ?", [id], (err, question) => {
        if (!err && question) {
          const archivedAt = Date.now();
          db.run(
            `INSERT INTO archived_questions (id, username, text, status, upvotes, archived_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [question.id, question.username, question.text, question.status, question.upvotes, archivedAt],
            (err) => {
              if (!err) {
                db.run("DELETE FROM questions WHERE id = ?", [id], (err) => {
                  if (!err) {
                    emitAllQuestions();
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
      db.get("SELECT * FROM archived_questions WHERE id = ?", [id], (err, question) => {
        if (!err && question) {
          db.run(
            `INSERT INTO questions (id, username, text, status, upvotes, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [question.id, question.username, question.text, 'submitted', question.upvotes, Date.now()],
            (err) => {
              if (!err) {
                db.run("DELETE FROM archived_questions WHERE id = ?", [id], (err) => {
                  if (!err) {
                    db.all("SELECT * FROM archived_questions", [], (err, rows) => {
                      if (!err) socket.emit('archived_questions', rows);
                    });
  
                    emitAllQuestions();
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
          emitAllQuestions();
        }
      });
    }

    else if (action === 'cancel_live') {
      db.run("UPDATE questions SET status = 'approved' WHERE id = ?", [id], (err) => {
        if (!err) {
          emitAllQuestions();
          io.emit('live_question', null);
        }
      });
    }
    else if (action === 'edit') {
      db.run("UPDATE questions SET text = ? WHERE id = ?", [newText, id], (err) => {
        if (!err) {
          emitAllQuestions();
        }
      });
    }
    else {
      db.run("UPDATE questions SET status = ? WHERE id = ?", [action, id], (err) => {
        if (!err) {
          emitAllQuestions();
        }
      });
    }

    db.all("SELECT * FROM questions WHERE status = 'approved'", [], (err, rows) => {
      if (!err) io.emit('approved_questions', rows);
    });
  });

  socket.on('upvote', (questionId) => {
    db.get("SELECT * FROM questions WHERE id = ?", [questionId], (err, question) => {
      if (!err && question && question.status === 'approved') {
        db.get("SELECT * FROM votes WHERE question_id = ? AND socket_id = ?", [questionId, socket.id], (err, row) => {
          if (!row) {
            db.run("INSERT INTO votes (question_id, socket_id) VALUES (?, ?)", [questionId, socket.id], () => {
              db.run("UPDATE questions SET upvotes = upvotes + 1 WHERE id = ?", [questionId], () => {
                db.get("SELECT * FROM questions WHERE id = ?", [questionId], (err, updatedQuestion) => {
                  if (!err) {
                    io.emit('question_upvoted', [updatedQuestion]);
                    io.to('moderators').emit('update_vote', updatedQuestion);
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
    getSortedQuestions(sortBy, (err, rows) => {
      if (!err) {
        socket.emit('all_questions', rows);
      }
    });
  });

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
        socket.emit('approved_questions', rows);
      }
    });
  });

  socket.on('save_event_config', ({ eventName, eventURL, eventDatetime }) => {
    console.log('Received eventDatetime from moderator:', eventDatetime);
    currentEventName = eventName;
    currentEventDatetime = eventDatetime;
    console.log('Event updated:', eventName, eventURL, eventDatetime);
    io.emit('event_name_updated', { eventName });
    io.emit('event_url_updated', { eventURL });
    io.emit('event_datetime_updated', { eventDatetime });
  });

  socket.emit('event_name_updated', { eventName: currentEventName });
  socket.emit('event_datetime_updated', { eventDatetime: currentEventDatetime });

  socket.on('request_export_data', () => {
    const questionsQuery = `SELECT * FROM questions`;
    const archivedQuestionsQuery = `SELECT * FROM archived_questions`;

    db.all(questionsQuery, [], (err, questions) => {
      if (err) {
        console.error('Error fetching questions:', err);
        return;
      }

      db.all(archivedQuestionsQuery, [], (err, archivedQuestions) => {
        if (err) {
          console.error('Error fetching archived questions:', err);
          return;
        }

        socket.emit('export_data', { questions, archivedQuestions });
      });
    });
  });
});

const PORT = process.env.PORT || 4000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
