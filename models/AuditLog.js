const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema({
  action: { type: String },
  actor: { type: String },
  actorWallet: { type: String },
  actorRole: { type: String },
  targetType: { type: String },
  targetId: { type: String },
  targetTokenId: { type: Number },
  targetGeneEditId: { type: String },
  note: { type: String },
  details: { type: mongoose.Schema.Types.Mixed },
  timestamp: { type: Date, default: Date.now },
});

module.exports = mongoose.model("AuditLog", auditLogSchema);
