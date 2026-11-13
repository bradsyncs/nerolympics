
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL environment variable.");
  process.exit(1);
}

if (!process.env.SESSION_SECRET) {
  console.error("Missing SESSION_SECRET environment variable.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

const DEFAULT_STATE = {
  players: [],
  teams: [],
  events: [],
  matches: [],
  challenges: [],
  announcements: [],
  prizes: [],
  settings: {
    teamsPublished: false,
    mvpOpen: false
  },
  winner: null,
  history: [],
  hallOfFame: [],
  mvpVotes: {}
};

let databaseReady = false;

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: "nerolympics.sid",
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 12 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, "public")));

function makeId() {
  return crypto.randomUUID();
}

function cleanState(state) {
  const clean = {
    ...DEFAULT_STATE,
    ...(state && typeof state === "object" ? state : {})
  };

  for (const key of [
    "players",
    "teams",
    "events",
    "matches",
    "challenges",
    "announcements",
    "prizes",
    "history",
    "hallOfFame"
  ]) {
    if (!Array.isArray(clean[key])) clean[key] = [];
  }

  if (!clean.settings || typeof clean.settings !== "object") {
    clean.settings = {};
  }

  clean.settings = {
    ...DEFAULT_STATE.settings,
    ...clean.settings
  };

  if (!clean.mvpVotes || typeof clean.mvpVotes !== "object") {
    clean.mvpVotes = {};
  }

  return clean;
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(
    `INSERT INTO event_state (id, data)
     VALUES (1, $1::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(DEFAULT_STATE)]
  );

  databaseReady = true;
  console.log("Nerolympics PostgreSQL database ready.");
}

async function getState(client = pool) {
  const result = await client.query(
    "SELECT data FROM event_state WHERE id = 1"
  );

  if (!result.rows.length) {
    return cleanState(DEFAULT_STATE);
  }

  return cleanState(result.rows[0].data);
}

async function saveState(state, client = pool) {
  await client.query(
    `INSERT INTO event_state (id, data, updated_at)
     VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [JSON.stringify(cleanState(state))]
  );
}

