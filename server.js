
const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "nerolympics.json");

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: "nerolympics.sid",
  secret: process.env.SESSION_SECRET || "change-this-before-deploying",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 12
  }
}));

const emptyState = () => ({
  players: [],
  teams: [],
  events: [],
  matches: [],
  challenges: [],
  announcements: [],
  prizes: [],
  history: [],
  hallOfFame: [],
  settings: {
    teamsPublished: false,
    teamSize: 4,
    mvpOpen: false
  },
  winner: null,
  mvpVotes: {}
});

function ensureDataFile() {
  const folder = path.dirname(DATA_FILE);
  fs.mkdirSync(folder, { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(emptyState(), null, 2));
  }
}

function loadState() {
  ensureDataFile();

  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    const defaults = emptyState();

    return {
      ...defaults,
      ...saved,
      settings: { ...defaults.settings, ...(saved.settings || {}) },
      players: Array.isArray(saved.players) ? saved.players : [],
      teams: Array.isArray(saved.teams) ? saved.teams : [],
      events: Array.isArray(saved.events) ? saved.events : [],
      matches: Array.isArray(saved.matches) ? saved.matches : [],
      challenges: Array.isArray(saved.challenges) ? saved.challenges : [],
      announcements: Array.isArray(saved.announcements) ? saved.announcements : [],
      prizes: Array.isArray(saved.prizes) ? saved.prizes : [],
      history: Array.isArray(saved.history) ? saved.history : [],
      hallOfFame: Array.isArray(saved.hallOfFame) ? saved.hallOfFame : [],
      mvpVotes: saved.mvpVotes || {}
    };
  } catch (error) {
    console.error("Could not read event data:", error);
    throw new Error("The event data file could not be read.");
  }
}

let state = loadState();

function saveState() {
  const temporary = DATA_FILE + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, DATA_FILE);
}

function id() {
  return require("crypto").randomUUID();
}

function clean(value) {
  return String(value ?? "").trim().slice(0, 500);
}

function staffRequired(req, res, next) {
  if (!req.session.staff) {
    return res.status(401).json({ error: "Staff login required." });
  }
  next();
}

function publicState() {
  return {
    players: state.players.map(p => ({
      id: p.id,
      roblox: p.roblox,
      discord: p.discord,
      status: p.status,
      points: p.points || 0,
      teamId: p.teamId || null,
      achievements: p.achievements || []
    })),
    teams: state.settings.teamsPublished ? state.teams : [],
    events: state.events.filter(e => e.published !== false),
    matches: state.matches.filter(m => m.published !== false),
    challenges: state.challenges.filter(c => c.published),
    announcements: state.announcements.filter(a => a.published),
    settings: {
      teamsPublished: state.settings.teamsPublished,
      mvpOpen: state.settings.mvpOpen
    },
    winner: state.winner,
    history: state.history,
    hallOfFame: state.hallOfFame,
    mvp: {
      open: !!state.settings.mvpOpen
    }
  };
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/staff", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "staff.html"));
});

/* PUBLIC API */

app.get("/api/public/state", (req, res) => {
  res.json(publicState());
});

app.post("/api/mvp/vote", (req, res) => {
  if (!state.settings.mvpOpen) {
    return res.status(403).json({ error: "MVP voting is closed." });
  }

  const playerId = clean(req.body.playerId);
  const player = state.players.find(p => p.id === playerId);

  if (!player) {
    return res.status(404).json({ error: "Player not found." });
  }

  // One vote per browser session.
  if (req.session.mvpVoted) {
    return res.status(409).json({ error: "A vote has already been submitted from this session." });
  }

  state.mvpVotes[playerId] = (state.mvpVotes[playerId] || 0) + 1;
  req.session.mvpVoted = true;
  saveState();

  res.json({ success: true });
});

/* STAFF AUTHENTICATION */

