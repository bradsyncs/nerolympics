const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!DATABASE_URL || !SESSION_SECRET) {
  console.error('DATABASE_URL and SESSION_SECRET must be set in Render.');
  process.exit(1);
}
if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || !process.env.STAFF_USERNAME || !process.env.STAFF_PASSWORD) {
  console.error('Set ADMIN_USERNAME, ADMIN_PASSWORD, STAFF_USERNAME and STAFF_PASSWORD in Render.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000
});
const appDir = __dirname;
const publicDir = path.join(appDir, 'public');
const SCHEMA_VERSION = 2;
const HISTORY_LIMIT = 60;
const RECYCLE_LIMIT = 500;
const BACKUP_LIMIT = 30;
const DEFAULT_PERMISSIONS = {
  addPlayer: true, updatePlayer: true, deletePlayer: false,
  generateTeams: true, publishTeams: true, resetTeams: false, updateTeam: true,
  checkin: true, bulkCheckin: true,
  addEvent: true, updateEvent: true, deleteEvent: false,
  addMatch: true, updateMatch: true, completeMatch: true, deleteMatch: false,
  awardPoints: true, addAchievement: true,
  addChallenge: true, completeChallenge: true, deleteChallenge: false,
  addAnnouncement: true, updateAnnouncement: true, deleteAnnouncement: false,
  publishWinner: false, clearWinner: false,
  addHallOfFame: false, updateHallOfFame: false, deleteHallOfFame: false,
  selectMvp: true, publishMvp: false,
  addPrize: true, updatePrize: true, deletePrize: false, bulkPrizeDelivered: true,
  bulkPlayerStatus: true, bulkAwardPoints: true, bulkDeletePlayers: false,
  bulkPublishAnnouncements: true, bulkDeleteAnnouncements: false,
  bulkAssignTeam: true, bulkDeleteTeams: false,
  restoreRecycleItem: true,
  bulkRestoreRecycleItems: true,
  setMaintenance: true
};
const ADMIN_ONLY_ACTIONS = new Set([
  'clearWinner',
  'permanentDeleteRecycleItem', 'emptyRecycleBin', 'restoreVersion', 'undo',
  'importBackup', 'updatePermissions', 'createBackup', 'setCountdown'
]);
const DEFAULT_STATE = {
  schemaVersion: SCHEMA_VERSION,
  players: [], teams: [], events: [], matches: [], challenges: [], announcements: [], prizes: [],
  settings: {
    teamsPublished: false,
    maintenanceMode: false,
    maintenanceMessage: 'The Nerolympics website is temporarily under maintenance. Please check back soon.',
    eventStartAt: '2026-11-14T23:00:00.000Z',
    staffPermissions: { ...DEFAULT_PERMISSIONS },
    mvp: { playerId: null, message: '', published: false, publishedAt: null }
  },
  winner: null,
  history: [],
  hallOfFame: [],
  activityLog: [],
  versions: [],
  recycleBin: [],
  backups: []
};

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'nerolympics.sid',
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 }
}));

