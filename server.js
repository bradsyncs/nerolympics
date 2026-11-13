
const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE ||
  path.join(__dirname, "data", "nerolympics.json");

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: "nerolympics.sid",
  secret: process.env.SESSION_SECRET || "replace-this-secret-before-deployment",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 12 * 60 * 60 * 1000
  }
}));

function createEmptyState() {
  return {
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
  };
}

function ensureDataFile() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(createEmptyState(), null, 2));
  }
}

function loadState() {
  ensureDataFile();

  const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const defaults = createEmptyState();

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
}

let state = loadState();

function saveState() {
  const tempFile = DATA_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
  fs.renameSync(tempFile, DATA_FILE);
}

function makeId() {
  return crypto.randomUUID();
}

function text(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function staffRequired(req, res, next) {
  if (!req.session.staff) {
    return res.status(401).json({ error: "Staff login required." });
  }
  next();
}

function adminRequired(req, res, next) {
  if (!req.session.staff || req.session.staff.role !== "admin") {
    return res.status(403).json({ error: "Administrator access required." });
  }
  next();
}

function findPlayer(playerId) {
  return state.players.find(p => p.id === playerId);
}

function findTeam(teamId) {
  return state.teams.find(t => t.id === teamId);
}

function publicState() {
  return {
    players: state.players.map(p => ({
      id: p.id,
      roblox: p.roblox,
      status: p.status,
      points: p.points || 0,
      teamId: p.teamId || null,
      achievements: p.achievements || []
    })),

    teams: state.settings.teamsPublished
      ? state.teams.map(t => ({
          id: t.id,
          name: t.name,
          captain: t.captain || "",
          memberIds: t.memberIds || [],
          wins: t.wins || 0,
          points: t.points || 0
        }))
      : [],

    events: state.events.filter(e => e.published !== false),

    matches: state.matches.filter(m => m.published !== false),

    challenges: state.challenges.filter(c => c.published),

    announcements: state.announcements.filter(a => a.published),

    settings: {
      teamsPublished: state.settings.teamsPublished,
      mvpOpen: !!state.settings.mvpOpen
    },

    winner: state.winner,
    history: state.history,
    hallOfFame: state.hallOfFame,

    mvp: {
      open: !!state.settings.mvpOpen
    }
  };
}

/* WEBSITE FILES */

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/staff", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "staff.html"));
});

/* PUBLIC API */

app.get("/api/public/state", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(publicState());
});

app.post("/api/mvp/vote", (req, res) => {
  if (!state.settings.mvpOpen) {
    return res.status(403).json({ error: "MVP voting is closed." });
  }

  if (req.session.mvpVoted) {
    return res.status(409).json({
      error: "A vote has already been submitted from this browser session."
    });
  }

  const playerId = text(req.body.playerId);
  const player = findPlayer(playerId);

  if (!player) {
    return res.status(404).json({ error: "Player not found." });
  }

  state.mvpVotes[playerId] = (state.mvpVotes[playerId] || 0) + 1;
  req.session.mvpVoted = true;

  saveState();
  res.json({ success: true });
});

/* STAFF LOGIN */

app.post("/api/staff/login", (req, res, next) => {
  const username = text(req.body.username, 100);
  const password = String(req.body.password || "");

  const adminConfigured =
    !!process.env.ADMIN_USERNAME && !!process.env.ADMIN_PASSWORD;

  const staffConfigured =
    !!process.env.STAFF_USERNAME && !!process.env.STAFF_PASSWORD;

  if (!adminConfigured && !staffConfigured) {
    return res.status(500).json({
      error: "Configure staff credentials in Render environment variables."
    });
  }

  const isAdmin = adminConfigured &&
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD;

  const isStaff = staffConfigured &&
    username === process.env.STAFF_USERNAME &&
    password === process.env.STAFF_PASSWORD;

  if (!isAdmin && !isStaff) {
    return res.status(401).json({
      error: "Incorrect username or password."
    });
  }

  req.session.regenerate(err => {
    if (err) return next(err);

    req.session.staff = {
      username,
      role: isAdmin ? "admin" : "staff"
    };

    req.session.save(err => {
      if (err) return next(err);
      res.json({ success: true, role: req.session.staff.role });
    });
  });
});