function requireStaff(req, res, next) {
  if (!req.session || !req.session.role) {
    return res.status(401).json({ error: "Staff login required." });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || req.session.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

function safePublicState(state) {
  const players = state.players
    .filter(p => p.status !== "Disqualified")
    .map(p => ({
      id: p.id,
      roblox: p.roblox,
      status: p.status,
      points: Number(p.points || 0),
      teamId: p.teamId || null,
      achievements: p.achievements || []
    }));

  const teams = state.settings.teamsPublished
    ? state.teams.map(t => ({
        id: t.id,
        name: t.name,
        captain: t.captain || "",
        memberIds: t.memberIds || [],
        wins: Number(t.wins || 0),
        points: Number(t.points || 0)
      }))
    : [];

  return {
    players,
    teams,
    events: state.events.filter(e => e.published !== false),
    matches: state.matches.filter(m => m.published !== false),
    challenges: state.challenges.filter(c => c.published),
    announcements: state.announcements.filter(a => a.published),
    settings: {
      teamsPublished: Boolean(state.settings.teamsPublished),
      mvpOpen: Boolean(state.settings.mvpOpen)
    },
    winner: state.winner && state.winner.published ? state.winner : null,
    history: state.history,
    hallOfFame: state.hallOfFame,
    mvp: {
      open: Boolean(state.settings.mvpOpen)
    }
  };
}

function validateBackup(body) {
  if (!body || typeof body !== "object") return false;

  const state = body.data || body.state || body;

  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return false;
  }

  const requiredArrays = [
    "players",
    "teams",
    "events",
    "matches",
    "challenges",
    "announcements",
    "prizes"
  ];

  return requiredArrays.every(
    key => Array.isArray(state[key])
  );
}

async function performAction(state, type, payload) {
  const p = payload || {};

  switch (type) {
    case "addPlayer": {
      if (!p.roblox || !String(p.roblox).trim()) {
        throw new Error("Roblox username is required.");
      }

      state.players.push({
        id: makeId(),
        roblox: String(p.roblox).trim(),
        discord: String(p.discord || "").trim(),
        previousClans: String(p.previousClans || ""),
        status: p.status || "Registered",
        points: 0,
        teamId: null,
        registeredAt: new Date().toISOString(),
        checkIns: [],
        achievements: []
      });
      break;
    }

    case "updatePlayer": {
      const player = state.players.find(x => x.id === p.id);
      if (!player) throw new Error("Player not found.");

      Object.assign(player, {
        roblox: p.roblox ?? player.roblox,
        discord: p.discord ?? player.discord,
        previousClans: p.previousClans ?? player.previousClans,
        status: p.status ?? player.status,
        points: p.points === undefined
          ? player.points
          : Number(p.points)
      });
      break;
    }

    case "deletePlayer":
      state.players = state.players.filter(x => x.id !== p.id);
      for (const team of state.teams) {
        team.memberIds = (team.memberIds || []).filter(id => id !== p.id);
      }
      break;

    case "generateTeams": {
      const size = Math.floor(Number(p.size));
      if (!Number.isInteger(size) || size < 1) {
        throw new Error("Enter a valid team size.");
      }

      const eligible = state.players.filter(
        player => player.status !== "Disqualified"
      );

      const shuffled = [...eligible].sort(() => Math.random() - 0.5);
      state.teams = [];

      for (let i = 0; i < shuffled.length; i += size) {
        const members = shuffled.slice(i, i + size);
        const teamNumber = state.teams.length + 1;

        const team = {
          id: makeId(),
          name: `Team ${teamNumber}`,
          captain: members[0]?.roblox || "",
          memberIds: members.map(member => member.id),
          wins: 0,
          points: 0
        };

        state.teams.push(team);
        for (const member of members) member.teamId = team.id;
      }

      state.settings.teamsPublished = false;
      state.winner = null;
      break;
    }

    case "publishTeams":
      if (!state.teams.length) throw new Error("Generate teams first.");
      state.settings.teamsPublished = true;
      break;

    case "resetTeams":
      state.teams = [];
      state.settings.teamsPublished = false;
      for (const player of state.players) player.teamId = null;
      break;

    case "updateTeam": {
      const team = state.teams.find(x => x.id === p.id);
      if (!team) throw new Error("Team not found.");
      if (p.name !== undefined) team.name = String(p.name);
      if (p.captain !== undefined) team.captain = String(p.captain);
      break;
    }

    case "checkin": {
      const player = state.players.find(x => x.id === p.playerId);
      if (!player) throw new Error("Player not found.");

      if (!Array.isArray(player.checkIns)) player.checkIns = [];

      const existing = player.checkIns.find(
        x => x.eventId === p.eventId
      );

      const record = {
        eventId: p.eventId || "",
        status: p.status || "Present",
        updatedAt: new Date().toISOString()
      };

      if (existing) Object.assign(existing, record);
      else player.checkIns.push(record);
      break;
    }

    case "addEvent":
      state.events.push({
        id: makeId(),
        title: String(p.title || "New event"),
        description: String(p.description || ""),
        startAt: p.startAt || null,
        status: p.status || "Upcoming",
        published: p.published !== false
      });
      break;

    case "updateEvent": {
      const event = state.events.find(x => x.id === p.id);
      if (!event) throw new Error("Event not found.");
      Object.assign(event, p, { id: event.id });
      break;
    }

    case "deleteEvent":
      state.events = state.events.filter(x => x.id !== p.id);
      break;

    case "addMatch":
      state.matches.push({
        id: makeId(),
        title: String(p.title || "New match"),
        eventId: p.eventId || "",
        teamIds: Array.isArray(p.teamIds) ? p.teamIds : [],
        status: "scheduled",
        winnerTeamId: null,
        scheduledAt: p.scheduledAt || null,
        published: p.published !== false
      });
      break;

    case "completeMatch": {
      const match = state.matches.find(x => x.id === p.matchId);
      if (!match) throw new Error("Match not found.");

      const winner = state.teams.find(x => x.id === p.winnerTeamId);
      if (!winner) throw new Error("Winning team not found.");

      if (match.status !== "completed") {
        winner.wins = Number(winner.wins || 0) + 1;
        winner.points = Number(winner.points || 0) + 10;

        for (const playerId of winner.memberIds || []) {
          const player = state.players.find(x => x.id === playerId);
          if (player) player.points = Number(player.points || 0) + 10;
        }
      }

      match.status = "completed";
      match.winnerTeamId = winner.id;
      match.completedAt = new Date().toISOString();
      break;
    }

    case "awardPoints": {
      const player = state.players.find(x => x.id === p.playerId);
      if (!player) throw new Error("Player not found.");

      const amount = Number(p.amount);
      if (!Number.isFinite(amount)) throw new Error("Invalid points amount.");

      player.points = Number(player.points || 0) + amount;
      break;
    }

    case "addAchievement": {
      const player = state.players.find(x => x.id === p.playerId);
      if (!player) throw new Error("Player not found.");
      if (!Array.isArray(player.achievements)) player.achievements = [];
      player.achievements.push(String(p.achievement || "Achievement"));
      break;
    }

    case "addChallenge":
      state.challenges.push({
        id: makeId(),
        title: String(p.title || "Bonus challenge"),
        description: String(p.description || ""),
        points: Number(p.points || 0),
        achievement: String(p.achievement || ""),
        published: Boolean(p.published),
        completedBy: []
      });
      break;

    case "completeChallenge": {
      const challenge = state.challenges.find(x => x.id === p.challengeId);
      const player = state.players.find(x => x.id === p.playerId);
      if (!challenge || !player) throw new Error("Challenge or player not found.");

      if (!Array.isArray(challenge.completedBy)) challenge.completedBy = [];

      if (!challenge.completedBy.includes(player.id)) {
        challenge.completedBy.push(player.id);
        player.points = Number(player.points || 0) + Number(challenge.points || 0);

        if (challenge.achievement) {
          player.achievements = player.achievements || [];
          player.achievements.push(challenge.achievement);
        }
      }
      break;
    }

    case "deleteChallenge":
      state.challenges = state.challenges.filter(x => x.id !== p.challengeId);
      break;

    case "toggleMvp":
      state.settings.mvpOpen = Boolean(p.open);
      break;

    case "resetVotes":
      state.mvpVotes = {};
      break;

    case "addAnnouncement":
      state.announcements.push({
        id: makeId(),
        title: String(p.title || "Announcement"),
        body: String(p.body || ""),
        published: Boolean(p.published),
        createdAt: new Date().toISOString()
      });
      break;

    case "updateAnnouncement": {
      const item = state.announcements.find(x => x.id === p.id);
      if (!item) throw new Error("Announcement not found.");
      Object.assign(item, p, { id: item.id });
      break;
    }

    case "deleteAnnouncement":
      state.announcements = state.announcements.filter(x => x.id !== p.id);
      break;

    case "publishWinner": {
      const team = state.teams.find(x => x.id === p.teamId);
      if (!team) throw new Error("Winning team not found.");

      state.winner = {
        id: makeId(),
        teamId: team.id,
        teamName: team.name,
        message: String(p.message || "Congratulations!"),
        publishedAt: new Date().toISOString(),
        published: true
      };

      state.history.push({
        id: makeId(),
        teamName: team.name,
        teamId: team.id,
        date: new Date().toISOString(),
        title: "Nerolympics Champion"
      });

      state.hallOfFame.unshift({
        id: makeId(),
        teamName: team.name,
        teamId: team.id,
        date: new Date().toISOString()
      });
      break;
    }

    case "clearWinner":
      state.winner = null;
      break;

    case "addPrize": {
      const player = state.players.find(x => x.id === p.playerId);
      state.prizes.push({
        id: makeId(),
        playerId: p.playerId || "",
        playerName: player ? player.roblox : String(p.playerName || ""),
        reward: String(p.reward || ""),
        delivered: false,
        public: Boolean(p.public)
      });
      break;
    }

    case "updatePrize": {
      const prize = state.prizes.find(x => x.id === p.id);
      if (!prize) throw new Error("Prize record not found.");
      Object.assign(prize, p, { id: prize.id });
      break;
    }

    default:
      throw new Error("Unknown action: " + type);
  }

  return state;
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/staff", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "staff.html"));
});