function id() { return crypto.randomUUID(); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function text(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function num(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function bool(value) { return value === true || value === 'true'; }
function normalizeState(input) {
  const state = { ...clone(DEFAULT_STATE), ...(input && typeof input === 'object' ? input : {}) };
  for (const key of ['players','teams','events','matches','challenges','announcements','prizes','history','hallOfFame','activityLog','versions','recycleBin','backups']) {
    if (!Array.isArray(state[key])) state[key] = [];
  }
  state.settings = { ...clone(DEFAULT_STATE.settings), ...(state.settings || {}) };
  state.settings.staffPermissions = { ...DEFAULT_PERMISSIONS, ...(state.settings.staffPermissions || {}) };
  state.settings.mvp = { ...DEFAULT_STATE.settings.mvp, ...(state.settings.mvp || {}) };

  // Remove fields belonging to the retired Previous Clans and public MVP voting features.
  delete state.mvpVotes;
  delete state.settings.mvpOpen;
  state.players.forEach(player => { delete player.previousClans; });
  state.recycleBin.forEach(item => {
    if (item.type === 'player' && item.record) delete item.record.previousClans;
  });

  state.schemaVersion = SCHEMA_VERSION;
  return state;
}

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS event_state (id INTEGER PRIMARY KEY CHECK (id=1), data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS automatic_backups (id BIGSERIAL PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`INSERT INTO event_state(id,data) VALUES(1,$1::jsonb) ON CONFLICT(id) DO NOTHING`, [JSON.stringify(DEFAULT_STATE)]);
  const state = await getState();
  await saveState(state);
  console.log('Nerolympics database ready.');
}
async function getState(client = pool) {
  const result = await client.query('SELECT data FROM event_state WHERE id=1');
  return normalizeState(result.rows[0]?.data || DEFAULT_STATE);
}
async function saveState(state, client = pool) {
  await client.query(`INSERT INTO event_state(id,data,updated_at) VALUES(1,$1::jsonb,NOW()) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`, [JSON.stringify(normalizeState(state))]);
}
function requireStaff(req, res, next) {
  if (!req.session?.role) return res.status(401).json({ error: 'Staff login required.' });
  next();
}
function requireAdmin(req, res, next) {
  if (req.session?.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}
function checkPermission(state, role, action) {
  if (role === 'admin') return true;
  if (ADMIN_ONLY_ACTIONS.has(action)) return false;
  return state.settings.staffPermissions[action] === true;
}
function publicState(state) {
  const players = state.players.filter(p => p.status !== 'Disqualified').map(p => ({
    id: p.id, roblox: p.roblox, status: p.status, points: num(p.points), teamId: p.teamId || null,
    achievements: Array.isArray(p.achievements) ? p.achievements : []
  }));
  const teams = state.settings.teamsPublished ? state.teams.map(t => {
    const memberIds = Array.isArray(t.memberIds) ? t.memberIds : [];
    const memberPoints = players
      .filter(player => memberIds.includes(player.id))
      .reduce((total, player) => total + num(player.points), 0);
    return {
      id: t.id, name: t.name, captain: t.captain || '',
      memberIds, wins: num(t.wins), points: memberPoints
    };
  }) : [];
  const mvpPlayer = state.settings.mvp.published ? players.find(p => p.id === state.settings.mvp.playerId) : null;
  return {
    players, teams,
    events: state.events.filter(e => e.published !== false),
    matches: state.matches.filter(m => m.published !== false),
    challenges: state.challenges.filter(c => c.published),
    announcements: state.announcements.filter(a => a.published),
    prizes: state.prizes.filter(p => p.public && p.delivered),
    settings: { teamsPublished: !!state.settings.teamsPublished, maintenanceMode: !!state.settings.maintenanceMode, eventStartAt: state.settings.eventStartAt || DEFAULT_STATE.settings.eventStartAt },
    winner: state.winner?.published ? state.winner : null,
    history: state.history,
    hallOfFame: state.hallOfFame,
    mvp: mvpPlayer ? { player: mvpPlayer, message: state.settings.mvp.message, publishedAt: state.settings.mvp.publishedAt } : null
  };
}
function summaryFor(type, p) {
  const names = {
    addPlayer: `Added participant ${p.roblox || ''}`, updatePlayer: `Updated participant ${p.roblox || ''}`,
    deletePlayer: 'Moved participant to Recycle Bin', generateTeams: 'Generated teams', publishTeams: 'Published teams',
    resetTeams: 'Moved teams to Recycle Bin', updateTeam: `Updated team ${p.name || ''}`,
    checkin: 'Updated participant check-in', bulkCheckin: 'Updated multiple check-ins',
    addEvent: `Created event ${p.title || ''}`, updateEvent: `Updated event ${p.title || ''}`, deleteEvent: 'Moved event to Recycle Bin',
    addMatch: `Created match ${p.title || ''}`, updateMatch: `Updated match ${p.title || ''}`, completeMatch: 'Completed match', deleteMatch: 'Moved match to Recycle Bin',
    awardPoints: 'Awarded points', bulkAwardPoints: 'Awarded points to multiple participants',
    addAchievement: 'Added achievement', addChallenge: `Created challenge ${p.title || ''}`, completeChallenge: 'Completed challenge', deleteChallenge: 'Moved challenge to Recycle Bin',
    addAnnouncement: `Created announcement ${p.title || ''}`, updateAnnouncement: 'Updated announcement', deleteAnnouncement: 'Moved announcement to Recycle Bin',
    publishWinner: 'Published event winner', clearWinner: 'Cleared event winner',
    setCountdown: 'Updated event countdown date and time',
    addHallOfFame: 'Added Hall of Fame entry', updateHallOfFame: 'Updated Hall of Fame entry', deleteHallOfFame: 'Moved Hall of Fame entry to Recycle Bin', selectMvp: 'Selected MVP', publishMvp: 'Published MVP',
    addPrize: 'Added prize record', updatePrize: 'Updated prize record', deletePrize: 'Moved prize to Recycle Bin',
    bulkPlayerStatus: 'Changed participant statuses', bulkDeletePlayers: 'Moved participants to Recycle Bin',
    bulkAssignTeam: 'Assigned participants to a team', bulkPrizeDelivered: 'Updated prize delivery statuses',
    bulkPublishAnnouncements: 'Updated announcement publication', bulkDeleteAnnouncements: 'Moved announcements to Recycle Bin',
    bulkDeleteTeams: 'Moved teams to Recycle Bin', restoreRecycleItem: 'Restored item from Recycle Bin', bulkRestoreRecycleItems: 'Restored multiple Recycle Bin items'
  };
  return names[type] || `Performed ${type}`;
}
function pushRecycle(state, type, record) {
  state.recycleBin.unshift({ id: id(), type, deletedAt: new Date().toISOString(), record: clone(record) });
  state.recycleBin = state.recycleBin.slice(0, RECYCLE_LIMIT);
}
function findById(list, itemId, label) {
  const item = list.find(x => x.id === itemId);
  if (!item) throw new Error(`${label} not found.`);
  return item;
}
function takeSnapshot(state, summary) {
  const snap = clone(state);
  snap.versions = [];
  snap.backups = [];
  state.versions.unshift({ id: id(), createdAt: new Date().toISOString(), summary, snapshot: snap });
  state.versions = state.versions.slice(0, HISTORY_LIMIT);
}
function logActivity(state, summary, type) {
  state.activityLog.unshift({ id: id(), timestamp: new Date().toISOString(), summary, type });
  state.activityLog = state.activityLog.slice(0, 250);
}

async function performAction(state, type, p) {
  const now = new Date().toISOString();
  switch (type) {
    case 'addPlayer': {
      const roblox = text(p.roblox, 40);
      if (!roblox) throw new Error('Roblox username is required.');
      if (state.players.some(x => x.roblox.toLowerCase() === roblox.toLowerCase())) throw new Error('That Roblox username is already registered.');
      state.players.push({ id: id(), roblox, discord: text(p.discord, 80), status: text(p.status || 'Registered', 40), points: 0, teamId: null, registeredAt: now, checkIns: [], achievements: [] });
      break;
    }
    case 'updatePlayer': {
      const player = findById(state.players, p.id, 'Participant');
      if (p.roblox !== undefined) player.roblox = text(p.roblox, 40);
      if (p.discord !== undefined) player.discord = text(p.discord, 80);
      if (p.status !== undefined) player.status = text(p.status, 40);
      if (p.points !== undefined) player.points = num(p.points);
      if (p.teamId !== undefined) player.teamId = p.teamId || null;
      break;
    }
    case 'deletePlayer': {
      const index = state.players.findIndex(x => x.id === p.id); if (index < 0) throw new Error('Participant not found.');
      const [player] = state.players.splice(index, 1); pushRecycle(state, 'player', player);
      state.teams.forEach(t => t.memberIds = (t.memberIds || []).filter(x => x !== player.id)); break;
    }
    case 'generateTeams': {
      const size = Math.max(1, Math.min(20, Math.floor(num(p.size, 5))));
      const eligible = state.players.filter(x => x.status !== 'Disqualified');
      for (let i = eligible.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [eligible[i], eligible[j]] = [eligible[j], eligible[i]]; }
      state.teams.forEach(t => pushRecycle(state, 'team', t));
      state.teams = [];
      eligible.forEach((player, index) => {
        const teamIndex = Math.floor(index / size);
        if (!state.teams[teamIndex]) state.teams[teamIndex] = { id: id(), name: `Team ${teamIndex + 1}`, captain: '', memberIds: [], wins: 0, points: 0 };
        state.teams[teamIndex].memberIds.push(player.id); player.teamId = state.teams[teamIndex].id;
      });
      state.settings.teamsPublished = false; break;
    }
    case 'publishTeams': state.settings.teamsPublished = true; break;
    case 'resetTeams': state.teams.forEach(t => pushRecycle(state, 'team', t)); state.teams = []; state.players.forEach(x => x.teamId = null); state.settings.teamsPublished = false; break;
    case 'updateTeam': {
      const team = findById(state.teams, p.id, 'Team');
      if (p.name !== undefined) team.name = text(p.name, 60);
      if (p.captain !== undefined) team.captain = text(p.captain, 60);
      if (p.memberIds !== undefined) {
        const ids = [...new Set((Array.isArray(p.memberIds) ? p.memberIds : []).filter(pid => state.players.some(x => x.id === pid)))];
        state.players.forEach(x => { if (x.teamId === team.id) x.teamId = null; });
        team.memberIds = ids; ids.forEach(pid => { const player = state.players.find(x => x.id === pid); player.teamId = team.id; });
      }
      break;
    }
    case 'bulkAssignTeam': {
      const team = p.teamId ? findById(state.teams, p.teamId, 'Team') : null;
      const ids = Array.isArray(p.playerIds) ? p.playerIds : [];
      ids.forEach(pid => { const player = state.players.find(x => x.id === pid); if (!player) return; if (player.teamId) { const old = state.teams.find(t => t.id === player.teamId); if (old) old.memberIds = old.memberIds.filter(x => x !== pid); } player.teamId = team?.id || null; if (team && !team.memberIds.includes(pid)) team.memberIds.push(pid); });
      break;
    }
    case 'checkin': {
      const player = findById(state.players, p.playerId, 'Participant');
      findById(state.events, p.eventId, 'Event');
      player.checkIns = Array.isArray(player.checkIns) ? player.checkIns : [];
      const entry = { eventId: p.eventId, status: text(p.status || 'Present', 30), timestamp: now };
      const index = player.checkIns.findIndex(x => x.eventId === p.eventId); if (index >= 0) player.checkIns[index] = entry; else player.checkIns.push(entry);
      break;
    }
    case 'bulkCheckin': {
      findById(state.events, p.eventId, 'Event');
      const ids = Array.isArray(p.playerIds) ? p.playerIds : [];
      ids.forEach(playerId => { const player = state.players.find(x => x.id === playerId); if (!player) return; player.checkIns ||= []; const entry = { eventId: p.eventId, status: text(p.status || 'Present', 30), timestamp: now }; const i = player.checkIns.findIndex(x => x.eventId === p.eventId); if (i >= 0) player.checkIns[i] = entry; else player.checkIns.push(entry); });
      break;
    }
    case 'addEvent': state.events.push({ id: id(), title: text(p.title, 100), description: text(p.description, 1000), startAt: p.startAt || null, status: text(p.status || 'Upcoming', 40), published: p.published !== false, createdAt: now }); break;
    case 'updateEvent': { const e = findById(state.events, p.id, 'Event'); ['title','description','startAt','status','published'].forEach(k => { if (p[k] !== undefined) e[k] = k === 'published' ? bool(p[k]) : (k === 'description' ? text(p[k],1000) : text(p[k],100)); }); break; }
    case 'deleteEvent': { const i = state.events.findIndex(x => x.id === p.id); if (i < 0) throw new Error('Event not found.'); pushRecycle(state, 'event', state.events.splice(i,1)[0]); break; }
    case 'addMatch': state.matches.push({ id: id(), title: text(p.title,100), eventId: p.eventId || null, teamIds: Array.isArray(p.teamIds) ? p.teamIds : [], status: 'Scheduled', winnerTeamId: null, scheduledAt: p.scheduledAt || null, published: p.published !== false, createdAt: now }); break;
    case 'updateMatch': { const m = findById(state.matches,p.id,'Match'); ['title','eventId','scheduledAt','published','status'].forEach(k => { if (p[k] !== undefined) m[k] = p[k]; }); if (p.teamIds) m.teamIds = p.teamIds; break; }
    case 'completeMatch': { const m = findById(state.matches,p.matchId,'Match'); m.status = 'Completed'; m.winnerTeamId = p.winnerTeamId || null; if (p.awardPoints !== false && m.winnerTeamId) { const team = state.teams.find(t => t.id === m.winnerTeamId); if (team) { team.wins = num(team.wins)+1; team.points = num(team.points)+10; team.memberIds.forEach(pid => { const player = state.players.find(x => x.id === pid); if (player) player.points = num(player.points)+10; }); } } break; }
    case 'deleteMatch': { const i=state.matches.findIndex(x=>x.id===p.id); if(i<0) throw new Error('Match not found.'); pushRecycle(state,'match',state.matches.splice(i,1)[0]); break; }
    case 'awardPoints': { const player=findById(state.players,p.playerId,'Participant'); player.points=num(player.points)+num(p.amount); break; }
    case 'bulkAwardPoints': { const ids=Array.isArray(p.playerIds)?p.playerIds:[]; ids.forEach(pid=>{const player=state.players.find(x=>x.id===pid);if(player)player.points=num(player.points)+num(p.amount);}); break; }
    case 'bulkPlayerStatus': { const ids=Array.isArray(p.playerIds)?p.playerIds:[]; ids.forEach(pid=>{const player=state.players.find(x=>x.id===pid);if(player)player.status=text(p.status,40);}); break; }
    case 'bulkDeletePlayers': { const ids=new Set(p.playerIds||[]); state.players=state.players.filter(player=>{if(!ids.has(player.id))return true;pushRecycle(state,'player',player);state.teams.forEach(t=>t.memberIds=t.memberIds.filter(x=>x!==player.id));return false;}); break; }
    case 'addAchievement': { const player=findById(state.players,p.playerId,'Participant'); player.achievements ||= []; player.achievements.push({id:id(),name:text(p.name,80),createdAt:now}); break; }
    case 'addChallenge': state.challenges.push({id:id(),title:text(p.title,100),description:text(p.description,1000),points:num(p.points),achievement:text(p.achievement,80),published:bool(p.published),completedBy:[],createdAt:now}); break;
    case 'completeChallenge': { const challenge=findById(state.challenges,p.challengeId,'Challenge'); const player=findById(state.players,p.playerId,'Participant'); challenge.completedBy ||= []; if(!challenge.completedBy.includes(player.id)){challenge.completedBy.push(player.id);player.points=num(player.points)+num(challenge.points);if(challenge.achievement){player.achievements ||= [];player.achievements.push({id:id(),name:challenge.achievement,createdAt:now});}} break; }
    case 'deleteChallenge': { const i=state.challenges.findIndex(x=>x.id===p.id);if(i<0)throw new Error('Challenge not found.');pushRecycle(state,'challenge',state.challenges.splice(i,1)[0]);break; }
    case 'addAnnouncement': state.announcements.push({id:id(),title:text(p.title,100),body:text(p.body,3000),published:bool(p.published),createdAt:now});break;
    case 'updateAnnouncement': {const a=findById(state.announcements,p.id,'Announcement');['title','body','published'].forEach(k=>{if(p[k]!==undefined)a[k]=k==='published'?bool(p[k]):text(p[k],3000);});break;}
    case 'deleteAnnouncement': {const i=state.announcements.findIndex(x=>x.id===p.id);if(i<0)throw new Error('Announcement not found.');pushRecycle(state,'announcement',state.announcements.splice(i,1)[0]);break;}
    case 'bulkPublishAnnouncements': {const ids=new Set(p.ids||[]);state.announcements.forEach(a=>{if(ids.has(a.id))a.published=bool(p.published);});break;}
    case 'bulkDeleteAnnouncements': {const ids=new Set(p.ids||[]);state.announcements=state.announcements.filter(a=>{if(!ids.has(a.id))return true;pushRecycle(state,'announcement',a);return false;});break;}
    case 'publishWinner': {const team=findById(state.teams,p.teamId,'Winning team');state.winner={id:id(),teamId:team.id,teamName:team.name,message:text(p.message,1000),published:true,publishedAt:now};state.hallOfFame.unshift({id:id(),teamId:team.id,teamName:team.name,message:state.winner.message,publishedAt:now});break;}
    case 'clearWinner': state.winner=null;break;
    case 'addHallOfFame': {
      const teamName = text(p.teamName, 100);
      if (!teamName) throw new Error('Enter a team or player name.');
      state.hallOfFame.unshift({id:id(),teamName,message:text(p.message,1000),publishedAt:p.publishedAt ? new Date(p.publishedAt).toISOString() : now});
      break;
    }
    case 'updateHallOfFame': {
      const entry = findById(state.hallOfFame,p.id,'Hall of Fame entry');
      if (p.teamName !== undefined) entry.teamName = text(p.teamName,100);
      if (p.message !== undefined) entry.message = text(p.message,1000);
      if (p.publishedAt !== undefined) entry.publishedAt = p.publishedAt ? new Date(p.publishedAt).toISOString() : null;
      break;
    }
    case 'deleteHallOfFame': {
      const i = state.hallOfFame.findIndex(x=>x.id===p.id);
      if (i<0) throw new Error('Hall of Fame entry not found.');
      pushRecycle(state,'hallOfFame',state.hallOfFame.splice(i,1)[0]);
      break;
    }
    case 'selectMvp': {const player=findById(state.players,p.playerId,'MVP participant');state.settings.mvp={playerId:player.id,message:text(p.message,1000),published:false,publishedAt:null};break;}
    case 'publishMvp': {if(!state.settings.mvp.playerId)throw new Error('Select an MVP first.');state.settings.mvp.published=true;state.settings.mvp.publishedAt=now;break;}
    case 'addPrize': {const player=findById(state.players,p.playerId,'Participant');state.prizes.push({id:id(),playerId:player.id,playerName:player.roblox,reward:text(p.reward,150),delivered:bool(p.delivered),public:bool(p.public),createdAt:now});break;}
    case 'updatePrize': {const prize=findById(state.prizes,p.id,'Prize');['reward','delivered','public'].forEach(k=>{if(p[k]!==undefined)prize[k]=['delivered','public'].includes(k)?bool(p[k]):text(p[k],150);});break;}
    case 'deletePrize': {const i=state.prizes.findIndex(x=>x.id===p.id);if(i<0)throw new Error('Prize not found.');pushRecycle(state,'prize',state.prizes.splice(i,1)[0]);break;}
    case 'bulkPrizeDelivered': {const ids=new Set(p.ids||[]);state.prizes.forEach(x=>{if(ids.has(x.id))x.delivered=bool(p.delivered);});break;}
    case 'bulkDeleteTeams': {const ids=new Set(p.ids||[]);state.teams=state.teams.filter(t=>{if(!ids.has(t.id))return true;pushRecycle(state,'team',t);state.players.forEach(p=>{if(p.teamId===t.id)p.teamId=null;});return false;});break;}
    case 'restoreRecycleItem': {const i=state.recycleBin.findIndex(x=>x.id===p.id);if(i<0)throw new Error('Recycle Bin item not found.');const item=state.recycleBin[i];const map={player:'players',team:'teams',event:'events',match:'matches',challenge:'challenges',announcement:'announcements',prize:'prizes',hallOfFame:'hallOfFame'};const key=map[item.type];if(!key)throw new Error('Unsupported restore type.');if(state[key].some(x=>x.id===item.record.id))throw new Error('A record with that ID already exists.');state[key].push(item.record);state.recycleBin.splice(i,1);if(item.type==='team'){(item.record.memberIds||[]).forEach(pid=>{const player=state.players.find(x=>x.id===pid);if(player)player.teamId=item.record.id;});}if(item.type==='player'&&item.record.teamId){const team=state.teams.find(t=>t.id===item.record.teamId);if(team&&!team.memberIds.includes(item.record.id))team.memberIds.push(item.record.id);}break;}
    case 'permanentDeleteRecycleItem': {const i=state.recycleBin.findIndex(x=>x.id===p.id);if(i<0)throw new Error('Recycle Bin item not found.');state.recycleBin.splice(i,1);break;}
    case 'emptyRecycleBin': state.recycleBin=[];break;
    case 'updatePermissions': {const next=p.permissions||{};Object.keys(DEFAULT_PERMISSIONS).forEach(k=>{if(typeof next[k]==='boolean')state.settings.staffPermissions[k]=next[k];});break;}
    case 'setMaintenance': state.settings.maintenanceMode=bool(p.enabled);state.settings.maintenanceMessage=text(p.message||state.settings.maintenanceMessage,1000);break;
    case 'setCountdown': { if (!p.eventStartAt || Number.isNaN(new Date(p.eventStartAt).getTime())) throw new Error('Enter a valid event date and time.'); state.settings.eventStartAt = new Date(p.eventStartAt).toISOString(); break; }
    default: throw new Error(`Unknown action: ${type}`);
  }
}

async function mutate(req, res, type, payload = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const state = await getState(client);
    if (!checkPermission(state, req.session.role, type)) throw Object.assign(new Error('Your staff account does not have permission to perform this action.'), { status: 403 });
    const summary = summaryFor(type, payload);
    if (type !== 'setMaintenance') takeSnapshot(state, summary);
    await performAction(state, type, payload);
    logActivity(state, summary, type);
    if (type !== 'setMaintenance') {
      await client.query('INSERT INTO automatic_backups(data) VALUES($1::jsonb)', [JSON.stringify({ app: 'nerolympics', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), data: state })]);
      await client.query('DELETE FROM automatic_backups WHERE id NOT IN (SELECT id FROM automatic_backups ORDER BY created_at DESC LIMIT $1)', [BACKUP_LIMIT]);
    }
    await saveState(state, client);
    await client.query('COMMIT');
    res.json({ success: true, state: req.session.role === 'admin' ? state : undefined });
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>{});
    res.status(error.status || 400).json({ error: error.message || 'Action failed.' });
  } finally { client.release(); }
}

function maintenancePage(message) {
  const safe = String(message || DEFAULT_STATE.settings.maintenanceMessage).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#10091b"><title>Maintenance | The Nerolympics</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;overflow:hidden;background:radial-gradient(ellipse at 50% -10%,#56317d 0,#1a1028 38%,#080711 78%);color:#f7f2ff;font-family:Inter,system-ui,Arial,sans-serif;padding:24px}.glow{position:fixed;width:420px;height:420px;border-radius:50%;filter:blur(95px);background:#8b5cf6;opacity:.19;animation:pulse 5s ease-in-out infinite alternate}.card{position:relative;width:min(680px,100%);text-align:center;padding:clamp(30px,7vw,58px) 28px;border:1px solid #9870ce88;border-radius:26px;background:linear-gradient(145deg,#281a3dcc,#120d1deF);box-shadow:0 30px 100px #0009,0 0 55px #8b5cf622;backdrop-filter:blur(12px)}small{color:#d2baff;letter-spacing:.28em;font-weight:800;font-size:11px}.spark{margin:0 auto 17px;width:58px;height:58px;display:grid;place-items:center;border-radius:19px;background:linear-gradient(145deg,#c4a5ff,#7540d5);font-size:27px;box-shadow:0 0 35px #9b6cff77}h1{font-size:clamp(2.2rem,8vw,4.2rem);line-height:1.02;letter-spacing:-.05em;margin:18px 0;color:#fff}p{color:#d3c5e6;line-height:1.8;font-size:15px;white-space:pre-wrap}.line{height:1px;width:75px;margin:22px auto;background:linear-gradient(90deg,transparent,#b99aff,transparent)}.foot{color:#9885b5;font-size:10px;letter-spacing:.2em}@keyframes pulse{to{transform:scale(1.2);opacity:.3}}@media(prefers-reduced-motion:reduce){.glow{animation:none}}</style></head><body><div class="glow"></div><main class="card"><div class="spark">✦</div><small>NEROTOPIA PRESENTS</small><h1>THE NEROLYMPICS</h1><div class="line"></div><p>${safe}</p><div class="foot">WE'LL BE BACK SOON · THANK YOU FOR YOUR PATIENCE</div></main></body></html>`;
}

app.get('/health', (req,res)=>res.json({ok:true,service:'nerolympics'}));
app.get('/staff', (req,res)=>res.sendFile(path.join(publicDir,'staff.html')));
app.get('/', async (req,res)=>{
  try { const state=await getState(); if(state.settings.maintenanceMode) return res.status(503).send(maintenancePage(state.settings.maintenanceMessage)); }
  catch(e){console.error('Maintenance check failed:',e.message);}
  res.sendFile(path.join(publicDir,'index.html'));
});
app.get('/api/public/state', async (req,res)=>{
  try {const state=await getState();if(state.settings.maintenanceMode)return res.status(503).json({maintenance:true,message:state.settings.maintenanceMessage});res.json(publicState(state));}
  catch(e){res.status(500).json({error:'Could not load event data.'});}
});
app.post('/api/staff/login', async (req,res)=>{
  const username=text(req.body.username,100);const password=String(req.body.password||'');
  const safeEqual=(a,b)=>{const aa=Buffer.from(String(a));const bb=Buffer.from(String(b));return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);};
  let role=null;
  if(safeEqual(username,process.env.ADMIN_USERNAME)&&safeEqual(password,process.env.ADMIN_PASSWORD))role='admin';
  else if(safeEqual(username,process.env.STAFF_USERNAME)&&safeEqual(password,process.env.STAFF_PASSWORD))role='staff';
  if(!role)return res.status(401).json({error:'Incorrect username or password.'});
  req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Could not start session.'});req.session.role=role;req.session.save(()=>res.json({success:true,role}));});
});
app.post('/api/staff/logout',requireStaff,(req,res)=>req.session.destroy(()=>res.json({success:true})));
app.get('/api/staff/me',(req,res)=>res.json({authenticated:!!req.session?.role,role:req.session?.role||null}));
app.get('/api/staff/state',requireStaff,async(req,res)=>{try{const state=await getState();if(req.session.role==='staff'){state.versions=[];state.backups=[];}res.json(state);}catch(e){res.status(500).json({error:'Could not load staff data.'});}});
app.post('/api/staff/action',requireStaff,async(req,res)=>{
  const {type,payload}=req.body||{};
  if(typeof type!=='string')return res.status(400).json({error:'Action type is required.'});
  if(type==='restoreVersion'||type==='undo'||type==='importBackup'||type==='createBackup'||type==='updatePermissions'||type==='permanentDeleteRecycleItem'||type==='emptyRecycleBin'){
    if(req.session.role!=='admin')return res.status(403).json({error:'Admin access required.'});
    if(type==='restoreVersion'||type==='undo')return restoreVersion(req,res,type,payload||{});
    if(type==='importBackup')return importBackup(req,res,payload||{});
    if(type==='createBackup')return createBackup(req,res);
    if(type==='updatePermissions')return mutate(req,res,'updatePermissions',payload||{});
    if(type==='permanentDeleteRecycleItem'||type==='emptyRecycleBin')return mutate(req,res,type,payload||{});
  }
  return mutate(req,res,type,payload||{});
});
async function restoreVersion(req,res,type,payload){
  const client=await pool.connect();try{await client.query('BEGIN');const state=await getState(client);let version;
    if(type==='undo')version=state.versions[0];else version=state.versions.find(v=>v.id===payload.versionId);
    if(!version)throw new Error('Version not found.');takeSnapshot(state,type==='undo'?'Before undo':'Before version restore');const restored=normalizeState(version.snapshot);restored.versions=state.versions;restored.activityLog=state.activityLog;restored.recycleBin=state.recycleBin;restored.backups=state.backups;logActivity(restored,type==='undo'?'Undid the latest change':'Restored a previous version',type);await saveState(restored,client);await client.query('COMMIT');res.json({success:true});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});res.status(400).json({error:e.message});}finally{client.release();}}
