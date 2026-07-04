const express = require("express");
const RegistrationLicense = require("../models/RegistrationLicense");
const GeneEdit = require("../models/GeneEdit");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");

const router = express.Router();

function publicUser(user) {
  if (!user) return null;
  return {
    walletAddress: user.walletAddress,
    did: user.did,
    walletType: user.walletType,
    authProvider: user.authProvider,
    displayName: user.displayName || user.username,
    institution: user.institution,
    institutionId: user.institutionId,
    department: user.department,
    title: user.title,
    country: user.country,
    researchAreas: user.researchAreas || [],
    website: user.website,
    orcid: user.orcid,
    verifiedResearcher: Boolean(user.verifiedResearcher),
    avatarSeed: user.avatarSeed || user.walletAddress,
    joinedDate: user.createdAt,
  };
}

async function hydrateCertificate(cert) {
  if (!cert) return null;
  const geneEdit = await GeneEdit.findById(cert.geneEditId).lean().catch(() => null);
  const owner = await User.findOne({ walletAddress: cert.ownerWallet }).lean().catch(() => null);
  const auditLogs = await AuditLog.find({
    $or: [
      { targetGeneEditId: String(cert.geneEditId) },
      { targetTokenId: cert.tokenId },
      { targetId: cert.certificateNumber },
    ],
  }).sort({ timestamp: 1 }).limit(80).lean();

  return {
    certificate: cert,
    certificateId: cert.certificateNumber || String(cert._id),
    geneEdit,
    owner: publicUser(owner),
    auditLogs,
    provenance: cert.provenance || [],
  };
}

function certificateQuery(query) {
  const value = String(query || "").trim();
  if (!value) return null;
  const or = [
    { certificateNumber: value },
    { transactionHash: value },
    { ownerWallet: value.toLowerCase() },
  ];
  const token = Number(value);
  if (Number.isFinite(token)) or.push({ tokenId: token });
  return { $or: or };
}

router.get("/verify", async (req, res, next) => {
  try {
    const q = String(req.query.query || "").trim();
    if (!q) return res.status(400).json({ error: "Query is required." });
    let cert = await RegistrationLicense.findOne(certificateQuery(q)).lean();
    if (!cert) {
      const edit = await GeneEdit.findOne({
        $or: [
          { sequenceHash: q },
          { transactionHash: q },
          { authorWallet: q.toLowerCase() },
          ...(Number.isFinite(Number(q)) ? [{ tokenId: Number(q) }] : []),
        ],
      }).lean();
      if (edit) cert = await RegistrationLicense.findOne({ geneEditId: edit._id }).lean();
    }
    if (!cert) return res.status(404).json({ error: "Certificate not found." });
    await AuditLog.create({
      action: "certificate_public_verified",
      actor: "public",
      actorRole: "public",
      targetType: "certificate",
      targetId: cert.certificateNumber || String(cert._id),
      targetTokenId: cert.tokenId,
      targetGeneEditId: String(cert.geneEditId),
      details: { queryType: "public_search" },
    }).catch(() => {});
    res.json(await hydrateCertificate(cert));
  } catch (err) {
    next(err);
  }
});

router.get("/:certificateId", async (req, res, next) => {
  try {
    const id = req.params.certificateId;
    const cert = await RegistrationLicense.findOne({
      $or: [{ certificateNumber: id }, ...(id.match(/^[a-f\d]{24}$/i) ? [{ _id: id }] : [])],
    }).lean();
    if (!cert) return res.status(404).json({ error: "Certificate not found." });
    const payload = await hydrateCertificate(cert);
    await AuditLog.create({ action: "public_verification_performed", actor: "public", actorRole: "public", targetType: "certificate", targetId: id }).catch(() => {});
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
