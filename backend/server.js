require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { getCommitsForToday } = require('./gitService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, '../frontend')));

app.get('/api/summary', async (req, res) => {
  try {
    const data = await getCommitsForToday();
    res.json(data);
  } catch (err) {
    console.error('Error fetching summary:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
