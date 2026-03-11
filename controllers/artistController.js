const Artist = require('../models/Artist');

// Get all active artists with name, bio, image, and active status
const UserPreference = require('../models/UserPreference');
exports.getActiveArtists = async (req, res) => {
  try {
    const artists = await Artist.find({ active: true }).select('name bio image active');
    const baseUrl = process.env.API_BASE_URL || 'http://192.168.29.39:3000';
    // For each artist, count followers (UserPreference docs referencing this artist)
    const artistsWithFullImageUrl = await Promise.all(artists.map(async artist => {
      let imageUrl = null;
      if (artist.image) {
        imageUrl = baseUrl + '/uploads/artists/' + artist.image;
      }
      // Count followers: UserPreference docs where artists array contains this artist._id
      let followerCount = 0;
      try {
        followerCount = await UserPreference.countDocuments({ artists: artist._id });
      } catch (e) { followerCount = 0; }
      return {
        _id: artist._id,
        name: artist.name,
        bio: artist.bio,
        image: imageUrl,
        active: artist.active,
        followerCount
      };
    }));
    res.json(artistsWithFullImageUrl);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch artists' });
  }
};
