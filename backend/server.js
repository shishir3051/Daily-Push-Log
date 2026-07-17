require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const { getCommits } = require('./gitService');
const Project = require('./models/Project');
const PushLog = require('./models/PushLog');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Summary generation endpoint
app.get('/api/summary', async (req, res) => {
  try {
    const since = req.query.since || 'midnight';
    const data = await getCommits(since);
    
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
    const projects = await Project.find();
    res.json({ ok: true, projects });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    const { name, path } = req.body;
    const project = new Project({ name, path });
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
