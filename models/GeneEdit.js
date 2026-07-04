const mongoose = require("mongoose");

const similarityMatchSchema = new mongoose.Schema({
  tokenId: Number,
  title: String,
  similarity: Number,
}, { _id: false });

const geneEditSchema = new mongoose.Schema({
  tokenId: { type: Number, unique: true, sparse: true },
  transactionHash: { type: String },
  contractAddress: { type: String },
  authorWallet: { type: String, required: true, lowercase: true, trim: true },
  authorUsername: { type: String },
  ownerDid: { type: String },
  transactionMode: { type: String, enum: ["metamask_direct", "did_assisted"], default: "metamask_direct" },
  title: { type: String, required: true, trim: true },
  description: { type: String },
  organism: { type: String },
  targetLoci: { type: String },
  category: { type: String },
  keywords: [{ type: String }],
  licenseType: {
    type: String,
    enum: ["CC-BY", "CC-BY-NC", "CC0", "MIT", "All-Rights-Reserved", "Custom"],
    default: "CC-BY",
  },
  customLicenseText: { type: String },
  isPrivate: { type: Boolean, default: false },
  ipfsCID: { type: String },
  metadataCID: { type: String },
  sequenceHash: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  status: {
    type: String,
    enum: ["draft", "registered", "duplicate_blocked", "inactive"],
    default: "draft",
  },
  adminReviewNote: { type: String },
  reviewedBy: { type: String },
  reviewedAt: { type: Date },
  submittedAt: { type: Date },
  similarityScore: { type: Number },
  similarityMatches: [similarityMatchSchema],
  isFlagged: { type: Boolean, default: false },
  flagReason: { type: String },
  flaggedBy: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

geneEditSchema.index({ title: "text", description: "text", organism: "text", authorUsername: "text", keywords: "text" });
geneEditSchema.index({ sequenceHash: 1 }, { unique: true, sparse: true });
geneEditSchema.pre("save", function updateTimestamp(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("GeneEdit", geneEditSchema);
