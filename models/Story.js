const mongoose = require('mongoose');

const storySchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, required: true },
  imageUrl: { type: String, required: true },
  category: { type: String, default: 'General' },
  author: { type: String, default: 'Unknown' },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Story', storySchema);