app.get("/api/public/state", async (req, res) => {
  try {
    const state = await getState();
    res.json(safePublicState(state));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to load event data." });
  }
});

app.post("/api/mvp/vote", async (req, res) => {
  if (!req.session || !req.session.mvpVoted) {
    try {
      const state = await getState();

      if (!state.settings.mvpOpen) {
        return res.status(400).json({ error: "MVP voting is closed." });
      }

      const player = state.players.find(
        x => x.id === req.body.playerId && x.status !== "Disqualified"
      );

      if (!player) {
        return res.status(400).json({ error: "Select a valid player." });
      }

      state.mvpVotes[player.id] = Number(state.mvpVotes[player.id] || 0) + 1;
      await saveState(state);

      req.session.mvpVoted = true;
      return res.json({ success: true });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "Vote could not be saved." });
    }
  }

  res.status(409).json({ error: "A vote has already been submitted in this session." });
});

app.post("/api/staff/login", (req, res) => {
  const { username, password } = req.body || {};

  const adminMatch =
    process.env.ADMIN_USERNAME &&
    process.env.ADMIN_PASSWORD &&
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD;

  const staffMatch =
    process.env.STAFF_USERNAME &&
    process.env.STAFF_PASSWORD &&
    username === process.env.STAFF_USERNAME &&
    password === process.env.STAFF_PASSWORD;

  if (!adminMatch && !staffMatch) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }

  req.session.regenerate(error => {
    if (error) return res.status(500).json({ error: "Login failed." });

    req.session.role = adminMatch ? "admin" : "staff";
    req.session.username = username;

    req.session.save(saveError => {
      if (saveError) return res.status(500).json({ error: "Login failed." });
      res.json({ success: true, role: req.session.role });
    });
  });
});

