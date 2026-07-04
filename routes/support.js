const express = require("express");
const Admin = require("../models/Admin");
const ContactMessage = require("../models/ContactMessage");
const AuditLog = require("../models/AuditLog");
const { verifyAdmin } = require("../middleware/authMiddleware");

const router = express.Router();

function ruleAnswer(question = "") {
  const text = question.toLowerCase();
  if (text.includes("metamask") || text.includes("wallet")) return "Connect MetaMask, switch to Sepolia, then sign in as a researcher from the public navbar.";
  if (text.includes("similarity")) return "Upload your sequence first, then run the explicit similarity check before minting. Scores above 70% need extra review.";
  if (text.includes("certificate") || text.includes("verify")) return "Use the Verify page with a certificate ID, token ID, transaction hash, sequence hash, or owner wallet.";
  if (text.includes("license") || text.includes("use")) return "Open an approved gene edit card, choose Request Use / License, complete the agreement builder, and submit the on-chain request.";
  if (text.includes("ipfs")) return "GeneChain encrypts the raw sequence before IPFS upload. Public pages only show CIDs and metadata, not raw encrypted sequence content.";
  if (text.includes("admin") || text.includes("review")) return "Admins review pending submissions after the researcher mints on Sepolia. Approval verifies the certificate; rejection includes a reason.";
  return "I can answer basic GeneChain workflow questions. For account-specific or personal admin help, use the personal admin contact option on this page.";
}

router.get("/admins", async (_req, res, next) => {
  try {
    const admins = await Admin.find().select("email name createdAt lastLogin").sort({ createdAt: 1 }).lean();
    res.json({ items: admins.map((admin) => ({ name: admin.name, email: admin.email, joinedDate: admin.createdAt, role: "Platform Admin" })) });
  } catch (err) {
    next(err);
  }
});

router.post("/ask", async (req, res, next) => {
  try {
    const answer = ruleAnswer(req.body.question || req.body.message || "");
    const item = await ContactMessage.create({
      senderWallet: req.body.senderWallet,
      senderEmail: req.body.senderEmail,
      senderName: req.body.senderName,
      subject: req.body.subject || "Rule assistant question",
      message: req.body.question || req.body.message,
      type: "ai_question",
      ruleResponse: answer,
      status: "answered",
    });
    await AuditLog.create({ action: "admin_rule_assistant_used", actor: req.body.senderWallet || "public", actorRole: "public", targetType: "contactMessage", targetId: String(item._id) }).catch(() => {});
    res.json({ answer, messageId: item._id });
  } catch (err) {
    next(err);
  }
});

router.post("/contact", async (req, res, next) => {
  try {
    const item = await ContactMessage.create({
      senderWallet: req.body.senderWallet,
      senderEmail: req.body.senderEmail,
      senderName: req.body.senderName,
      subject: req.body.subject,
      message: req.body.message,
      type: "admin_contact",
    });
    await AuditLog.create({ action: "personal_admin_contact_requested", actor: req.body.senderWallet || req.body.senderEmail || "public", actorRole: "public", targetType: "contactMessage", targetId: String(item._id), details: { subject: item.subject } }).catch(() => {});
    res.status(201).json({ message: "Admin contact request submitted.", contactMessage: item });
  } catch (err) {
    next(err);
  }
});

router.get("/history", async (req, res, next) => {
  try {
    const wallet = req.query.wallet;
    if (!wallet) return res.json({ items: [] });
    const items = await ContactMessage.find({ senderWallet: wallet }).sort({ createdAt: 1 }).lean();
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// Admin endpoints for messages
router.get("/messages", verifyAdmin, async (req, res, next) => {
  try {
    const items = await ContactMessage.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

router.post("/messages/:id/reply", verifyAdmin, async (req, res, next) => {
  try {
    const item = await ContactMessage.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          adminReply: req.body.reply,
          repliedBy: req.admin.email,
          repliedAt: new Date(),
          status: "answered",
          hasReply: true,
        },
      },
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Message not found" });
    res.json({ message: "Reply sent", contactMessage: item });
  } catch (err) {
    next(err);
  }
});

router.patch("/messages/:id/read", verifyAdmin, async (req, res, next) => {
  try {
    const item = await ContactMessage.findByIdAndUpdate(
      req.params.id,
      { $set: { isRead: true } },
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Message not found" });
    res.json({ message: "Marked as read", contactMessage: item });
  } catch (err) {
    next(err);
  }
});

router.delete("/messages/:id", verifyAdmin, async (req, res, next) => {
  try {
    const item = await ContactMessage.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ error: "Message not found" });
    res.json({ message: "Message deleted" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
