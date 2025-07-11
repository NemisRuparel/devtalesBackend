const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const ImageKit = require('imagekit');
const multer = require('multer');
const { Clerk, ClerkExpressRequireAuth } = require('@clerk/clerk-sdk-node');


const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increased limit for media uploads

const PORT = process.env.PORT || 3000;

const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
});

// Initialize Clerk
if (!global.Clerk) {
  global.Clerk = new Clerk({ secretKey: process.env.CLERK_SECRET_KEY });
}

// Configure Multer for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// MongoDB connection
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch((err) => console.error('MongoDB connection error:', err));

// Schemas
const userSchema = new mongoose.Schema({
  clerkId: { type: String, required: true, unique: true },
  username: { type: String, unique: true, sparse: true },
  email: { type: String, unique: true, sparse: true },
  imageUrl: { type: String },
  bio: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const storySchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, required: true },
  category: { type: String, required: true },
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  author: { type: String, required: true },
  authorImage: { type: String },
  imageUrl: { type: String },
  audioUrl: { type: String },
  videoUrl: { type: String },
  likes: [{ type: String }], // Store Clerk user IDs
  bookmarks: [{ type: String }], // Store Clerk user IDs
  comments: [
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      username: { type: String, required: true },
      content: { type: String, required: true },
      createdAt: { type: Date, default: Date.now },
    },
  ],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', userSchema);
const Story = mongoose.model('Story', storySchema);

// Middleware to sync Clerk user data with MongoDB
const syncUser = async (req, res, next) => {
  if (!req.auth || !req.auth.userId) {
    return res.status(401).json({ error: 'Unauthorized: No user ID provided by Clerk.' });
  }

  try {
    const clerkUser = await global.Clerk.users.getUser(req.auth.userId);
    if (!clerkUser) {
      return res.status(404).json({ error: 'User not found in Clerk.' });
    }

    let user = await User.findOne({ clerkId: clerkUser.id });

    if (!user) {
      user = new User({
        clerkId: clerkUser.id,
        username: clerkUser.username || clerkUser.firstName + ' ' + clerkUser.lastName || `user_${clerkUser.id}`,
        email: clerkUser.emailAddresses[0]?.emailAddress,
        imageUrl: clerkUser.imageUrl,
      });
      await user.save();
      console.log('New user created in MongoDB:', user.username);
    } else {
      user.username = clerkUser.username || clerkUser.firstName + ' ' + clerkUser.lastName || user.username;
      user.email = clerkUser.emailAddresses[0]?.emailAddress || user.email;
      user.imageUrl = clerkUser.imageUrl || user.imageUrl;
      user.updatedAt = Date.now();
      await user.save();
    }
    req.user = user; // Attach MongoDB user document to request
    next();
  } catch (error) {
    console.error('Error syncing user:', error);
    res.status(500).json({ error: 'Internal server error during user sync: ' + error.message });
  }
};

// Helper for ImageKit upload
const uploadToImageKit = async (file, folder = 'hindu-stories') => {
  return new Promise((resolve, reject) => {
    imagekit.upload(
      {
        file: file.buffer,
        fileName: `${Date.now()}_${file.originalname}`,
        folder: folder,
      },
      (error, result) => {
        if (error) {
          return reject(error);
        }
        resolve(result.url);
      }
    );
  });
};

// Public route: Get all stories
app.get('/api/stories', async (req, res) => {
  try {
    const stories = await Story.find()
      .populate('authorId', 'username imageUrl')
      .populate('comments.userId', 'username')
      .sort({ createdAt: -1 });

    const formattedStories = stories.map((story) => ({
      ...story.toObject(),
      author: story.authorId ? story.authorId.username : 'Unknown',
      authorImage: story.authorId ? story.authorId.imageUrl : '',
      comments: story.comments.map((comment) => ({
        ...comment.toObject(),
        username: comment.userId ? comment.userId.username : 'Unknown',
      })),
    }));
    res.json(formattedStories);
  } catch (err) {
    console.error('Error fetching stories:', err);
    res.status(500).json({ error: 'Failed to fetch stories' });
  }
});

