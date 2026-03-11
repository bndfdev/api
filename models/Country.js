const mongoose = require('mongoose');

const CountrySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true
  },
  code: {
    type: String,
    required: true,
    unique: true
  },
  enabled: {
    type: Boolean,
    default: true
  },
  flag: {
    type: String,
    required: true
  },
  countryCode: {
    type: String,
    required: true
  }
});

module.exports = mongoose.model('Country', CountrySchema);
