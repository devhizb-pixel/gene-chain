const express = require("express");
const GeneEdit = require("../models/GeneEdit");
const RegistrationLicense = require("../models/RegistrationLicense");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const Institution = require("../models/Institution");
const LicenseRequest = require("../models/LicenseRequest");
const LicenseAgreement = require("../models/LicenseAgreement");
const ContactMessage = require("../models/ContactMessage");
const { verifyAdmin } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/gene-edits", verifyAdmin, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
    const query = {};
    if (req.query.status) query.status = req.query.status;
    if (req.query.license) query.licenseType = req.query.license;
    const [itemsRaw, total] = await Promise.all([
      GeneEdit.find(query).sort({ submittedAt: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      GeneEdit.countDocuments(query),
    ]);
    const wallets = [...new Set(itemsRaw.map((item) => item.authorWallet).filter(Boolean))];
    const users = await User.find({ walletAddress: { $in: wallets } }).lean();
    const userMap = Object.fromEntries(users.map((user) => [user.walletAddress, user]));
    const items = itemsRaw.map((item) => {
      const row = item.toObject();
      const profile = userMap[row.authorWallet];
      row.authorUsername = profile?.displayName || profile?.username || row.authorUsername;
      row.authorInstitution = profile?.institution;
      row.authorProfile = profile ? {
        displayName: profile.displayName || profile.username,
        institution: profile.institution,
        title: profile.title,
        verifiedResearcher: profile.verifiedResearcher,
      } : null;
      return row;
    });
    res.json({ items, geneEdits: items, total, page, pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    next(err);
  }
});

router.get("/stats", verifyAdmin, async (_req, res, next) => {
  try {
    const [totalRegistrations, drafts, inactive, duplicateAttempts, totalUsers, googleUsers, metamaskUsers, didIdentities, relayerSubmitted, relayerConfirmed, relayerFailed, licenseRows, perDay] = await Promise.all([
      GeneEdit.countDocuments({ status: "registered" }),
      GeneEdit.countDocuments({ status: "draft" }),
      GeneEdit.countDocuments({ status: "inactive" }),
      AuditLog.countDocuments({ action: { $in: ["duplicate_blocked", "duplicate_check_blocked"] } }),
      User.countDocuments({ isActive: true }),
      User.countDocuments({ authProvider: "google" }),
      User.countDocuments({ authProvider: "metamask" }),
      User.countDocuments({ did: { $exists: true, $ne: null } }),
      AuditLog.countDocuments({ action: "relayer_transaction_submitted" }),
      AuditLog.countDocuments({ action: "relayer_transaction_confirmed" }),
      AuditLog.countDocuments({ action: "relayer_transaction_failed" }),
      GeneEdit.aggregate([{ $match: { status: "registered" } }, { $group: { _id: "$licenseType", count: { $sum: 1 } } }]),
      GeneEdit.aggregate([
        { $match: { status: "registered", createdAt: { $gte: new Date(Date.now() - 30 * 86400000) } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);
    const licenseBreakdown = Object.fromEntries(licenseRows.map((row) => [row._id || "Unknown", row.count]));
    res.json({
      totalRegistrations,
      drafts,
      inactive,
      duplicateAttempts,
      totalUsers,
      googleUsers,
      metamaskUsers,
      didIdentities,
      embeddedWalletUsers: googleUsers,
      metamaskWalletUsers: metamaskUsers,
      relayerTransactions: relayerSubmitted,
      relayerSuccessRate: relayerSubmitted ? Math.round((relayerConfirmed / relayerSubmitted) * 100) : 0,
      relayerFailures: relayerFailed,
      licenseBreakdown,
      registrationsPerDay: perDay.map((row) => ({ date: row._id, count: row.count })),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/audit-logs", verifyAdmin, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
    const [items, total] = await Promise.all([
      AuditLog.find().sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit),
      AuditLog.countDocuments(),
    ]);
    res.json({ items, auditLogs: items, total, page, pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    next(err);
  }
});

router.get("/registration-licenses", verifyAdmin, async (req, res, next) => {
  try {
    const query = {};
    if (req.query.status) query.status = req.query.status;
    const items = await RegistrationLicense.find(query).sort({ updatedAt: -1 }).limit(200).lean();
    const geneIds = items.map((item) => item.geneEditId).filter(Boolean);
    const edits = await GeneEdit.find({ _id: { $in: geneIds } }).lean();
    const editMap = Object.fromEntries(edits.map((edit) => [String(edit._id), edit]));
    res.json({
      items: items.map((item) => ({ ...item, geneEdit: editMap[String(item.geneEditId)] || null })),
      registrationLicenses: items,
      total: items.length,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/license-agreements", verifyAdmin, async (req, res, next) => {
  try {
    const agreements = await LicenseAgreement.find().sort({ issuedAt: -1 }).limit(200).lean();
    const requestIds = agreements.map((item) => item.licenseRequestId).filter(Boolean);
    const geneIds = agreements.map((item) => item.geneEditId).filter(Boolean);
    const [requests, edits] = await Promise.all([
      LicenseRequest.find({ _id: { $in: requestIds } }).lean(),
      GeneEdit.find({ _id: { $in: geneIds } }).lean(),
    ]);
    const requestMap = Object.fromEntries(requests.map((item) => [String(item._id), item]));
    const editMap = Object.fromEntries(edits.map((item) => [String(item._id), item]));
    const items = agreements.map((item) => ({
      ...item,
      request: requestMap[String(item.licenseRequestId)] || null,
      geneEdit: editMap[String(item.geneEditId)] || null,
    }));
    res.json({ items, licenseAgreements: items, total: items.length });
  } catch (err) {
    next(err);
  }
});

router.get("/messages", verifyAdmin, async (req, res, next) => {
  try {
    const query = {};
    if (req.query.status) query.status = req.query.status;
    const items = await ContactMessage.find(query).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ items, contactMessages: items, total: items.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
