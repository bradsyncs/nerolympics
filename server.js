const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL environment variable.");
  process.exit(1);
}

if (!process.env.SESSION_SECRET) {
  console.error("Missing SESSION_SECRET environment variable.");
  process.exit(1);
}

if (
  !process.env.ADMIN_USERNAME ||
  !process.env.ADMIN_PASSWORD ||
  !process.env.STAFF_USERNAME ||
  !process.env.STAFF_PASSWORD
) {
  console.error("Missing staff or admin login environment variables.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

const DEFAULT_PERMISSIONS = {
  addPlayer: true,
  updatePlayer: true,
  deletePlayer: false,
  generateTeams: true,
  publishTeams: true,
  resetTeams: false,
  updateTeam: true,
  checkin: true,
  bulkCheckin: true,
  addEvent: true,
  updateEvent: true,
  deleteEvent: false,
  addMatch: true,
  updateMatch: true,
  completeMatch: true,
  deleteMatch: false,
  awardPoints: true,
  addAchievement: true,
  addChallenge: true,
  completeChallenge: true,
  deleteChallenge: false,
  addAnnouncement: true,
  updateAnnouncement: true,
  deleteAnnouncement: false,
  selectMvp: true,
  addPrize: true,
  updatePrize: true,
  deletePrize: false,
  bulkPrizeDelivered: true,
  bulkPlayerStatus: true,
  bulkAwardPoints: true,
  bulkAssignTeam: true,
  bulkDeletePlayers: false,
  bulkDeleteTeams: false,
  bulkPublishAnnouncements: true,
  bulkDeleteAnnouncements: false,
  restoreRecycleItem: true,
  bulkRestoreRecycleItems: true,
  publishWinner: true
};

const ADMIN_ONLY_ACTIONS = new Set([
  "resetTeams",
  "clearWinner",
  "publishWinner",
  "updatePermissions",
  "setMaintenance",
  "undo",
  "restoreVersion",
  "permanentDeleteRecycleItem",
  "bulkPermanentDeleteRecycleItems",
  "emptyRecycleBin",
  "createBackup",
  "importBackup"
]);

const DEFAULT_STATE = {
  players: [],
  teams: [],
  events: [],
  matches: [],
  challenges: [],
  announcements: [],
  prizes: [],
  recycleBin: [],
  versions: [],
  activityLog: [],
  backups: [],
  settings: {
    teamsPublished: false,
    maintenanceMode: false,
    maintenanceMessage: "The Nerolympics website is currently undergoing maintenance. Please check back soon.",
    staffPermissions: { ...DEFAULT_PERMISSIONS },
    mvp: {
      playerId: null,
      message: "",
      published: false,
      publishedAt: null
    }
  },
  winner: null,
  history: [],
  hallOfFame: []
};

const SNAPSHOT_LIMIT = 40;
const RECYCLE_LIMIT = 500;
const ACTIVITY_LIMIT = 300;
const BACKUP_LIMIT = 30;

app.use(express.json({ limit: "25mb" }));
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

function id() {
  return crypto.randomUUID();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanState(input) {
  const state = {
    ...clone(DEFAULT_STATE),
    ...(input && typeof input === "object" ? input : {})
  };

  const arrayKeys = [
    "players",
    "teams",
    "events",
    "matches",
    "challenges",
    "announcements",
    "prizes",
    "recycleBin",
    "versions",
    "activityLog",
    "backups",
    "history",
    "hallOfFame"
  ];

  for (const key of arrayKeys) {
    if (!Array.isArray(state[key])) {
      state[key] = [];
    }
  }

  state.settings = {
    ...DEFAULT_STATE.settings,
    ...(state.settings || {})
  };

  state.settings.staffPermissions = {
    ...DEFAULT_PERMISSIONS,
    ...(state.settings.staffPermissions || {})
  };

  state.settings.mvp = {
    ...DEFAULT_STATE.settings.mvp,
    ...(state.settings.mvp || {})
  };

  if (!state.settings.maintenanceMessage) {
    state.settings.maintenanceMessage =
      DEFAULT_STATE.settings.maintenanceMessage;
  }

  // Remove the retired Previous Clans field from old records.
  state.players = state.players.map(player => {
    const clean = { ...player };
    delete clean.previousClans;
    return clean;
  });

  return state;
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    INSERT INTO event_state (id, data)
    VALUES (1, $1::jsonb)
    ON CONFLICT (id) DO NOTHING
  `, [JSON.stringify(DEFAULT_STATE)]);

  console.log("Nerolympics database ready.");
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
  await client.query(`
    INSERT INTO event_state (id, data, updated_at)
    VALUES (1, $1::jsonb, NOW())
    ON CONFLICT (id)
    DO UPDATE SET
      data = EXCLUDED.data,
      updated_at = NOW()
  `, [JSON.stringify(cleanState(state))]);
}

function requireStaff(req, res, next) {
  if (!req.session || !req.session.role) {
    return res.status(401).json({
      error: "Staff login required."
    });
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || req.session.role !== "admin") {
    return res.status(403).json({
      error: "Administrator access required."
    });
  }

  next();
}

function addActivity(state, summary) {
  state.activityLog.unshift({
    id: id(),
    summary: String(summary),
    timestamp: new Date().toISOString()
  });

  state.activityLog = state.activityLog.slice(0, ACTIVITY_LIMIT);
}

function createSnapshot(state, summary) {
  const snapshot = clone(state);

  snapshot.versions = [];
  snapshot.activityLog = [];
  snapshot.backups = [];

  state.versions.unshift({
    id: id(),
    summary: String(summary || "Saved version"),
    createdAt: new Date().toISOString(),
    snapshot
  });

  state.versions = state.versions.slice(0, SNAPSHOT_LIMIT);
}

function moveToRecycleBin(state, type, record) {
  if (!record) return;

  state.recycleBin.unshift({
    id: id(),
    type,
    record: clone(record),
    deletedAt: new Date().toISOString()
  });

  state.recycleBin = state.recycleBin.slice(0, RECYCLE_LIMIT);
}

function removePlayerFromTeams(state, playerId) {
  for (const team of state.teams) {
    team.memberIds = (team.memberIds || [])
      .filter(memberId => memberId !== playerId);
  }
}

function assignPlayerToTeam(state, player, teamId) {
  removePlayerFromTeams(state, player.id);

  player.teamId = teamId || null;

  if (teamId) {
    const team = state.teams.find(x => x.id === teamId);

    if (!team) {
      throw new Error("Team not found.");
    }

    if (!Array.isArray(team.memberIds)) {
      team.memberIds = [];
    }

    if (!team.memberIds.includes(player.id)) {
      team.memberIds.push(player.id);
    }
  }
}

function findRecord(array, recordId, label) {
  const record = array.find(x => x.id === recordId);

  if (!record) {
    throw new Error(`${label} not found.`);
  }

  return record;
}

function restoreRecycleRecord(state, recycleId) {
  const index = state.recycleBin.findIndex(x => x.id === recycleId);

  if (index === -1) {
    throw new Error("Recycle Bin record not found.");
  }

  const item = state.recycleBin[index];
  const record = clone(item.record);

  const destinations = {
    player: "players",
    team: "teams",
    event: "events",
    match: "matches",
    challenge: "challenges",
    announcement: "announcements",
    prize: "prizes"
  };

  const destination = destinations[item.type];

  if (!destination) {
    throw new Error("This record type cannot be restored.");
  }

  if (state[destination].some(x => x.id === record.id)) {
    throw new Error("A record with this ID already exists.");
  }

  state[destination].push(record);
  state.recycleBin.splice(index, 1);

  if (item.type === "player" && record.teamId) {
    const team = state.teams.find(x => x.id === record.teamId);

    if (team) {
      team.memberIds = team.memberIds || [];

      if (!team.memberIds.includes(record.id)) {
        team.memberIds.push(record.id);
      }
    }
  }

  return item;
}

function validateBackup(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }

  const data = body.data || body.state || body;

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }

  const required = [
    "players",
    "teams",
    "events",
    "matches",
    "challenges",
    "announcements",
    "prizes"
  ];

  return required.every(key => Array.isArray(data[key]));
}

function safePublicState(state) {
  const players = state.players
    .filter(player => player.status !== "Disqualified")
    .map(player => ({
      id: player.id,
      roblox: player.roblox,
      status: player.status,
      points: Number(player.points || 0),
      teamId: player.teamId || null,
      achievements: player.achievements || []
    }));

  const teams = state.settings.teamsPublished
    ? state.teams.map(team => ({
        id: team.id,
        name: team.name,
        captain: team.captain || "",
        memberIds: team.memberIds || [],
        wins: Number(team.wins || 0),
        points: Number(team.points || 0)
      }))
    : [];

  const mvp = state.settings.mvp || {};

  return {
    players,
    teams,
    events: state.events.filter(x => x.published !== false),
    matches: state.matches.filter(x => x.published !== false),
    challenges: state.challenges.filter(x => x.published),
    announcements: state.announcements.filter(x => x.published),
    prizes: state.prizes.filter(x => x.public),
    settings: {
      teamsPublished: Boolean(state.settings.teamsPublished),
      maintenanceMode: Boolean(state.settings.maintenanceMode)
    },
    winner: state.winner && state.winner.published
      ? state.winner
      : null,
    history: state.history,
    hallOfFame: state.hallOfFame,
    mvp: {
      playerId: mvp.published ? mvp.playerId : null,
      message: mvp.published ? mvp.message : "",
      published: Boolean(mvp.published),
      publishedAt: mvp.publishedAt || null
    }
  };
}

function publicMaintenancePage(message) {
  const safeMessage = String(message || "")
    .replace(/[&<>"']/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nerolympics | Maintenance</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;
background:#090910;color:#fff;font-family:Arial,sans-serif;padding:24px}
main{max-width:620px;text-align:center;padding:48px 30px;
border:1px solid #39304e;border-radius:20px;
background:linear-gradient(145deg,#171329,#11121b)}
h1{font-size:clamp(28px,6vw,44px);margin:0 0 18px}
p{color:#c8c3dc;line-height:1.7}
</style>
</head>
<body>
<main>
<h1>The Nerolympics</h1>
<p>${safeMessage}</p>
</main>
</body>
</html>`;
}

// Public maintenance mode does not block staff pages or API routes.
app.get("/", async (req, res, next) => {
  try {
    const state = await getState();

    if (state.settings.maintenanceMode) {
      return res.status(503).send(
        publicMaintenancePage(state.settings.maintenanceMessage)
      );
    }

    res.sendFile(path.join(__dirname, "public", "index.html"));
  } catch (error) {
    next(error);
  }
});

app.get("/staff", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "staff.html"));
});

