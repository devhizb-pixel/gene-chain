const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  walletAddress: { type: String, unique: true, lowercase: true, trim: true },
  email: { type: String, lowercase: true, trim: true },
  googleSubject: { type: String, unique: true, sparse: true },
  username: { type: String },
  role: { type: String, enum: ["researcher", "public", "admin"], default: "researcher" },
  authProvider: { type: String, enum: ["google", "metamask"], default: "metamask" },
  did: { type: String, unique: true, sparse: true },
  walletType: { type: String, enum: ["embedded", "metamask"], default: "metamask" },
  profilePicture: { type: String },
  institution: { type: String },
  displayName: { type: String },
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: "Institution" },
  department: { type: String },
  title: { type: String },
  country: { type: String },
  bio: { type: String },
  researchAreas: [{ type: String }],
  website: { type: String },
  orcid: { type: String },
  verifiedResearcher: { type: Boolean, default: false },
  avatarSeed: { type: String },
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date },
  lastLoginAt: { type: Date },
  isActive: { type: Boolean, default: true },
});

module.exports = mongoose.model("User", userSchema);