// Protected route: Get user-specific stories
app.get('/api/stories/user/:clerkId', ClerkExpressRequireAuth(), syncUser, async (req, res) => {
  try {
    const { clerkId } = req.params;
    const user = await User.findOne({ clerkId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const stories = await Story.find({ authorId: user._id })
      .populate('authorId', 'username imageUrl')
      .populate('comments.userId', 'username')
      .sort({ createdAt: -1 });

    const formattedStories = stories.map((story) => ({
      ...story.toObject(),
      author: story.authorId ? story.authorId.username : 'Unknown',
      authorImage: story.authorId ? story.authorId.imageUrl : '',
      comments: story.comments.map((comment) => ({
        ...comment.toObject(),
        username: comment.userId ? comment.userId.username : 'Unknown',
      })),
    }));
    res.json(formattedStories);
  } catch (err) {
    console.error('Error fetching user stories:', err);
    res.status(500).json({ error: 'Failed to fetch user stories: ' + err.message });
  }
});

// Protected route: Create a new story
app.post(
  '/api/stories',
  ClerkExpressRequireAuth(),
  syncUser,
  upload.fields([{ name: 'image' }, { name: 'audio' }, { name: 'video' }]),
  async (req, res) => {
    try {
      const { title, content, category } = req.body;
      if (!title || !content || !category) {
        return res.status(400).json({ error: 'Title, content, and category are required.' });
      }

      let imageUrl = null;
      let audioUrl = null;
      let videoUrl = null;

      if (req.files && req.files.image) {
        imageUrl = await uploadToImageKit(req.files.image[0], 'story-images');
      }
      if (req.files && req.files.audio) {
        audioUrl = await uploadToImageKit(req.files.audio[0], 'story-audio');
      }
      if (req.files && req.files.video) {
        videoUrl = await uploadToImageKit(req.files.video[0], 'story-videos');
      }

      const newStory = new Story({
        title,
        content,
        category,
        authorId: req.user._id,
        author: req.user.username,
        authorImage: req.user.imageUrl,
        imageUrl,
        audioUrl,
        videoUrl,
      });
      await newStory.save();

      const populatedStory = await Story.findById(newStory._id)
        .populate('authorId', 'username imageUrl')
        .populate('comments.userId', 'username');

      const formattedStory = {
        ...populatedStory.toObject(),
        author: populatedStory.authorId ? populatedStory.authorId.username : 'Unknown',
        authorImage: populatedStory.authorId ? populatedStory.authorId.imageUrl : '',
        comments: populatedStory.comments.map((comment) => ({
          ...comment.toObject(),
          username: comment.userId ? comment.userId.username : 'Unknown',
        })),
      };

      res.status(201).json(formattedStory);
    } catch (err) {
      console.error('Error creating story:', err);
      res.status(500).json({ error: 'Failed to create story: ' + err.message });
    }
  }
);

// Protected route: Update a story by ID
app.put(
  '/api/stories/:id',
  ClerkExpressRequireAuth(),
  syncUser,
  upload.fields([{ name: 'image' }, { name: 'audio' }, { name: 'video' }]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { title, content, category } = req.body;

      const story = await Story.findById(id);
      if (!story) {
        return res.status(404).json({ error: 'Story not found' });
      }
      if (story.authorId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ error: 'Unauthorized: You can only edit your own stories.' });
      }

      story.title = title || story.title;
      story.content = content || story.content;
      story.category = category || story.category;

      if (req.files && req.files.image) {
        story.imageUrl = await uploadToImageKit(req.files.image[0], 'story-images');
      }
      if (req.files && req.files.audio) {
        story.audioUrl = await uploadToImageKit(req.files.audio[0], 'story-audio');
      }
      if (req.files && req.files.video) {
        story.videoUrl = await uploadToImageKit(req.files.video[0], 'story-videos');
      }

      story.updatedAt = Date.now();
      await story.save();

      const populatedStory = await Story.findById(story._id)
        .populate('authorId', 'username imageUrl')
        .populate('comments.userId', 'username');

      const formattedStory = {
        ...populatedStory.toObject(),
        author: populatedStory.authorId ? populatedStory.authorId.username : 'Unknown',
        authorImage: populatedStory.authorId ? populatedStory.authorId.imageUrl : '',
        comments: populatedStory.comments.map((comment) => ({
          ...comment.toObject(),
          username: comment.userId ? comment.userId.username : 'Unknown',
        })),
      };
      res.json(formattedStory);
    } catch (err) {
      console.error('Error updating story:', err);
      res.status(500).json({ error: 'Failed to update story: ' + err.message });
    }
  }
);

