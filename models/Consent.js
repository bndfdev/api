const mongoose = require('mongoose');

// One accepted legal document version, kept for audit (POST /v1/me/consents): who, which document and
// version, when, from which IP address and app install. Never deleted by the API. See src/modules/legal.
const consentSchema = new mongoose.Schema({
  // The account, or the guest (accountType 'guest': then a guest_accounts id). A guest's consents move to
  // the account it becomes at sign-up.
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  accountType: { type: String, enum: ['user', 'guest'], required: true },
  documentType: { type: String, enum: ['terms', 'privacy'], required: true },
  version: { type: String, required: true },
  acceptedAt: { type: Date, required: true },
  ip: { type: String },
  installationId: { type: String },
}, { collection: 'consents' });

// One record per account, document and version; also serves "this account's consents, newest first".
consentSchema.index({ userId: 1, documentType: 1, version: 1 }, { unique: true });
consentSchema.index({ userId: 1, acceptedAt: -1 });

module.exports = mongoose.models.Consent || mongoose.model('Consent', consentSchema);