async function createBackup(req,res){try{const state=await getState();const data={app:'nerolympics',schemaVersion:SCHEMA_VERSION,exportedAt:new Date().toISOString(),data:state};await pool.query('INSERT INTO automatic_backups(data) VALUES($1::jsonb)',[JSON.stringify(data)]);await pool.query('DELETE FROM automatic_backups WHERE id NOT IN (SELECT id FROM automatic_backups ORDER BY created_at DESC LIMIT $1)',[BACKUP_LIMIT]);res.json({success:true,backup:data});}catch(e){res.status(500).json({error:'Backup failed.'});}}
async function importBackup(req, res, payload) {
  const body = payload.backup;
  if (!body || typeof body !== 'object' || Number(body.schemaVersion || 1) > SCHEMA_VERSION) {
    return res.status(400).json({ error: 'This backup is invalid or uses an unsupported version.' });
  }
  // Accept both this app's export wrapper and older plain-state JSON backups.
  const raw = body.data || body.state || body;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return res.status(400).json({ error: 'Backup data is missing or invalid.' });
  }
  for (const key of ['players', 'teams', 'events', 'matches', 'challenges', 'announcements', 'prizes']) {
    if (!Array.isArray(raw[key])) {
      return res.status(400).json({ error: `Backup validation failed: ${key} must be an array.` });
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await getState(client);
    takeSnapshot(current, 'Before backup import');
    const restored = normalizeState(raw);
    restored.versions = current.versions;
    restored.activityLog = current.activityLog;
    restored.recycleBin = current.recycleBin;
    restored.backups = current.backups;
    logActivity(restored, 'Imported a validated backup', 'importBackup');
    await saveState(restored, client);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
}
app.get('/api/staff/backup',requireStaff,requireAdmin,async(req,res)=>{try{const state=await getState();res.json({app:'nerolympics',schemaVersion:SCHEMA_VERSION,exportedAt:new Date().toISOString(),data:state});}catch(e){res.status(500).json({error:'Export failed.'});}});
app.get('/api/staff/analytics',requireStaff,async(req,res)=>{try{const s=await getState();const total=s.players.length;const checkins=s.players.reduce((n,p)=>n+(p.checkIns||[]).filter(c=>c.status==='Present'||c.status==='Late').length,0);const possible=s.players.length*s.events.length;const teamStats=s.teams.map(t=>({id:t.id,name:t.name,players:(t.memberIds||[]).length,points:num(t.points),wins:num(t.wins)})).sort((a,b)=>b.points-a.points);res.json({participants:total,active:s.players.filter(p=>p.status!=='Disqualified').length,participationRate:possible?Math.round(checkins/possible*100):0,totalPoints:s.players.reduce((n,p)=>n+num(p.points),0),matches:s.matches.length,completedMatches:s.matches.filter(m=>m.status==='Completed').length,teamStats});}catch(e){res.status(500).json({error:'Analytics unavailable.'});}});
app.get('/api/staff/search',requireStaff,async(req,res)=>{try{const q=text(req.query.q,100).toLowerCase();if(!q)return res.json([]);const s=await getState();const groups=[['Participant',s.players,x=>`${x.roblox} ${x.discord||''}`],['Team',s.teams,x=>x.name],['Event',s.events,x=>`${x.title} ${x.description||''}`],['Match',s.matches,x=>x.title],['Announcement',s.announcements,x=>`${x.title} ${x.body||''}`],['Prize',s.prizes,x=>`${x.playerName} ${x.reward}`],['Recycle Bin',s.recycleBin,x=>`${x.type} ${x.record?.roblox||x.record?.name||x.record?.title||''}`],['Version History',s.versions,x=>`${x.summary||''}`],['Activity Log',s.activityLog,x=>`${x.summary||''}`]];const out=[];for(const [type,items,field] of groups)for(const item of items){if(field(item).toLowerCase().includes(q))out.push({type,id:item.id,label:item.roblox||item.name||item.title||item.reward||item.type,detail:type==='Participant'?item.status:type==='Prize'?item.playerName:''});}res.json(out.slice(0,60));}catch(e){res.status(500).json({error:'Search failed.'});}});
app.get('/api/staff/backups',requireStaff,requireAdmin,async(req,res)=>{try{const r=await pool.query('SELECT id,created_at FROM automatic_backups ORDER BY created_at DESC LIMIT 30');res.json(r.rows);}catch(e){res.status(500).json({error:'Could not load backups.'});}});
app.use('/api',(req,res)=>res.status(404).json({error:'API route not found.'}));
app.use((req,res)=>res.status(404).send('Page not found.'));
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({error:'Unexpected server error.'});});

initDb().then(()=>{
  app.listen(PORT,()=>console.log(`Nerolympics server listening on ${PORT}`));
  // Backups run while the service is awake; a persistent database remains the source of truth.
  setInterval(async()=>{try{const state=await getState();await pool.query('INSERT INTO automatic_backups(data) VALUES($1::jsonb)',[JSON.stringify({app:'nerolympics',schemaVersion:SCHEMA_VERSION,exportedAt:new Date().toISOString(),data:state})]);await pool.query('DELETE FROM automatic_backups WHERE id NOT IN (SELECT id FROM automatic_backups ORDER BY created_at DESC LIMIT $1)',[BACKUP_LIMIT]);}catch(e){console.error('Scheduled backup failed:',e.message);}},6*60*60*1000).unref();
}).catch(error=>{console.error('Database initialization failed:',error);process.exit(1);});