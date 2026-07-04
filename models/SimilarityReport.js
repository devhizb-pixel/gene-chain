const mongoose = require("mongoose");

const matchSchema = new mongoose.Schema({
  geneEditId: String,
  tokenId: Number,
  title: String,
  owner: String,
  organism: String,
  matchPercentage: Number,
  certificateId: String,
  certificateStatus: String,
}, { _id: false });

const similarityReportSchema = new mongoose.Schema({
  geneEditId: { type: mongoose.Schema.Types.ObjectId, ref: "GeneEdit" },
  sequenceHash: { type: String },
  kmerSize: { type: Number, default: 5 },
  totalKmers: { type: Number, default: 0 },
  matchingKmers: { type: Number, default: 0 },
  score: { type: Number, default: 0 },
  riskLevel: { type: String },
  jaccard: { type: Number, default: 0 },
  matches: [matchSchema],
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("SimilarityReport", similarityReportSchema);
