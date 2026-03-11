const Country = require('../models/Country');

// GET /api/countries/list
exports.listAllCountries = async (req, res) => {
  try {
    const countries = await Country.find({}, { name: 1, code: 1, countryCode: 1, flag: 1 });
    res.json({
      success: true,
      countries: countries.map(c => ({
        _id: c._id,
        name: c.name,
        code: c.code,
        countryCode: c.countryCode,
        flag: c.flag
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};
