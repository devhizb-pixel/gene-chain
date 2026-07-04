const express = require("express");
const User = require("../models/User");
const GeneEdit = require("../models/GeneEdit");
const RegistrationLicense = require("../models/RegistrationLicense");
const LicenseRequest = require("../models/LicenseRequest");
const AuditLog = require("../models/AuditLog");
const { verifyUser } = require("../middleware/authMiddleware");

const router = express.Router();

function cleanAreas(value) {
  if (Array.isArray(value)) return value.map(String).map((x) => x.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((x) => x.trim()).filter(Boolean);
  return [];
}

function publicUser(user) {
  if (!user) return null;
  return {
    walletAddress: user.walletAddress,
    username: user.username,
    displayName: user.displayName || user.username,
    institution: user.institution,
    institutionId: user.institutionId,
    department: user.department,
    title: user.title,
    country: user.country,
    bio: user.bio,
    researchAreas: user.researchAreas || [],
    website: user.website,
    orcid: user.orcid,
    verifiedResearcher: Boolean(user.verifiedResearcher),
    avatarSeed: user.avatarSeed || user.walletAddress,
    joinedDate: user.createdAt,
  };
}

async function profilePayload(address) {
  const wallet = String(address || "").toLowerCase();
  const user = await User.findOne({ walletAddress: wallet }).populate("institutionId").lean();
  const [edits, certs, requested, granted] = await Promise.all([
    GeneEdit.find({ authorWallet: wallet, status: "registered" }).sort({ createdAt: -1 }).lean(),
    RegistrationLicense.find({ ownerWallet: wallet, status: "registered" }).sort({ verifiedAt: -1 }).lean(),
    LicenseRequest.countDocuments({ requesterWallet: wallet }),
    LicenseRequest.countDocuments({ ownerWallet: wallet, status: "approved" }),
  ]);
  const allCounts = await GeneEdit.aggregate([
    { $match: { authorWallet: wallet } },
    { $group: { _id: "$status", count: { $sum: 1 }, avgSimilarity: { $avg: "$similarityScore" } } },
  ]);
  const counts = Object.fromEntries(allCounts.map((row) => [row._id, row.count]));
  const avgRows = allCounts.filter((row) => Number.isFinite(row.avgSimilarity));
  const similarityRiskAverage = avgRows.length ? Math.round(avgRows.reduce((sum, row) => sum + row.avgSimilarity, 0) / avgRows.length) : 0;
  return {
    researcher: publicUser(user) || { walletAddress: wallet, avatarSeed: wallet, displayName: `${wallet.slice(0, 6)}...${wallet.slice(-4)}` },
    stats: {
      totalGeneEdits: Object.values(counts).reduce((sum, n) => sum + n, 0),
      approvedGeneEdits: counts.approved || 0,
      pendingReview: counts.pending_review || 0,
      certificatesVerified: certs.length,
      licensesRequested: requested,
      licensesGranted: granted,
      similarityRiskAverage,
    },
    approvedGeneEdits: edits,
    verifiedCertificates: certs,
    activity: [
      ...edits.slice(0, 5).map((edit) => ({ action: "public_gene_edit", title: edit.title, timestamp: edit.createdAt, targetId: edit._id })),
      ...certs.slice(0, 5).map((cert) => ({ action: "certificate_verified", title: cert.title, timestamp: cert.verifiedAt || cert.updatedAt, targetId: cert.certificateNumber })),
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 10),
  };
}

router.get("/:walletAddress", async (req, res, next) => {
  try {
    res.json(await profilePayload(req.params.walletAddress));
  } catch (err) {
    next(err);
  }
});

async function updateProfile(req, res, next) {
  try {
    const allowed = ["displayName", "email", "institution", "institutionId", "department", "title", "country", "bio", "website", "orcid"];
    const patch = {};
    allowed.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) patch[key] = req.body[key];
    });
    patch.researchAreas = cleanAreas(req.body.researchAreas);
    patch.avatarSeed = req.user.walletAddress;
    const user = await User.findOneAndUpdate(
      { walletAddress: req.user.walletAddress },
      { $set: patch },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    const publicName = user.displayName || user.username;
    if (publicName) {
      await Promise.all([
        GeneEdit.updateMany({ authorWallet: req.user.walletAddress }, { $set: { authorUsername: publicName } }),
        RegistrationLicense.updateMany({ ownerWallet: req.user.walletAddress }, { $set: { ownerUsername: publicName } }),
        LicenseRequest.updateMany({ requesterWallet: req.user.walletAddress }, { $set: { requesterUsername: publicName } }),
      ]);
    }
    await AuditLog.create({
      action: "researcher_profile_updated",
      actor: req.user.walletAddress,
      actorWallet: req.user.walletAddress,
      actorRole: "researcher",
      targetType: "user",
      targetId: req.user.walletAddress,
    }).catch(() => {});
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

router.patch("/profile", verifyUser, updateProfile);
router.patch("/profile/me", verifyUser, updateProfile);

module.exports = router;
