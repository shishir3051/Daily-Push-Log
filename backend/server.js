require('dotenv').config();

// Allow self-signed certs for internal nProject server (NPROJECT_INSECURE=true)
if (process.env.NPROJECT_INSECURE === 'true') {
  const originalEmit = process.emit;
  process.emit = function (name, data, ...args) {
    if (name === 'warning' && typeof data === 'object' && data.message.includes('NODE_TLS_REJECT_UNAUTHORIZED')) {
      return false;
    }
    return originalEmit.apply(process, [name, data, ...args]);
  };
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const { getCommits } = require('./gitService');
const Project = require('./models/Project');
const PushLog = require('./models/PushLog');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// Prevent caching for all API routes
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Summary generation endpoint
app.get('/api/summary', async (req, res) => {
  try {
    const since = req.query.since || 'midnight';
    const until = req.query.until || '';
    const projectIds = req.query.projectIds || 'all';
    const author = req.query.author || '';
    const data = await getCommits(since, until, projectIds, author);
    
    // Automatically save to DB
    if (data.ok && data.text && !data.fromCache) {
      const log = new PushLog({ summary: data.summary, text: data.text });
      await log.save();
    }
    
    res.json(data);
  } catch (err) {
    console.error('Error fetching summary:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Projects API
app.get('/api/projects', async (req, res) => {
  try {
    const author = req.query.author;
    let query = {};
    if (author) {
      query.$or = [
        { author: author },
        { author: { $exists: false } },
        { author: null },
        { author: '' }
      ];
    }
    const projects = await Project.find(query);
    res.json({ ok: true, projects });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    const { name, path, author } = req.body;
    const project = new Project({ name, path, author });
    await project.save();
    res.json({ ok: true, project });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    await Project.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PushLogs API
app.post('/api/logs', async (req, res) => {
  try {
    const { summary, text } = req.body;
    const log = new PushLog({ summary, text });
    await log.save();
    res.json({ ok: true, log });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── nProject (OpenProject) Integration ─────────────────────────────────────
function nprojectConfig(req) {
  const url   = process.env.NPROJECT_URL;
  // Get token from frontend header
  let token = req.headers['x-nproject-token'];
  if (!url || !token) return null;
  // OpenProject API auth: Basic with literal username "apikey" + token as password
  return {
    url,
    headers: {
      'Authorization': `Basic ${Buffer.from(`apikey:${token}`).toString('base64')}`,
      'Content-Type': 'application/json',
      'Accept': 'application/hal+json'
    }
  };
}

// POST /api/login — validate nProject API token
app.post('/api/login', async (req, res) => {
  const { token } = req.body;
  
  if (!token) return res.status(400).json({ ok: false, error: 'Token required' });
  
  const url = process.env.NPROJECT_URL;
  if (!url) return res.status(500).json({ ok: false, error: 'NPROJECT_URL not configured in backend' });

  try {
    const authHeader = `Basic ${Buffer.from(`apikey:${token}`).toString('base64')}`;
    const r = await fetch(`${url}/api/v3/users/me`, {
      headers: { 'Authorization': authHeader, 'Accept': 'application/hal+json' }
    });
    const data = await r.json();
    
    if (r.ok && data.id) {
      res.json({ ok: true, user: { id: data.id, name: data.name, email: data.email } });
    } else {
      res.status(401).json({ ok: false, error: 'Invalid API Token' });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// GET /api/nproject/projects — fetch active project list from nProject
app.get('/api/nproject/projects', async (req, res) => {
  const cfg = nprojectConfig(req);
  if (!cfg) return res.status(401).json({ ok: false, error: 'Not authenticated with nProject' });
  try {
    const r = await fetch(
      `${cfg.url}/api/v3/projects?pageSize=-1&filters=%5B%7B%22active%22%3A%7B%22operator%22%3A%22%3D%22%2C%22values%22%3A%5B%22t%22%5D%7D%7D%5D`,
      { headers: cfg.headers }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ ok: false, error: data.message || 'nProject API error' });
    const projects = (data._embedded?.elements || data.elements || []).map(p => ({ id: p.id, name: p.name }));
    res.json({ ok: true, projects });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/nproject/workpackages/:projectId — open work packages as parent-story candidates
app.get('/api/nproject/workpackages/:projectId', async (req, res) => {
  const cfg = nprojectConfig(req);
  if (!cfg) return res.status(401).json({ ok: false, error: 'Not authenticated with nProject' });
  try {
    const filters = encodeURIComponent(JSON.stringify([
      { project: { operator: '=', values: [String(req.params.projectId)] } },
      { status:  { operator: 'o' } }
    ]));
    const sort = encodeURIComponent(JSON.stringify([['updatedAt', 'desc']]));
    const r = await fetch(
      `${cfg.url}/api/v3/work_packages?pageSize=100&filters=${filters}&sortBy=${sort}`,
      { headers: cfg.headers }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ ok: false, error: data.message || 'nProject API error' });
    const workpackages = (data._embedded?.elements || []).map(wp => ({
      id:      wp.id,
      subject: wp.subject,
      type:    wp._links?.type?.title || 'Work Package',
      version: wp._links?.version?.title || 'No Sprint'
    }));
    res.json({ ok: true, workpackages });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Get time entry activities using a work package context
app.get('/api/nproject/activities/:wpId', async (req, res) => {
  const cfg = nprojectConfig(req);
  if (!cfg) return res.status(401).json({ ok: false, error: 'Not authenticated with nProject' });
  try {
    const r = await fetch(`${cfg.url}/api/v3/time_entries/form`, {
      method: 'POST',
      headers: cfg.headers,
      body: JSON.stringify({
        _links: { workPackage: { href: `/api/v3/work_packages/${req.params.wpId}` } }
      })
    });
    const data = await r.json();
    let activities = [];
    if (data._embedded && data._embedded.schema && data._embedded.schema.activity) {
      activities = data._embedded.schema.activity._embedded.allowedValues.map(a => ({
        id: a.id,
        name: a.name
      }));
    }
    res.json({ ok: true, activities });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// fetch with an abort-based timeout, so a stalled nProject request fails fast
// instead of hanging on undici's ~5 minute default.
async function fetchWithTimeout(url, options = {}, ms = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Run an async worker over items with a bounded concurrency limit.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const pool = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(pool);
  return results;
}

// POST /api/send-to-nproject — create one Task per AI summary line, optionally as children of a Story
app.post('/api/send-to-nproject', async (req, res) => {
  const cfg = nprojectConfig(req);
  if (!cfg || !cfg.url || !cfg.headers.Authorization) {
    return res.status(401).json({ 
      ok: false, 
      error: 'Not authenticated with nProject' 
    });
  }

  const { projectId, parentId, tasks, date, activityId } = req.body;
  if (!projectId || !Array.isArray(tasks) || tasks.length === 0) {
    return res.status(400).json({ ok: false, error: 'projectId and tasks[] are required' });
  }

  // Resolve the CURRENT logged-in user from their token, so tasks are assigned
  // to whoever is signed in (not a hardcoded user ID).
  let assigneeId;
  try {
    const meRes = await fetchWithTimeout(`${cfg.url}/api/v3/users/me`, { headers: cfg.headers });
    const me = await meRes.json();
    if (!meRes.ok || !me.id) throw new Error(me.message || 'could not identify current user');
    assigneeId = me.id;
  } catch (err) {
    return res.status(502).json({ ok: false, error: `Could not determine current nProject user: ${err.message}` });
  }

  // NPROJECT_TASK_TYPE_ID: Task type ID in your OpenProject instance.
  // Verify available types at: GET /api/v3/types
  const typeId = process.env.NPROJECT_TASK_TYPE_ID || process.env.NPROJECT_TYPE_ID;
  if (!typeId) {
    return res.status(500).json({ ok: false, error: 'NPROJECT_TASK_TYPE_ID is not configured in the backend .env' });
  }
  const fallbackDate = date || new Date().toISOString().split('T')[0];
  // Tasks sharing one parent Story must be created SEQUENTIALLY: OpenProject
  // optimistic-locks the parent, so concurrent children collide with
  // "conflicting modifications". With no parent, send in parallel for speed.
  const concurrency = parentId ? 1 : (parseInt(process.env.NPROJECT_SEND_CONCURRENCY, 10) || 5);

  const outcomes = await runWithConcurrency(tasks, concurrency, async (task) => {
    // Each task may carry its own commit-day date; fall back to the request date
    const subject  = typeof task === 'string' ? task : task.subject;
    const taskDate = (task && typeof task === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(task.date))
      ? task.date
      : fallbackDate;
    const links = {
      project: { href: `/api/v3/projects/${projectId}` },
      type:    { href: `/api/v3/types/${typeId}` },
      status:  { href: `/api/v3/statuses/6` },              // Ready for QA
      assignee:{ href: `/api/v3/users/${assigneeId}` }      // current logged-in user
    };
    // Attach parent Story so task becomes a child work package
    if (parentId) links.parent = { href: `/api/v3/work_packages/${parentId}` };

    const wpBody = {
      subject,
      _links: links,
      estimatedTime: 'PT4H',
      remainingTime: 'PT0H',
      startDate: taskDate,
      dueDate: taskDate
    };

    // Create the work package, retrying briefly on optimistic-lock conflicts
    // (the parent Story being updated by a sibling at the same moment).
    let createdWp = null, lastError = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const r = await fetchWithTimeout(`${cfg.url}/api/v3/work_packages`, {
          method: 'POST',
          headers: cfg.headers,
          body: JSON.stringify(wpBody)
        });
        const data = await r.json();
        if (r.ok) { createdWp = data; break; }
        lastError = data.message || r.statusText;
        if (/conflicting modifications/i.test(lastError) && attempt < 4) {
          await new Promise(res => setTimeout(res, 250 * attempt + Math.random() * 250));
          continue; // retry with a little backoff + jitter
        }
        break;
      } catch (err) {
        lastError = err.name === 'AbortError'
          ? 'request timed out (nProject not responding)'
          : err.message;
        break;
      }
    }

    if (!createdWp) {
      return { ok: false, error: `"${subject.slice(0, 60)}": ${lastError}` };
    }

    // Automatically log 4 hours of spent time (best-effort; a failure here
    // does not fail the task itself)
    try {
      const timeBody = {
        hours: 'PT4H',
        spentOn: taskDate,
        comment: { raw: 'Automated time log from Push Log' },
        _links: {
          workPackage: { href: `/api/v3/work_packages/${createdWp.id}` }
        }
      };
      if (activityId) {
        timeBody._links.activity = { href: `/api/v3/time_entries/activities/${activityId}` };
      }
      await fetchWithTimeout(`${cfg.url}/api/v3/time_entries`, {
        method: 'POST',
        headers: cfg.headers,
        body: JSON.stringify(timeBody)
      });
    } catch (timeErr) {
      console.error(`Failed to log time for task ${createdWp.id}:`, timeErr.message);
    }
    return { ok: true, id: createdWp.id };
  });

  const created = outcomes.filter(o => o.ok).map(o => o.id);
  const errors  = outcomes.filter(o => !o.ok).map(o => o.error);

  console.log(`[nProject] Created: ${created.length}, Failed: ${errors.length}`, errors);
  res.json({ ok: created.length > 0, created: created.length, failed: errors.length, errors });
});


app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
