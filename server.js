/**
 * VolunteerSkill - Full Stack Demo Application
 * Node.js + Express | In-Memory Storage | JWT Auth | Role-Based Access Control
 * AI Matching Engine priority: Location -> Availability -> Skill
 */

// Minimal .env loader (no extra dependency). Real environment variables take priority.
try {
  const envPath = require('path').join(__dirname, '.env');
  if (require('fs').existsSync(envPath)) {
    require('fs').readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    });
  }
} catch (e) { console.warn('Could not read .env:', e.message); }

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'volunteerskill-demo-secret-key-change-in-production';
const JWT_EXPIRES_IN = '7d';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const QR_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

app.use(cors());
app.use(express.json({ limit: '5mb' })); // slightly higher limit to allow base64 NGO verification docs
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   IN-MEMORY DATA STORES (persisted to disk — see loadDB/saveDB below)
   ============================================================ */
const db = {
  volunteers: [],   // { id, name, email, phone, passwordHash, role, location, skills, availability, experience, preferredCategories, rating, ratingCount, completedEvents, certificates, createdAt, hoursCompleted, badges[], milestones[], leaderboardOptIn, notifPrefs{}, privacy{} }
  ngos: [],         // { id, ngoName, registrationNumber, address, location, description, email, passwordHash, role, verified, verificationStatus, verificationDocs[], createdAt, notifPrefs{} }
  admins: [],       // { id, email, passwordHash, role }
  events: [],       // { id, ngoId, title, description, category, location, date, timeSlot, requiredSkills, volunteersNeeded, status, matchedVolunteers[], assignedVolunteers[], candidatePool[], createdAt, budget, resourceRequirements, requiredRoles[], emergencyContact{}, searchRadiusKm, cancelledAt, cancelReason }
  notifications: [],// { id, userId, role, title, message, category, read, createdAt }
  certificates: [], // { id, code, volunteerId, eventId, issuedAt }
  reports: [],      // { id, type: 'event'|'user', targetId, reporterId, reporterRole, reason, status, createdAt, resolvedAt, resolution }
  auditLogs: [],    // { id, actorId, actorRole, action, targetType, targetId, details, createdAt }
  appreciations: [],// { id, ngoId, ngoName, volunteerId, volunteerName, message, eventId, createdAt }
  qrTokens: [],     // { token, eventId, volunteerId, purpose: 'checkin'|'checkout', used, createdAt, expiresAt }
  impactShares: [], // { token, volunteerId, createdAt }
  microTasks: [],   // { id, ngoId, title, description, requiredSkill, estimatedMinutes, deadline, mode:'online'|'offline', location, volunteersNeeded, difficulty, instructions, submissionRequirements, status, assignedVolunteers[], createdAt }
  microTaskSubmissions: [], // { id, taskId, volunteerId, submissionText, submissionUrl, status:'submitted'|'approved'|'rejected', reviewNote, submittedAt, reviewedAt }
  impactReports: [] // { id, eventId, ngoId, manualFields:{beneficiaries, environmentalImpact, communityImpactNotes, photos[]}, verified, generatedAt }
};

const BADGE_CATALOG = [
  { id: 'first_event', label: 'First Steps', description: 'Completed your first volunteering event.', icon: 'fa-seedling', check: v => v.completedEvents.length >= 1 },
  { id: 'five_events', label: 'Committed Helper', description: 'Completed 5 volunteering events.', icon: 'fa-hands-helping', check: v => v.completedEvents.length >= 5 },
  { id: 'ten_events', label: 'Community Champion', description: 'Completed 10 volunteering events.', icon: 'fa-award', check: v => v.completedEvents.length >= 10 },
  { id: 'twentyfive_events', label: 'Impact Leader', description: 'Completed 25 volunteering events.', icon: 'fa-crown', check: v => v.completedEvents.length >= 25 },
  { id: 'ten_hours', label: 'Time Giver', description: 'Logged 10+ volunteering hours.', icon: 'fa-clock', check: v => (v.hoursCompleted || 0) >= 10 },
  { id: 'fifty_hours', label: 'Dedicated Volunteer', description: 'Logged 50+ volunteering hours.', icon: 'fa-hourglass-half', check: v => (v.hoursCompleted || 0) >= 50 },
  { id: 'hundred_hours', label: 'Century Club', description: 'Logged 100+ volunteering hours.', icon: 'fa-medal', check: v => (v.hoursCompleted || 0) >= 100 },
  { id: 'five_star', label: 'Top Rated', description: 'Maintained a 4.5+ average rating (3+ reviews).', icon: 'fa-star', check: v => v.ratingCount >= 3 && v.rating >= 4.5 },
  { id: 'multi_skill', label: 'Versatile Volunteer', description: 'Used 3+ different skills across events.', icon: 'fa-toolbox', check: v => new Set(v.skillsUsedHistory || []).size >= 3 }
];

/* ---- Persistence: load on boot, autosave on an interval + on exit ---- */
function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      Object.keys(db).forEach(key => {
        if (Array.isArray(parsed[key])) db[key] = parsed[key];
      });
      console.log(`Loaded persisted data from ${DATA_FILE}`);
      return true;
    }
  } catch (err) {
    console.error('Failed to load persisted data, starting fresh:', err.message);
  }
  return false;
}

let saveScheduled = false;
function saveDB() {
  // Debounce rapid successive writes into a single write on next tick
  if (saveScheduled) return;
  saveScheduled = true;
  setImmediate(() => {
    saveScheduled = false;
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
    } catch (err) {
      console.error('Failed to persist data:', err.message);
    }
  });
}

const wasLoaded = loadDB();

// Seed a default admin account for demo purposes (only if no admins exist yet)
if (db.admins.length === 0) {
  const passwordHash = bcrypt.hashSync('admin123', 8);
  db.admins.push({
    id: uuidv4(),
    email: 'admin@volunteerskill.org',
    passwordHash,
    role: 'admin',
    name: 'Platform Admin'
  });
  console.log('Seeded default admin -> email: admin@volunteerskill.org | password: admin123');
  saveDB();
}

process.on('SIGINT', () => { saveDB(); process.exit(0); });
process.on('SIGTERM', () => { saveDB(); process.exit(0); });
setInterval(saveDB, 5000).unref();

/* ============================================================
   HELPERS
   ============================================================ */

