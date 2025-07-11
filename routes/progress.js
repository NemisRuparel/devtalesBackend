const express = require('express');
const router = express.Router();
const Progress = require('../models/Progress');
const authMiddleware = require('../middleware/auth');

// Get progress for a user
router.get('/:userId', authMiddleware, async (req, res) => {
  try {
    const progress = await Progress.find({ userId: req.params.userId });
    res.json(progress);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Update or create progress
router.post('/', authMiddleware, async (req, res) => {
  const { storyId, progress } = req.body;
  try {
    const existingProgress = await Progress.findOne({
      userId: req.user.id,
      storyId,
    });

    if (existingProgress) {
      existingProgress.progress = progress;
      existingProgress.updatedAt = new Date();
      await existingProgress.save();
      res.json(existingProgress);
    } else {
      const newProgress = new Progress({
        userId: req.user.id,
        storyId,
        progress,
      });
      await newProgress.save();
      res.json(newProgress);
    }
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;