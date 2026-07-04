const mongoose = require("mongoose");

const historySchema = new mongoose.Schema({
  action: { type: String, required: true },
  actor: { type: String },
  actorRole: { type: String },
  note: { type: String },
  transactionHash: { type: String },
  timestamp: { type: Date, default: Date.now },
}, { _id: false });

const registrationLicenseSchema = new mongoose.Schema({
  geneEditId: { type: mongoose.Schema.Types.ObjectId, ref: "GeneEdit", required: true, unique: true },
  tokenId: { type: Number },
  transactionHash: { type: String },
  contractAddress: { type: String },
  title: { type: String, required: true },
  ownerWallet: { type: String, required: true, lowercase: true },
  ownerUsername: { type: String },
  licenseType: { type: String, required: true },
  customLicenseText: { type: String },
  status: {
    type: String,
    enum: ["draft", "registered", "inactive"],
    default: "draft",
  },
  verificationNote: { type: String },
  verifiedBy: { type: String },
  verifiedAt: { type: Date },
  rejectedBy: { type: String },
  rejectedAt: { type: Date },
  certificateNumber: { type: String, unique: true, sparse: true },
  provenance: [historySchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

registrationLicenseSchema.pre("save", function updateTimestamp(next) {
  this.updatedAt = new Date();
  next();
});

registrationLicenseSchema.methods.addHistory = function addHistory(entry) {
  this.provenance.push({ ...entry, timestamp: new Date() });
};

module.exports = mongoose.model("RegistrationLicense", registrationLicenseSchema);