app.post("/api/staff/login", (req, res) => {
  const username = clean(req.body.username);
  const password = String(req.body.password || "");

  const adminMatch =
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD;

  const staffMatch =
    username === process.env.STAFF_USERNAME &&
    password === process.env.STAFF_PASSWORD;

  if ((!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) &&
      (!process.env.STAFF_USERNAME || !process.env.STAFF_PASSWORD)) {
    return res.status(500).json({ error: "Staff credentials have not been configured." });
  }

  if (!adminMatch && !staffMatch) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }

  req.session.staff = {
    username,
    role: adminMatch ? "admin" : "staff"
  };

  res.json({ success: true, role: req.session.staff.role });
});

app.post("/api/staff/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("nerolympics.sid");
    res.json({ success: true });
  });
});

app.get("/api/staff/me", staffRequired, (req, res) => {
  res.json({ staff: req.session.staff });
});

app.get("/api/staff/state", staffRequired, (req, res) => {
  res.json(state);
});

/* STAFF ACTIONS */

app.post("/api/staff/action", staffRequired, (req, res) => {
  const { type, payload = {} } = req.body || {};

  try {
    let result = { success: true };

    switch (type) {

      case "addPlayer": {
        const roblox = clean(payload.roblox);
        const discord = clean(payload.discord);

        if (!roblox || !discord) {
          throw new Error("Roblox and Discord usernames are required.");
        }

        const player = {
          id: id(),
          roblox,
          discord,
          previousClans: clean(payload.previousClans),
          status: "Registered",
          points: 0,
          teamId: null,
          registeredAt: new Date().toISOString(),
          checkIns: {},
          achievements: []
        };

        state.players.push(player);
        result.player = player;
        break;
      }

      case "updatePlayer": {
        const player = state.players.find(p => p.id === payload.id);
        if (!player) throw new Error("Player not found.");

        Object.assign(player, {
          roblox: clean(payload.roblox ?? player.roblox),
          discord: clean(payload.discord ?? player.discord),
          status: clean(payload.status ?? player.status),
          points: Number(payload.points ?? player.points) || 0
        });
        break;
      }

      case "deletePlayer": {
        state.players = state.players.filter(p => p.id !== payload.id);
        state.teams.forEach(t => {
          t.memberIds = (t.memberIds || []).filter(id => id !== payload.id);
        });
        break;
      }

      case "generateTeams": {
        if (state.settings.teamsPublished) {
          throw new Error("Published teams cannot be rerolled. Reset teams first.");
        }

        const size = Math.max(1, Math.min(100, Number(payload.teamSize || state.settings.teamSize || 4)));
        const eligible = state.players.filter(p => p.status !== "Removed");

        if (!eligible.length) throw new Error("There are no registered players.");

        const shuffled = [...eligible].sort(() => Math.random() - 0.5);
        state.teams = [];

        for (let i = 0; i < shuffled.length; i += size) {
          const members = shuffled.slice(i, i + size);
          const team = {
            id: id(),
            name: `Team ${state.teams.length + 1}`,
            captain: "",
            memberIds: members.map(p => p.id),
            wins: 0,
            points: 0
          };

          state.teams.push(team);
          members.forEach(p => p.teamId = team.id);
        }

        state.settings.teamSize = size;
        state.settings.teamsPublished = false;
        break;
      }

      case "publishTeams": {
        if (!state.teams.length) throw new Error("Generate teams before publishing.");
        state.settings.teamsPublished = true;
        break;
      }

      case "resetTeams": {
        state.settings.teamsPublished = false;
        state.teams = [];
        state.players.forEach(p => p.teamId = null);
        break;
      }

      case "updateTeam": {
        const team = state.teams.find(t => t.id === payload.id);
        if (!team) throw new Error("Team not found.");

        if (state.settings.teamsPublished) {
          throw new Error("Unpublish or reset teams before editing them.");
        }

        if (payload.name !== undefined) team.name = clean(payload.name);
        if (payload.captain !== undefined) team.captain = clean(payload.captain);
        break;
      }

      case "checkin": {
        const player = state.players.find(p => p.id === payload.playerId);
        if (!player) throw new Error("Player not found.");

        player.checkIns = player.checkIns || {};
        player.checkIns[clean(payload.eventId || "general")] = true;
        player.status = "Checked In";
        break;
      }

      case "addEvent": {
        const event = {
          id: id(),
          title: clean(payload.title),
          description: clean(payload.description),
          startAt: payload.startAt || null,
          status: clean(payload.status || "Upcoming"),
          published: payload.published !== false
        };

        if (!event.title) throw new Error("Event title is required.");
        state.events.push(event);
        result.event = event;
        break;
      }

      case "updateEvent": {
        const event = state.events.find(e => e.id === payload.id);
        if (!event) throw new Error("Event not found.");
        Object.assign(event, payload);
        break;
      }

      case "deleteEvent": {
        state.events = state.events.filter(e => e.id !== payload.id);
        break;
      }

      case "addMatch": {
        const match = {
          id: id(),
          title: clean(payload.title),
          eventId: payload.eventId || null,
          teamIds: Array.isArray(payload.teamIds) ? payload.teamIds : [],
          status: "Scheduled",
          winnerTeamId: null,
          scheduledAt: payload.scheduledAt || null,
          published: payload.published !== false
        };

        if (!match.title) throw new Error("Match title is required.");
        state.matches.push(match);
        result.match = match;
        break;
      }

      case "completeMatch": {
        const match = state.matches.find(m => m.id === payload.id);
        if (!match) throw new Error("Match not found.");
        if (match.status === "Completed") throw new Error("This match is already completed.");

        const winningTeamId = payload.winnerTeamId;
        const team = state.teams.find(t => t.id === winningTeamId);

        if (!team) throw new Error("Winning team not found.");

        match.status = "Completed";
        match.winnerTeamId = winningTeamId;

        team.wins = (team.wins || 0) + 1;

        const points = Number(payload.points ?? 10);
        team.points = (team.points || 0) + points;

        team.memberIds.forEach(playerId => {
          const player = state.players.find(p => p.id === playerId);
          if (player) player.points = (player.points || 0) + points;
        });
        break;
      }

      case "awardPoints": {
        const player = state.players.find(p => p.id === payload.playerId);
        if (!player) throw new Error("Player not found.");

        const points = Number(payload.points);
        if (!Number.isFinite(points)) throw new Error("Enter a valid point amount.");

        player.points = (player.points || 0) + points;
        break;
      }

      case "addAchievement": {
        const player = state.players.find(p => p.id === payload.playerId);
        if (!player) throw new Error("Player not found.");

        player.achievements = player.achievements || [];
        player.achievements.push({
          id: id(),
          name: clean(payload.name || payload.achievement),
          awardedAt: new Date().toISOString()
        });
        break;
      }

      case "addChallenge": {
        const challenge = {
          id: id(),
          title: clean(payload.title),
          description: clean(payload.description),
          points: Number(payload.points) || 0,
          achievement: clean(payload.achievement),
          published: !!payload.published,
          completedBy: []
        };

        if (!challenge.title) throw new Error("Challenge title is required.");
        state.challenges.push(challenge);
        break;
      }

      case "completeChallenge": {
        const challenge = state.challenges.find(c => c.id === payload.id);
        const player = state.players.find(p => p.id === payload.playerId);
        if (!challenge || !player) throw new Error("Challenge or player not found.");

        challenge.completedBy = challenge.completedBy || [];
        if (challenge.completedBy.includes(player.id)) {
          throw new Error("This player has already completed this challenge.");
        }

        challenge.completedBy.push(player.id);
        player.points = (player.points || 0) + (Number(challenge.points) || 0);

        if (challenge.achievement) {
          player.achievements = player.achievements || [];
          player.achievements.push({
            id: id(),
            name: challenge.achievement,
            awardedAt: new Date().toISOString()
          });
        }
        break;
      }

      case "deleteChallenge": {
        state.challenges = state.challenges.filter(c => c.id !== payload.id);
        break;
      }

      case "toggleMvp": {
        state.settings.mvpOpen = payload.open === undefined
          ? !state.settings.mvpOpen
          : !!payload.open;
        break;
      }

      case "resetVotes": {
        state.mvpVotes = {};
        break;
      }

      case "addAnnouncement": {
        state.announcements.push({
          id: id(),
          title: clean(payload.title),
          body: clean(payload.body),
          published: !!payload.published,
          createdAt: new Date().toISOString()
        });
        break;
      }

      case "updateAnnouncement": {
        const item = state.announcements.find(a => a.id === payload.id);
        if (!item) throw new Error("Announcement not found.");
        Object.assign(item, payload);
        break;
      }

      case "deleteAnnouncement": {
        state.announcements = state.announcements.filter(a => a.id !== payload.id);
        break;
      }

      case "publishWinner": {
        const team = state.teams.find(t => t.id === payload.teamId);
        if (!team) throw new Error("Winning team not found.");

        state.winner = {
          id: id(),
          teamId: team.id,
          teamName: team.name,
          message: clean(payload.message || "Congratulations to the champions!")
        };

        state.history.unshift({
          id: id(),
          name: "The Nerolympics",
          winner: team.name,
          completedAt: new Date().toISOString()
        });

        team.memberIds.forEach(playerId => {
          const player = state.players.find(p => p.id === playerId);
          if (player) {
            state.hallOfFame.unshift({
              id: id(),
              name: player.roblox,
              description: `Member of ${team.name}, Nerolympics champions.`
            });
          }
        });
        break;
      }

      case "clearWinner": {
        state.winner = null;
        break;
      }

      case "addPrize": {
        state.prizes.push({
          id: id(),
          playerName: clean(payload.playerName),
          reward: clean(payload.reward),
          delivered: false
        });
        break;
      }

      case "updatePrize": {
        const prize = state.prizes.find(p => p.id === payload.id);
        if (!prize) throw new Error("Prize record not found.");
        Object.assign(prize, payload);
        break;
      }

      default:
        throw new Error("Unknown staff action: " + clean(type));
    }

    saveState();
    res.json(result);

  } catch (error) {
    res.status(400).json({ error: error.message || "Action failed." });
  }
});