app.get("/api/public/state", async (req, res) => {
  try {
    const state = await getState();

    if (state.settings.maintenanceMode) {
      return res.status(503).json({
        maintenanceMode: true,
        message: state.settings.maintenanceMessage
      });
    }

    res.json(safePublicState(state));
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Unable to load event data."
    });
  }
});

app.post("/api/staff/login", (req, res) => {
  const { username, password } = req.body || {};

  const adminMatch =
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD;

  const staffMatch =
    username === process.env.STAFF_USERNAME &&
    password === process.env.STAFF_PASSWORD;

  if (!adminMatch && !staffMatch) {
    return res.status(401).json({
      error: "Incorrect username or password."
    });
  }

  req.session.regenerate(error => {
    if (error) {
      return res.status(500).json({
        error: "Login failed."
      });
    }

    req.session.role = adminMatch ? "admin" : "staff";
    req.session.username = username;

    req.session.save(saveError => {
      if (saveError) {
        return res.status(500).json({
          error: "Unable to save login session."
        });
      }

      res.json({
        success: true,
        role: req.session.role
      });
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
    authenticated: Boolean(req.session?.role),
    role: req.session?.role || null,
    username: req.session?.username || null
  });
});

app.get("/api/staff/state", requireStaff, async (req, res) => {
  try {
    const state = await getState();

    if (req.session.role !== "admin") {
      state.versions = [];
      state.backups = [];
      state.settings.staffPermissions = {};
    }

    res.json(state);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Unable to load staff data."
    });
  }
});