// Protected route: Delete a story by ID
app.delete('/api/stories/:id', ClerkExpressRequireAuth(), syncUser, async (req, res) => {
  try {
    const { id } = req.params;
    const story = await Story.findById(id);

    if (!story) {
      return res.status(404).json({ error: 'Story not found' });
    }
    if (story.authorId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Unauthorized: You can only delete your own stories.' });
    }

    await Story.findByIdAndDelete(id);
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting story:', err);
    res.status(500).json({ error: 'Failed to delete story: ' + err.message });
  }
});

// Protected route: Like/Unlike a story
app.post('/api/stories/:id/like', ClerkExpressRequireAuth(), syncUser, async (req, res) => {
  try {
    const { id } = req.params;
    const clerkUserId = req.auth.userId;

    const story = await Story.findById(id);
    if (!story) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const likedIndex = story.likes.indexOf(clerkUserId);
    if (likedIndex > -1) {
      story.likes.splice(likedIndex, 1);
    } else {
      story.likes.push(clerkUserId);
    }
    await story.save();

    const populatedStory = await Story.findById(story._id)
      .populate('authorId', 'username imageUrl')
      .populate('comments.userId', 'username');

    const formattedStory = {
      ...populatedStory.toObject(),
      author: populatedStory.authorId ? populatedStory.authorId.username : 'Unknown',
      authorImage: populatedStory.authorId ? populatedStory.authorId.imageUrl : '',
      comments: populatedStory.comments.map((comment) => ({
        ...comment.toObject(),
        username: comment.userId ? comment.userId.username : 'Unknown',
      })),
    };
    res.json(formattedStory);
  } catch (err) {
    console.error('Error liking/unliking story:', err);
    res.status(500).json({ error: 'Failed to update like status: ' + err.message });
  }
});

// Protected route: Bookmark/Unbookmark a story
app.post('/api/stories/:id/bookmark', ClerkExpressRequireAuth(), syncUser, async (req, res) => {
  try {
    const { id } = req.params;
    const clerkUserId = req.auth.userId;

    const story = await Story.findById(id);
    if (!story) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const bookmarkedIndex = story.bookmarks.indexOf(clerkUserId);
    if (bookmarkedIndex > -1) {
      story.bookmarks.splice(bookmarkedIndex, 1);
    } else {
      story.bookmarks.push(clerkUserId);
    }
    await story.save();

    const populatedStory = await Story.findById(story._id)
      .populate('authorId', 'username imageUrl')
      .populate('comments.userId', 'username');

    const formattedStory = {
      ...populatedStory.toObject(),
      author: populatedStory.authorId ? populatedStory.authorId.username : 'Unknown',
      authorImage: populatedStory.authorId ? populatedStory.authorId.imageUrl : '',
      comments: populatedStory.comments.map((comment) => ({
        ...comment.toObject(),
        username: comment.userId ? comment.userId.username : 'Unknown',
      })),
    };
    res.json(formattedStory);
  } catch (err) {
    console.error('Error bookmarking/unbookmarking story:', err);
    res.status(500).json({ error: 'Failed to update bookmark status: ' + err.message });
  }
});

// Protected route: Add a comment to a story
app.post('/api/stories/:id/comment', ClerkExpressRequireAuth(), syncUser, async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    const userId = req.user._id;
    const username = req.user.username;

    if (!content) {
      return res.status(400).json({ error: 'Comment content cannot be empty.' });
    }

    const story = await Story.findById(id);
    if (!story) {
      return res.status(404).json({ error: 'Story not found' });
    }

    story.comments.push({ userId, username, content });
    await story.save();

    const populatedStory = await Story.findById(story._id)
      .populate('authorId', 'username imageUrl')
      .populate('comments.userId', 'username');

    const formattedStory = {
      ...populatedStory.toObject(),
      author: populatedStory.authorId ? populatedStory.authorId.username : 'Unknown',
      authorImage: populatedStory.authorId ? populatedStory.authorId.imageUrl : '',
      comments: populatedStory.comments.map((comment) => ({
        ...comment.toObject(),
        username: comment.userId ? comment.userId.username : 'Unknown',
      })),
    };
    res.status(201).json(formattedStory);
  } catch (err) {
    console.error('Error adding comment:', err);
    res.status(500).json({ error: 'Failed to add comment: ' + err.message });
  }
});

