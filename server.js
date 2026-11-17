"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DB_PATH = path.resolve(process.env.DATABASE_PATH || path.join(ROOT, "data", "firststep.sqlite"));
const SESSION_COOKIE = "firststep_session";
const SESSION_AGE_SECONDS = 7 * 24 * 60 * 60;
const PASSWORD_BYTES = 64;
const PASSWORD_OPTIONS = { N: 16384, r: 8, p: 1 };
const CATEGORIES = new Set(["Design", "Technology", "Marketing", "Business"]);
const LOCATIONS = new Set(["Remote", "New York, NY", "Austin, TX", "Chicago, IL", "Seattle, WA"]);
const EMPLOYMENT_TYPES = new Set(["Full-time", "Internship", "Part-time", "Contract"]);
const APPLICATION_STATUSES = new Set(["submitted", "reviewed", "interview", "rejected", "offered"]);
const authAttempts = new Map();

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const database = new DatabaseSync(DB_PATH);
database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('graduate', 'employer')),
    company_name TEXT NOT NULL DEFAULT '',
    major TEXT NOT NULL DEFAULT '',
    graduation_year INTEGER,
    bio TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    logo TEXT NOT NULL,
    logo_class TEXT NOT NULL DEFAULT 'logo-sage',
    location TEXT NOT NULL,
    type TEXT NOT NULL,
    category TEXT NOT NULL,
    salary TEXT NOT NULL,
    pay_period TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS saved_jobs (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, job_id)
  );
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    graduate_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'submitted',
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (job_id, graduate_id)
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    time_label TEXT NOT NULL,
    location TEXT NOT NULL,
    details TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS event_rsvps (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (event_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS mentorship_requests (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    status TEXT NOT NULL DEFAULT 'requested',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS jobs_active_created ON jobs(is_active, created_at DESC);
  CREATE INDEX IF NOT EXISTS applications_job ON applications(job_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
`);

function now() {
  return new Date().toISOString();
}

function seedDatabase() {
  const jobsCount = database.prepare("SELECT COUNT(*) AS count FROM jobs").get().count;
  if (jobsCount === 0) {
    const seedJobs = [
      ["Junior Product Designer", "Northstar Studio", "N", "logo-sage", "New York, NY", "Full-time", "Design", "$68k–$82k", "/ year", "Help shape thoughtful digital experiences alongside a kind, curious design team."],
      ["Graduate Software Engineer", "Orbit Labs", "O", "logo-peach", "Remote", "Full-time", "Technology", "$88k–$105k", "/ year", "Build tools people love, learn from great engineers, and make your first lines count."],
      ["Marketing Associate", "Goodwell Co.", "g.", "logo-blue", "Austin, TX", "Full-time", "Marketing", "$54k–$66k", "/ year", "Bring fresh ideas to a growing brand and turn good stories into real connection."],
      ["Business Analyst — Early Career", "Evergreen Partners", "E", "logo-lilac", "Chicago, IL", "Full-time", "Business", "$64k–$78k", "/ year", "Make sense of the numbers and help teams make decisions with confidence."],
      ["UX Research Intern", "Morrow Health", "M", "logo-gold", "Remote", "Internship", "Design", "$28–$34", "/ hour", "Listen, learn, and help make everyday healthcare a little more human."],
      ["Associate Data Analyst", "Tandem Finance", "T", "logo-cyan", "Seattle, WA", "Full-time", "Technology", "$72k–$86k", "/ year", "Turn complex data into clear answers with a supportive, collaborative team."]
    ];
    const insertJob = database.prepare(`
      INSERT INTO jobs (title, company, logo, logo_class, location, type, category, salary, pay_period, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const job of seedJobs) insertJob.run(...job, now());
  }

  const eventsCount = database.prepare("SELECT COUNT(*) AS count FROM events").get().count;
  if (eventsCount === 0) {
    const insertEvent = database.prepare(`
      INSERT INTO events (title, starts_at, time_label, location, details) VALUES (?, ?, ?, ?, ?)
    `);
    insertEvent.run("First Job, Best Job: Ask a Recruiter", "2026-11-18T12:30:00Z", "12:30 PM", "Online panel", "Ask recruiters your early-career questions and hear practical advice.");
    insertEvent.run("Portfolio reviews with Northstar Studio", "2026-11-21T15:00:00Z", "3:00 PM", "Virtual workshop", "Get thoughtful feedback on your portfolio from working designers.");
  }
}

seedDatabase();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    companyName: user.company_name,
    major: user.major,
    graduationYear: user.graduation_year,
    bio: user.bio
  };
}