// Haversine distance in km between two lat/lng points
function distanceKm(loc1, loc2) {
  if (!loc1 || !loc2 || loc1.lat == null || loc2.lat == null) return Infinity;
  const R = 6371;
  const dLat = toRad(loc2.lat - loc1.lat);
  const dLng = toRad(loc2.lng - loc1.lng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(loc1.lat)) * Math.cos(toRad(loc2.lat)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
function toRad(deg) { return (deg * Math.PI) / 180; }

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function findUserByEmail(email) {
  const v = db.volunteers.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (v) return { user: v, role: 'volunteer' };
  const n = db.ngos.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (n) return { user: n, role: 'ngo' };
  const a = db.admins.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (a) return { user: a, role: 'admin' };
  return null;
}

function getStoreByRole(role) {
  if (role === 'volunteer') return db.volunteers;
  if (role === 'ngo') return db.ngos;
  if (role === 'admin') return db.admins;
  return null;
}

function findUserById(id, role) {
  const store = getStoreByRole(role);
  return store ? store.find(u => u.id === id) : null;
}

function publicVolunteer(v) {
  const { passwordHash, ...rest } = v;
  return rest;
}
function publicNgo(n) {
  const { passwordHash, verificationDocs, ...rest } = n;
  return { ...rest, verificationDocCount: (verificationDocs || []).length };
}
function publicAdmin(a) {
  const { passwordHash, ...rest } = a;
  return rest;
}

function toPublicUser(user, role) {
  if (role === 'volunteer') return publicVolunteer(user);
  if (role === 'ngo') return publicNgo(user);
  if (role === 'admin') return publicAdmin(user);
  return user;
}

const DEFAULT_NOTIF_PREFS = {
  opportunity: true,
  application: true,
  replacement: true,
  reminder: true,
  scheduleChange: true,
  attendance: true,
  certificate: true,
  feedback: true,
  badge: true,
  general: true
};

// Some categories are safety/operationally critical and are always delivered
// regardless of user preference (e.g. SOS-related, replacement requests to NGOs).
const ALWAYS_DELIVER_CATEGORIES = ['sos', 'safety', 'verification'];

function addNotification(userId, role, title, message, category = 'general') {
  const user = findUserById(userId, role);
  const prefs = (user && user.notifPrefs) ? user.notifPrefs : DEFAULT_NOTIF_PREFS;
  const allowed = ALWAYS_DELIVER_CATEGORIES.includes(category) || prefs[category] !== false;
  if (!allowed) return null;

  const note = {
    id: uuidv4(),
    userId,
    role,
    title,
    message,
    category,
    read: false,
    createdAt: new Date().toISOString()
  };
  db.notifications.push(note);
  saveDB();
  return note;
}

function generateCertCode() {
  return 'VS-' + crypto.randomBytes(3).toString('hex').toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
}

// Builds the full, display-ready certificate payload (used by the certificate page and verification).
function buildCertificateView(cert) {
  const event = db.events.find(e => e.id === cert.eventId);
  const task = (db.microTasks || []).find(t => t.id === cert.eventId);
  const volunteer = db.volunteers.find(v => v.id === cert.volunteerId);
  let hours = cert.hours;
  if (hours == null && task && !event) hours = Math.round((task.estimatedMinutes / 60) * 10) / 10;
  if (hours == null) {
    const asg = event && event.assignedVolunteers.find(a => a.volunteerId === cert.volunteerId);
    hours = event ? (asg && asg.checkInAt && asg.checkOutAt
      ? Math.round(((new Date(asg.checkOutAt) - new Date(asg.checkInAt)) / 3600000) * 10) / 10
      : (event.estimatedHoursPerVolunteer || 4)) : null;
  }
  return {
    id: cert.id,
    code: cert.code,
    volunteerName: cert.volunteerName || (volunteer && volunteer.name) || 'Volunteer',
    eventTitle: cert.eventTitle,
    ngoName: cert.ngoName,
    issuedAt: cert.issuedAt,
    eventDate: event ? (event.date || event.startDate || null) : (task ? (task.deadline || null) : null),
    location: event && event.location ? (event.location.address || event.location.name || event.location.city || null) : null,
    skills: event ? (event.requiredSkills || []) : (task && task.requiredSkill ? [task.requiredSkill] : []),
    hours: hours,
    isMicroTask: !!task && !event
  };
}

function issueCompletedEventCertificate(event, volunteer) {
  const existing = db.certificates.find(c => c.eventId === event.id && c.volunteerId === volunteer.id);
  if (existing) return { certificate: existing, alreadyExisted: true };

  const ngo = db.ngos.find(n => n.id === event.ngoId);
  if (!ngo) return null;

  const certificate = {
    id: uuidv4(),
    code: generateCertCode(),
    volunteerId: volunteer.id,
    volunteerName: volunteer.name,
    eventId: event.id,
    eventTitle: event.title,
    ngoName: ngo.ngoName,
    issuedAt: new Date().toISOString()
  };
  certificate.hours = buildCertificateView(certificate).hours;
  db.certificates.push(certificate);
  if (!Array.isArray(volunteer.certificates)) volunteer.certificates = [];
  volunteer.certificates.push(certificate.id);
  addNotification(
    volunteer.id,
    'volunteer',
    'Certificate Issued!',
    `Your certificate for "${event.title}" is ready. Verification code: ${certificate.code}`,
    'certificate'
  );
  return { certificate, alreadyExisted: false };
}

function logAudit(actorId, actorRole, action, targetType, targetId, details = '') {
  const entry = {
    id: uuidv4(),
    actorId,
    actorRole,
    action,
    targetType,
    targetId,
    details,
    createdAt: new Date().toISOString()
  };
  db.auditLogs.push(entry);
  saveDB();
  return entry;
}

// Approximate a lat/lng to protect volunteer privacy (roughly ~1km grid),
// used whenever exact location sharing has not been authorized.
function approxLocation(loc) {
  if (!loc || loc.lat == null) return loc;
  const round = n => Math.round(n * 100) / 100; // ~1.1km precision
  return { lat: round(loc.lat), lng: round(loc.lng), address: loc.address ? loc.address.split(',').slice(-2).join(',').trim() : undefined };
}

// Very rough ETA estimate for display purposes only (assumes ~30km/h average
// urban travel speed). Real routing requires the Google Directions API on the frontend.
function estimateTravelMinutes(km) {
  if (!isFinite(km)) return null;
  return Math.max(3, Math.round((km / 30) * 60));
}

function toCSV(rows, columns) {
  const escape = v => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = columns.map(c => escape(c.label)).join(',');
  const lines = rows.map(row => columns.map(c => escape(typeof c.value === 'function' ? c.value(row) : row[c.value])).join(','));
  return [header, ...lines].join('\n');
}

// Evaluate badge catalog against a volunteer, award any newly-earned badges,
// and fire a notification + milestone entry for each new one.
function checkAndAwardBadges(volunteer) {
  if (!volunteer.badges) volunteer.badges = [];
  if (!volunteer.milestones) volunteer.milestones = [];
  const earnedIds = new Set(volunteer.badges.map(b => b.id));
  BADGE_CATALOG.forEach(def => {
    if (!earnedIds.has(def.id) && def.check(volunteer)) {
      const badge = { id: def.id, label: def.label, description: def.description, icon: def.icon, earnedAt: new Date().toISOString() };
      volunteer.badges.push(badge);
      volunteer.milestones.push({ id: uuidv4(), type: 'badge', label: `Earned badge: ${def.label}`, date: badge.earnedAt });
      addNotification(volunteer.id, 'volunteer', 'New Badge Earned!', `Congratulations! You've earned the "${def.label}" badge.`, 'badge');
    }
  });
}

/* ============================================================
   IMPACT SCORE / SKILL PASSPORT / COMMUNITY NEED HELPERS
   ============================================================ */
const IMPACT_CATEGORY_MAP = {
  'health': 'Healthcare', 'healthcare': 'Healthcare',
  'education': 'Education',
  'environment': 'Environment',
  'disaster relief': 'Community Service', 'animal welfare': 'Community Service',
  'elderly care': 'Community Service', 'child welfare': 'Community Service',
  'community development': 'Community Service', 'food distribution': 'Community Service',
  'digital literacy': 'Digital'
};
function toImpactCategory(rawCategory, mode) {
  if (mode === 'online') return 'Digital';
  const key = (rawCategory || '').toLowerCase().trim();
  return IMPACT_CATEGORY_MAP[key] || 'Community Service';
}

// Impact Score is a weighted, non-purely-competitive contribution measure.
// It rewards consistency and verified impact rather than raw volume alone.
function computeImpactScore(volunteer) {
  const hours = volunteer.hoursCompleted || 0;
  const eventsCompleted = volunteer.completedEvents.length;
  const microApproved = db.microTaskSubmissions.filter(s => s.volunteerId === volunteer.id && s.status === 'approved').length;
  const avgRating = volunteer.rating || 0;
  const verifiedSkillCount = computeSkillPassport(volunteer).skills.length;
  const ngosSupported = new Set(
    volunteer.completedEvents.map(eid => { const e = db.events.find(ev => ev.id === eid); return e ? e.ngoId : null; }).filter(Boolean)
  ).size;

  // Weighted formula — capped contributions per factor so no single factor dominates
  const score =
    Math.min(hours * 2, 200) +             // up to 200 pts from hours
    Math.min(eventsCompleted * 15, 300) +  // up to 300 pts from events
    Math.min(microApproved * 5, 100) +     // up to 100 pts from micro-tasks
    Math.min(avgRating * 20, 100) +        // up to 100 pts from NGO feedback quality
    Math.min(verifiedSkillCount * 10, 100) + // up to 100 pts from verified skills
    Math.min(ngosSupported * 10, 100);     // up to 100 pts from breadth of NGOs supported

  // Category breakdown: hours attributed to each impact category
  const categoryHours = { Healthcare: 0, Education: 0, Environment: 0, 'Community Service': 0, Digital: 0 };
  volunteer.completedEvents.forEach(eid => {
    const e = db.events.find(ev => ev.id === eid);
    if (!e) return;
    const cat = toImpactCategory(e.category, 'offline');
    const assignment = e.assignedVolunteers.find(a => a.volunteerId === volunteer.id);
    let h = e.estimatedHoursPerVolunteer || 4;
    if (assignment && assignment.checkInAt && assignment.checkOutAt) {
      h = Math.round(((new Date(assignment.checkOutAt) - new Date(assignment.checkInAt)) / 3600000) * 10) / 10;
    }
    categoryHours[cat] = Math.round((categoryHours[cat] + h) * 10) / 10;
  });
  db.microTaskSubmissions.filter(s => s.volunteerId === volunteer.id && s.status === 'approved').forEach(s => {
    const task = db.microTasks.find(t => t.id === s.taskId);
    if (!task) return;
    const cat = toImpactCategory(task.category, task.mode);
    categoryHours[cat] = Math.round((categoryHours[cat] + (task.estimatedMinutes / 60)) * 10) / 10;
  });

  return {
    totalScore: Math.round(score),
    totalHours: hours,
    eventsCompleted,
    tasksCompleted: microApproved,
    verifiedSkillCount,
    ngosSupported,
    certificatesEarned: volunteer.certificates.length,
    microTasksCompleted: microApproved,
    categoryBreakdown: categoryHours
  };
}

// Impact Timeline: chronological contribution history built from milestones + micro-task approvals
function computeImpactTimeline(volunteer) {
  const events = (volunteer.milestones || []).map(m => ({ date: m.date, type: m.type, label: m.label }));
  db.microTaskSubmissions.filter(s => s.volunteerId === volunteer.id && s.status === 'approved').forEach(s => {
    const task = db.microTasks.find(t => t.id === s.taskId);
    events.push({ date: s.reviewedAt, type: 'micro_task', label: `Completed micro-task "${task ? task.title : 'Unknown'}"` });
  });
  return events.sort((a, b) => new Date(b.date) - new Date(a.date));
}

// Skill Passport: a skill is "verified" only when backed by real evidence
// (a completed event requiring that skill + NGO feedback/verification, or an approved micro-task).
function computeSkillPassport(volunteer) {
  const evidenceBySkill = {};
  function addEvidence(skill, evidence) {
    const key = skill.toLowerCase();
    if (!evidenceBySkill[key]) evidenceBySkill[key] = { skill, evidence: [], hours: 0 };
    evidenceBySkill[key].evidence.push(evidence);
  }

  volunteer.completedEvents.forEach(eid => {
    const e = db.events.find(ev => ev.id === eid);
    if (!e) return;
    const ngo = db.ngos.find(n => n.id === e.ngoId);
    const fb = e.feedback.find(f => f.volunteerId === volunteer.id);
    const assignment = e.assignedVolunteers.find(a => a.volunteerId === volunteer.id);
    let hours = e.estimatedHoursPerVolunteer || 4;
    if (assignment && assignment.checkInAt && assignment.checkOutAt) {
      hours = Math.round(((new Date(assignment.checkOutAt) - new Date(assignment.checkInAt)) / 3600000) * 10) / 10;
    }
    (e.requiredSkills || []).forEach(skill => {
      if (!(volunteer.skills || []).map(s => s.toLowerCase()).includes(skill.toLowerCase())) return;
      addEvidence(skill, {
        type: 'event', eventId: e.id, eventTitle: e.title, ngoName: ngo ? ngo.ngoName : 'Unknown NGO',
        ngoVerified: !!fb, rating: fb ? fb.rating : null, hours, date: e.date
      });
      const key = skill.toLowerCase();
      evidenceBySkill[key].hours = Math.round((evidenceBySkill[key].hours + hours) * 10) / 10;
    });
  });

  db.microTaskSubmissions.filter(s => s.volunteerId === volunteer.id && s.status === 'approved').forEach(s => {
    const task = db.microTasks.find(t => t.id === s.taskId);
    if (!task || !task.requiredSkill) return;
    addEvidence(task.requiredSkill, {
      type: 'micro_task', taskId: task.id, taskTitle: task.title,
      ngoVerified: true, hours: Math.round((task.estimatedMinutes / 60) * 10) / 10, date: s.reviewedAt
    });
    const key = task.requiredSkill.toLowerCase();
    evidenceBySkill[key].hours = Math.round((evidenceBySkill[key].hours + task.estimatedMinutes / 60) * 10) / 10;
  });

  const certsBySkill = {};
  db.certificates.filter(c => c.volunteerId === volunteer.id).forEach(c => {
    const e = db.events.find(ev => ev.id === c.eventId);
    (e ? e.requiredSkills : []).forEach(skill => {
      const key = skill.toLowerCase();
      if (!certsBySkill[key]) certsBySkill[key] = [];
      certsBySkill[key].push({ code: c.code, eventTitle: c.eventTitle });
    });
  });

  const skills = Object.values(evidenceBySkill)
    .filter(e => e.evidence.some(ev => ev.ngoVerified)) // ONLY verified skills, never bare self-reported ones
    .map(e => ({
      skill: e.skill,
      verified: true,
      level: e.hours >= 40 ? 'Expert' : e.hours >= 15 ? 'Intermediate' : 'Beginner',
      totalHours: e.hours,
      projects: e.evidence.map(ev => ev.type === 'event' ? ev.eventTitle : ev.taskTitle),
      certificates: certsBySkill[e.skill.toLowerCase()] || [],
      evidence: e.evidence
    }));

  return { volunteerName: volunteer.name, skills };
}
function authenticate(req, res, next) {
  const header = req.headers['authorization'];
  const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authentication token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = findUserById(decoded.id, decoded.role);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    req.user = user;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.userRole)) {
      return res.status(403).json({ error: 'Access denied for this role' });
    }
    next();
  };
}

/* ============================================================
   AI MATCHING ENGINE
   Priority (strict, in this exact order): Location -> Availability -> Skill
   ============================================================ */

// Does volunteer availability intersect with event's required time slot?
function availabilityMatchScore(volunteer, event) {
  if (!event.timeSlot || !volunteer.availability || volunteer.availability.length === 0) return 0;
  let score = 0;
  volunteer.availability.forEach(slot => {
    if (slot.day && event.timeSlot.day && slot.day.toLowerCase() === event.timeSlot.day.toLowerCase()) {
      score += 1;
      // Bonus if time window overlaps too
      if (slot.timeOfDay && event.timeSlot.timeOfDay &&
          slot.timeOfDay.toLowerCase() === event.timeSlot.timeOfDay.toLowerCase()) {
        score += 1;
      }
    }
  });
  return score;
}

// Count of overlapping skills between volunteer and event's required skills
function skillMatchScore(volunteer, event) {
  if (!event.requiredSkills || event.requiredSkills.length === 0) return 0;
  const vSkills = (volunteer.skills || []).map(s => s.toLowerCase());
  const reqSkills = event.requiredSkills.map(s => s.toLowerCase());
  return reqSkills.filter(s => vSkills.includes(s)).length;
}

// Rough numeric ordering for free-text experience levels, used only as a 4th-priority tiebreaker
const EXPERIENCE_RANK = { 'none': 0, 'beginner': 1, 'intermediate': 2, 'experienced': 3, 'expert': 4 };
function experienceScore(volunteer) {
  const key = (volunteer.experience || '').toLowerCase().trim();
  if (key in EXPERIENCE_RANK) return EXPERIENCE_RANK[key];
  // Fallback: treat any non-empty free-text experience as "some experience"
  return key ? 1 : 0;
}

/**
 * Rank all eligible volunteers for an event using STRICT priority ordering:
 * 1) Location distance ascending (closer = better)         [PRIMARY — never overridden]
 * 2) Availability score descending (more overlap = better)
 * 3) Skill score descending (more overlap = better)
 * 4) Experience score descending
 * 5) Rating descending
 * A far-away volunteer can never outrank a nearer eligible volunteer on the
 * basis of skill/experience/rating — distance is always compared first.
 * Returns a sorted array of { volunteerId, distanceKm, availabilityScore, skillScore, experienceScore, rating }
 */
function rankCandidates(event, excludeIds = []) {
  const radius = event.searchRadiusKm || 50;
  const candidates = db.volunteers
    .filter(v => !excludeIds.includes(v.id))
    .map(v => {
      const dist = distanceKm(v.location, event.location);
      const avail = availabilityMatchScore(v, event);
      const skill = skillMatchScore(v, event);
      const exp = experienceScore(v);
      return {
        volunteerId: v.id,
        distanceKm: dist,
        availabilityScore: avail,
        skillScore: skill,
        experienceScore: exp,
        rating: v.rating || 0
      };
    })
    // Only consider volunteers within the event's search radius as truly "matchable" by location
    .filter(c => c.distanceKm <= radius);

  candidates.sort((a, b) => {
    if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;             // 1. LOCATION
    if (a.availabilityScore !== b.availabilityScore) return b.availabilityScore - a.availabilityScore; // 2. AVAILABILITY
    if (a.skillScore !== b.skillScore) return b.skillScore - a.skillScore;             // 3. SKILL
    if (a.experienceScore !== b.experienceScore) return b.experienceScore - a.experienceScore; // 4. EXPERIENCE
    return b.rating - a.rating;                                                        // 5. RATING
  });

  return candidates;
}

/**
 * Run the AI matching engine for an event.
 * Selects top N = volunteersNeeded as "matched" (pending acceptance),
 * keeps remaining ranked candidates as a backup pool for replacement matching.
 */
function runMatchingEngine(event) {
  const ranked = rankCandidates(event, []);
  const needed = event.volunteersNeeded || 1;

  const matched = ranked.slice(0, needed).map(c => ({
    volunteerId: c.volunteerId,
    status: 'pending', // pending | accepted | rejected
    distanceKm: Math.round(c.distanceKm * 10) / 10,
    availabilityScore: c.availabilityScore,
    skillScore: c.skillScore,
    experienceScore: c.experienceScore,
    rating: c.rating,
    matchedAt: new Date().toISOString()
  }));

  const backupPool = ranked.slice(needed); // remaining candidates for replacement

  event.matchedVolunteers = matched;
  event.candidatePool = backupPool;

  // Notify matched volunteers
  matched.forEach(m => {
    addNotification(
      m.volunteerId,
      'volunteer',
      'New Opportunity Matched!',
      `You've been matched to "${event.title}" based on your location, availability, and skills. Please review and respond.`,
      'opportunity'
    );
  });

  return event;
}

/**
 * Re-run matching for every currently OPEN or IN-PROGRESS event whose candidate
 * pool could plausibly change. Called automatically whenever a volunteer's
 * location, availability, or skills change, so recommendations always stay current.
 * Existing ACCEPTED assignments are preserved; only pending/unfilled slots are refreshed.
 */
