const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_FILE =
  process.env.DATA_FILE || path.join(__dirname, "data.json");

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || "CHANGE_THIS_BEFORE_DEPLOYING",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 8
  }
}));

app.use(express.static(path.join(__dirname, "public")));

const defaultData = {
  announcements: [
    {
      id: 1,
      title: "The Nerolympics are coming!",
      message: "Get ready for a week of competitions, challenges, and prizes!",
      date: new Date().toISOString()
    }
  ],
  leaderboard: [],
  teams: [],
  schedule: [],
  results: []
};

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      saveData(defaultData);
      return structuredClone(defaultData);
    }

    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (error) {
    console.error("Could not load data:", error);
    return structuredClone(defaultData);
  }
}

function saveData(data) {
  const directory = path.dirname(DATA_FILE);
  fs.mkdirSync(directory, { recursive: true });

  const temporaryFile = DATA_FILE + ".tmp";
  fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2));
  fs.renameSync(temporaryFile, DATA_FILE);
}

let data = loadData();

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;

  const first = Buffer.from(a);
  const second = Buffer.from(b);

  return first.length === second.length &&
    crypto.timingSafeEqual(first, second);
}

function requireStaff(req, res, next) {
  if (!req.session.staff) {
    return res.status(401).json({ error: "Staff login required." });
  }

  next();
}

function cleanText(value, maxLength = 500) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

// Public event data
app.get("/api/data", (req, res) => {
  res.json(data);
});

// Check login status
app.get("/api/session", (req, res) => {
  res.json({
    loggedIn: Boolean(req.session.staff),
    username: req.session.staff?.username || null
  });
});

// Staff login
app.post("/api/login", (req, res) => {
  const username = cleanText(req.body.username, 40);
  const password = req.body.password;

  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const staffUsername = process.env.STAFF_USERNAME;
  const staffPassword = process.env.STAFF_PASSWORD;

  const isAdmin =
    adminUsername &&
    adminPassword &&
    safeEqual(username, adminUsername) &&
    safeEqual(password, adminPassword);

  const isStaff =
    staffUsername &&
    staffPassword &&
    safeEqual(username, staffUsername) &&
    safeEqual(password, staffPassword);

  if (!isAdmin && !isStaff) {
    return res.status(401).json({ error: "Incorrect login details." });
  }

  req.session.staff = {
    username,
    role: isAdmin ? "admin" : "staff"
  };

  res.json({
    success: true,
    role: req.session.staff.role
  });
});

// Staff logout
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

// Add announcement
app.post("/api/announcements", requireStaff, (req, res) => {
  const title = cleanText(req.body.title, 100);
  const message = cleanText(req.body.message, 1000);

  if (!title || !message) {
    return res.status(400).json({ error: "Complete both fields." });
  }

  const announcement = {
    id: Date.now(),
    title,
    message,
    date: new Date().toISOString()
  };

  data.announcements.unshift(announcement);
  saveData(data);

  res.json({ success: true, announcement });
});

// Delete announcement
app.delete("/api/announcements/:id", requireStaff, (req, res) => {
  const id = Number(req.params.id);

  data.announcements = data.announcements.filter(item => item.id !== id);
  saveData(data);

  res.json({ success: true });
});

// Add leaderboard entry
app.post("/api/leaderboard", requireStaff, (req, res) => {
  const name = cleanText(req.body.name, 60);
  const team = cleanText(req.body.team, 60);
  const points = Number(req.body.points);

  if (!name || !team || !Number.isFinite(points) || points < 0) {
    return res.status(400).json({ error: "Enter valid leaderboard details." });
  }

  const existing = data.leaderboard.find(
    item => item.name.toLowerCase() === name.toLowerCase()
  );

  if (existing) {
    existing.team = team;
    existing.points = points;
  } else {
    data.leaderboard.push({
      id: Date.now(),
      name,
      team,
      points
    });
  }

  data.leaderboard.sort((a, b) => b.points - a.points);
  saveData(data);

  res.json({ success: true });
});

// Delete leaderboard entry
app.delete("/api/leaderboard/:id", requireStaff, (req, res) => {
  const id = Number(req.params.id);

  data.leaderboard = data.leaderboard.filter(item => item.id !== id);
  saveData(data);

  res.json({ success: true });
});

// Add a team
app.post("/api/teams", requireStaff, (req, res) => {
  const name = cleanText(req.body.name, 60);
  const members = cleanText(req.body.members, 500);

  if (!name) {
    return res.status(400).json({ error: "Team name is required." });
  }

  data.teams.push({
    id: Date.now(),
    name,
    members: members.split(",").map(x => x.trim()).filter(Boolean)
  });

  saveData(data);
  res.json({ success: true });
});

// Delete a team
app.delete("/api/teams/:id", requireStaff, (req, res) => {
  const id = Number(req.params.id);

  data.teams = data.teams.filter(team => team.id !== id);
  saveData(data);

  res.json({ success: true });
});

// Add schedule event
app.post("/api/schedule", requireStaff, (req, res) => {
  const title = cleanText(req.body.title, 100);
  const time = cleanText(req.body.time, 100);
  const description = cleanText(req.body.description, 500);

  if (!title || !time) {
    return res.status(400).json({ error: "Title and time are required." });
  }

  data.schedule.push({
    id: Date.now(),
    title,
    time,
    description
  });

  saveData(data);
  res.json({ success: true });
});

// Delete schedule event
app.delete("/api/schedule/:id", requireStaff, (req, res) => {
  const id = Number(req.params.id);

  data.schedule = data.schedule.filter(item => item.id !== id);
  saveData(data);

  res.json({ success: true });
});

// Only serve the website for normal page requests
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Nerolympics running on port ${PORT}`);
});