/* MVP RESULTS */

app.get("/api/mvp", staffRequired, (req, res) => {
  const results = Object.entries(state.mvpVotes).map(([playerId, votes]) => {
    const player = state.players.find(p => p.id === playerId);
    return player ? { roblox: player.roblox, votes } : null;
  }).filter(Boolean).sort((a,b) => b.votes - a.votes);

  res.json({
    open: !!state.settings.mvpOpen,
    results
  });
});

/* BACKUP AND RESTORE */

app.get("/api/staff/backup", staffRequired, (req, res) => {
  res.setHeader("Content-Disposition", 'attachment; filename="nerolympics-backup.json"');
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(state, null, 2));
});

app.post("/api/staff/restore", staffRequired, (req, res) => {
  try {
    const incoming = req.body;

    if (!incoming || !Array.isArray(incoming.players) || !Array.isArray(incoming.teams)) {
      return res.status(400).json({ error: "Invalid backup file." });
    }

    state = {
      ...emptyState(),
      ...incoming,
      settings: { ...emptyState().settings, ...(incoming.settings || {}) }
    };

    saveState();
    res.json({ success: true });

  } catch {
    res.status(400).json({ error: "Could not restore backup." });
  }
});

/* LEGACY API ALIASES */

app.get("/api/data", (req, res) => res.json(publicState()));
app.get("/api/session", (req, res) => {
  res.json({ authenticated: !!req.session.staff, staff: req.session.staff || null });
});

app.post("/api/login", (req, res) => {
  req.url = "/api/staff/login";
  app.handle(req, res);
});

app.post("/api/logout", (req, res) => {
  req.url = "/api/staff/logout";
  app.handle(req, res);
});

/* START */

app.listen(PORT, () => {
  console.log(`Nerolympics server running on port ${PORT}`);
});