function recomputeOpenEventMatches() {
  db.events
    .filter(e => e.status === 'open' || e.status === 'in-progress')
    .forEach(event => {
      const acceptedIds = event.matchedVolunteers.filter(m => m.status === 'accepted').map(m => m.volunteerId);
      const rejectedIds = event.matchedVolunteers.filter(m => m.status === 'rejected').map(m => m.volunteerId);
      const stillPending = event.matchedVolunteers.filter(m => m.status === 'pending').map(m => m.volunteerId);
      const excludeIds = [...acceptedIds, ...rejectedIds];
      const ranked = rankCandidates(event, excludeIds);
      const stillNeeded = Math.max(0, (event.volunteersNeeded || 1) - acceptedIds.length);

      const newlyRanked = ranked.filter(c => !stillPending.includes(c.volunteerId));
      const keepPending = event.matchedVolunteers.filter(m => m.status === 'pending' && ranked.some(r => r.volunteerId === m.volunteerId));
      const additions = newlyRanked.slice(0, Math.max(0, stillNeeded - keepPending.length)).map(c => ({
        volunteerId: c.volunteerId,
        status: 'pending',
        distanceKm: Math.round(c.distanceKm * 10) / 10,
        availabilityScore: c.availabilityScore,
        skillScore: c.skillScore,
        experienceScore: c.experienceScore,
        rating: c.rating,
        matchedAt: new Date().toISOString()
      }));

      if (additions.length > 0) {
        event.matchedVolunteers = [
          ...event.matchedVolunteers.filter(m => m.status !== 'pending'),
          ...keepPending,
          ...additions
        ];
        additions.forEach(m => addNotification(
          m.volunteerId, 'volunteer', 'New Opportunity Matched!',
          `You've been matched to "${event.title}" based on your location, availability, and skills. Please review and respond.`, 'opportunity'
        ));
      }
      event.candidatePool = ranked.filter(c =>
        !event.matchedVolunteers.some(m => m.volunteerId === c.volunteerId)
      );
    });
  saveDB();
}

/**
 * Replacement matching: called when a volunteer rejects (or is removed from) an event.
 * Pulls the next best candidate from the backup pool (already sorted by priority).
 */
function runReplacementMatching(event) {
  if (!event.candidatePool) event.candidatePool = [];
  const currentIds = event.matchedVolunteers.map(m => m.volunteerId);
  // Refresh pool to exclude anyone already matched/assigned
  let pool = event.candidatePool.filter(c => !currentIds.includes(c.volunteerId));

  if (pool.length === 0) {
    // Re-rank from scratch excluding current + already-rejected volunteers
    const excludeIds = event.matchedVolunteers.map(m => m.volunteerId);
    pool = rankCandidates(event, excludeIds);
  }

  const replacement = pool.shift();
  event.candidatePool = pool;

  if (replacement) {
    const newMatch = {
      volunteerId: replacement.volunteerId,
      status: 'pending',
      distanceKm: Math.round(replacement.distanceKm * 10) / 10,
      availabilityScore: replacement.availabilityScore,
      skillScore: replacement.skillScore,
      experienceScore: replacement.experienceScore,
      rating: replacement.rating,
      isReplacement: true,
      matchedAt: new Date().toISOString()
    };
    event.matchedVolunteers.push(newMatch);
    addNotification(
      replacement.volunteerId,
      'volunteer',
      'New Opportunity Matched!',
      `You've been matched to "${event.title}" (replacement match) based on your location, availability, and skills.`,
      'opportunity'
    );
    return newMatch;
  }
  return null;
}

/* ============================================================
   VALIDATION HELPERS
   ============================================================ */
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/* ============================================================
   AUTH ROUTES
   ============================================================ */

