const mongoose = require("mongoose");

const licenseAgreementSchema = new mongoose.Schema({
  agreementId: { type: String, required: true, unique: true },
  licenseRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "LicenseRequest", required: true },
  geneEditId: { type: mongoose.Schema.Types.ObjectId, ref: "GeneEdit", required: true },
  tokenId: { type: Number, required: true },
  certificateId: { type: String },
  licensorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  ownerAddress: { type: String, required: true, lowercase: true },
  licenseeUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  requesterAddress: { type: String, required: true, lowercase: true },
  purpose: { type: String, required: true },
  intendedUse: { type: String },
  duration: { type: String },
  attributionRequired: { type: Boolean, default: true },
  commercialUseAllowed: { type: Boolean, default: false },
  redistributionAllowed: { type: Boolean, default: false },
  derivativeUseAllowed: { type: Boolean, default: false },
  organization: { type: String },
  paymentType: { type: String },
  customTerms: { type: String },
  agreementText: { type: String },
  status: { type: String, enum: ["approved", "rejected", "revoked", "expired"], default: "approved" },
  verificationStatus: { type: String, enum: ["pending_verification", "verified", "invalid"], default: "pending_verification" },
  issuedAt: { type: Date, default: Date.now },
  approvedAt: { type: Date },
  verifiedAt: { type: Date },
  txHash: { type: String },
  verificationHash: { type: String, required: true },
  verificationLink: { type: String },
  licensedFileName: { type: String },
  licensedFileEncrypted: { type: String },
  licensedFileProvidedAt: { type: Date },
  licensedFileProvidedBy: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

licenseAgreementSchema.pre("save", function updateTimestamp(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("LicenseAgreement", licenseAgreementSchema);