app.post("/api/staff/logout", requireStaff, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("nerolympics.sid");
    res.json({ success: true });
  });
});

app.get("/api/staff/me", (req, res) => {
  res.json({
    authenticated: Boolean(req.session && req.session.role),
    role: req.session?.role || null,
    username: req.session?.username || null
  });
});

app.get("/api/staff/state", requireStaff, async (req, res) => {
  try {
    res.json(await getState());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to load staff data." });
  }
});

app.post("/api/staff/action", requireStaff, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT data FROM event_state WHERE id = 1 FOR UPDATE"
    );

    const state = cleanState(result.rows[0]?.data || DEFAULT_STATE);
    const updated = await performAction(
      state,
      req.body?.type,
      req.body?.payload
    );

    await saveState(updated, client);
    await client.query("COMMIT");

    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(400).json({ error: error.message || "Action failed." });
  } finally {
    client.release();
  }
});

app.get("/api/mvp", async (req, res) => {
  try {
    const state = await getState();

    const results = state.players
      .filter(p => p.status !== "Disqualified")
      .map(p => ({
        roblox: p.roblox,
        votes: Number(state.mvpVotes[p.id] || 0)
      }))
      .sort((a, b) => b.votes - a.votes);

    res.json({
      open: Boolean(state.settings.mvpOpen),
      results
    });
  } catch (error) {
    res.status(500).json({ error: "Unable to load MVP results." });
  }
});

app.get("/api/staff/backup", requireStaff, async (req, res) => {
  try {
    const state = await getState();

    const backup = {
      format: "nerolympics-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      data: state
    };

    const filename = `nerolympics-backup-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;

    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );

    res.send(JSON.stringify(backup, null, 2));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Backup export failed." });
  }
});

app.post("/api/staff/restore", requireStaff, requireAdmin, async (req, res) => {
  if (!validateBackup(req.body)) {
    return res.status(400).json({ error: "Invalid backup file." });
  }

  const incoming = req.body.data || req.body.state || req.body;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT id FROM event_state WHERE id = 1 FOR UPDATE"
    );

    await saveState(cleanState(incoming), client);
    await client.query("COMMIT");

    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Backup restore failed." });
  } finally {
    client.release();
  }
});

app.use((req, res) => {
  res.status(404).send("Page not found.");
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Nerolympics running on port ${PORT}`);
    });
  })
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
