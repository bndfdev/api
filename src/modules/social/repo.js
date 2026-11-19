const mongoose = require('mongoose');
const User = require('../../../models/User');
const LinkToken = require('../../../models/LinkToken');

function findIdentity({ provider, providerUserId }) {
  return User.findOne({ socialIdentities: { $elemMatch: { provider, providerUserId } } }).lean();
}

async function createUser(doc) {
  return (await User.create(doc)).toObject();
}

async function issueLink(doc) {
  await LinkToken.create(doc);
}

/** The token is consumed in the same transaction as the identity is attached. Failed writes leave it usable. */
async function link({ userId, identity, tokenHash, at }) {
  return mongoose.connection.transaction(async (session) => {
    let verified = identity;
    if (tokenHash) {
      const token = await LinkToken.findOneAndDelete({ tokenHash, userId, expiresAt: { $gt: at } }, { session }).lean();
      if (!token) return { invalidToken: true };
      verified = { provider: token.provider, providerUserId: token.providerUserId, email: token.email };
    }
    const user = await User.findById(userId).session(session).lean();
    if (!user) return { missing: true };
    const existing = (user.socialIdentities || []).find((i) => i.provider === verified.provider && i.providerUserId === verified.providerUserId);
    if (existing) return { identity: existing };
    const stored = { ...verified, linkedAt: at };
    await User.updateOne({ _id: userId }, { $push: { socialIdentities: stored }, $set: { updatedAt: at } }, { session });
    return { identity: stored };
  });
}

module.exports = { findIdentity, createUser, issueLink, link };