app.post("/api/staff/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("nerolympics.sid");
    res.json({ success: true });
  });
});

app.get("/api/staff/me", (req, res) => {
  if (!req.session.staff) {
    return res.status(401).json({ authenticated: false });
  }

  res.json({
    authenticated: true,
    role: req.session.staff.role,
    username: req.session.staff.username
  });
});

app.get("/api/staff/state", staffRequired, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(state);
});

/* STAFF ACTIONS */

app.post("/api/staff/action", staffRequired, (req, res) => {
  const type = text(req.body.type, 100);
  const payload = req.body.payload || {};

  try {
    switch (type) {

      case "addPlayer": {
        const roblox = text(payload.roblox, 100);
        const discord = text(payload.discord, 100);

        if (!roblox || !discord) {
          throw new Error("Roblox and Discord usernames are required.");
        }

        if (state.players.some(p =>
          p.roblox.toLowerCase() === roblox.toLowerCase()
        )) {
          throw new Error("That Roblox username is already registered.");
        }

        state.players.push({
          id: makeId(),
          roblox,
          discord,
          previousClans: text(payload.previousClans),
          status: "Registered",
          points: 0,
          teamId: null,
          registeredAt: new Date().toISOString(),
          checkIns: {},
          achievements: []
        });
        break;
      }

      case "updatePlayer": {
        const player = findPlayer(payload.id);
        if (!player) throw new Error("Participant not found.");

        if (payload.roblox !== undefined) {
          player.roblox = text(payload.roblox, 100);
        }
        if (payload.discord !== undefined) {
          player.discord = text(payload.discord, 100);
        }
        if (payload.status !== undefined) {
          player.status = text(payload.status, 50);
        }
        if (payload.points !== undefined) {
          player.points = number(payload.points, player.points || 0);
        }
        break;
      }

      case "deletePlayer": {
        state.players = state.players.filter(p => p.id !== payload.id);

        state.teams.forEach(team => {
          team.memberIds = (team.memberIds || []).filter(id => id !== payload.id);
        });

        delete state.mvpVotes[payload.id];
        break;
      }

      case "generateTeams": {
        if (state.settings.teamsPublished) {
          throw new Error("Published teams cannot be rerolled.");
        }

        const size = Math.max(2, Math.min(50,
          number(payload.size ?? payload.teamSize, state.settings.teamSize || 4)
        ));

        const players = state.players.filter(p => p.status !== "Disqualified");

        if (!players.length) throw new Error("There are no eligible participants.");

        // Fisher-Yates shuffle.
        const shuffled = [...players];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        state.teams = [];
        state.players.forEach(p => { p.teamId = null; });

        for (let i = 0; i < shuffled.length; i += size) {
          const members = shuffled.slice(i, i + size);
          const team = {
            id: makeId(),
            name: `Team ${state.teams.length + 1}`,
            captain: "",
            memberIds: members.map(p => p.id),
            wins: 0,
            points: 0
          };

          state.teams.push(team);
          members.forEach(p => { p.teamId = team.id; });
        }

        state.settings.teamSize = size;
        state.settings.teamsPublished = false;
        break;
      }

      case "publishTeams": {
        if (!state.teams.length) throw new Error("Generate teams first.");
        state.settings.teamsPublished = true;
        break;
      }

      case "resetTeams": {
        if (state.settings.teamsPublished) {
          throw new Error("Published teams cannot be reset.");
        }

        state.teams = [];
        state.players.forEach(p => { p.teamId = null; });
        break;
      }

      case "updateTeam": {
        if (state.settings.teamsPublished) {
          throw new Error("Published teams cannot be edited.");
        }

        const team = findTeam(payload.id);
        if (!team) throw new Error("Team not found.");

        if (payload.name !== undefined) team.name = text(payload.name, 100);
        if (payload.captain !== undefined) team.captain = text(payload.captain, 100);
        break;
      }

      case "checkin": {
        const player = findPlayer(payload.playerId);
        if (!player) throw new Error("Participant not found.");

        const eventId = text(payload.eventId);
        const status = text(payload.status || "Present");

        if (!eventId) throw new Error("Select an event.");
        if (!["Present", "Absent", "Late"].includes(status)) {
          throw new Error("Invalid check-in status.");
        }

        player.checkIns = player.checkIns || {};
        player.checkIns[eventId] = status;
        break;
      }

      case "addEvent": {
        const title = text(payload.title, 150);
        if (!title) throw new Error("Event title is required.");

        state.events.push({
          id: makeId(),
          title,
          description: text(payload.description, 2000),
          startAt: payload.startAt || null,
          status: "Upcoming",
          published: true
        });
        break;
      }

      case "updateEvent": {
        const event = state.events.find(e => e.id === payload.id);
        if (!event) throw new Error("Event not found.");

        if (payload.title !== undefined) event.title = text(payload.title, 150);
        if (payload.description !== undefined) event.description = text(payload.description, 2000);
        if (payload.status !== undefined) event.status = text(payload.status, 50);
        if (payload.startAt !== undefined) event.startAt = payload.startAt;
        if (payload.published !== undefined) event.published = !!payload.published;
        break;
      }

      case "deleteEvent": {
        state.events = state.events.filter(e => e.id !== payload.id);
        break;
      }

      case "addMatch": {
        const title = text(payload.title, 150);
        if (!title) throw new Error("Match name is required.");

        const teamIds = Array.isArray(payload.teamIds)
          ? payload.teamIds.filter(teamId => !!findTeam(teamId))
          : [];

        if (teamIds.length < 2) {
          throw new Error("Select at least two valid teams for a match.");
        }

        state.matches.push({
          id: makeId(),
          title,
          eventId: text(payload.eventId),
          teamIds,
          status: "scheduled",
          winnerTeamId: null,
          scheduledAt: payload.scheduledAt || null,
          published: true
        });
        break;
      }

      case "completeMatch": {
        // The dashboard sends matchId, not id.
        const matchId = payload.matchId || payload.id;
        const match = state.matches.find(m => m.id === matchId);

        if (!match) throw new Error("Match not found.");
        if (match.status === "completed") throw new Error("Match is already completed.");

        const winningTeamId = payload.winnerTeamId;
        if (!match.teamIds.includes(winningTeamId)) {
          throw new Error("The selected winner is not part of this match.");
        }

        const team = findTeam(winningTeamId);
        if (!team) throw new Error("Winning team not found.");

        match.status = "completed";
        match.winnerTeamId = winningTeamId;

        team.wins = (team.wins || 0) + 1;

        const points = number(payload.points, 10);
        team.points = (team.points || 0) + points;

        team.memberIds.forEach(playerId => {
          const player = findPlayer(playerId);
          if (player) player.points = (player.points || 0) + points;
        });
        break;
      }

      case "awardPoints": {
        const player = findPlayer(payload.playerId);
        if (!player) throw new Error("Participant not found.");

        // The dashboard sends amount.
        const amount = number(payload.amount ?? payload.points, NaN);
        if (!Number.isFinite(amount)) throw new Error("Enter a valid point amount.");

        player.points = (player.points || 0) + amount;
        break;
      }

      case "addAchievement": {
        const player = findPlayer(payload.playerId);
        if (!player) throw new Error("Participant not found.");

        const name = text(payload.name || payload.achievement, 150);
        if (!name) throw new Error("Achievement name is required.");

        player.achievements = player.achievements || [];
        player.achievements.push({
          id: makeId(),
          name,
          awardedAt: new Date().toISOString()
        });
        break;
      }

      case "addChallenge": {
        const title = text(payload.title, 150);
        if (!title) throw new Error("Challenge title is required.");

        state.challenges.push({
          id: makeId(),
          title,
          description: text(payload.description, 2000),
          points: number(payload.points, 0),
          achievement: text(payload.achievement, 150),
          published: !!payload.published,
          completedBy: []
        });
        break;
      }

      case "completeChallenge": {
        // The dashboard sends challengeId.
        const challengeId = payload.challengeId || payload.id;
        const challenge = state.challenges.find(c => c.id === challengeId);
        const player = findPlayer(payload.playerId);

        if (!challenge || !player) {
          throw new Error("Challenge or participant not found.");
        }

        challenge.completedBy = challenge.completedBy || [];

        if (challenge.completedBy.includes(player.id)) {
          throw new Error("This participant has already completed this challenge.");
        }

        challenge.completedBy.push(player.id);
        player.points = (player.points || 0) + (challenge.points || 0);

        if (challenge.achievement) {
          player.achievements = player.achievements || [];
          player.achievements.push({
            id: makeId(),
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
        const title = text(payload.title, 150);
        const body = text(payload.body, 5000);

        if (!title || !body) throw new Error("Title and message are required.");

        state.announcements.unshift({
          id: makeId(),
          title,
          body,
          published: !!payload.published,
          createdAt: new Date().toISOString()
        });
        break;
      }

      case "updateAnnouncement": {
        const item = state.announcements.find(a => a.id === payload.id);
        if (!item) throw new Error("Announcement not found.");

        if (payload.title !== undefined) item.title = text(payload.title, 150);
        if (payload.body !== undefined) item.body = text(payload.body, 5000);
        if (payload.published !== undefined) item.published = !!payload.published;
        break;
      }

      case "deleteAnnouncement": {
        state.announcements = state.announcements.filter(a => a.id !== payload.id);
        break;
      }

      case "publishWinner": {
        const team = findTeam(payload.teamId);
        if (!team) throw new Error("Select a valid winning team.");

        state.winner = {
          id: makeId(),
          teamId: team.id,
          teamName: team.name,
          message: text(payload.message || "Congratulations to the champions!", 1000),
          publishedAt: new Date().toISOString()
        };

        state.history.unshift({
          id: makeId(),
          name: "The Nerolympics",
          winner: team.name,
          completedAt: new Date().toISOString()
        });

        team.memberIds.forEach(playerId => {
          const player = findPlayer(playerId);
          if (!player) return;

          const alreadyListed = state.hallOfFame.some(
            entry => entry.name === player.roblox &&
              entry.description === `Member of ${team.name}, Nerolympics champions.`
          );

          if (!alreadyListed) {
            state.hallOfFame.unshift({
              id: makeId(),
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
        // The dashboard sends playerId, not playerName.
        const player = findPlayer(payload.playerId);
        if (!player) throw new Error("Select a valid participant.");

        const reward = text(payload.reward, 300);
        if (!reward) throw new Error("Enter a reward.");

        state.prizes.push({
          id: makeId(),
          playerId: player.id,
          playerName: player.roblox,
          reward,
          delivered: false,
          public: !!payload.public,
          createdAt: new Date().toISOString()
        });
        break;
      }

      case "updatePrize": {
        const prize = state.prizes.find(p => p.id === payload.id);
        if (!prize) throw new Error("Prize record not found.");

        if (payload.delivered !== undefined) prize.delivered = !!payload.delivered;
        if (payload.reward !== undefined) prize.reward = text(payload.reward, 300);
        if (payload.public !== undefined) prize.public = !!payload.public;
        break;
      }

      default:
        throw new Error("Unknown action: " + type);
    }

    saveState();
    res.json({ success: true });

  } catch (error) {
    res.status(400).json({
      error: error.message || "The requested action could not be completed."
    });
  }
});

/* MVP RESULTS */

app.get("/api/mvp", staffRequired, (req, res) => {
  const results = Object.entries(state.mvpVotes)
    .map(([playerId, votes]) => {
      const player = findPlayer(playerId);
      return player ? {
        playerId,
        roblox: player.roblox,
        votes
      } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.votes - a.votes);

  res.json({
    open: !!state.settings.mvpOpen,
    results
  });
});

/* BACKUP AND RESTORE */

app.get("/api/staff/backup", staffRequired, (req, res) => {
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="nerolympics-backup.json"'
  );
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(state, null, 2));
});

app.post("/api/staff/restore", adminRequired, (req, res) => {
  try {
    const incoming = req.body;

    if (!incoming ||
        !Array.isArray(incoming.players) ||
        !Array.isArray(incoming.teams)) {
      return res.status(400).json({ error: "Invalid backup file." });
    }

    const defaults = createEmptyState();

    state = {
      ...defaults,
      ...incoming,
      settings: { ...defaults.settings, ...(incoming.settings || {}) }
    };

    saveState();
    res.json({ success: true });

  } catch (error) {
    res.status(400).json({ error: "Could not restore backup." });
  }
});

/* ERROR HANDLER */

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "An unexpected server error occurred." });
});

/* START SERVER */

app.listen(PORT, () => {
  console.log(`Nerolympics server running on port ${PORT}`);
});