function permissionForAction(type) {
  const aliases = {
    bulkDeletePlayers: "bulkDeletePlayers",
    bulkDeleteTeams: "bulkDeleteTeams",
    bulkDeleteAnnouncements: "bulkDeleteAnnouncements",
    bulkRestoreRecycleItems: "bulkRestoreRecycleItems",
    bulkPrizeDelivered: "bulkPrizeDelivered"
  };

  return aliases[type] || type;
}

async function performAction(state, type, payload) {
  const p = payload || {};
  const now = new Date().toISOString();

  switch (type) {
    case "addPlayer": {
      const roblox = String(p.roblox || "").trim();

      if (!roblox) {
        throw new Error("Roblox username is required.");
      }

      if (state.players.some(x =>
        String(x.roblox).toLowerCase() === roblox.toLowerCase()
      )) {
        throw new Error("This participant is already registered.");
      }

      state.players.push({
        id: id(),
        roblox,
        discord: String(p.discord || "").trim(),
        status: p.status || "Registered",
        points: 0,
        teamId: null,
        registeredAt: now,
        checkIns: [],
        achievements: []
      });

      break;
    }

    case "updatePlayer": {
      const player = findRecord(state.players, p.id, "Participant");

      if (p.roblox !== undefined) {
        player.roblox = String(p.roblox).trim();
      }

      if (p.discord !== undefined) {
        player.discord = String(p.discord).trim();
      }

      if (p.status !== undefined) {
        player.status = String(p.status);
      }

      if (p.points !== undefined) {
        const points = Number(p.points);

        if (!Number.isFinite(points)) {
          throw new Error("Invalid points value.");
        }

        player.points = points;
      }

      break;
    }

    case "deletePlayer": {
      const player = findRecord(state.players, p.id, "Participant");

      moveToRecycleBin(state, "player", player);
      state.players = state.players.filter(x => x.id !== p.id);
      removePlayerFromTeams(state, p.id);

      break;
    }

    case "bulkDeletePlayers": {
      const ids = p.playerIds || [];

      for (const playerId of ids) {
        const player = state.players.find(x => x.id === playerId);

        if (player) {
          moveToRecycleBin(state, "player", player);
          removePlayerFromTeams(state, playerId);
        }
      }

      state.players = state.players.filter(x => !ids.includes(x.id));
      break;
    }

    case "bulkPlayerStatus": {
      const ids = p.playerIds || [];

      for (const player of state.players) {
        if (ids.includes(player.id)) {
          player.status = String(p.status || player.status);
        }
      }

      break;
    }

    case "bulkAwardPoints": {
      const amount = Number(p.amount);

      if (!Number.isFinite(amount)) {
        throw new Error("Invalid points amount.");
      }

      for (const player of state.players) {
        if ((p.playerIds || []).includes(player.id)) {
          player.points = Number(player.points || 0) + amount;
        }
      }

      break;
    }

    case "bulkAssignTeam": {
      const ids = p.playerIds || [];

      for (const player of state.players) {
        if (ids.includes(player.id)) {
          assignPlayerToTeam(state, player, p.teamId || null);
        }
      }

      break;
    }

    case "generateTeams": {
      const size = Math.floor(Number(p.size));

      if (!Number.isInteger(size) || size < 1) {
        throw new Error("Enter a valid team size.");
      }

      const eligible = state.players.filter(
        x => x.status !== "Disqualified"
      );

      const shuffled = [...eligible].sort(() => Math.random() - 0.5);

      state.teams = [];

      for (let i = 0; i < shuffled.length; i += size) {
        const members = shuffled.slice(i, i + size);

        const team = {
          id: id(),
          name: `Team ${state.teams.length + 1}`,
          captain: members[0]?.roblox || "",
          memberIds: members.map(x => x.id),
          wins: 0,
          points: 0
        };

        state.teams.push(team);

        for (const player of members) {
          player.teamId = team.id;
        }
      }

      state.settings.teamsPublished = false;
      state.winner = null;

      break;
    }

    case "publishTeams":
      if (!state.teams.length) {
        throw new Error("Generate teams first.");
      }

      state.settings.teamsPublished = true;
      break;

    case "resetTeams":
      for (const team of state.teams) {
        moveToRecycleBin(state, "team", team);
      }

      state.teams = [];
      state.settings.teamsPublished = false;

      for (const player of state.players) {
        player.teamId = null;
      }

      break;

    case "updateTeam": {
      const team = findRecord(state.teams, p.id, "Team");

      if (p.name !== undefined) {
        team.name = String(p.name);
      }

      if (p.captain !== undefined) {
        team.captain = String(p.captain);
      }

      break;
    }

    case "bulkDeleteTeams": {
      const ids = p.ids || [];

      for (const teamId of ids) {
        const team = state.teams.find(x => x.id === teamId);

        if (team) {
          moveToRecycleBin(state, "team", team);

          for (const player of state.players) {
            if (player.teamId === teamId) {
              player.teamId = null;
            }
          }
        }
      }

      state.teams = state.teams.filter(x => !ids.includes(x.id));
      break;
    }

    case "checkin": {
      const player = findRecord(state.players, p.playerId, "Participant");

      if (!Array.isArray(player.checkIns)) {
        player.checkIns = [];
      }

      const existing = player.checkIns.find(
        x => x.eventId === (p.eventId || "")
      );

      const record = {
        eventId: p.eventId || "",
        status: p.status || "Present",
        updatedAt: now
      };

      if (existing) {
        Object.assign(existing, record);
      } else {
        player.checkIns.push(record);
      }

      break;
    }

    case "bulkCheckin": {
      for (const player of state.players) {
        if (!(p.playerIds || []).includes(player.id)) continue;

        if (!Array.isArray(player.checkIns)) {
          player.checkIns = [];
        }

        const eventId = p.eventId || "";

        const existing = player.checkIns.find(
          x => x.eventId === eventId
        );

        const record = {
          eventId,
          status: p.status || "Present",
          updatedAt: now
        };

        if (existing) {
          Object.assign(existing, record);
        } else {
          player.checkIns.push(record);
        }
      }

      break;
    }

    case "addEvent":
      state.events.push({
        id: id(),
        title: String(p.title || "New event"),
        description: String(p.description || ""),
        startAt: p.startAt || null,
        status: p.status || "Upcoming",
        published: p.published !== false
      });
      break;

    case "updateEvent": {
      const event = findRecord(state.events, p.id, "Event");

      Object.assign(event, p, { id: event.id });
      break;
    }

    case "deleteEvent": {
      const event = findRecord(state.events, p.id, "Event");

      moveToRecycleBin(state, "event", event);
      state.events = state.events.filter(x => x.id !== p.id);

      break;
    }

    case "addMatch":
      state.matches.push({
        id: id(),
        title: String(p.title || "New match"),
        eventId: p.eventId || "",
        teamIds: Array.isArray(p.teamIds) ? p.teamIds : [],
        status: "Scheduled",
        winnerTeamId: null,
        scheduledAt: p.scheduledAt || null,
        published: p.published !== false
      });
      break;

    case "updateMatch": {
      const match = findRecord(state.matches, p.id, "Match");

      Object.assign(match, p, { id: match.id });
      break;
    }

    case "completeMatch": {
      const match = findRecord(
        state.matches,
        p.matchId,
        "Match"
      );

      const winner = findRecord(
        state.teams,
        p.winnerTeamId,
        "Winning team"
      );

      if (match.status !== "Completed" &&
          match.status !== "completed") {
        winner.wins = Number(winner.wins || 0) + 1;
        winner.points = Number(winner.points || 0) + 10;

        for (const playerId of winner.memberIds || []) {
          const player = state.players.find(x => x.id === playerId);

          if (player) {
            player.points = Number(player.points || 0) + 10;
          }
        }
      }

      match.status = "Completed";
      match.winnerTeamId = winner.id;
      match.completedAt = now;

      break;
    }

    case "deleteMatch": {
      const match = findRecord(state.matches, p.id || p.matchId, "Match");

      moveToRecycleBin(state, "match", match);
      state.matches = state.matches.filter(x => x.id !== match.id);

      break;
    }

    case "awardPoints": {
      const player = findRecord(state.players, p.playerId, "Participant");
      const amount = Number(p.amount);

      if (!Number.isFinite(amount)) {
        throw new Error("Invalid points amount.");
      }

      player.points = Number(player.points || 0) + amount;
      break;
    }

    case "addAchievement": {
      const player = findRecord(state.players, p.playerId, "Participant");

      if (!Array.isArray(player.achievements)) {
        player.achievements = [];
      }

      player.achievements.push(
        String(p.achievement || p.name || "Achievement")
      );

      break;
    }

    case "addChallenge":
      state.challenges.push({
        id: id(),
        title: String(p.title || "Bonus challenge"),
        description: String(p.description || ""),
        points: Number(p.points || 0),
        achievement: String(p.achievement || ""),
        published: Boolean(p.published),
        completedBy: []
      });
      break;

    case "completeChallenge": {
      const challenge = findRecord(
        state.challenges,
        p.challengeId,
        "Challenge"
      );

      const player = findRecord(
        state.players,
        p.playerId,
        "Participant"
      );

      challenge.completedBy = challenge.completedBy || [];

      if (!challenge.completedBy.includes(player.id)) {
        challenge.completedBy.push(player.id);

        player.points =
          Number(player.points || 0) +
          Number(challenge.points || 0);

        if (challenge.achievement) {
          player.achievements = player.achievements || [];
          player.achievements.push(challenge.achievement);
        }
      }

      break;
    }

    case "deleteChallenge": {
      const challenge = findRecord(
        state.challenges,
        p.challengeId || p.id,
        "Challenge"
      );

      moveToRecycleBin(state, "challenge", challenge);

      state.challenges = state.challenges.filter(
        x => x.id !== challenge.id
      );

      break;
    }

    case "addAnnouncement":
      state.announcements.push({
        id: id(),
        title: String(p.title || "Announcement"),
        body: String(p.body || ""),
        published: Boolean(p.published),
        createdAt: now
      });
      break;

    case "updateAnnouncement": {
      const announcement = findRecord(
        state.announcements,
        p.id,
        "Announcement"
      );

      Object.assign(announcement, p, { id: announcement.id });
      break;
    }

    case "deleteAnnouncement": {
      const announcement = findRecord(
        state.announcements,
        p.id,
        "Announcement"
      );

      moveToRecycleBin(state, "announcement", announcement);

      state.announcements = state.announcements.filter(
        x => x.id !== p.id
      );

      break;
    }

    case "bulkPublishAnnouncements": {
      for (const announcement of state.announcements) {
        if ((p.ids || []).includes(announcement.id)) {
          announcement.published = Boolean(p.published);
        }
      }

      break;
    }

    case "bulkDeleteAnnouncements": {
      const ids = p.ids || [];

      for (const announcementId of ids) {
        const announcement = state.announcements.find(
          x => x.id === announcementId
        );

        if (announcement) {
          moveToRecycleBin(state, "announcement", announcement);
        }
      }

      state.announcements = state.announcements.filter(
        x => !ids.includes(x.id)
      );

      break;
    }

    case "publishWinner": {
      const team = findRecord(state.teams, p.teamId, "Team");

      state.winner = {
        id: id(),
        teamId: team.id,
        teamName: team.name,
        message: String(p.message || "Congratulations!"),
        publishedAt: now,
        published: true
      };

      state.history.unshift({
        id: id(),
        teamId: team.id,
        teamName: team.name,
        title: "Nerolympics Champion",
        date: now
      });

      state.hallOfFame.unshift({
        id: id(),
        teamId: team.id,
        teamName: team.name,
        date: now
      });

      break;
    }

    case "clearWinner":
      state.winner = null;
      break;

    case "selectMvp": {
      const player = findRecord(
        state.players,
        p.playerId,
        "Participant"
      );

      state.settings.mvp = {
        playerId: player.id,
        message: String(p.message || ""),
        published: Boolean(p.published),
        publishedAt: p.published ? now : null
      };

      break;
    }

    case "addPrize": {
      const player = state.players.find(x => x.id === p.playerId);

      state.prizes.push({
        id: id(),
        playerId: p.playerId || "",
        playerName: player
          ? player.roblox
          : String(p.playerName || ""),
        reward: String(p.reward || ""),
        delivered: false,
        public: Boolean(p.public)
      });

      break;
    }

    case "updatePrize": {
      const prize = findRecord(state.prizes, p.id, "Prize");

      Object.assign(prize, p, { id: prize.id });
      break;
    }

    case "deletePrize": {
      const prize = findRecord(
        state.prizes,
        p.id || p.prizeId,
        "Prize"
      );

      moveToRecycleBin(state, "prize", prize);

      state.prizes = state.prizes.filter(x => x.id !== prize.id);
      break;
    }

    case "bulkPrizeDelivered": {
      for (const prize of state.prizes) {
        if ((p.ids || []).includes(prize.id)) {
          prize.delivered = Boolean(p.delivered);
        }
      }

      break;
    }

    case "restoreRecycleItem":
      restoreRecycleRecord(state, p.id);
      break;

    case "bulkRestoreRecycleItems":
      for (const recycleId of p.ids || p.recycleIds || []) {
        restoreRecycleRecord(state, recycleId);
      }
      break;

    case "permanentDeleteRecycleItem": {
      const index = state.recycleBin.findIndex(x => x.id === p.id);

      if (index === -1) {
        throw new Error("Recycle Bin record not found.");
      }

      state.recycleBin.splice(index, 1);
      break;
    }

    case "bulkPermanentDeleteRecycleItems": {
      const ids = p.ids || [];

      state.recycleBin = state.recycleBin.filter(
        x => !ids.includes(x.id)
      );

      break;
    }

    case "emptyRecycleBin":
      state.recycleBin = [];
      break;

    case "updatePermissions": {
      const incoming = p.permissions || {};

      for (const key of Object.keys(DEFAULT_PERMISSIONS)) {
        if (typeof incoming[key] === "boolean") {
          state.settings.staffPermissions[key] = incoming[key];
        }
      }

      break;
    }

    case "setMaintenance":
      state.settings.maintenanceMode = Boolean(p.enabled);
      state.settings.maintenanceMessage = String(
        p.message || DEFAULT_STATE.settings.maintenanceMessage
      );
      break;

    case "undo": {
      const previous = state.versions[0];

      if (!previous) {
        throw new Error("There is no previous version to restore.");
      }

      const restored = cleanState(previous.snapshot);

      state.players = restored.players;
      state.teams = restored.teams;
      state.events = restored.events;
      state.matches = restored.matches;
      state.challenges = restored.challenges;
      state.announcements = restored.announcements;
      state.prizes = restored.prizes;
      state.recycleBin = restored.recycleBin;
      state.settings = restored.settings;
      state.winner = restored.winner;
      state.history = restored.history;
      state.hallOfFame = restored.hallOfFame;

      break;
    }

    case "restoreVersion": {
      const version = findRecord(
        state.versions,
        p.versionId,
        "Version"
      );

      const restored = cleanState(version.snapshot);

      state.players = restored.players;
      state.teams = restored.teams;
      state.events = restored.events;
      state.matches = restored.matches;
      state.challenges = restored.challenges;
      state.announcements = restored.announcements;
      state.prizes = restored.prizes;
      state.recycleBin = restored.recycleBin;
      state.settings = restored.settings;
      state.winner = restored.winner;
      state.history = restored.history;
      state.hallOfFame = restored.hallOfFame;

      break;
    }

    case "createBackup": {
      state.backups.unshift({
        id: id(),
        createdAt: now,
        summary: "Manual backup",
        data: clone({
          ...state,
          versions: [],
          activityLog: [],
          backups: []
        })
      });

      state.backups = state.backups.slice(0, BACKUP_LIMIT);
      break;
    }

    case "importBackup": {
      const backup = p.backup;

      if (!validateBackup(backup)) {
        throw new Error("The selected backup is invalid.");
      }

      const incoming = cleanState(
        backup.data || backup.state || backup
      );

      state.players = incoming.players;
      state.teams = incoming.teams;
      state.events = incoming.events;
      state.matches = incoming.matches;
      state.challenges = incoming.challenges;
      state.announcements = incoming.announcements;
      state.prizes = incoming.prizes;
      state.recycleBin = incoming.recycleBin;
      state.settings = incoming.settings;
      state.winner = incoming.winner;
      state.history = incoming.history;
      state.hallOfFame = incoming.hallOfFame;

      break;
    }

    default:
      throw new Error("Unknown action: " + type);
  }

  return state;
}

