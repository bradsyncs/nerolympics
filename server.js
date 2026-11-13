const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const STAFF_USERNAME = process.env.STAFF_USERNAME;
const STAFF_PASSWORD = process.env.STAFF_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!ADMIN_USERNAME || !ADMIN_PASSWORD ||
    !STAFF_USERNAME || !STAFF_PASSWORD ||
    !SESSION_SECRET) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: "nerolympics.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, "public")));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." }
});

const voteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

function id() {
  return crypto.randomUUID();
}

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function initialData() {
  return {
    settings: {
      eventName: "The Nerolympics",
      officialStart: "2026-11-14T23:00:00.000Z",
      teamsPublished: false,
      mvpVotingOpen: true
    },
    players: [],
    teams: [],
    events: [],
    matches: [],
    announcements: [],
    challenges: [],
    prizes: [],
    votes: [],
    winner: null,
    history: []
  };
}

let data = initialData();

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      data = { ...initialData(), ...saved };
    } else {
      saveData();
    }
  } catch (error) {
    console.error("Could not load data:", error);
    throw error;
  }
}

function saveData() {
  const directory = path.dirname(DATA_FILE);
  fs.mkdirSync(directory, { recursive: true });

  const temporary = DATA_FILE + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, DATA_FILE);
}

loadData();

function requireStaff(req, res, next) {
  if (!req.session || !req.session.staff) {
    return res.status(401).json({ error: "Staff login required." });
  }
  next();
}

function publicState() {
  const teams = data.settings.teamsPublished
    ? data.teams.map(team => ({
        id: team.id,
        name: team.name,
        captain: team.captain,
        memberIds: team.memberIds,
        members: team.memberIds.map(playerId => {
          const player = data.players.find(p => p.id === playerId);
          return player ? {
            id: player.id,
            roblox: player.roblox,
            points: player.points || 0
          } : null;
        }).filter(Boolean)
      }))
    : [];

  const players = data.players.map(player => ({
    id: player.id,
    roblox: player.roblox,
    status: player.status,
    points: player.points || 0,
    achievements: player.achievements || [],
    teamId: data.settings.teamsPublished ? player.teamId : null
  }));

  const totalPoints = data.players.reduce(
    (sum, player) => sum + (Number(player.points) || 0), 0
  );

  const completedMatches = data.matches.filter(
    match => match.status === "completed"
  );

  return {
    settings: data.settings,
    players,
    teams,
    events: data.events,
    matches: completedMatches,
    announcements: data.announcements,
    challenges: data.challenges.filter(challenge => challenge.published),
    prizes: data.prizes.filter(prize => prize.public),
    winner: data.winner,
    history: data.history,
    analytics: {
      participants: data.players.length,
      teams: data.settings.teamsPublished ? data.teams.length : 0,
      completedMatches: completedMatches.length,
      totalPoints
    },
    leaderboard: [...data.players]
      .sort((a, b) => (b.points || 0) - (a.points || 0))
      .map((player, index) => ({
        rank: index + 1,
        roblox: player.roblox,
        points: player.points || 0,
        teamId: data.settings.teamsPublished ? player.teamId : null
      }))
  };
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/staff", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "staff.html"));
});

app.get("/api/public", (req, res) => {
  res.json(publicState());
});