function jsonResponse(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(value));
}

function parseCookies(request) {
  const result = {};
  for (const pair of (request.headers.cookie || "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator > 0) result[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
  }
  return result;
}

function currentSession(request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || token.length > 200) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const session = database.prepare(`
    SELECT sessions.token_hash, sessions.csrf_token, sessions.expires_at, users.*
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(tokenHash, now());
  return session || null;
}

function requireUser(session) {
  if (!session) throw new HttpError(401, "Please sign in to continue.");
  return session;
}

function requireRole(session, role) {
  requireUser(session);
  if (session.role !== role) throw new HttpError(403, "This action is not available for your account type.");
  return session;
}

function checkOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let originHost;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    throw new HttpError(403, "Request origin was not accepted.");
  }
  if (originHost !== String(request.headers.host || "").toLowerCase()) {
    throw new HttpError(403, "Request origin was not accepted.");
  }
}

function checkCsrf(request, session) {
  requireUser(session);
  if (request.headers["x-csrf-token"] !== session.csrf_token) {
    throw new HttpError(403, "Your session has expired. Refresh and try again.");
  }
}

function checkAuthRate(request) {
  const ip = request.socket.remoteAddress || "unknown";
  const timestamp = Date.now();
  const previous = authAttempts.get(ip);
  const entry = previous && previous.resetAt > timestamp ? previous : { count: 0, resetAt: timestamp + 60_000 };
  entry.count += 1;
  authAttempts.set(ip, entry);
  if (entry.count > 12) throw new HttpError(429, "Too many sign-in attempts. Please wait a minute and try again.");
}

async function readJson(request) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Send this request as JSON.");
  }
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 64 * 1024) throw new HttpError(413, "Request body is too large.");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function text(value, field, min, max) {
  if (typeof value !== "string") throw new HttpError(400, `${field} is required.`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new HttpError(400, `${field} must be between ${min} and ${max} characters.`);
  }
  return normalized;
}

function validateEmail(value) {
  const email = text(value, "Email", 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
  return email;
}

function sessionCookie(token, secure) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

function createLoginSession(response, request, user) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrfToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + SESSION_AGE_SECONDS * 1000).toISOString();
  database.prepare("INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)")
    .run(tokenHash, user.id, csrfToken, expiresAt);
  return {
    user: publicUser(user),
    csrfToken,
    cookie: sessionCookie(token, Boolean(request.socket.encrypted))
  };
}

function jobResults(user, view) {
  const userId = user ? user.id : -1;
  return database.prepare(`
    SELECT jobs.*,
      EXISTS (SELECT 1 FROM saved_jobs WHERE saved_jobs.job_id = jobs.id AND saved_jobs.user_id = ?) AS saved,
      EXISTS (SELECT 1 FROM applications WHERE applications.job_id = jobs.id AND applications.graduate_id = ?) AS applied,
      (SELECT COUNT(*) FROM applications WHERE applications.job_id = jobs.id) AS applicant_count
    FROM jobs
    WHERE jobs.is_active = 1
    ORDER BY jobs.created_at DESC, jobs.id DESC
  `).all(userId, userId).filter(job => {
    if (view === "mine") return user && user.role === "employer" && job.owner_id === user.id;
    if (view === "saved") return user && user.role === "graduate" && job.saved === 1;
    if (view === "applications") return user && user.role === "graduate" && job.applied === 1;
    return true;
  }).map(job => ({
    id: job.id,
    title: job.title,
    company: job.company,
    logo: job.logo,
    logoClass: job.logo_class,
    location: job.location,
    type: job.type,
    category: job.category,
    salary: job.salary,
    payPeriod: job.pay_period,
    description: job.description,
    posted: formatPosted(job.created_at),
    saved: Boolean(job.saved),
    applied: Boolean(job.applied),
    applicantCount: user && user.role === "employer" && job.owner_id === user.id ? job.applicant_count : undefined
  }));
}

function formatPosted(value) {
  const elapsedDays = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  if (elapsedDays < 1) return "today";
  if (elapsedDays === 1) return "1 day ago";
  if (elapsedDays < 7) return `${elapsedDays} days ago`;
  if (elapsedDays < 14) return "1 week ago";
  return `${Math.floor(elapsedDays / 7)} weeks ago`;
}

function findJob(id) {
  if (!/^\d+$/.test(id)) throw new HttpError(404, "Opportunity not found.");
  const job = database.prepare("SELECT * FROM jobs WHERE id = ? AND is_active = 1").get(Number(id));
  if (!job) throw new HttpError(404, "Opportunity not found.");
  return job;
}

function sameOriginJson(response, status, data, cookie) {
  const headers = cookie ? { "Set-Cookie": cookie } : {};
  jsonResponse(response, status, data, headers);
}

async function handleApi(request, response, url) {
  checkOrigin(request);
  const pathname = url.pathname;
  const session = currentSession(request);

  if (request.method === "GET" && pathname === "/api/me") {
    const csrfToken = session ? session.csrf_token : null;
    return jsonResponse(response, 200, { user: session ? publicUser(session) : null, csrfToken });
  }

  if (request.method === "POST" && (pathname === "/api/auth/register" || pathname === "/api/auth/login")) {
    checkAuthRate(request);
    const body = await readJson(request);
    const email = validateEmail(body.email);
    const password = text(body.password, "Password", 10, 200);
    let user;

    if (pathname.endsWith("register")) {
      const name = text(body.name, "Name", 2, 80);
      if (!["graduate", "employer"].includes(body.role)) throw new HttpError(400, "Choose a valid account type.");
      const companyName = body.role === "employer" ? text(body.companyName, "Company or institution", 2, 100) : "";
      const salt = crypto.randomBytes(16);
      const passwordHash = crypto.scryptSync(password, salt, PASSWORD_BYTES, PASSWORD_OPTIONS);
      try {
        const result = database.prepare(`
          INSERT INTO users (name, email, password_salt, password_hash, role, company_name, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(name, email, salt.toString("hex"), passwordHash.toString("hex"), body.role, companyName, now());
        user = database.prepare("SELECT * FROM users WHERE id = ?").get(Number(result.lastInsertRowid));
      } catch (error) {
        if (error.message.includes("UNIQUE constraint failed: users.email")) {
          throw new HttpError(409, "An account with that email already exists.");
        }
        throw error;
      }
    } else {
      user = database.prepare("SELECT * FROM users WHERE email = ?").get(email);
      const salt = user ? Buffer.from(user.password_salt, "hex") : Buffer.alloc(16);
      const expected = user ? Buffer.from(user.password_hash, "hex") : Buffer.alloc(PASSWORD_BYTES);
      const actual = crypto.scryptSync(password, salt, PASSWORD_BYTES, PASSWORD_OPTIONS);
      if (!user || !crypto.timingSafeEqual(actual, expected)) {
        throw new HttpError(401, "Email or password is incorrect.");
      }
    }

    const login = createLoginSession(response, request, user);
    return sameOriginJson(response, 200, { user: login.user, csrfToken: login.csrfToken }, login.cookie);
  }

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    checkCsrf(request, session);
    database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(session.token_hash);
    return sameOriginJson(response, 200, { ok: true }, `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${request.socket.encrypted ? "; Secure" : ""}`);
  }

  if (request.method === "GET" && pathname === "/api/jobs") {
    const view = url.searchParams.get("view") || "all";
    if (!["all", "saved", "applications", "mine"].includes(view)) throw new HttpError(400, "Unknown opportunity view.");
    if (view === "mine") requireRole(session, "employer");
    if (view === "saved" || view === "applications") requireRole(session, "graduate");
    const query = (url.searchParams.get("q") || "").trim().toLowerCase();
    const location = url.searchParams.get("location") || "";
    const category = url.searchParams.get("category") || "";
    if (location && !LOCATIONS.has(location)) throw new HttpError(400, "Choose a supported location.");
    if (category && category !== "Remote" && !CATEGORIES.has(category)) throw new HttpError(400, "Choose a supported category.");
    const jobs = jobResults(session, view).filter(job =>
      (!query || [job.title, job.company, job.category, job.location, job.description].some(value => value.toLowerCase().includes(query))) &&
      (!location || job.location === location) &&
      (!category || (category === "Remote" ? job.location === "Remote" : job.category === category))
    );
    return jsonResponse(response, 200, { jobs });
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(save|applications))?$/);
  if (jobMatch && jobMatch[2] === "save" && request.method === "POST") {
    const user = requireRole(session, "graduate");
    checkCsrf(request, session);
    const job = findJob(jobMatch[1]);
    database.prepare("INSERT OR IGNORE INTO saved_jobs (user_id, job_id, created_at) VALUES (?, ?, ?)")
      .run(user.id, job.id, now());
    return jsonResponse(response, 200, { saved: true });
  }

  if (jobMatch && jobMatch[2] === "save" && request.method === "DELETE") {
    const user = requireRole(session, "graduate");
    checkCsrf(request, session);
    findJob(jobMatch[1]);
    database.prepare("DELETE FROM saved_jobs WHERE user_id = ? AND job_id = ?").run(user.id, Number(jobMatch[1]));
    return jsonResponse(response, 200, { saved: false });
  }

  if (jobMatch && jobMatch[2] === "applications" && request.method === "POST") {
    const user = requireRole(session, "graduate");
    checkCsrf(request, session);
    const job = findJob(jobMatch[1]);
    if (job.owner_id === user.id) throw new HttpError(403, "You cannot apply to your own opportunity.");
    try {
      const result = database.prepare(`
        INSERT INTO applications (job_id, graduate_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(job.id, user.id, now(), now());
      return jsonResponse(response, 201, { applicationId: Number(result.lastInsertRowid), status: "submitted" });
    } catch (error) {
      if (error.message.includes("UNIQUE constraint failed: applications.job_id, applications.graduate_id")) {
        throw new HttpError(409, "You have already applied to this opportunity.");
      }
      throw error;
    }
  }

  if (request.method === "POST" && pathname === "/api/jobs") {
    const user = requireRole(session, "employer");
    checkCsrf(request, session);
    const body = await readJson(request);
    const title = text(body.title, "Job title", 3, 80);
    const location = text(body.location, "Location", 2, 40);
    const category = text(body.category, "Category", 3, 30);
    const type = text(body.type, "Opportunity type", 3, 20);
    const salary = text(body.salary, "Compensation", 1, 30);
    const payPeriod = text(body.payPeriod, "Pay period", 2, 20);
    const description = text(body.description, "Role summary", 20, 240);
    if (!LOCATIONS.has(location)) throw new HttpError(400, "Choose a supported location.");
    if (!CATEGORIES.has(category)) throw new HttpError(400, "Choose a supported category.");
    if (!EMPLOYMENT_TYPES.has(type)) throw new HttpError(400, "Choose a valid opportunity type.");
    if (!["/ year", "/ hour"].includes(payPeriod)) throw new HttpError(400, "Choose a valid pay period.");
    const logo = user.company_name.split(/\s+/).slice(0, 2).map(word => word.charAt(0)).join("").toUpperCase();
    const result = database.prepare(`
      INSERT INTO jobs (owner_id, title, company, logo, logo_class, location, type, category, salary, pay_period, description, created_at)
      VALUES (?, ?, ?, ?, 'logo-sage', ?, ?, ?, ?, ?, ?, ?)
    `).run(user.id, title, user.company_name, logo, location, type, category, salary, payPeriod, description, now());
    const job = database.prepare("SELECT id, title FROM jobs WHERE id = ?").get(Number(result.lastInsertRowid));
    return jsonResponse(response, 201, { job: { id: job.id, title: job.title } });
  }

  if (request.method === "GET" && pathname === "/api/employer/applications") {
    const user = requireRole(session, "employer");
    const applications = database.prepare(`
      SELECT applications.id, applications.status, applications.created_at,
        users.name AS applicant_name, users.email AS applicant_email,
        users.major, users.graduation_year, users.bio,
        jobs.id AS job_id, jobs.title AS job_title, jobs.company
      FROM applications
      JOIN jobs ON jobs.id = applications.job_id
      JOIN users ON users.id = applications.graduate_id
      WHERE jobs.owner_id = ?
      ORDER BY applications.created_at DESC
    `).all(user.id);
    return jsonResponse(response, 200, { applications });
  }

  const applicationMatch = pathname.match(/^\/api\/employer\/applications\/(\d+)$/);
  if (applicationMatch && request.method === "PATCH") {
    const user = requireRole(session, "employer");
    checkCsrf(request, session);
    const body = await readJson(request);
    const status = text(body.status, "Application status", 1, 20);
    if (!APPLICATION_STATUSES.has(status)) throw new HttpError(400, "Choose a valid application status.");
    const result = database.prepare(`
      UPDATE applications
      SET status = ?, updated_at = ?
      WHERE id = ? AND job_id IN (SELECT id FROM jobs WHERE owner_id = ?)
    `).run(status, now(), Number(applicationMatch[1]), user.id);
    if (result.changes === 0) throw new HttpError(404, "Application not found for your opportunities.");
    return jsonResponse(response, 200, { status });
  }

  if (request.method === "GET" && pathname === "/api/events") {
    const userId = session ? session.id : -1;
    const events = database.prepare(`
      SELECT events.*, EXISTS (
        SELECT 1 FROM event_rsvps WHERE event_rsvps.event_id = events.id AND event_rsvps.user_id = ?
      ) AS registered
      FROM events ORDER BY starts_at
    `).all(userId);
    return jsonResponse(response, 200, { events: events.map(event => ({
      id: event.id,
      title: event.title,
      startsAt: event.starts_at,
      time: event.time_label,
      location: event.location,
      details: event.details,
      registered: Boolean(event.registered)
    })) });
  }

  const eventMatch = pathname.match(/^\/api\/events\/(\d+)\/rsvp$/);
  if (eventMatch && request.method === "POST") {
    const user = requireRole(session, "graduate");
    checkCsrf(request, session);
    const eventId = Number(eventMatch[1]);
    if (!database.prepare("SELECT id FROM events WHERE id = ?").get(eventId)) throw new HttpError(404, "Event not found.");
    database.prepare("INSERT OR IGNORE INTO event_rsvps (event_id, user_id, created_at) VALUES (?, ?, ?)")
      .run(eventId, user.id, now());
    return jsonResponse(response, 200, { registered: true });
  }

  if (eventMatch && request.method === "DELETE") {
    const user = requireRole(session, "graduate");
    checkCsrf(request, session);
    database.prepare("DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?").run(Number(eventMatch[1]), user.id);
    return jsonResponse(response, 200, { registered: false });
  }

  if (request.method === "POST" && pathname === "/api/mentorship-requests") {
    const user = requireRole(session, "graduate");
    checkCsrf(request, session);
    database.prepare(`
      INSERT INTO mentorship_requests (user_id, created_at) VALUES (?, ?)
      ON CONFLICT(user_id) DO NOTHING
    `).run(user.id, now());
    const requestRow = database.prepare("SELECT status FROM mentorship_requests WHERE user_id = ?").get(user.id);
    return jsonResponse(response, 200, { status: requestRow.status });
  }

  if (request.method === "PATCH" && pathname === "/api/profile") {
    const user = requireUser(session);
    checkCsrf(request, session);
    const body = await readJson(request);
    const name = text(body.name, "Name", 2, 80);
    const major = body.major === undefined ? user.major : text(body.major, "Field of study", 0, 80);
    const bio = body.bio === undefined ? user.bio : text(body.bio, "About you", 0, 500);
    const year = body.graduationYear === undefined || body.graduationYear === ""
      ? user.graduation_year
      : Number(body.graduationYear);
    if (year !== null && (!Number.isInteger(year) || year < 1950 || year > 2100)) {
      throw new HttpError(400, "Enter a valid graduation year.");
    }
    const companyName = user.role === "employer" && body.companyName !== undefined
      ? text(body.companyName, "Company or institution", 2, 100)
      : user.company_name;
    database.prepare(`
      UPDATE users SET name = ?, major = ?, bio = ?, graduation_year = ?, company_name = ? WHERE id = ?
    `).run(name, major, bio, year, companyName, user.id);
    const updatedUser = database.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
    return jsonResponse(response, 200, { user: publicUser(updatedUser) });
  }

  throw new HttpError(404, "API route not found.");
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon"
  })[extension] || "application/octet-stream";
}

async function handleRequest(request, response) {
  const securityHeaders = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "Cross-Origin-Opener-Policy": "same-origin"
  };
  for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);

  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);
    if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Method not allowed.");

    const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const filePath = path.resolve(ROOT, `.${requestedPath}`);
    if (!filePath.startsWith(`${ROOT}${path.sep}`) && filePath !== path.join(ROOT, "index.html")) {
      throw new HttpError(404, "Page not found.");
    }
    const file = await fs.promises.readFile(filePath).catch(error => {
      if (error.code === "ENOENT" || error.code === "EISDIR") throw new HttpError(404, "Page not found.");
      throw error;
    });
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-cache",
      "Content-Length": file.length
    });
    response.end(request.method === "HEAD" ? undefined : file);
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error(error);
    jsonResponse(response, status, {
      error: status === 500 ? "The server could not complete that request." : error.message
    });
  }
}

function createServer() {
  return http.createServer((request, response) => {
    void handleRequest(request, response);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  const server = createServer();
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`FirstStep listening at http://${host}:${address.port}`);
    console.log(`SQLite database: ${DB_PATH}`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(() => {
        database.close();
        process.exit(0);
      });
    });
  }
}

module.exports = { createServer };