app.post("/api/staff/action", requireStaff, async (req, res) => {
  const type = req.body?.type;
  const payload = req.body?.payload || {};
  const role = req.session.role;

  if (!type || typeof type !== "string") {
    return res.status(400).json({
      error: "An action type is required."
    });
  }

  if (ADMIN_ONLY_ACTIONS.has(type) && role !== "admin") {
    return res.status(403).json({
      error: "Administrator access required for this action."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      "SELECT data FROM event_state WHERE id = 1 FOR UPDATE"
    );

    const state = cleanState(result.rows[0]?.data || DEFAULT_STATE);

    if (role !== "admin") {
      const permission = permissionForAction(type);

      if (state.settings.staffPermissions[permission] !== true) {
        throw new Error("This action is disabled for standard staff.");
      }
    }

    // Save a snapshot before changes, excluding administrative housekeeping.
    if (!["createBackup"].includes(type)) {
      createSnapshot(state, `Before: ${type}`);
    }

    await performAction(state, type, payload);

    // Shared accounts only: never store a person's identity in the log.
    addActivity(state, `Action completed: ${type}`);

    await saveState(state, client);

    await client.query("COMMIT");

    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(error);

    res.status(400).json({
      error: error.message || "Action failed."
    });
  } finally {
    client.release();
  }
});

app.get("/api/staff/analytics", requireStaff, async (req, res) => {
  try {
    const state = await getState();

    const total = state.players.length;

    const active = state.players.filter(
      x => x.status !== "Disqualified"
    ).length;

    const checkedIn = state.players.filter(
      x => (x.checkIns || []).some(c => c.status === "Present")
    ).length;

    const totalPoints = state.players.reduce(
      (sum, player) => sum + Number(player.points || 0),
      0
    );

    const completedMatches = state.matches.filter(
      x => x.status === "Completed" || x.status === "completed"
    ).length;

    const teamStats = state.teams.map(team => ({
      id: team.id,
      name: team.name,
      players: (team.memberIds || []).length,
      points: Number(team.points || 0),
      wins: Number(team.wins || 0)
    }));

    res.json({
      participants: total,
      active,
      participationRate: total
        ? Math.round((checkedIn / total) * 100)
        : 0,
      totalPoints,
      matches: state.matches.length,
      completedMatches,
      teamStats
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Unable to load analytics."
    });
  }
});

app.get("/api/staff/search", requireStaff, async (req, res) => {
  try {
    const state = await getState();
    const query = String(req.query.q || "").toLowerCase().trim();

    if (!query) {
      return res.json({ results: [] });
    }

    const collections = [
      ["Participant", state.players, ["roblox", "discord"]],
      ["Team", state.teams, ["name", "captain"]],
      ["Event", state.events, ["title", "description"]],
      ["Match", state.matches, ["title"]],
      ["Challenge", state.challenges, ["title", "description"]],
      ["Announcement", state.announcements, ["title", "body"]],
      ["Prize", state.prizes, ["playerName", "reward"]]
    ];

    const results = [];

    for (const [type, records, fields] of collections) {
      for (const record of records) {
        if (fields.some(field =>
          String(record[field] || "").toLowerCase().includes(query)
        )) {
          results.push({
            type,
            id: record.id,
            name:
              record.roblox ||
              record.name ||
              record.title ||
              record.playerName ||
              type
          });
        }
      }
    }

    for (const item of state.recycleBin) {
      const record = item.record || {};

      const searchable = JSON.stringify(record).toLowerCase();

      if (searchable.includes(query)) {
        results.push({
          type: `Recycle Bin: ${item.type}`,
          id: item.id,
          name:
            record.roblox ||
            record.name ||
            record.title ||
            item.type
        });
      }
    }

    res.json({ results: results.slice(0, 100) });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Search failed."
    });
  }
});