app.post("/api/staff/login", loginLimiter, (req, res) => {
  const username = clean(req.body.username, 100);
  const password = String(req.body.password || "");

  const isAdmin =
    username === ADMIN_USERNAME && password === ADMIN_PASSWORD;

  const isStaff =
    username === STAFF_USERNAME && password === STAFF_PASSWORD;

  if (!isAdmin && !isStaff) {
    return res.status(401).json({ error: "Incorrect username or password." });
  }

  req.session.regenerate(error => {
    if (error) {
      return res.status(500).json({ error: "Could not start session." });
    }

    req.session.staff = true;
    req.session.role = isAdmin ? "admin" : "staff";

    res.json({
      success: true,
      role: req.session.role
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
    authenticated: !!req.session?.staff,
    role: req.session?.role || null
  });
});

app.get("/api/staff/state", requireStaff, (req, res) => {
  res.json(data);
});

app.get("/api/staff/backup", requireStaff, (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="nerolympics-backup.json"'
  );
  res.send(JSON.stringify(data, null, 2));
});

app.post("/api/staff/restore", requireStaff, (req, res) => {
  const incoming = req.body;

  if (!incoming || !Array.isArray(incoming.players) ||
      !Array.isArray(incoming.teams) ||
      !Array.isArray(incoming.matches)) {
    return res.status(400).json({ error: "Invalid backup file." });
  }

  data = { ...initialData(), ...incoming };
  saveData();
  res.json({ success: true });
});

app.post("/api/vote", voteLimiter, (req, res) => {
  if (!data.settings.mvpVotingOpen) {
    return res.status(403).json({ error: "MVP voting is closed." });
  }

  const voterId = clean(req.body.voterId, 100);
  const nomineeId = clean(req.body.nomineeId, 100);

  const voter = data.players.find(p => p.id === voterId);
  const nominee = data.players.find(p => p.id === nomineeId);

  if (!voter || !nominee || voter.id === nominee.id) {
    return res.status(400).json({ error: "Invalid vote." });
  }

  if (data.votes.some(vote => vote.voterId === voterId)) {
    return res.status(409).json({ error: "You have already voted." });
  }

  data.votes.push({
    voterId,
    nomineeId,
    createdAt: new Date().toISOString()
  });

  saveData();
  res.json({ success: true });
});

app.get("/api/mvp", (req, res) => {
  const counts = {};

  data.votes.forEach(vote => {
    counts[vote.nomineeId] = (counts[vote.nomineeId] || 0) + 1;
  });

  res.json({
    open: data.settings.mvpVotingOpen,
    results: data.settings.mvpVotingOpen ? [] :
      Object.entries(counts).map(([playerId, votes]) => {
        const player = data.players.find(p => p.id === playerId);
        return player ? { roblox: player.roblox, votes } : null;
      }).filter(Boolean).sort((a, b) => b.votes - a.votes)
  });
});

app.post("/api/staff/action", requireStaff, (req, res) => {
  const type = clean(req.body.type, 80);
  const p = req.body.payload || {};
  const now = new Date().toISOString();

  try {
    switch (type) {
      case "addPlayer": {
        const roblox = clean(p.roblox, 40);
        const discord = clean(p.discord, 80);

        if (!roblox || !discord) {
          throw new Error("Roblox and Discord usernames are required.");
        }

        if (data.players.some(player =>
          player.roblox.toLowerCase() === roblox.toLowerCase())) {
          throw new Error("That Roblox username is already registered.");
        }

        data.players.push({
          id: id(),
          roblox,
          discord,
          status: "Registered",
          registeredAt: now,
          points: 0,
          teamId: null,
          checkIns: {},
          achievements: [],
          notes: ""
        });
        break;
      }

      case "updatePlayer": {
        const player = data.players.find(x => x.id === p.id);
        if (!player) throw new Error("Player not found.");

        if (p.roblox !== undefined) player.roblox = clean(p.roblox, 40);
        if (p.discord !== undefined) player.discord = clean(p.discord, 80);
        if (p.status !== undefined) player.status = clean(p.status, 40);
        if (p.notes !== undefined) player.notes = clean(p.notes, 1000);
        break;
      }

      case "deletePlayer": {
        data.players = data.players.filter(x => x.id !== p.id);
        data.teams.forEach(team => {
          team.memberIds = team.memberIds.filter(x => x !== p.id);
        });
        data.votes = data.votes.filter(
          vote => vote.voterId !== p.id && vote.nomineeId !== p.id
        );
        break;
      }

      case "generateTeams": {
        if (data.settings.teamsPublished) {
          throw new Error("Published teams cannot be rerolled.");
        }

        const size = Math.floor(Number(p.size));
        if (!Number.isInteger(size) || size < 2 || size > 50) {
          throw new Error("Team size must be between 2 and 50.");
        }

        const eligible = data.players.filter(
          player => player.status !== "Disqualified"
        );

        if (eligible.length < 2) {
          throw new Error("You need at least two eligible players.");
        }

        const shuffled = [...eligible];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        const count = Math.ceil(shuffled.length / size);
        const groups = Array.from({ length: count }, () => []);

        shuffled.forEach((player, index) => {
          groups[index % count].push(player);
        });

        data.teams = groups.map((members, index) => ({
          id: id(),
          name: clean(p.names?.[index], 50) || `Team ${index + 1}`,
          captain: "",
          memberIds: members.map(player => player.id),
          createdAt: now
        }));

        data.players.forEach(player => {
          const team = data.teams.find(t => t.memberIds.includes(player.id));
          player.teamId = team ? team.id : null;
        });
        break;
      }

      case "updateTeam": {
        const team = data.teams.find(x => x.id === p.id);
        if (!team) throw new Error("Team not found.");
        if (data.settings.teamsPublished) {
          throw new Error("Teams have already been published.");
        }

        if (p.name !== undefined) team.name = clean(p.name, 50);
        if (p.captain !== undefined) team.captain = clean(p.captain, 50);
        break;
      }

      case "publishTeams": {
        if (!data.teams.length) throw new Error("Generate teams first.");
        data.settings.teamsPublished = true;
        data.teams.forEach(team => team.publishedAt = now);
        break;
      }

      case "addEvent": {
        const title = clean(p.title, 100);
        if (!title) throw new Error("Event title is required.");

        data.events.push({
          id: id(),
          title,
          description: clean(p.description, 1000),
          startAt: clean(p.startAt, 60),
          status: "Upcoming",
          createdAt: now
        });
        break;
      }

      case "updateEvent": {
        const event = data.events.find(x => x.id === p.id);
        if (!event) throw new Error("Event not found.");
        ["title", "description", "startAt", "status"].forEach(key => {
          if (p[key] !== undefined) {
            event[key] = clean(p[key], key === "description" ? 1000 : 150);
          }
        });
        break;
      }

      case "deleteEvent": {
        data.events = data.events.filter(x => x.id !== p.id);
        break;
      }

      case "checkin": {
        const player = data.players.find(x => x.id === p.playerId);
        if (!player) throw new Error("Player not found.");
        if (!p.eventId) throw new Error("Select an event.");

        player.checkIns[p.eventId] = clean(p.status, 30);
        break;
      }

      case "addMatch": {
        const teamIds = Array.isArray(p.teamIds) ? p.teamIds : [];
        if (teamIds.length < 2) throw new Error("Select at least two teams.");

        data.matches.push({
          id: id(),
          title: clean(p.title, 100) || "Match",
          eventId: clean(p.eventId, 100),
          teamIds,
          winnerTeamId: null,
          placements: [],
          status: "scheduled",
          scheduledAt: clean(p.scheduledAt, 60),
          createdAt: now
        });
        break;
      }

      case "completeMatch": {
        const match = data.matches.find(x => x.id === p.matchId);
        if (!match) throw new Error("Match not found.");
        if (!match.teamIds.includes(p.winnerTeamId)) {
          throw new Error("Winner must be one of the selected teams.");
        }

        match.winnerTeamId = p.winnerTeamId;
        match.status = "completed";
        match.completedAt = now;

        const winner = data.teams.find(t => t.id === p.winnerTeamId);
        if (winner) {
          winner.wins = (winner.wins || 0) + 1;
        }

        if (!data.history.some(item => item.matchId === match.id)) {
          data.history.push({
            matchId: match.id,
            title: match.title,
            winnerTeamId: match.winnerTeamId,
            completedAt: now
          });
        }

        if (p.awardPoints !== false && winner) {
          winner.memberIds.forEach(playerId => {
            const player = data.players.find(x => x.id === playerId);
            if (player) player.points = (player.points || 0) + 10;
          });
        }
        break;
      }

      case "awardPoints": {
        const player = data.players.find(x => x.id === p.playerId);
        if (!player) throw new Error("Player not found.");

        const amount = Number(p.amount);
        if (!Number.isFinite(amount) || amount < -10000 || amount > 10000) {
          throw new Error("Enter a valid points amount.");
        }

        player.points = (player.points || 0) + amount;
        break;
      }

      case "addAchievement": {
        const player = data.players.find(x => x.id === p.playerId);
        if (!player) throw new Error("Player not found.");
        const name = clean(p.name, 100);
        if (!name) throw new Error("Achievement name is required.");
        player.achievements.push({ name, createdAt: now });
        break;
      }

      case "addChallenge": {
        const title = clean(p.title, 100);
        if (!title) throw new Error("Challenge title is required.");

        data.challenges.push({
          id: id(),
          title,
          description: clean(p.description, 1000),
          points: Number(p.points) || 0,
          achievement: clean(p.achievement, 100),
          published: !!p.published,
          completedBy: [],
          createdAt: now
        });
        break;
      }

      case "completeChallenge": {
        const challenge = data.challenges.find(x => x.id === p.challengeId);
        const player = data.players.find(x => x.id === p.playerId);
        if (!challenge || !player) throw new Error("Challenge or player not found.");

        if (challenge.completedBy.includes(player.id)) {
          throw new Error("This player already completed the challenge.");
        }

        challenge.completedBy.push(player.id);
        player.points = (player.points || 0) + (challenge.points || 0);

        if (challenge.achievement) {
          player.achievements.push({
            name: challenge.achievement,
            createdAt: now
          });
        }
        break;
      }

      case "deleteChallenge": {
        data.challenges = data.challenges.filter(x => x.id !== p.id);
        break;
      }

      case "addAnnouncement": {
        const title = clean(p.title, 100);
        if (!title) throw new Error("Announcement title is required.");

        data.announcements.unshift({
          id: id(),
          title,
          body: clean(p.body, 2000),
          published: !!p.published,
          createdAt: now
        });
        break;
      }

      case "updateAnnouncement": {
        const item = data.announcements.find(x => x.id === p.id);
        if (!item) throw new Error("Announcement not found.");
        if (p.title !== undefined) item.title = clean(p.title, 100);
        if (p.body !== undefined) item.body = clean(p.body, 2000);
        if (p.published !== undefined) item.published = !!p.published;
        break;
      }

      case "deleteAnnouncement": {
        data.announcements = data.announcements.filter(x => x.id !== p.id);
        break;
      }

      case "addPrize": {
        const player = data.players.find(x => x.id === p.playerId);
        if (!player) throw new Error("Player not found.");

        data.prizes.push({
          id: id(),
          playerId: player.id,
          playerName: player.roblox,
          reward: clean(p.reward, 150),
          delivered: false,
          public: !!p.public,
          createdAt: now
        });
        break;
      }

      case "updatePrize": {
        const prize = data.prizes.find(x => x.id === p.id);
        if (!prize) throw new Error("Prize not found.");
        if (p.delivered !== undefined) prize.delivered = !!p.delivered;
        if (p.reward !== undefined) prize.reward = clean(p.reward, 150);
        break;
      }

      case "publishWinner": {
        const team = data.teams.find(x => x.id === p.teamId);
        if (!team) throw new Error("Select a valid team.");
        if (!data.settings.teamsPublished) {
          throw new Error("Publish teams before announcing a winner.");
        }

        data.winner = {
          teamId: team.id,
          teamName: team.name,
          message: clean(p.message, 1000),
          publishedAt: now,
          members: team.memberIds.map(playerId => {
            const player = data.players.find(x => x.id === playerId);
            return player ? player.roblox : null;
          }).filter(Boolean)
        };
        break;
      }

      case "clearWinner": {
        data.winner = null;
        break;
      }

      case "toggleMvp": {
        data.settings.mvpVotingOpen = !!p.open;
        break;
      }

      case "resetVotes": {
        data.votes = [];
        break;
      }

      case "resetTeams": {
        if (data.settings.teamsPublished) {
          throw new Error("Published teams cannot be reset.");
        }
        data.teams = [];
        data.players.forEach(player => player.teamId = null);
        break;
      }

      default:
        throw new Error("Unknown staff action.");
    }

    saveData();
    res.json({ success: true, state: data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "An unexpected server error occurred." });
});

app.listen(PORT, () => {
  console.log(`Nerolympics running on port ${PORT}`);
});