// Register Volunteer
app.post('/api/auth/register/volunteer', (req, res) => {
  try {
    const {
      name, email, phone, password,
      location, skills, availability,
      experience, preferredCategories
    } = req.body;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: 'Name, email, phone, and password are required' });
    }
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (findUserByEmail(email)) return res.status(409).json({ error: 'Email already registered' });
    if (!location || location.lat == null || location.lng == null) {
      return res.status(400).json({ error: 'Location with latitude and longitude is required' });
    }

    const passwordHash = bcrypt.hashSync(password, 8);
    const volunteer = {
      id: uuidv4(),
      name,
      email,
      phone,
      passwordHash,
      role: 'volunteer',
      location: { lat: parseFloat(location.lat), lng: parseFloat(location.lng), address: location.address || '' },
      skills: Array.isArray(skills) ? skills : (skills ? [skills] : []),
      availability: Array.isArray(availability) ? availability : [],
      experience: experience || '',
      preferredCategories: Array.isArray(preferredCategories) ? preferredCategories : [],
      rating: 0,
      ratingCount: 0,
      completedEvents: [],
      certificates: [],
      hoursCompleted: 0,
      skillsUsedHistory: [],
      badges: [],
      milestones: [],
      leaderboardOptIn: false,
      notifPrefs: { ...DEFAULT_NOTIF_PREFS },
      privacy: { profileVisibility: 'public', shareExactLocationWithNgos: false },
      createdAt: new Date().toISOString()
    };
    db.volunteers.push(volunteer);
    saveDB();

    const token = signToken({ id: volunteer.id, role: 'volunteer' });
    addNotification(volunteer.id, 'volunteer', 'Welcome to VolunteerSkill!', 'Your profile is live. We will start matching you with nearby opportunities.', 'general');
    res.status(201).json({ token, role: 'volunteer', user: publicVolunteer(volunteer) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Register NGO
app.post('/api/auth/register/ngo', (req, res) => {
  try {
    const { ngoName, registrationNumber, address, location, description, email, password } = req.body;

    if (!ngoName || !registrationNumber || !address || !email || !password) {
      return res.status(400).json({ error: 'NGO name, registration number, address, email, and password are required' });
    }
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (findUserByEmail(email)) return res.status(409).json({ error: 'Email already registered' });
    if (!location || location.lat == null || location.lng == null) {
      return res.status(400).json({ error: 'Location with latitude and longitude is required' });
    }

    const passwordHash = bcrypt.hashSync(password, 8);
    const ngo = {
      id: uuidv4(),
      ngoName,
      registrationNumber,
      address,
      location: { lat: parseFloat(location.lat), lng: parseFloat(location.lng) },
      description: description || '',
      email,
      passwordHash,
      role: 'ngo',
      verified: false,
      verificationStatus: 'pending', // pending | approved | rejected
      verificationDocs: [],
      notifPrefs: { ...DEFAULT_NOTIF_PREFS },
      createdAt: new Date().toISOString()
    };
    db.ngos.push(ngo);
    saveDB();

    const token = signToken({ id: ngo.id, role: 'ngo' });
    addNotification(ngo.id, 'ngo', 'Registration Received', 'Your NGO account was created and is pending admin verification. Upload verification documents from your dashboard to speed up approval.', 'verification');
    res.status(201).json({ token, role: 'ngo', user: publicNgo(ngo) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login (role-aware)
app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const found = findUserByEmail(email);
    if (!found) return res.status(401).json({ error: 'Invalid email or password' });

    const { user, role } = found;
    const ok = bcrypt.compareSync(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    const token = signToken({ id: user.id, role });
    res.json({ token, role, user: toPublicUser(user, role) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

/* ============================================================
   PROFILE ROUTES
   ============================================================ */
app.get('/api/profile', authenticate, (req, res) => {
  res.json({ role: req.userRole, user: toPublicUser(req.user, req.userRole) });
});

app.put('/api/profile', authenticate, (req, res) => {
  const editable = { ...req.body };
  delete editable.id;
  delete editable.password;
  delete editable.passwordHash;
  delete editable.role;
  delete editable.email; // email change not allowed in this demo
  delete editable.verified;
  delete editable.verificationStatus;
  delete editable.verificationDocs;
  delete editable.rating;
  delete editable.ratingCount;
  delete editable.completedEvents;
  delete editable.certificates;
  delete editable.hoursCompleted;
  delete editable.badges;
  delete editable.milestones;
  delete editable.skillsUsedHistory;

  // Detect whether matching-relevant fields changed, so we can auto re-run recommendations
  const matchRelevantChanged = req.userRole === 'volunteer' && (
    ('location' in editable) || ('availability' in editable) || ('skills' in editable) || ('experience' in editable)
  );

  Object.assign(req.user, editable);
  saveDB();

  if (matchRelevantChanged) {
    recomputeOpenEventMatches();
  }

  res.json({ user: toPublicUser(req.user, req.userRole) });
});

// Notification preferences
app.get('/api/notifications/preferences', authenticate, (req, res) => {
  res.json({ preferences: req.user.notifPrefs || DEFAULT_NOTIF_PREFS });
});
app.put('/api/notifications/preferences', authenticate, (req, res) => {
  req.user.notifPrefs = { ...DEFAULT_NOTIF_PREFS, ...(req.user.notifPrefs || {}), ...req.body };
  saveDB();
  res.json({ preferences: req.user.notifPrefs });
});

// Volunteer privacy settings
app.get('/api/volunteer/privacy', authenticate, authorize('volunteer'), (req, res) => {
  res.json({ privacy: req.user.privacy || { profileVisibility: 'public', shareExactLocationWithNgos: false } });
});
app.put('/api/volunteer/privacy', authenticate, authorize('volunteer'), (req, res) => {
  req.user.privacy = { ...(req.user.privacy || {}), ...req.body };
  saveDB();
  res.json({ privacy: req.user.privacy });
});

/* ============================================================
   EVENT ROUTES (NGO)
   ============================================================ */

// Create event -> triggers AI matching automatically
app.post('/api/events', authenticate, authorize('ngo'), (req, res) => {
  try {
    const {
      title, description, category, location, date,
      timeSlot, requiredSkills, volunteersNeeded,
      budget, resourceRequirements, requiredRoles, emergencyContact, searchRadiusKm,
      estimatedHoursPerVolunteer
    } = req.body;

    if (!title || !category || !date || !volunteersNeeded) {
      return res.status(400).json({ error: 'Title, category, date, and volunteersNeeded are required' });
    }
    if (!req.user.verified) {
      return res.status(403).json({ error: 'Your NGO must be verified by an admin before publishing events.' });
    }

    const event = {
      id: uuidv4(),
      ngoId: req.user.id,
      title,
      description: description || '',
      category,
      location: location && location.lat != null
        ? { lat: parseFloat(location.lat), lng: parseFloat(location.lng), address: location.address || '' }
        : req.user.location,
      date,
      timeSlot: timeSlot || {},
      requiredSkills: Array.isArray(requiredSkills) ? requiredSkills : [],
      volunteersNeeded: parseInt(volunteersNeeded, 10),
      searchRadiusKm: searchRadiusKm ? parseFloat(searchRadiusKm) : 50,
      budget: budget != null ? parseFloat(budget) || 0 : 0,
      resourceRequirements: resourceRequirements || '',
      requiredRoles: Array.isArray(requiredRoles) ? requiredRoles : [],
      emergencyContact: emergencyContact && emergencyContact.name ? {
        name: emergencyContact.name, phone: emergencyContact.phone || ''
      } : { name: req.user.ngoName, phone: '' },
      estimatedHoursPerVolunteer: estimatedHoursPerVolunteer ? parseFloat(estimatedHoursPerVolunteer) : 4,
      status: 'open', // open | in-progress | completed | cancelled
      matchedVolunteers: [],
      assignedVolunteers: [],
      candidatePool: [],
      feedback: [],
      cancelledAt: null,
      cancelReason: null,
      createdAt: new Date().toISOString()
    };

    db.events.push(event);
    runMatchingEngine(event);
    saveDB();

    res.status(201).json({ event, matchCount: event.matchedVolunteers.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Event creation failed' });
  }
});

// Get NGO's own events (with match results)
app.get('/api/events', authenticate, authorize('ngo'), (req, res) => {
  const events = db.events.filter(e => e.ngoId === req.user.id).map(enrichEventForNgo);
  res.json({ events });
});

// Get single event detail
app.get('/api/events/:id', authenticate, (req, res) => {
  const event = db.events.find(e => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (req.userRole === 'ngo' && event.ngoId !== req.user.id) {
    return res.status(403).json({ error: 'Not your event' });
  }
  res.json({ event: enrichEventForNgo(event) });
});

function enrichEventForNgo(event) {
  const matched = event.matchedVolunteers.map(m => {
    const v = db.volunteers.find(vol => vol.id === m.volunteerId);
    return { ...m, volunteer: v ? publicVolunteer(v) : null };
  });
  const assigned = event.assignedVolunteers.map(a => {
    const v = db.volunteers.find(vol => vol.id === a.volunteerId);
    return { ...a, volunteer: v ? publicVolunteer(v) : null };
  });
  return { ...event, matchedVolunteers: matched, assignedVolunteers: assigned };
}

// Manually trigger re-matching for an event (optional utility endpoint)
app.post('/api/events/:id/rematch', authenticate, authorize('ngo'), (req, res) => {
  const event = db.events.find(e => e.id === req.params.id && e.ngoId === req.user.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  runMatchingEngine(event);
  saveDB();
  res.json({ event: enrichEventForNgo(event) });
});

// Edit an event's requirements/resources. Re-runs matching if location/skills/date/timeSlot/radius change.
app.put('/api/events/:id', authenticate, authorize('ngo'), (req, res) => {
  const event = db.events.find(e => e.id === req.params.id && e.ngoId === req.user.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.status === 'cancelled' || event.status === 'completed') {
    return res.status(400).json({ error: `Cannot edit a ${event.status} event` });
  }

  const fields = ['title', 'description', 'category', 'date', 'timeSlot', 'requiredSkills',
    'volunteersNeeded', 'budget', 'resourceRequirements', 'requiredRoles', 'emergencyContact',
    'searchRadiusKm', 'estimatedHoursPerVolunteer'];
  const matchRelevant = ['location', 'date', 'timeSlot', 'requiredSkills', 'searchRadiusKm', 'volunteersNeeded'];
  let shouldRematch = false;

  fields.forEach(f => { if (f in req.body) event[f] = req.body[f]; });
  if (req.body.location && req.body.location.lat != null) {
    event.location = { lat: parseFloat(req.body.location.lat), lng: parseFloat(req.body.location.lng), address: req.body.location.address || '' };
  }
  matchRelevant.forEach(f => { if (f in req.body) shouldRematch = true; });

  if (event.volunteersNeeded) event.volunteersNeeded = parseInt(event.volunteersNeeded, 10);
  if (event.searchRadiusKm) event.searchRadiusKm = parseFloat(event.searchRadiusKm);

  if (shouldRematch) runMatchingEngine(event);
  saveDB();

  // Notify existing matched/assigned volunteers of schedule/location changes
  if ('date' in req.body || 'timeSlot' in req.body || 'location' in req.body) {
    const affected = new Set([
      ...event.matchedVolunteers.map(m => m.volunteerId),
      ...event.assignedVolunteers.map(a => a.volunteerId)
    ]);
    affected.forEach(vid => addNotification(vid, 'volunteer', 'Event Details Updated',
      `The schedule or location for "${event.title}" has changed. Please review the updated details.`, 'scheduleChange'));
  }

  res.json({ event: enrichEventForNgo(event) });
});

// Cancel an event — notifies every matched/assigned volunteer and logs the action
app.post('/api/events/:id/cancel', authenticate, authorize('ngo'), (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'A cancellation reason is required' });

  const event = db.events.find(e => e.id === req.params.id && e.ngoId === req.user.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.status === 'cancelled') return res.status(400).json({ error: 'Event is already cancelled' });
  if (event.status === 'completed') return res.status(400).json({ error: 'Cannot cancel a completed event' });

  event.status = 'cancelled';
  event.cancelledAt = new Date().toISOString();
  event.cancelReason = reason.trim();

  const affected = new Set([
    ...event.matchedVolunteers.map(m => m.volunteerId),
    ...event.assignedVolunteers.map(a => a.volunteerId)
  ]);
  affected.forEach(vid => addNotification(vid, 'volunteer', 'Event Cancelled',
    `"${event.title}" has been cancelled by the organizing NGO. Reason: ${reason.trim()}`, 'scheduleChange'));

  logAudit(req.user.id, 'ngo', 'cancel_event', 'event', event.id, reason.trim());
  saveDB();
  res.json({ event: enrichEventForNgo(event) });
});

// Post-event impact report: attendance, hours, feedback summary for one event
app.get('/api/events/:id/report', authenticate, authorize('ngo'), (req, res) => {
  const event = db.events.find(e => e.id === req.params.id && e.ngoId === req.user.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const attendanceRecords = event.assignedVolunteers.map(a => {
    const v = db.volunteers.find(vol => vol.id === a.volunteerId);
    const hours = (a.checkInAt && a.checkOutAt)
      ? Math.round(((new Date(a.checkOutAt) - new Date(a.checkInAt)) / 3600000) * 10) / 10
      : null;
    return {
      volunteerId: a.volunteerId,
      volunteerName: v ? v.name : 'Unknown',
      status: a.status,
      checkInAt: a.checkInAt || null,
      checkOutAt: a.checkOutAt || null,
      hours
    };
  });

  const totalHours = attendanceRecords.reduce((sum, r) => sum + (r.hours || 0), 0);
  const avgRating = event.feedback.length
    ? Math.round((event.feedback.reduce((s, f) => s + f.rating, 0) / event.feedback.length) * 10) / 10
    : null;

  res.json({
    event: { id: event.id, title: event.title, status: event.status, date: event.date },
    totalAssigned: event.assignedVolunteers.length,
    totalCompleted: event.assignedVolunteers.filter(a => a.status === 'completed').length,
    totalCheckedIn: attendanceRecords.filter(r => r.checkInAt).length,
    totalHoursLogged: Math.round(totalHours * 10) / 10,
    averageFeedbackRating: avgRating,
    feedback: event.feedback,
    attendance: attendanceRecords
  });
});

// Downloadable attendance report (CSV)
app.get('/api/events/:id/attendance/export', authenticate, authorize('ngo'), (req, res) => {
  const event = db.events.find(e => e.id === req.params.id && e.ngoId === req.user.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const rows = event.assignedVolunteers.map(a => {
    const v = db.volunteers.find(vol => vol.id === a.volunteerId);
    const hours = (a.checkInAt && a.checkOutAt)
      ? Math.round(((new Date(a.checkOutAt) - new Date(a.checkInAt)) / 3600000) * 10) / 10 : '';
    return {
      volunteer: v ? v.name : 'Unknown',
      email: v ? v.email : '',
      status: a.status,
      checkInAt: a.checkInAt || '',
      checkOutAt: a.checkOutAt || '',
      hours
    };
  });
  const csv = toCSV(rows, [
    { label: 'Volunteer', value: 'volunteer' },
    { label: 'Email', value: 'email' },
    { label: 'Status', value: 'status' },
    { label: 'Check-In', value: 'checkInAt' },
    { label: 'Check-Out', value: 'checkOutAt' },
    { label: 'Hours', value: 'hours' }
  ]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${event.id}.csv"`);
  res.send(csv);
});

/* ============================================================
   VOLUNTEER OPPORTUNITY ROUTES
   ============================================================ */

// Get all opportunities matched to this volunteer (auto-displayed, no manual search)
app.get('/api/volunteer/opportunities', authenticate, authorize('volunteer'), (req, res) => {
  const myOpportunities = [];
  db.events.forEach(event => {
    const match = event.matchedVolunteers.find(m => m.volunteerId === req.user.id);
    if (match) {
      const ngo = db.ngos.find(n => n.id === event.ngoId);
      myOpportunities.push({
        eventId: event.id,
        title: event.title,
        description: event.description,
        category: event.category,
        date: event.date,
        timeSlot: event.timeSlot,
        location: event.location,
        requiredSkills: event.requiredSkills,
        status: match.status,
        distanceKm: match.distanceKm,
        availabilityScore: match.availabilityScore,
        skillScore: match.skillScore,
        ngoName: ngo ? ngo.ngoName : 'Unknown NGO',
        eventStatus: event.status
      });
    }
  });
  res.json({ opportunities: myOpportunities });
});

// Accept an opportunity
app.post('/api/volunteer/opportunities/:eventId/accept', authenticate, authorize('volunteer'), (req, res) => {
  const event = db.events.find(e => e.id === req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const match = event.matchedVolunteers.find(m => m.volunteerId === req.user.id);
  if (!match) return res.status(404).json({ error: 'You are not matched to this event' });
  if (match.status !== 'pending') return res.status(400).json({ error: `Already ${match.status}` });

  match.status = 'accepted';
  match.respondedAt = new Date().toISOString();

  // Prevent duplicate assignments (defensive check, should not normally happen)
  const alreadyAssigned = event.assignedVolunteers.some(a => a.volunteerId === req.user.id);
  if (!alreadyAssigned) {
    event.assignedVolunteers.push({
      volunteerId: req.user.id,
      status: 'assigned', // assigned | in-progress | completed
      assignedAt: new Date().toISOString(),
      checkInAt: null,
      checkOutAt: null,
      manualCorrections: []
    });
  }

  const ngo = db.ngos.find(n => n.id === event.ngoId);
  if (ngo) {
    const msg = match.isReplacement
      ? `${req.user.name} accepted the replacement opportunity for "${event.title}".`
      : `${req.user.name} accepted the opportunity "${event.title}".`;
    addNotification(ngo.id, 'ngo', match.isReplacement ? 'Replacement Volunteer Accepted' : 'Volunteer Accepted', msg, 'application');
  }
  saveDB();

  res.json({ message: 'Opportunity accepted', match });
});

// Reject an opportunity -> triggers replacement matching
app.post('/api/volunteer/opportunities/:eventId/reject', authenticate, authorize('volunteer'), (req, res) => {
  const event = db.events.find(e => e.id === req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const match = event.matchedVolunteers.find(m => m.volunteerId === req.user.id);
  if (!match) return res.status(404).json({ error: 'You are not matched to this event' });
  if (match.status !== 'pending') return res.status(400).json({ error: `Already ${match.status}` });

  match.status = 'rejected';
  match.respondedAt = new Date().toISOString();

  const replacement = runReplacementMatching(event);

  const ngo = db.ngos.find(n => n.id === event.ngoId);
  if (ngo) {
    addNotification(ngo.id, 'ngo', 'Volunteer Rejected',
      `${req.user.name} rejected "${event.title}". ${replacement ? 'A replacement volunteer has been matched.' : 'No replacement candidates available.'}`,
      'replacement');
  }
  saveDB();

  res.json({ message: 'Opportunity rejected', replacement: replacement || null });
});

// Cancel an ALREADY-ACCEPTED assignment -> also triggers replacement matching
app.post('/api/volunteer/opportunities/:eventId/cancel', authenticate, authorize('volunteer'), (req, res) => {
  const event = db.events.find(e => e.id === req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (event.status === 'cancelled' || event.status === 'completed') {
    return res.status(400).json({ error: `Cannot cancel — event is ${event.status}` });
  }
  const match = event.matchedVolunteers.find(m => m.volunteerId === req.user.id);
  if (!match || match.status !== 'accepted') return res.status(400).json({ error: 'You do not have an accepted assignment for this event' });

  match.status = 'cancelled';
  match.respondedAt = new Date().toISOString();
  event.assignedVolunteers = event.assignedVolunteers.filter(a => a.volunteerId !== req.user.id);

  const replacement = runReplacementMatching(event);

  const ngo = db.ngos.find(n => n.id === event.ngoId);
  if (ngo) {
    addNotification(ngo.id, 'ngo', 'Volunteer Cancelled',
      `${req.user.name} cancelled their accepted assignment for "${event.title}". ${replacement ? 'A replacement volunteer has been matched.' : 'No replacement candidates available.'}`,
      'replacement');
  }
  saveDB();

  res.json({ message: 'Assignment cancelled', replacement: replacement || null });
});

/* ============================================================
   TASK ASSIGNMENT / STATUS UPDATES (NGO manages assigned volunteers)
   ============================================================ */
app.put('/api/events/:id/tasks/:volunteerId/status', authenticate, authorize('ngo'), (req, res) => {
  const { status } = req.body; // assigned | in-progress | completed
  const validStatuses = ['assigned', 'in-progress', 'completed'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const event = db.events.find(e => e.id === req.params.id && e.ngoId === req.user.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const assignment = event.assignedVolunteers.find(a => a.volunteerId === req.params.volunteerId);
  if (!assignment) return res.status(404).json({ error: 'Volunteer not assigned to this event' });

  assignment.status = status;
  assignment.updatedAt = new Date().toISOString();
  let certificate = null;

  if (status === 'completed') {
    const volunteer = db.volunteers.find(v => v.id === req.params.volunteerId);
    if (volunteer && !volunteer.completedEvents.includes(event.id)) {
      volunteer.completedEvents.push(event.id);

      // Track hours: prefer real QR check-in/out timestamps, fall back to the event's estimate
      let hours = event.estimatedHoursPerVolunteer || 4;
      if (assignment.checkInAt && assignment.checkOutAt) {
        hours = Math.round(((new Date(assignment.checkOutAt) - new Date(assignment.checkInAt)) / 3600000) * 10) / 10;
      }
      volunteer.hoursCompleted = Math.round(((volunteer.hoursCompleted || 0) + hours) * 10) / 10;

      // Track which skills were exercised for the "Versatile Volunteer" badge and impact profile
      if (!volunteer.skillsUsedHistory) volunteer.skillsUsedHistory = [];
      (event.requiredSkills || []).forEach(s => {
        if ((volunteer.skills || []).map(x => x.toLowerCase()).includes(s.toLowerCase())) {
          volunteer.skillsUsedHistory.push(s);
        }
      });

      checkAndAwardBadges(volunteer);

      // Monthly milestone tracking
      const monthKey = new Date().toISOString().slice(0, 7);
      volunteer.milestones.push({ id: uuidv4(), type: 'event_completed', label: `Completed "${event.title}"`, date: new Date().toISOString(), month: monthKey });
    }
    if (volunteer) {
      const issued = issueCompletedEventCertificate(event, volunteer);
      certificate = issued && issued.certificate;
    }
    addNotification(
      req.params.volunteerId,
      'volunteer',
      'Task Completed',
      `Your task for "${event.title}" has been marked completed.${certificate ? ' Your certificate is now available in My Certificates.' : ''}`,
      'application'
    );

    // Auto-mark event completed if all assigned volunteers are done
    const allDone = event.assignedVolunteers.length > 0 && event.assignedVolunteers.every(a => a.status === 'completed');
    if (allDone) event.status = 'completed';
  } else {
    if (event.status === 'open') event.status = 'in-progress';
  }
  saveDB();

  res.json({ assignment, event: enrichEventForNgo(event), certificate });
});

// Manual attendance correction by NGO staff (with mandatory reason, kept as an audit trail)
app.put('/api/events/:id/tasks/:volunteerId/attendance/correct', authenticate, authorize('ngo'), (req, res) => {
  const { checkInAt, checkOutAt, reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required for manual attendance corrections' });

  const event = db.events.find(e => e.id === req.params.id && e.ngoId === req.user.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const assignment = event.assignedVolunteers.find(a => a.volunteerId === req.params.volunteerId);
  if (!assignment) return res.status(404).json({ error: 'Volunteer not assigned to this event' });

  const before = { checkInAt: assignment.checkInAt, checkOutAt: assignment.checkOutAt };
  if (checkInAt) assignment.checkInAt = checkInAt;
  if (checkOutAt) assignment.checkOutAt = checkOutAt;
  if (!assignment.manualCorrections) assignment.manualCorrections = [];
  assignment.manualCorrections.push({
    id: uuidv4(), by: req.user.id, reason: reason.trim(), before,
    after: { checkInAt: assignment.checkInAt, checkOutAt: assignment.checkOutAt },
    correctedAt: new Date().toISOString()
  });

  logAudit(req.user.id, 'ngo', 'manual_attendance_correction', 'assignment', `${event.id}:${req.params.volunteerId}`, reason.trim());
  saveDB();
  res.json({ assignment });
});

/* ============================================================
   FEEDBACK ROUTES
   ============================================================ */
app.post('/api/events/:id/feedback', authenticate, authorize('ngo'), (req, res) => {
  const { volunteerId, rating, comment } = req.body;
  if (!volunteerId || rating == null) return res.status(400).json({ error: 'volunteerId and rating are required' });
  if (rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be between 1 and 5' });

  const event = db.events.find(e => e.id === req.params.id && e.ngoId === req.user.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const assignment = event.assignedVolunteers.find(a => a.volunteerId === volunteerId);
  if (!assignment) return res.status(404).json({ error: 'Volunteer not assigned to this event' });

  const feedbackEntry = {
    id: uuidv4(),
    volunteerId,
    rating: parseFloat(rating),
    comment: comment || '',
    createdAt: new Date().toISOString()
  };
  event.feedback.push(feedbackEntry);

  const volunteer = db.volunteers.find(v => v.id === volunteerId);
  if (volunteer) {
    const totalScore = volunteer.rating * volunteer.ratingCount + feedbackEntry.rating;
    volunteer.ratingCount += 1;
    volunteer.rating = Math.round((totalScore / volunteer.ratingCount) * 10) / 10;
    addNotification(volunteer.id, 'volunteer', 'New Feedback Received', `You received a ${feedbackEntry.rating}-star rating for "${event.title}".`, 'feedback');
    checkAndAwardBadges(volunteer);
  }
  saveDB();

  res.status(201).json({ feedback: feedbackEntry, updatedRating: volunteer ? volunteer.rating : null });
});

/* ============================================================
   CERTIFICATE ROUTES
   ============================================================ */
app.post('/api/certificates/generate/:eventId/:volunteerId', authenticate, authorize('ngo'), (req, res) => {
  const event = db.events.find(e => e.id === req.params.eventId && e.ngoId === req.user.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const assignment = event.assignedVolunteers.find(a => a.volunteerId === req.params.volunteerId);
  if (!assignment || assignment.status !== 'completed') {
    return res.status(400).json({ error: 'Volunteer task must be marked completed before generating a certificate' });
  }

  const volunteer = db.volunteers.find(v => v.id === req.params.volunteerId);
  if (!volunteer) return res.status(404).json({ error: 'Volunteer not found' });

  const issued = issueCompletedEventCertificate(event, volunteer);
  if (!issued) return res.status(404).json({ error: 'Event organiser not found' });
  saveDB();

  res.status(issued.alreadyExisted ? 200 : 201).json(issued);
});

// Public certificate verification
app.get('/api/certificates/verify/:code', (req, res) => {
  const cert = db.certificates.find(c => c.code === req.params.code);
  if (!cert) return res.status(404).json({ valid: false, error: 'Certificate not found' });
  res.json({ valid: true, certificate: buildCertificateView(cert) });
});

// NGO: list certificates it has issued for an event (so the dashboard can show "View" instead of "Generate")
app.get('/api/events/:eventId/certificates', authenticate, authorize('ngo'), (req, res) => {
  const event = db.events.find(e => e.id === req.params.eventId && e.ngoId === req.user.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json({ certificates: db.certificates.filter(c => c.eventId === event.id) });
});

// Volunteer's own certificates
app.get('/api/volunteer/certificates', authenticate, authorize('volunteer'), (req, res) => {
  let createdCertificate = false;
  db.events.forEach(event => {
    const assignment = event.assignedVolunteers.find(a => a.volunteerId === req.user.id && a.status === 'completed');
    if (!assignment) return;
    const volunteer = db.volunteers.find(v => v.id === req.user.id);
    if (!volunteer) return;
    const issued = issueCompletedEventCertificate(event, volunteer);
    if (issued && !issued.alreadyExisted) createdCertificate = true;
  });
  if (createdCertificate) saveDB();

  const certs = db.certificates.filter(c => c.volunteerId === req.user.id);
  res.json({ certificates: certs });
});

/* ============================================================
   NOTIFICATIONS
   ============================================================ */
app.get('/api/notifications', authenticate, (req, res) => {
  const notes = db.notifications
    .filter(n => n.userId === req.user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ notifications: notes });
});

app.post('/api/notifications/:id/read', authenticate, (req, res) => {
  const note = db.notifications.find(n => n.id === req.params.id && n.userId === req.user.id);
  if (!note) return res.status(404).json({ error: 'Notification not found' });
  note.read = true;
  res.json({ notification: note });
});

app.post('/api/notifications/read-all', authenticate, (req, res) => {
  db.notifications.filter(n => n.userId === req.user.id).forEach(n => (n.read = true));
  res.json({ message: 'All notifications marked read' });
});

/* ============================================================
   ADMIN ROUTES
   ============================================================ */
app.get('/api/admin/ngos', authenticate, authorize('admin'), (req, res) => {
  res.json({ ngos: db.ngos.map(publicNgo) });
});

app.put('/api/admin/ngos/:id/verify', authenticate, authorize('admin'), (req, res) => {
  const ngo = db.ngos.find(n => n.id === req.params.id);
  if (!ngo) return res.status(404).json({ error: 'NGO not found' });
  ngo.verified = true;
  ngo.verificationStatus = 'approved';
  addNotification(ngo.id, 'ngo', 'NGO Verified!', 'Your NGO has been verified by the admin. You can now publish events, and volunteers will see your Verified badge.', 'verification');
  logAudit(req.user.id, 'admin', 'verify_ngo', 'ngo', ngo.id, '');
  saveDB();
  res.json({ ngo: publicNgo(ngo) });
});

app.put('/api/admin/ngos/:id/reject', authenticate, authorize('admin'), (req, res) => {
  const ngo = db.ngos.find(n => n.id === req.params.id);
  if (!ngo) return res.status(404).json({ error: 'NGO not found' });
  ngo.verified = false;
  ngo.verificationStatus = 'rejected';
  addNotification(ngo.id, 'ngo', 'NGO Verification Rejected', 'Your NGO verification was rejected. Please review your submitted documents and contact support for details.', 'verification');
  logAudit(req.user.id, 'admin', 'reject_ngo', 'ngo', ngo.id, req.body && req.body.reason ? req.body.reason : '');
  saveDB();
  res.json({ ngo: publicNgo(ngo) });
});

app.get('/api/admin/stats', authenticate, authorize('admin'), (req, res) => {
  res.json({
    totalVolunteers: db.volunteers.length,
    totalNgos: db.ngos.length,
    verifiedNgos: db.ngos.filter(n => n.verified).length,
    pendingNgos: db.ngos.filter(n => !n.verified).length,
    totalEvents: db.events.length,
    completedEvents: db.events.filter(e => e.status === 'completed').length,
    totalCertificates: db.certificates.length
  });
});

app.get('/api/admin/volunteers', authenticate, authorize('admin'), (req, res) => {
  res.json({ volunteers: db.volunteers.map(publicVolunteer) });
});

app.get('/api/admin/events', authenticate, authorize('admin'), (req, res) => {
  res.json({ events: db.events });
});

/* ============================================================
   NGO DASHBOARD STATS
   ============================================================ */
app.get('/api/ngo/stats', authenticate, authorize('ngo'), (req, res) => {
  const myEvents = db.events.filter(e => e.ngoId === req.user.id);
  const totalMatched = myEvents.reduce((sum, e) => sum + e.matchedVolunteers.length, 0);
  const totalAccepted = myEvents.reduce((sum, e) => sum + e.matchedVolunteers.filter(m => m.status === 'accepted').length, 0);
  res.json({
    totalEvents: myEvents.length,
    openEvents: myEvents.filter(e => e.status === 'open').length,
    inProgressEvents: myEvents.filter(e => e.status === 'in-progress').length,
    completedEvents: myEvents.filter(e => e.status === 'completed').length,
    totalMatched,
    totalAccepted,
    verified: req.user.verified
  });
});

/* ============================================================
   PUBLIC CONFIG (non-secret browser keys only — never expose private keys)
   ============================================================ */
app.get('/api/config', (req, res) => {
  res.json({
    googleMapsApiKey: GOOGLE_MAPS_API_KEY || null,
    radiusOptionsKm: [5, 10, 25, 50, 100]
  });
});

/* ============================================================
   VOLUNTEER IMPACT PROFILE
   ============================================================ */
app.get('/api/volunteer/impact', authenticate, authorize('volunteer'), (req, res) => {
  res.json({ impact: buildImpactProfile(req.user) });
});

function buildImpactProfile(volunteer) {
  const completedEventDetails = volunteer.completedEvents.map(eid => {
    const ev = db.events.find(e => e.id === eid);
    if (!ev) return null;
    const ngo = ev ? db.ngos.find(n => n.id === ev.ngoId) : null;
    const fb = ev.feedback.find(f => f.volunteerId === volunteer.id);
    return {
      eventId: ev.id, title: ev.title, category: ev.category, date: ev.date,
      ngoName: ngo ? ngo.ngoName : 'Unknown NGO', rating: fb ? fb.rating : null, comment: fb ? fb.comment : null
    };
  }).filter(Boolean);

  const certs = db.certificates.filter(c => c.volunteerId === volunteer.id);
  const appreciations = db.appreciations.filter(a => a.volunteerId === volunteer.id);

  return {
    name: volunteer.name,
    completedEventsCount: completedEventDetails.length,
    totalHours: volunteer.hoursCompleted || 0,
    skillsUsed: [...new Set(volunteer.skillsUsedHistory || [])],
    certificates: certs,
    rating: volunteer.rating,
    ratingCount: volunteer.ratingCount,
    badges: volunteer.badges || [],
    milestones: (volunteer.milestones || []).slice().reverse(),
    completedEvents: completedEventDetails,
    appreciations,
    leaderboardOptIn: !!volunteer.leaderboardOptIn
  };
}

// Generate (or reuse) a public share link for the impact profile
app.post('/api/volunteer/impact/share', authenticate, authorize('volunteer'), (req, res) => {
  let share = db.impactShares.find(s => s.volunteerId === req.user.id);
  if (!share) {
    share = { token: crypto.randomBytes(12).toString('hex'), volunteerId: req.user.id, createdAt: new Date().toISOString() };
    db.impactShares.push(share);
    saveDB();
  }
  res.json({ shareUrl: `/public-impact.html?token=${share.token}` });
});

// Public (no-auth) read-only view of a shared impact profile
app.get('/api/public/impact/:token', (req, res) => {
  const share = db.impactShares.find(s => s.token === req.params.token);
  if (!share) return res.status(404).json({ error: 'Share link not found or expired' });
  const volunteer = db.volunteers.find(v => v.id === share.volunteerId);
  if (!volunteer) return res.status(404).json({ error: 'Volunteer not found' });
  res.json({ impact: buildImpactProfile(volunteer) });
});

/* ============================================================
   AI VOLUNTEER ASSISTANT
   Scoped strictly to the logged-in volunteer's own authorized data.
   Rule/intent-based by default (no external calls, no data leaves the server).
   To upgrade to a generative LLM, wire ANTHROPIC_API_KEY server-side and
   replace answerAssistantQuery's fallback branch — never call it from the browser.
   ============================================================ */
app.post('/api/volunteer/assistant', authenticate, authorize('volunteer'), (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });
  const reply = answerAssistantQuery(req.user, message.trim());
  res.json({ reply });
});

function answerAssistantQuery(volunteer, message) {
  const q = message.toLowerCase();

  const myOpportunities = [];
  db.events.forEach(event => {
    const match = event.matchedVolunteers.find(m => m.volunteerId === volunteer.id);
    if (match) myOpportunities.push({ event, match });
  });

  if (/upcoming|next event|schedule/.test(q)) {
    const upcoming = myOpportunities
      .filter(o => o.match.status === 'accepted' && o.event.status !== 'cancelled' && o.event.status !== 'completed')
      .sort((a, b) => new Date(a.event.date) - new Date(b.event.date));
    if (!upcoming.length) return "You don't have any upcoming confirmed events right now. Check your Matched Opportunities list — accepting a pending match will add it here.";
    return "Your upcoming events:\n" + upcoming.map(o => `• ${o.event.title} on ${VS_fmt(o.event.date)}${o.event.timeSlot?.day ? ' (' + o.event.timeSlot.day + ' ' + (o.event.timeSlot.timeOfDay || '') + ')' : ''}`).join('\n');
  }

  if (/application|status of my|pending|did i get/.test(q)) {
    const pending = myOpportunities.filter(o => o.match.status === 'pending');
    const accepted = myOpportunities.filter(o => o.match.status === 'accepted');
    const rejected = myOpportunities.filter(o => o.match.status === 'rejected');
    let out = `You have ${pending.length} pending, ${accepted.length} accepted, and ${rejected.length} declined application(s).`;
    if (pending.length) out += "\nPending: " + pending.map(o => o.event.title).join(', ');
    return out;
  }

  if (/requirement|what do i need|skills needed|what.?s required/.test(q)) {
    const active = myOpportunities.filter(o => o.match.status !== 'rejected');
    if (!active.length) return "You don't have any matched opportunities yet to show requirements for.";
    return active.map(o => `• "${o.event.title}" requires: ${(o.event.requiredSkills || []).join(', ') || 'no specific skills listed'}. ${o.event.volunteersNeeded} volunteer(s) needed total.`).join('\n');
  }

  if (/certificate/.test(q)) {
    const certs = db.certificates.filter(c => c.volunteerId === volunteer.id);
    if (!certs.length) return "You don't have any certificates yet. Complete an assigned task and your NGO can issue one from their dashboard.";
    return "Your certificates:\n" + certs.map(c => `• "${c.eventTitle}" issued by ${c.ngoName} — code ${c.code}`).join('\n');
  }

  if (/find|suggest|recommend|new opportunit|nearby/.test(q)) {
    const openMatches = myOpportunities.filter(o => o.match.status === 'pending');
    if (!openMatches.length) return "No new opportunities are waiting on you right now — as NGOs post events near you that fit your availability and skills, they'll appear automatically in your Matched Opportunities list.";
    return "You have opportunities waiting for a response:\n" + openMatches.map(o => `• ${o.event.title} — ${o.match.distanceKm}km away, skill match ${o.match.skillScore}`).join('\n');
  }

  if (/hour|impact|badge|milestone/.test(q)) {
    return `You've completed ${volunteer.completedEvents.length} event(s) totalling ${volunteer.hoursCompleted || 0} hour(s), and earned ${(volunteer.badges || []).length} badge(s). Check your Impact Profile for the full breakdown.`;
  }

  if (/hi|hello|hey/.test(q)) {
    return `Hi ${volunteer.name.split(' ')[0]}! I can help you check your application status, upcoming events, event requirements, and certificates. What would you like to know?`;
  }

  return "I can help with: your upcoming events, application status, event requirements, certificates, and your volunteering impact/badges. Could you rephrase your question around one of those?";
}
function VS_fmt(d) { return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }

/* ============================================================
   ADVANCED MAPS / NEARBY DISCOVERY
   Location-first at all times. Approximate volunteer locations are shown to
   NGOs unless the volunteer has explicitly authorized exact sharing.
   ============================================================ */

// Nearby OPEN opportunities for a volunteer, with radius filter + distance/ETA + capacity indicator
app.get('/api/volunteer/nearby', authenticate, authorize('volunteer'), (req, res) => {
  const radius = parseFloat(req.query.radiusKm) || 25;
  const results = db.events
    .filter(e => e.status === 'open' || e.status === 'in-progress')
    .map(e => {
      const dist = distanceKm(req.user.location, e.location);
      const ngo = db.ngos.find(n => n.id === e.ngoId);
      const daysUntil = Math.ceil((new Date(e.date) - new Date()) / (1000 * 60 * 60 * 24));
      return {
        eventId: e.id,
        title: e.title,
        category: e.category,
        date: e.date,
        location: e.location,
        distanceKm: Math.round(dist * 10) / 10,
        etaMinutes: estimateTravelMinutes(dist),
        ngoName: ngo ? ngo.ngoName : 'Unknown NGO',
        capacity: e.volunteersNeeded,
        acceptedCount: e.assignedVolunteers.length,
        spotsRemaining: Math.max(0, e.volunteersNeeded - e.assignedVolunteers.length),
        requiredSkills: e.requiredSkills,
        urgency: daysUntil <= 3 ? 'High' : daysUntil <= 7 ? 'Medium' : 'Low'
      };
    })
    .filter(r => r.distanceKm <= radius)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  res.json({ radiusKm: radius, results });
});

// Nearby verified NGOs for a volunteer (NGO location discovery)
app.get('/api/volunteer/nearby-ngos', authenticate, authorize('volunteer'), (req, res) => {
  const radius = parseFloat(req.query.radiusKm) || 25;
  const results = db.ngos
    .filter(n => n.verified)
    .map(n => {
      const dist = distanceKm(req.user.location, n.location);
      return { ngoId: n.id, ngoName: n.ngoName, address: n.address, location: n.location, distanceKm: Math.round(dist * 10) / 10 };
    })
    .filter(r => r.distanceKm <= radius)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  res.json({ radiusKm: radius, results });
});

// NGO-facing: geographic distribution of matched/assigned volunteers for allocation planning.
// Exact coordinates are only shown for volunteers who opted into exact sharing; others are approximated.
app.get('/api/ngo/volunteer-map', authenticate, authorize('ngo'), (req, res) => {
  const myEventIds = db.events.filter(e => e.ngoId === req.user.id).map(e => e.id);
  const seen = new Map();
  db.events.filter(e => e.ngoId === req.user.id).forEach(event => {
    [...event.matchedVolunteers, ...event.assignedVolunteers].forEach(m => {
      const v = db.volunteers.find(vol => vol.id === m.volunteerId);
      if (!v || seen.has(v.id)) return;
      const shareExact = v.privacy && v.privacy.shareExactLocationWithNgos;
      seen.set(v.id, {
        volunteerId: v.id,
        name: v.name,
        location: shareExact ? v.location : approxLocation(v.location),
        exact: !!shareExact
      });
    });
  });
  res.json({ volunteers: Array.from(seen.values()) });
});

/* ============================================================
   QR ATTENDANCE & VERIFICATION
   Tokens are single-use, short-lived, and bound to one event+volunteer pair.
   ============================================================ */

function issueQrToken(eventId, volunteerId, purpose) {
  // Invalidate any previous unused token of the same purpose for this assignment
  db.qrTokens.forEach(t => {
    if (t.eventId === eventId && t.volunteerId === volunteerId && t.purpose === purpose && !t.used) t.used = true;
  });
  const token = crypto.randomBytes(16).toString('hex');
  const record = {
    token, eventId, volunteerId, purpose, used: false,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + QR_TOKEN_TTL_MS).toISOString()
  };
  db.qrTokens.push(record);
  saveDB();
  return record;
}

// Volunteer (or the assigning NGO) generates a fresh QR token for check-in or check-out
app.post('/api/events/:id/assignments/:volunteerId/qrcode', authenticate, (req, res) => {
  const { purpose } = req.body; // 'checkin' | 'checkout'
  if (!['checkin', 'checkout'].includes(purpose)) return res.status(400).json({ error: "purpose must be 'checkin' or 'checkout'" });

  const event = db.events.find(e => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  if (req.userRole === 'volunteer' && req.user.id !== req.params.volunteerId) return res.status(403).json({ error: 'Not your assignment' });
  if (req.userRole === 'ngo' && event.ngoId !== req.user.id) return res.status(403).json({ error: 'Not your event' });

  const assignment = event.assignedVolunteers.find(a => a.volunteerId === req.params.volunteerId);
  if (!assignment) return res.status(404).json({ error: 'Volunteer is not assigned to this event' });
  if (purpose === 'checkin' && assignment.checkInAt) return res.status(400).json({ error: 'Already checked in' });
  if (purpose === 'checkout' && !assignment.checkInAt) return res.status(400).json({ error: 'Must check in before checking out' });
  if (purpose === 'checkout' && assignment.checkOutAt) return res.status(400).json({ error: 'Already checked out' });

  const record = issueQrToken(event.id, req.params.volunteerId, purpose);
  // The token is what gets encoded into a QR image client-side (see qrcode library in the dashboard)
  res.json({ token: record.token, purpose, expiresAt: record.expiresAt });
});

// NGO staff scans the QR code (payload = the raw token string) to record check-in
app.post('/api/attendance/scan', authenticate, authorize('ngo'), (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });

  const record = db.qrTokens.find(t => t.token === token);
  if (!record) return res.status(404).json({ error: 'Invalid or unrecognized QR code' });
  if (record.used) return res.status(409).json({ error: 'This QR code has already been used (duplicate scan prevented)' });
  if (new Date(record.expiresAt) < new Date()) return res.status(410).json({ error: 'This QR code has expired. Please generate a new one.' });

  const event = db.events.find(e => e.id === record.eventId);
  if (!event || event.ngoId !== req.user.id) return res.status(403).json({ error: 'This QR code does not belong to one of your events' });

  const assignment = event.assignedVolunteers.find(a => a.volunteerId === record.volunteerId);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  record.used = true;
  const now = new Date().toISOString();
  if (record.purpose === 'checkin') {
    if (assignment.checkInAt) return res.status(409).json({ error: 'Volunteer is already checked in (duplicate prevented)' });
    assignment.checkInAt = now;
    if (assignment.status === 'assigned') assignment.status = 'in-progress';
  } else {
    if (!assignment.checkInAt) return res.status(400).json({ error: 'Volunteer has not checked in yet' });
    if (assignment.checkOutAt) return res.status(409).json({ error: 'Volunteer is already checked out (duplicate prevented)' });
    assignment.checkOutAt = now;
  }

  const volunteer = db.volunteers.find(v => v.id === record.volunteerId);
  addNotification(record.volunteerId, 'volunteer',
    record.purpose === 'checkin' ? 'Checked In' : 'Checked Out',
    `You were ${record.purpose === 'checkin' ? 'checked in to' : 'checked out from'} "${event.title}" at ${new Date(now).toLocaleTimeString()}.`,
    'attendance');

  logAudit(req.user.id, 'ngo', `qr_${record.purpose}`, 'assignment', `${event.id}:${record.volunteerId}`, '');
  saveDB();

  res.json({ message: `${record.purpose === 'checkin' ? 'Check-in' : 'Check-out'} recorded`, volunteerName: volunteer ? volunteer.name : 'Unknown', timestamp: now });
});

/* ============================================================
   ENGAGEMENT: BADGES, LEADERBOARD, APPRECIATION WALL, MONTHLY SUMMARY
   ============================================================ */
app.get('/api/volunteer/badges', authenticate, authorize('volunteer'), (req, res) => {
  const earnedIds = new Set((req.user.badges || []).map(b => b.id));
  const catalog = BADGE_CATALOG.map(def => ({
    id: def.id, label: def.label, description: def.description, icon: def.icon,
    earned: earnedIds.has(def.id),
    earnedAt: earnedIds.has(def.id) ? req.user.badges.find(b => b.id === def.id).earnedAt : null
  }));
  res.json({ badges: catalog });
});

// Opt-in only leaderboard — never the sole recognition mechanism, purely supplementary
app.get('/api/leaderboard', authenticate, (req, res) => {
  const top = db.volunteers
    .filter(v => v.leaderboardOptIn)
    .map(v => ({ name: v.name, hoursCompleted: v.hoursCompleted || 0, completedEvents: v.completedEvents.length, badgeCount: (v.badges || []).length }))
    .sort((a, b) => b.hoursCompleted - a.hoursCompleted)
    .slice(0, 25);
  res.json({ leaderboard: top });
});

app.put('/api/volunteer/leaderboard-optin', authenticate, authorize('volunteer'), (req, res) => {
  req.user.leaderboardOptIn = !!req.body.optIn;
  saveDB();
  res.json({ leaderboardOptIn: req.user.leaderboardOptIn });
});

// NGO posts a public appreciation message for a volunteer (separate from the private star rating)
app.post('/api/events/:id/appreciate', authenticate, authorize('ngo'), (req, res) => {
  const { volunteerId, message } = req.body;
  if (!volunteerId || !message || !message.trim()) return res.status(400).json({ error: 'volunteerId and message are required' });
  const event = db.events.find(e => e.id === req.params.id && e.ngoId === req.user.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const volunteer = db.volunteers.find(v => v.id === volunteerId);
  if (!volunteer) return res.status(404).json({ error: 'Volunteer not found' });

  const entry = {
    id: uuidv4(), ngoId: req.user.id, ngoName: req.user.ngoName,
    volunteerId, volunteerName: volunteer.name, message: message.trim(),
    eventId: event.id, createdAt: new Date().toISOString()
  };
  db.appreciations.push(entry);
  addNotification(volunteerId, 'volunteer', 'You Were Appreciated!', `${req.user.ngoName} posted a thank-you message for your work on "${event.title}".`, 'general');
  saveDB();
  res.status(201).json({ appreciation: entry });
});

app.get('/api/appreciation-wall', (req, res) => {
  const wall = db.appreciations.slice().reverse().slice(0, 50);
  res.json({ appreciations: wall });
});

app.get('/api/volunteer/monthly-summary', authenticate, authorize('volunteer'), (req, res) => {
  const monthKey = req.query.month || new Date().toISOString().slice(0, 7);
  const monthMilestones = (req.user.milestones || []).filter(m => m.type === 'event_completed' && (m.month === monthKey || (m.date || '').startsWith(monthKey)));
  res.json({
    month: monthKey,
    eventsCompleted: monthMilestones.length,
    milestones: monthMilestones
  });
});

/* ============================================================
   TRUST & SAFETY
   ============================================================ */

// NGO uploads a verification document (base64-encoded) for admin review
app.post('/api/ngo/verification-docs', authenticate, authorize('ngo'), (req, res) => {
  const { filename, base64 } = req.body;
  if (!filename || !base64) return res.status(400).json({ error: 'filename and base64 content are required' });
  if (base64.length > 4 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max ~3MB)' });

  const doc = { id: uuidv4(), filename, base64, uploadedAt: new Date().toISOString() };
  req.user.verificationDocs = req.user.verificationDocs || [];
  req.user.verificationDocs.push(doc);
  req.user.verificationStatus = 'pending';
  saveDB();
  addNotification(req.user.id, 'ngo', 'Document Uploaded', `"${filename}" was submitted for verification review.`, 'verification');
  res.status(201).json({ document: { id: doc.id, filename: doc.filename, uploadedAt: doc.uploadedAt } });
});

app.get('/api/ngo/verification-docs', authenticate, authorize('ngo'), (req, res) => {
  const docs = (req.user.verificationDocs || []).map(d => ({ id: d.id, filename: d.filename, uploadedAt: d.uploadedAt }));
  res.json({ documents: docs, status: req.user.verificationStatus || 'pending' });
});

app.get('/api/admin/ngos/:id/docs', authenticate, authorize('admin'), (req, res) => {
  const ngo = db.ngos.find(n => n.id === req.params.id);
  if (!ngo) return res.status(404).json({ error: 'NGO not found' });
  res.json({ documents: ngo.verificationDocs || [], status: ngo.verificationStatus || 'pending' });
});

// Report an event or a user (volunteer/NGO) for admin review
app.post('/api/reports', authenticate, (req, res) => {
  const { type, targetId, reason } = req.body;
  if (!['event', 'user'].includes(type) || !targetId || !reason || !reason.trim()) {
    return res.status(400).json({ error: 'type (event|user), targetId, and reason are required' });
  }
  const report = {
    id: uuidv4(), type, targetId, reason: reason.trim(),
    reporterId: req.user.id, reporterRole: req.userRole,
    status: 'open', createdAt: new Date().toISOString(), resolvedAt: null, resolution: null
  };
  db.reports.push(report);
  saveDB();
  logAudit(req.user.id, req.userRole, 'submit_report', type, targetId, reason.trim());
  res.status(201).json({ report });
});

app.get('/api/admin/reports', authenticate, authorize('admin'), (req, res) => {
  res.json({ reports: db.reports.slice().reverse() });
});

app.put('/api/admin/reports/:id/resolve', authenticate, authorize('admin'), (req, res) => {
  const { resolution } = req.body;
  const report = db.reports.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  report.status = 'resolved';
  report.resolution = resolution || '';
  report.resolvedAt = new Date().toISOString();
  logAudit(req.user.id, 'admin', 'resolve_report', report.type, report.targetId, resolution || '');
  saveDB();
  res.json({ report });
});

// Emergency SOS during an active/in-progress event — notifies the organizing NGO and admins immediately,
// bypassing notification preferences, and returns the event's emergency contact for the volunteer to call.
app.post('/api/events/:id/sos', authenticate, authorize('volunteer'), (req, res) => {
  const event = db.events.find(e => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const isAssigned = event.assignedVolunteers.some(a => a.volunteerId === req.user.id);
  if (!isAssigned) return res.status(403).json({ error: 'You are not assigned to this event' });

  const ngo = db.ngos.find(n => n.id === event.ngoId);
  if (ngo) addNotification(ngo.id, 'ngo', '🚨 SOS ALERT', `${req.user.name} triggered an SOS during "${event.title}". Contact them immediately.`, 'sos');
  db.admins.forEach(a => addNotification(a.id, 'admin', '🚨 SOS ALERT', `${req.user.name} triggered an SOS during "${event.title}" (NGO: ${ngo ? ngo.ngoName : 'unknown'}).`, 'sos'));

  logAudit(req.user.id, 'volunteer', 'sos_triggered', 'event', event.id, '');
  saveDB();

  res.json({
    message: 'SOS sent. The organizing NGO and platform admins have been notified.',
    emergencyContact: event.emergencyContact || { name: ngo ? ngo.ngoName : 'NGO', phone: '' }
  });
});

app.get('/api/admin/audit-logs', authenticate, authorize('admin'), (req, res) => {
  res.json({ logs: db.auditLogs.slice().reverse().slice(0, 500) });
});

/* ============================================================
   ADMIN ANALYTICS (extended)
   ============================================================ */
app.get('/api/admin/analytics', authenticate, authorize('admin'), (req, res) => {
  const { from, to } = req.query;
  const inRange = d => {
    if (!d) return true;
    const t = new Date(d).getTime();
    if (from && t < new Date(from).getTime()) return false;
    if (to && t > new Date(to).getTime()) return false;
    return true;
  };

  const eventsInRange = db.events.filter(e => inRange(e.createdAt));
  const totalEvents = eventsInRange.length;
  const completedEvents = eventsInRange.filter(e => e.status === 'completed').length;
  const cancelledEvents = eventsInRange.filter(e => e.status === 'cancelled').length;
  const cancellationRate = totalEvents ? Math.round((cancelledEvents / totalEvents) * 1000) / 10 : 0;

  const totalMatches = eventsInRange.reduce((s, e) => s + e.matchedVolunteers.length, 0);
  const totalAccepted = eventsInRange.reduce((s, e) => s + e.matchedVolunteers.filter(m => m.status === 'accepted').length, 0);
  const participationRate = totalMatches ? Math.round((totalAccepted / totalMatches) * 1000) / 10 : 0;

  const totalHours = db.volunteers.reduce((s, v) => s + (v.hoursCompleted || 0), 0);

  const skillCount = {};
  eventsInRange.forEach(e => (e.requiredSkills || []).forEach(s => { skillCount[s] = (skillCount[s] || 0) + 1; }));
  const mostRequestedSkills = Object.entries(skillCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([skill, count]) => ({ skill, count }));

  // Geographic distribution: bucket volunteers into ~0.5-degree grid cells (coarse region proxy)
  const geoBuckets = {};
  db.volunteers.forEach(v => {
    if (!v.location || v.location.lat == null) return;
    const key = `${Math.round(v.location.lat * 2) / 2},${Math.round(v.location.lng * 2) / 2}`;
    geoBuckets[key] = (geoBuckets[key] || 0) + 1;
  });
  const geographicDistribution = Object.entries(geoBuckets).map(([key, count]) => {
    const [lat, lng] = key.split(',').map(Number);
    return { lat, lng, volunteerCount: count };
  });

  res.json({
    totalRegisteredVolunteers: db.volunteers.length,
    verifiedNgos: db.ngos.filter(n => n.verified).length,
    publishedEvents: totalEvents,
    completedEvents,
    volunteerParticipationRate: participationRate,
    totalVolunteeringHours: Math.round(totalHours * 10) / 10,
    eventCancellationRate: cancellationRate,
    mostRequestedSkills,
    geographicDistribution,
    totalMicroTasks: db.microTasks.length,
    microTasksCompleted: db.microTaskSubmissions.filter(s => s.status === 'approved').length,
    openReports: db.reports.filter(r => r.status === 'open').length
  });
});

app.get('/api/admin/analytics/export', authenticate, authorize('admin'), (req, res) => {
  const rows = db.events.map(e => ({
    title: e.title, category: e.category, status: e.status, date: e.date,
    volunteersNeeded: e.volunteersNeeded, accepted: e.matchedVolunteers.filter(m => m.status === 'accepted').length,
    createdAt: e.createdAt
  }));
  const csv = toCSV(rows, [
    { label: 'Title', value: 'title' }, { label: 'Category', value: 'category' },
    { label: 'Status', value: 'status' }, { label: 'Date', value: 'date' },
    { label: 'Volunteers Needed', value: 'volunteersNeeded' }, { label: 'Accepted', value: 'accepted' },
    { label: 'Created At', value: 'createdAt' }
  ]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="volunteerskill-analytics.csv"');
  res.send(csv);
});

/* ============================================================
   IMPACT SCORE, TIMELINE, SKILL PASSPORT
   ============================================================ */
app.get('/api/volunteer/impact-score', authenticate, authorize('volunteer'), (req, res) => {
  res.json({ impactScore: computeImpactScore(req.user) });
});

app.get('/api/volunteer/impact-timeline', authenticate, authorize('volunteer'), (req, res) => {
  res.json({ timeline: computeImpactTimeline(req.user) });
});

app.get('/api/volunteer/skill-passport', authenticate, authorize('volunteer'), (req, res) => {
  res.json({ passport: computeSkillPassport(req.user) });
});

// Generic share-link generator, reused for impact profile and skill passport
app.post('/api/volunteer/share/:kind', authenticate, authorize('volunteer'), (req, res) => {
  const kind = req.params.kind;
  if (!['impact', 'skillpassport'].includes(kind)) return res.status(400).json({ error: 'Invalid share kind' });
  let share = db.impactShares.find(s => s.volunteerId === req.user.id && s.kind === kind);
  if (!share) {
    share = { token: crypto.randomBytes(12).toString('hex'), volunteerId: req.user.id, kind, createdAt: new Date().toISOString() };
    db.impactShares.push(share);
    saveDB();
  }
  const page = kind === 'impact' ? 'public-impact.html' : 'public-skill-passport.html';
  res.json({ shareUrl: `/${page}?token=${share.token}` });
});

app.get('/api/public/skill-passport/:token', (req, res) => {
  const share = db.impactShares.find(s => s.token === req.params.token && s.kind === 'skillpassport');
  if (!share) return res.status(404).json({ error: 'Share link not found or expired' });
  const volunteer = db.volunteers.find(v => v.id === share.volunteerId);
  if (!volunteer) return res.status(404).json({ error: 'Volunteer not found' });
  res.json({ passport: computeSkillPassport(volunteer) });
});

// NGO (or admin) manually verifies a skill for a volunteer independent of a specific event —
// e.g. after direct observation. Recorded as evidence used by the Skill Passport.
app.post('/api/volunteers/:id/verify-skill', authenticate, authorize('ngo', 'admin'), (req, res) => {
  const { skill, note } = req.body;
  if (!skill || !skill.trim()) return res.status(400).json({ error: 'skill is required' });
  const volunteer = db.volunteers.find(v => v.id === req.params.id);
  if (!volunteer) return res.status(404).json({ error: 'Volunteer not found' });

  if (!volunteer.manualSkillVerifications) volunteer.manualSkillVerifications = [];
  volunteer.manualSkillVerifications.push({
    id: uuidv4(), skill: skill.trim(), verifiedBy: req.userRole === 'ngo' ? req.user.ngoName : 'Admin',
    verifierId: req.user.id, note: note || '', verifiedAt: new Date().toISOString()
  });
  if (!(volunteer.skills || []).map(s => s.toLowerCase()).includes(skill.trim().toLowerCase())) {
    volunteer.skills = [...(volunteer.skills || []), skill.trim()];
  }
  addNotification(volunteer.id, 'volunteer', 'Skill Verified', `Your "${skill.trim()}" skill was verified by ${req.userRole === 'ngo' ? req.user.ngoName : 'a platform admin'}.`, 'general');
  logAudit(req.user.id, req.userRole, 'verify_skill', 'volunteer', volunteer.id, skill.trim());
  saveDB();
  res.json({ message: 'Skill verified' });
});

/* ============================================================
   MICRO-VOLUNTEERING
   ============================================================ */

// NGO creates a micro-task
app.post('/api/micro-tasks', authenticate, authorize('ngo'), (req, res) => {
  if (!req.user.verified) return res.status(403).json({ error: 'Your NGO must be verified before publishing micro-tasks.' });
  const {
    title, description, requiredSkill, estimatedMinutes, deadline, mode, location,
    volunteersNeeded, difficulty, instructions, submissionRequirements, category
  } = req.body;

  if (!title || !description || !estimatedMinutes || !deadline || !mode) {
    return res.status(400).json({ error: 'title, description, estimatedMinutes, deadline, and mode are required' });
  }
  if (!['online', 'offline'].includes(mode)) return res.status(400).json({ error: "mode must be 'online' or 'offline'" });
  if (mode === 'offline' && (!location || location.lat == null)) {
    return res.status(400).json({ error: 'location is required for offline micro-tasks' });
  }

  const task = {
    id: uuidv4(),
    ngoId: req.user.id,
    title, description,
    requiredSkill: requiredSkill || '',
    category: category || 'Community Development',
    estimatedMinutes: parseInt(estimatedMinutes, 10),
    deadline,
    mode,
    location: mode === 'offline' ? { lat: parseFloat(location.lat), lng: parseFloat(location.lng), address: location.address || '' } : null,
    volunteersNeeded: parseInt(volunteersNeeded, 10) || 1,
    difficulty: difficulty || 'Easy',
    instructions: instructions || '',
    submissionRequirements: submissionRequirements || '',
    status: 'open', // open | filled | closed
    assignedVolunteers: [], // volunteerIds who claimed a slot
    createdAt: new Date().toISOString()
  };
  db.microTasks.push(task);
  saveDB();
  res.status(201).json({ task });
});

app.get('/api/micro-tasks', authenticate, authorize('ngo'), (req, res) => {
  const tasks = db.microTasks.filter(t => t.ngoId === req.user.id);
  res.json({ tasks });
});

app.post('/api/micro-tasks/:id/cancel', authenticate, authorize('ngo'), (req, res) => {
  const task = db.microTasks.find(t => t.id === req.params.id && t.ngoId === req.user.id);
  if (!task) return res.status(404).json({ error: 'Micro-task not found' });
  task.status = 'closed';
  saveDB();
  res.json({ task });
});

// Volunteer-facing: recommended micro-tasks.
// ONLINE tasks are matched purely on skill + availability of slots (distance is irrelevant).
// OFFLINE tasks continue to use location-first matching, same as full events.
app.get('/api/volunteer/micro-tasks', authenticate, authorize('volunteer'), (req, res) => {
  const now = new Date();
  const vSkills = (req.user.skills || []).map(s => s.toLowerCase());
  const openTasks = db.microTasks.filter(t => t.status === 'open' && new Date(t.deadline) > now && t.assignedVolunteers.length < t.volunteersNeeded);

  const scored = openTasks.map(t => {
    const skillMatch = !t.requiredSkill || vSkills.includes(t.requiredSkill.toLowerCase());
    const dist = t.mode === 'offline' ? distanceKm(req.user.location, t.location) : null;
    const ngo = db.ngos.find(n => n.id === t.ngoId);
    return { task: t, skillMatch, distanceKm: dist, ngoName: ngo ? ngo.ngoName : 'Unknown NGO' };
  }).filter(r => r.task.mode === 'online' ? r.skillMatch : (r.skillMatch && r.distanceKm != null && r.distanceKm <= 50));

  // Location-first for offline, skill-first for online (distance doesn't apply online)
  scored.sort((a, b) => {
    if (a.task.mode === 'offline' && b.task.mode === 'offline') return a.distanceKm - b.distanceKm;
    if (a.task.mode !== b.task.mode) return a.task.mode === 'offline' ? -1 : 1; // stable-ish ordering, not a ranking claim
    return new Date(a.task.deadline) - new Date(b.task.deadline);
  });

  res.json({
    tasks: scored.map(r => ({
      id: r.task.id, title: r.task.title, description: r.task.description, requiredSkill: r.task.requiredSkill,
      estimatedMinutes: r.task.estimatedMinutes, deadline: r.task.deadline, mode: r.task.mode,
      distanceKm: r.distanceKm != null ? Math.round(r.distanceKm * 10) / 10 : null,
      difficulty: r.task.difficulty, ngoName: r.ngoName,
      spotsRemaining: r.task.volunteersNeeded - r.task.assignedVolunteers.length,
      alreadyClaimed: r.task.assignedVolunteers.some(a => a.volunteerId === req.user.id)
    }))
  });
});

// Volunteer claims a slot and submits their work
app.post('/api/micro-tasks/:id/submit', authenticate, authorize('volunteer'), (req, res) => {
  const { submissionText, submissionUrl } = req.body;
  if (!submissionText && !submissionUrl) return res.status(400).json({ error: 'submissionText or submissionUrl is required' });

  const task = db.microTasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Micro-task not found' });
  if (task.status !== 'open') return res.status(400).json({ error: 'This micro-task is no longer accepting submissions' });
  if (new Date(task.deadline) < new Date()) return res.status(400).json({ error: 'Deadline has passed' });

  const alreadySubmitted = db.microTaskSubmissions.some(s => s.taskId === task.id && s.volunteerId === req.user.id);
  if (alreadySubmitted) return res.status(409).json({ error: 'You already submitted work for this micro-task' });
  if (task.assignedVolunteers.length >= task.volunteersNeeded) return res.status(400).json({ error: 'All slots for this micro-task are filled' });

  if (task.mode === 'offline') {
    const dist = distanceKm(req.user.location, task.location);
    if (dist > 50) return res.status(400).json({ error: 'This offline task is outside your matchable radius' });
  }

  task.assignedVolunteers.push({ volunteerId: req.user.id, claimedAt: new Date().toISOString() });
  if (task.assignedVolunteers.length >= task.volunteersNeeded) task.status = 'filled';

  const submission = {
    id: uuidv4(), taskId: task.id, volunteerId: req.user.id,
    submissionText: submissionText || '', submissionUrl: submissionUrl || '',
    status: 'submitted', reviewNote: '', submittedAt: new Date().toISOString(), reviewedAt: null
  };
  db.microTaskSubmissions.push(submission);
  addNotification(task.ngoId, 'ngo', 'Micro-Task Submission Received', `${req.user.name} submitted work for "${task.title}".`, 'application');
  saveDB();
  res.status(201).json({ submission });
});

app.get('/api/micro-tasks/:id/submissions', authenticate, authorize('ngo'), (req, res) => {
  const task = db.microTasks.find(t => t.id === req.params.id && t.ngoId === req.user.id);
  if (!task) return res.status(404).json({ error: 'Micro-task not found' });
  const subs = db.microTaskSubmissions.filter(s => s.taskId === task.id).map(s => {
    const v = db.volunteers.find(vol => vol.id === s.volunteerId);
    return { ...s, volunteerName: v ? v.name : 'Unknown' };
  });
  res.json({ task, submissions: subs });
});

// NGO reviews a submission -> approve updates hours/impact/skill passport; reject notifies volunteer
app.put('/api/micro-tasks/:taskId/submissions/:subId/review', authenticate, authorize('ngo'), (req, res) => {
  const { decision, note } = req.body; // 'approved' | 'rejected'
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });

  const task = db.microTasks.find(t => t.id === req.params.taskId && t.ngoId === req.user.id);
  if (!task) return res.status(404).json({ error: 'Micro-task not found' });
  const submission = db.microTaskSubmissions.find(s => s.id === req.params.subId && s.taskId === task.id);
  if (!submission) return res.status(404).json({ error: 'Submission not found' });
  if (submission.status !== 'submitted') return res.status(400).json({ error: `Already ${submission.status}` });

  submission.status = decision;
  submission.reviewNote = note || '';
  submission.reviewedAt = new Date().toISOString();

  const volunteer = db.volunteers.find(v => v.id === submission.volunteerId);
  if (decision === 'approved' && volunteer) {
    const hours = Math.round((task.estimatedMinutes / 60) * 10) / 10;
    volunteer.hoursCompleted = Math.round(((volunteer.hoursCompleted || 0) + hours) * 10) / 10;
    if (task.requiredSkill) {
      if (!volunteer.skillsUsedHistory) volunteer.skillsUsedHistory = [];
      volunteer.skillsUsedHistory.push(task.requiredSkill);
    }
    volunteer.milestones.push({ id: uuidv4(), type: 'micro_task', label: `Completed micro-task "${task.title}"`, date: submission.reviewedAt });
    checkAndAwardBadges(volunteer);
    addNotification(volunteer.id, 'volunteer', 'Micro-Task Approved!', `Your submission for "${task.title}" was approved. Your Impact Score and Skill Passport have been updated.`, 'application');
  } else if (volunteer) {
    addNotification(volunteer.id, 'volunteer', 'Micro-Task Needs Revision', `Your submission for "${task.title}" was not approved. ${note ? 'NGO note: ' + note : ''}`, 'application');
  }
  saveDB();
  res.json({ submission });
});

// Issue a certificate for a completed, approved micro-task (reuses the certificate model)
app.post('/api/micro-tasks/:taskId/submissions/:subId/certificate', authenticate, authorize('ngo'), (req, res) => {
  const task = db.microTasks.find(t => t.id === req.params.taskId && t.ngoId === req.user.id);
  if (!task) return res.status(404).json({ error: 'Micro-task not found' });
  const submission = db.microTaskSubmissions.find(s => s.id === req.params.subId && s.taskId === task.id);
  if (!submission || submission.status !== 'approved') return res.status(400).json({ error: 'Submission must be approved first' });

  const volunteer = db.volunteers.find(v => v.id === submission.volunteerId);
  if (!volunteer) return res.status(404).json({ error: 'Volunteer not found' });

  const existing = db.certificates.find(c => c.eventId === task.id && c.volunteerId === volunteer.id);
  if (existing) return res.json({ certificate: existing, alreadyExisted: true });

  const certificate = {
    id: uuidv4(), code: generateCertCode(), volunteerId: volunteer.id, volunteerName: volunteer.name,
    eventId: task.id, eventTitle: task.title + ' (Micro-Task)', ngoName: req.user.ngoName, issuedAt: new Date().toISOString(),
    hours: Math.round((task.estimatedMinutes / 60) * 10) / 10
  };
  db.certificates.push(certificate);
  volunteer.certificates.push(certificate.id);
  addNotification(volunteer.id, 'volunteer', 'Certificate Issued!', `Your certificate for micro-task "${task.title}" is ready. Code: ${certificate.code}`, 'certificate');
  saveDB();
  res.status(201).json({ certificate });
});

/* ============================================================
   COMMUNITY NEED HEATMAP
   Aggregated & approximate only — never plots individual volunteer locations.
   Need level is derived from unfilled volunteer/micro-task requirements.
   ============================================================ */
app.get('/api/community-need', (req, res) => {
  const { category, from, to, urgentOnly } = req.query;
  const now = new Date();

  const inDateRange = dateStr => {
    if (!dateStr) return true;
    const t = new Date(dateStr).getTime();
    if (from && t < new Date(from).getTime()) return false;
    if (to && t > new Date(to).getTime()) return false;
    return true;
  };

  const points = [];
  db.events.filter(e => (e.status === 'open' || e.status === 'in-progress') && inDateRange(e.date)).forEach(e => {
    const unfilled = Math.max(0, e.volunteersNeeded - e.assignedVolunteers.length);
    if (unfilled <= 0) return;
    const cat = toImpactCategory(e.category, 'offline');
    if (category && category !== 'all' && cat.toLowerCase() !== category.toLowerCase()) return;
    const daysUntil = Math.ceil((new Date(e.date) - now) / (1000 * 60 * 60 * 24));
    const urgent = daysUntil <= 3;
    if (urgentOnly === 'true' && !urgent) return;
    points.push({ lat: e.location.lat, lng: e.location.lng, category: cat, unfilled, urgent, source: 'event' });
  });
  db.microTasks.filter(t => t.status === 'open' && t.mode === 'offline' && t.location && inDateRange(t.deadline)).forEach(t => {
    const unfilled = Math.max(0, t.volunteersNeeded - t.assignedVolunteers.length);
    if (unfilled <= 0) return;
    const cat = toImpactCategory(t.category, 'offline');
    if (category && category !== 'all' && cat.toLowerCase() !== category.toLowerCase()) return;
    const daysUntil = Math.ceil((new Date(t.deadline) - now) / (1000 * 60 * 60 * 24));
    const urgent = daysUntil <= 1;
    if (urgentOnly === 'true' && !urgent) return;
    points.push({ lat: t.location.lat, lng: t.location.lng, category: cat, unfilled, urgent, source: 'micro-task' });
  });

  // Aggregate into a coarse grid (~5km cells) — protects privacy and produces a smoother heatmap
  const cellSize = 0.045; // roughly 5km
  const cells = {};
  points.forEach(p => {
    const key = `${Math.round(p.lat / cellSize) * cellSize},${Math.round(p.lng / cellSize) * cellSize},${p.category}`;
    if (!cells[key]) cells[key] = { lat: Math.round(p.lat / cellSize) * cellSize, lng: Math.round(p.lng / cellSize) * cellSize, category: p.category, unfilled: 0, urgent: false };
    cells[key].unfilled += p.unfilled;
    cells[key].urgent = cells[key].urgent || p.urgent;
  });

  const results = Object.values(cells).map(c => ({
    ...c,
    needLevel: c.unfilled >= 6 ? 'High' : c.unfilled >= 3 ? 'Medium' : 'Low'
  }));

  res.json({ points: results, categories: ['Healthcare', 'Education', 'Environment', 'Community Service', 'Digital'] });
});

/* ============================================================
   NGO IMPACT REPORT GENERATOR
   ============================================================ */
app.get('/api/events/:id/impact-report', authenticate, authorize('ngo'), (req, res) => {
  const event = db.events.find(e => e.id === req.params.id && e.ngoId === req.user.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  let manual = db.impactReports.find(r => r.eventId === event.id);
  if (!manual) {
    manual = { id: uuidv4(), eventId: event.id, ngoId: req.user.id, manualFields: { beneficiaries: null, environmentalImpact: '', communityImpactNotes: '', photos: [] }, verified: false, generatedAt: new Date().toISOString() };
    db.impactReports.push(manual);
    saveDB();
  }

  const registered = event.matchedVolunteers.length;
  const confirmed = event.assignedVolunteers.length;
  const attended = event.assignedVolunteers.filter(a => a.checkInAt).length;
  const hoursLogged = event.assignedVolunteers.reduce((sum, a) => {
    if (a.checkInAt && a.checkOutAt) return sum + (new Date(a.checkOutAt) - new Date(a.checkInAt)) / 3600000;
    return sum + (a.status === 'completed' ? (event.estimatedHoursPerVolunteer || 4) : 0);
  }, 0);
  const tasksCompleted = event.assignedVolunteers.filter(a => a.status === 'completed').length;
  const skillsContributed = [...new Set((event.requiredSkills || []))];
  const avgRating = event.feedback.length ? Math.round((event.feedback.reduce((s, f) => s + f.rating, 0) / event.feedback.length) * 10) / 10 : null;

  res.json({
    report: {
      eventOverview: { title: event.title, category: event.category, date: event.date, location: event.location, status: event.status, description: event.description },
      volunteerParticipation: { registered, confirmed, attended, attendanceRate: confirmed ? Math.round((attended / confirmed) * 1000) / 10 : 0 },
      volunteerHours: Math.round(hoursLogged * 10) / 10,
      tasksCompleted,
      skillsContributed,
      attendanceSummary: event.assignedVolunteers.map(a => {
        const v = db.volunteers.find(vol => vol.id === a.volunteerId);
        return { name: v ? v.name : 'Unknown', checkedIn: !!a.checkInAt, checkedOut: !!a.checkOutAt, status: a.status };
      }),
      feedbackSummary: { averageRating: avgRating, totalFeedback: event.feedback.length, comments: event.feedback.map(f => f.comment).filter(Boolean) },
      communityImpact: manual.manualFields,
      keyStatistics: { registered, confirmed, attended, hoursLogged: Math.round(hoursLogged * 10) / 10, tasksCompleted, avgRating },
      verified: manual.verified
    }
  });
});

// NGO edits/verifies the manually-entered impact fields (beneficiaries, environmental impact, photos)
app.put('/api/events/:id/impact-report', authenticate, authorize('ngo'), (req, res) => {
  const event = db.events.find(e => e.id === req.params.id && e.ngoId === req.user.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  let manual = db.impactReports.find(r => r.eventId === event.id);
  if (!manual) {
    manual = { id: uuidv4(), eventId: event.id, ngoId: req.user.id, manualFields: {}, verified: false, generatedAt: new Date().toISOString() };
    db.impactReports.push(manual);
  }
  const { beneficiaries, environmentalImpact, communityImpactNotes, photos, verified } = req.body;
  if (beneficiaries != null) manual.manualFields.beneficiaries = parseInt(beneficiaries, 10) || 0;
  if (environmentalImpact != null) manual.manualFields.environmentalImpact = environmentalImpact;
  if (communityImpactNotes != null) manual.manualFields.communityImpactNotes = communityImpactNotes;
  if (Array.isArray(photos)) manual.manualFields.photos = photos.slice(0, 6); // small base64 thumbnails only
  if (verified != null) manual.verified = !!verified;
  saveDB();
  res.json({ manualFields: manual.manualFields, verified: manual.verified });
});

// NGO-level aggregate impact report across all (or filtered) events, for the dashboard's Impact Statistics view
app.get('/api/ngo/impact-report', authenticate, authorize('ngo'), (req, res) => {
  const myEvents = db.events.filter(e => e.ngoId === req.user.id && e.status === 'completed');
  const totalHours = myEvents.reduce((sum, e) => sum + e.assignedVolunteers.reduce((s, a) => {
    if (a.checkInAt && a.checkOutAt) return s + (new Date(a.checkOutAt) - new Date(a.checkInAt)) / 3600000;
    return s + (a.status === 'completed' ? (e.estimatedHoursPerVolunteer || 4) : 0);
  }, 0), 0);
  const totalVolunteers = new Set(myEvents.flatMap(e => e.assignedVolunteers.map(a => a.volunteerId))).size;
  const skillCount = {};
  myEvents.forEach(e => (e.requiredSkills || []).forEach(s => { skillCount[s] = (skillCount[s] || 0) + 1; }));

  res.json({
    eventsCompleted: myEvents.length,
    totalVolunteers,
    totalHours: Math.round(totalHours * 10) / 10,
    topSkillsContributed: Object.entries(skillCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([skill, count]) => ({ skill, count })),
    byCategory: myEvents.reduce((acc, e) => { const c = toImpactCategory(e.category, 'offline'); acc[c] = (acc[c] || 0) + 1; return acc; }, {})
  });
});
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`VolunteerSkill server running on http://localhost:${PORT}`);
});
