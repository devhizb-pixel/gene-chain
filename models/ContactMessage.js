const mongoose = require("mongoose");

const replySchema = new mongoose.Schema({
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const contactMessageSchema = new mongoose.Schema({
  senderWallet: { type: String, lowercase: true },
  senderEmail: { type: String },
  senderName: { type: String },
  subject: { type: String },
  message: { type: String, required: true },
  type: { type: String, enum: ["ai_question", "admin_contact"], default: "admin_contact" },
  ruleResponse: { type: String },
  adminReply: { type: String },
  replies: [replySchema],
  hasReply: { type: Boolean, default: false },
  isRead: { type: Boolean, default: false },
  repliedBy: { type: String },
  repliedAt: { type: Date },
  status: { type: String, enum: ["open", "answered", "closed"], default: "open" },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("ContactMessage", contactMessageSchema);