// Protected route: Delete a comment from a story
app.delete('/api/stories/:storyId/comment/:commentId', ClerkExpressRequireAuth(), syncUser, async (req, res) => {
  try {
    const { storyId, commentId } = req.params;
    const userId = req.user._id;

    const story = await Story.findById(storyId);
    if (!story) {
      return res.status(404).json({ error: 'Story not found.' });
    }

    const comment = story.comments.id(commentId);
    if (!comment) {
      return res.status(404).json({ error: 'Comment not found.' });
    }

    if (comment.userId.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'Unauthorized: You can only delete your own comments.' });
    }

    story.comments.pull(commentId);
    await story.save();

    const populatedStory = await Story.findById(story._id)
      .populate('authorId', 'username imageUrl')
      .populate('comments.userId', 'username');

    const formattedStory = {
      ...populatedStory.toObject(),
      author: populatedStory.authorId ? populatedStory.authorId.username : 'Unknown',
      authorImage: populatedStory.authorId ? populatedStory.authorId.imageUrl : '',
      comments: populatedStory.comments.map((comment) => ({
        ...comment.toObject(),
        username: comment.userId ? comment.userId.username : 'Unknown',
      })),
    };
    res.json(formattedStory);
  } catch (err) {
    console.error('Error deleting comment:', err);
    res.status(500).json({ error: 'Failed to delete comment: ' + err.message });
  }
});

// Protected route: Get user profile by Clerk ID
app.get('/api/users/:clerkId', async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.params.clerkId });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (err) {
    console.error('Error fetching user profile:', err);
    res.status(500).json({ error: 'Failed to fetch user profile: ' + err.message });
  }
});

// Protected route: Get bookmarked stories
app.get('/api/stories/bookmarked', ClerkExpressRequireAuth(), syncUser, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const bookmarkedStories = await Story.find({ bookmarks: user.clerkId })
      .populate('authorId', 'username imageUrl')
      .populate('comments.userId', 'username')
      .sort({ createdAt: -1 });

    const formattedStories = bookmarkedStories.map((story) => ({
      ...story.toObject(),
      author: story.authorId ? story.authorId.username : 'Unknown',
      authorImage: story.authorId ? story.authorId.imageUrl : '',
      comments: story.comments.map((comment) => ({
        ...comment.toObject(),
        username: comment.userId ? comment.userId.username : 'Unknown',
      })),
    }));
    res.json(formattedStories);
  } catch (err) {
    console.error('Error fetching bookmarked stories:', err);
    res.status(500).json({ error: 'Failed to fetch bookmarked stories: ' + err.message });
  }
});

// Protected route: Update user profile
app.put(
  '/api/users/:id',
  ClerkExpressRequireAuth(),
  syncUser,
  upload.single('image'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { username, bio } = req.body;

      if (req.user.clerkId !== id) {
        return res.status(403).json({ error: 'Unauthorized: You can only edit your own profile' });
      }

      let updateData = {};
      if (username) updateData.username = username;
      if (bio) updateData.bio = bio;
      if (req.file) {
        updateData.imageUrl = await uploadToImageKit(req.file, 'profile-images');
      }

      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: 'No update data provided' });
      }

      const user = await User.findOneAndUpdate(
        { clerkId: id },
        { $set: { ...updateData, updatedAt: Date.now() } },
        { new: true }
      );

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json(user);
    } catch (err) {
      console.error('Error updating user profile:', err);
      res.status(500).json({ error: 'Failed to update profile: ' + err.message });
    }
  }
);

// Protected route: Delete user profile
app.delete('/api/users/:clerkId', ClerkExpressRequireAuth(), syncUser, async (req, res) => {
  try {
    const { clerkId } = req.params;

    // Ensure only the user can delete their own profile
    if (req.user.clerkId !== clerkId) {
      return res.status(403).json({ error: 'Unauthorized: You can only delete your own profile' });
    }

    // Find the user in MongoDB
    const user = await User.findOne({ clerkId });
    if (!user) {
      return res.status(404).json({ error: 'User not found in database' });
    }

    // Delete all stories authored by the user
    await Story.deleteMany({ authorId: user._id });

    // Remove user's likes, bookmarks, and comments from all stories
    await Story.updateMany(
      { $or: [{ likes: clerkId }, { bookmarks: clerkId }, { 'comments.userId': user._id }] },
      {
        $pull: {
          likes: clerkId,
          bookmarks: clerkId,
          comments: { userId: user._id },
        },
      }
    );

    // Delete the user from MongoDB
    await User.findOneAndDelete({ clerkId });

    // Delete the user from Clerk
    await global.Clerk.users.deleteUser(clerkId);

    res.status(204).send();
  } catch (err) {
    console.error('Error deleting user profile:', err);
    res.status(500).json({ error: 'Failed to delete profile: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
