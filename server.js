const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3').verbose();
const os = require('os');
const session = require('express-session');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

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

const CONFIG_DIR = path.join(__dirname, 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'event_config.json');

function ensureConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR);
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaultCfg = { themes: { user: 'user/default.css', live: 'live/default.css', moderator: 'moderator/default.css', presenter: 'presenter/default.css' }, eventName: 'VBC Event', eventDatetime: '' };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultCfg, null, 2));
  }
}

function loadConfig() {
  try {
    ensureConfig();
    return JSON.parse(fs.readFileSync(CONFIG_PATH));
  } catch (e) {
    return { themes: { user: 'user/default.css', live: 'live/default.css', moderator: 'moderator/default.css', presenter: 'presenter/default.css' } };
  }
}

function saveConfig(cfg) {
  ensureConfig();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// Return organized theme files grouped by view folder
function listThemesByView() {
  try {
    const themesDir = path.join(__dirname, 'public', 'themes');
    if (!fs.existsSync(themesDir)) return { user: [], live: [], moderator: [], presenter: [] };
    
    const views = { user: [], live: [], moderator: [], presenter: [] };
    const entries = fs.readdirSync(themesDir, { withFileTypes: true });
    
    entries.forEach(entry => {
      if (entry.isDirectory() && views.hasOwnProperty(entry.name)) {
        const viewDir = path.join(themesDir, entry.name);
        const files = fs.readdirSync(viewDir).filter(f => f.endsWith('.css'));
        views[entry.name] = files;
      }
    });
    
    return views;
  } catch (e) {
    return { user: [], live: [], moderator: [], presenter: [] };
  }
}

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

// Serve user page at root
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/user.html');
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

let timerState = {
  running: false,
  seconds: 0,
  interval: null,
};

function broadcastTimerState() {
  io.emit('timer_state', {
    seconds: timerState.seconds,
    running: timerState.running,
  });
}


function startTimer() {
  stopTimer();
  timerState.running = true;
  timerState.seconds = 0;
  timerState.interval = setInterval(() => {
    timerState.seconds++;
    broadcastTimerState();
  }, 1000);
  broadcastTimerState();
}

function stopTimer() {
  if (timerState.running) {
    timerState.running = false;
    clearInterval(timerState.interval);
    broadcastTimerState();
  }
}

io.on('connection', (socket) => {
  console.log('a user connected:', socket.id);

  // Send the current timer state to the newly connected client
  socket.emit('timer_state', {
    seconds: timerState.seconds,
    running: timerState.running,
  });

  socket.on('start_timer', startTimer);
  socket.on('stop_timer', stopTimer);


  // Check if the user is authenticated as a moderator
  if (socket.request.session.isAuthenticated) {
    socket.join('moderators');
    socket.moderatorSortBy = 'recency'; // Default sort order
    getSortedQuestions(socket.moderatorSortBy, (err, rows) => {
      if (!err) socket.emit('all_questions', rows);
    });
  }

  const networkIP = getLocalNetworkIP();
  socket.emit('network_ip', networkIP);

  db.all("SELECT * FROM questions WHERE status = 'approved' ORDER BY created_at DESC", [], (err, rows) => {
    if (!err) {
      console.log('Questions retrieved from database:', rows);
      socket.emit('approved_questions', rows);
    } else {
      console.error('Error retrieving questions:', err.message);
    }
  });
  db.get("SELECT * FROM questions WHERE status = 'live'", [], (err, row) => {
    if (!err) socket.emit('live_question', row);
  });
  db.get("SELECT * FROM questions WHERE status = 'next_up'", [], (err, row) => {
  if (!err) socket.emit('next_up_question', row);
  });

  emitQuestionCounts();

  let submittedQuestionIds = new Set();
  function emitQuestionCounts() {
    db.all("SELECT status, created_at FROM questions", [], (err, rows) => {
      if (!err) {
        const approved = rows.filter(r => r.status === 'approved' || r.status === 'live' || r.status === 'next_up').length;
        const unapproved = rows.filter(r => r.status === 'submitted').length;
        const total = rows.length;

        // Calculate questions submitted today (since midnight local time)
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const startOfTodayMs = startOfToday.getTime();
        const submittedToday = rows.filter(r => r.created_at >= startOfTodayMs).length;

        io.emit('question_counts', { approved, unapproved, total, submittedToday });
      }
    });
  }

  function emitAllQuestionsToModerators() {
    io.in('moderators').fetchSockets().then(sockets => {
      sockets.forEach(s => {
        getSortedQuestions(s.moderatorSortBy || 'recency', (err, rows) => {
          if (!err) s.emit('all_questions', rows);
        });
      });
    });
  }

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
        emitAllQuestionsToModerators();
        emitQuestionCounts();
      }
    });
    stmt.finalize();
  });

  socket.on('moderator_action', ({ id, action, sortBy, newText }) => {
    if (!socket.request.session.isAuthenticated) return;
    if (sortBy) socket.moderatorSortBy = sortBy;

    const emitAllQuestions = () => {
      emitAllQuestionsToModerators();
      emitQuestionCounts();
    };

    if (action === 'questiondeleted') {
      db.get("SELECT status FROM questions WHERE id = ?", [id], (err, row) => {
        const wasLive = row && row.status === 'live';
        const wasNextUp = row && row.status === 'next_up';

        db.run("DELETE FROM questions WHERE id = ?", [id], (err) => {
          if (!err) {
            db.run("DELETE FROM votes WHERE question_id = ?", [id]);
            if (wasLive) {
              io.emit('live_question', null);
              stopTimer();
            }
            if (wasNextUp) {
              io.emit('next_up_question', null);
            }
            emitAllQuestions();
          }
        });
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
              // Check if the question being made live WAS the next_up question
              db.get("SELECT id FROM questions WHERE status = 'next_up'", [], (err, nextUpRow) => {
                if (!err && nextUpRow && nextUpRow.id === id) {
                   // It was next_up, so now that it is live, we can clear next_up
                   io.emit('next_up_question', null);
                } else if (!err && !nextUpRow) {
                   // No next_up question, so just in case, clear it
                   io.emit('next_up_question', null);
                }
                // If it wasn't the next_up question, we DON'T clear next_up.
              });

              io.emit('live_question', row);
              emitAllQuestions();
              startTimer();
            }
          });
        }
      });
    }

    else if (action === 'next_up') {
      // Clear any existing next_up question and set it back to approved
      db.run("UPDATE questions SET status = 'approved' WHERE status = 'next_up'", [], (err) => {
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
          const wasLive = question.status === 'live';
          const wasNextUp = question.status === 'next_up';
          db.run(
            `INSERT INTO archived_questions (id, username, text, status, upvotes, archived_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [question.id, question.username, question.text, question.status, question.upvotes, archivedAt],
            (err) => {
              if (!err) {
                db.run("DELETE FROM questions WHERE id = ?", [id], (err) => {
                  if (!err) {
                    db.run("DELETE FROM votes WHERE question_id = ?", [id]);
                    if (wasLive) {
                      io.emit('live_question', null);
                      stopTimer();
                    }
                    if (wasNextUp) {
                      io.emit('next_up_question', null);
                    }
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
          stopTimer();
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

    db.all("SELECT * FROM questions WHERE status = 'approved' ORDER BY created_at DESC", [], (err, rows) => {
      if (!err) io.emit('approved_questions', rows);
    });
  });

  socket.on('get_approved_questions', () => {
    db.all("SELECT * FROM questions WHERE status = 'approved' ORDER BY created_at DESC", [], (err, rows) => {
      if (!err) {
        socket.emit('approved_questions', rows);
      }
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
                    emitAllQuestionsToModerators();
                    emitQuestionCounts();
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
    if (sortBy) socket.moderatorSortBy = sortBy;
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
    db.all("SELECT * FROM questions WHERE status = 'approved' ORDER BY created_at DESC", [], (err, rows) => {
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
  socket.on('save_event_config', ({ eventName, eventURL, eventDatetime, themes }) => {
    console.log('Received eventDatetime from moderator:', eventDatetime);
    currentEventName = eventName;
    currentEventDatetime = eventDatetime;
    console.log('Event updated:', eventName, eventURL, eventDatetime);
    // Persist config (load, update, save)
    const cfg = loadConfig();
    cfg.eventName = eventName;
    cfg.eventDatetime = eventDatetime;
    cfg.eventURL = eventURL;
    if (themes) cfg.themes = themes;
    saveConfig(cfg);

    io.emit('event_name_updated', { eventName });
    io.emit('event_url_updated', { eventURL });
    io.emit('event_datetime_updated', { eventDatetime });
    // Broadcast theme update
    io.emit('theme_updated', cfg.themes || {});
  });

  socket.emit('event_name_updated', { eventName: currentEventName });
  socket.emit('event_datetime_updated', { eventDatetime: currentEventDatetime });
  // Send current theme config to the newly connected client
  const cfg = loadConfig();
  socket.emit('theme_updated', cfg.themes || {});
  // Send available themes organized by view
  socket.emit('available_themes', listThemesByView());

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

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
