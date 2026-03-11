const Genre = require('../models/Genre');

// Get all active genres with name, description, image, and status (boolean)
exports.getActiveGenres = async (req, res) => {
  try {
    const genres = await Genre.find({ active: true }).select('name description image status');
    // Build full image URL for each genre
    const baseUrl = process.env.API_BASE_URL || 'http://192.168.29.39:3000';
    const genresWithFullImage = genres.map(g => ({
      _id: g._id,
      name: g.name,
      description: g.description,
      status: g.status,
      image: g.image ? (g.image.startsWith('http') ? g.image : `${baseUrl}/uploads/genres/${g.image.replace(/^\/uploads\/?genres\/?/, '')}`) : null
    }));
    res.json(genresWithFullImage);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch genres' });
  }
};
