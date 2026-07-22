const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
  name: { type: String, required: true },
  path: { type: String, required: true },
  author: { type: String, required: false }
}, { timestamps: true });

module.exports = mongoose.model('Project', projectSchema);