app.get("/api/staff/backup", requireStaff, requireAdmin, async (req, res) => {
  try {
    const state = await getState();

    const backup = {
      format: "nerolympics-backup",
      version: 2,
      exportedAt: new Date().toISOString(),
      data: state
    };

    res.json(backup);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Backup export failed."
    });
  }
});

app.get("/api/staff/backups", requireStaff, requireAdmin, async (req, res) => {
  try {
    const state = await getState();

    res.json(state.backups.map(backup => ({
      id: backup.id,
      createdAt: backup.createdAt,
      summary: backup.summary
    })));
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Unable to load backups."
    });
  }
});

app.post("/api/staff/restore", requireStaff, requireAdmin, async (req, res) => {
  if (!validateBackup(req.body)) {
    return res.status(400).json({
      error: "Invalid backup file."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      "SELECT data FROM event_state WHERE id = 1 FOR UPDATE"
    );

    const current = cleanState(result.rows[0]?.data || DEFAULT_STATE);

    createSnapshot(current, "Before backup restoration");

    const incoming = cleanState(
      req.body.data || req.body.state || req.body
    );

    incoming.versions = current.versions;
    incoming.activityLog = current.activityLog;
    incoming.backups = current.backups;

    addActivity(incoming, "Backup restored");

    await saveState(incoming, client);

    await client.query("COMMIT");

    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(error);

    res.status(500).json({
      error: "Backup restore failed."
    });
  } finally {
    client.release();
  }
});

// Automatic database backup every six hours while the server is running.
async function automaticBackup() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      "SELECT data FROM event_state WHERE id = 1 FOR UPDATE"
    );

    const state = cleanState(result.rows[0]?.data || DEFAULT_STATE);

    state.backups.unshift({
      id: id(),
      createdAt: new Date().toISOString(),
      summary: "Automatic backup",
      data: clone({
        ...state,
        versions: [],
        activityLog: [],
        backups: []
      })
    });

    state.backups = state.backups.slice(0, BACKUP_LIMIT);

    await saveState(state, client);

    await client.query("COMMIT");

    console.log("Automatic Nerolympics backup created.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Automatic backup failed:", error);
  } finally {
    client.release();
  }
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Nerolympics"
  });
});

app.use((req, res) => {
  res.status(404).send("Page not found.");
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Nerolympics running on port ${PORT}`);
    });

    setInterval(automaticBackup, 6 * 60 * 60 * 1000);
  })
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });