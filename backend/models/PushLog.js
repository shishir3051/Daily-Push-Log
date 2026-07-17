const mongoose = require('mongoose');

const commitSchema = new mongoose.Schema({
  hash: { type: String, required: true },
  time: { type: String, required: true },
  message: { type: String, required: true }
});

const projectLogSchema = new mongoose.Schema({
  project: { type: String, required: true },
  commits: [commitSchema]
});

const pushLogSchema = new mongoose.Schema({
  date: { type: Date, default: Date.now },
  summary: [projectLogSchema],
  text: { type: String, required: true }
}, { timestamps: true });

module.exports = mongoose.model('PushLog', pushLogSchema);
