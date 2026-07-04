const express = require("express");
const crypto = require("crypto");
const LicenseRequest = require("../models/LicenseRequest");
const LicenseAgreement = require("../models/LicenseAgreement");
const RegistrationLicense = require("../models/RegistrationLicense");
const GeneEdit = require("../models/GeneEdit");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { verifyUser } = require("../middleware/authMiddleware");

const router = express.Router();

function shortWallet(address) {
  if (!address) return "Unknown researcher";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function profile(user, wallet) {
  return {
    displayName: user?.displayName || user?.username || shortWallet(wallet),
    walletAddress: user?.walletAddress || wallet,
    institution: user?.institution || "Not provided",
    department: user?.department || "",
    title: user?.title || "",
    verifiedResearcher: Boolean(user?.verifiedResearcher),
    avatarSeed: user?.avatarSeed || wallet,
  };
}

async function hydrateRequests(items) {
  const rows = items.map((item) => (typeof item.toObject === "function" ? item.toObject() : item));
  const wallets = [...new Set(rows.flatMap((item) => [item.requesterWallet, item.ownerWallet]).filter(Boolean))];
  const users = await User.find({ walletAddress: { $in: wallets } }).lean();
  const userMap = Object.fromEntries(users.map((user) => [user.walletAddress, user]));
  const geneIds = rows.map((item) => item.geneEditId).filter(Boolean);
  const tokenIds = rows.map((item) => item.tokenId).filter(Boolean);
  const [editsById, editsByToken, agreements] = await Promise.all([
    GeneEdit.find({ _id: { $in: geneIds } }).lean(),
    GeneEdit.find({ tokenId: { $in: tokenIds } }).lean(),
    LicenseAgreement.find({ licenseRequestId: { $in: rows.map((item) => item._id) } }).lean(),
  ]);
  const editIdMap = Object.fromEntries(editsById.map((edit) => [String(edit._id), edit]));
  const editTokenMap = Object.fromEntries(editsByToken.map((edit) => [Number(edit.tokenId), edit]));
  const agreementMap = Object.fromEntries(agreements.map((agreement) => [String(agreement.licenseRequestId), agreement]));
  return rows.map((item) => ({
    license: item,
    requester: profile(userMap[item.requesterWallet], item.requesterWallet),
    owner: profile(userMap[item.ownerWallet], item.ownerWallet),
    geneEdit: editIdMap[String(item.geneEditId)] || editTokenMap[Number(item.tokenId)] || null,
    agreement: agreementMap[String(item._id)] || null,
  }));
}

function formatAgreementId(date = new Date()) {
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, "");
  return `LIC-GC-${ymd}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function verificationHash({ agreementId, tokenId, ownerAddress, requesterAddress, issuedAt }) {
  return crypto.createHash("sha256").update([
    agreementId,
    tokenId,
    ownerAddress,
    requesterAddress,
    new Date(issuedAt).toISOString(),
  ].join("|")).digest("hex");
}

function agreementText(edit, cert, body, requesterWallet) {
  const rights = [
    body.attributionRequired ? "Attribution is required" : "Attribution is waived",
    body.commercialUseAllowed ? "Commercial use is allowed" : "Commercial use is prohibited",
    body.redistributionAllowed ? "Redistribution is allowed" : "Redistribution is prohibited",
    body.derivativeUseAllowed ? "Derivative use is allowed" : "Derivative use is prohibited",
  ].join("; ");
  return [
    "GeneChain Prototype License Agreement",
    `Licensor wallet: ${edit.authorWallet}`,
    `Licensee wallet: ${requesterWallet}`,
    `Gene edit: ${edit.title}`,
    `Token ID: ${edit.tokenId}`,
    `Certificate ID: ${cert?.certificateNumber || "Pending"}`,
    `Purpose: ${body.purpose}`,
    `Intended use: ${body.intendedUse || "Research"}`,
    `Rights and restrictions: ${rights}.`,
    `Duration: ${body.duration || "1 year"}`,
    `Payment terms: ${body.paymentType || "Free"} ${body.fixedFee || body.royaltyPercent || body.customTerms || ""}`.trim(),
    `Notes: ${body.notes || "None"}`,
  ].join("\n");
}

async function getAgreementPayload(agreementId) {
  const agreement = await LicenseAgreement.findOne({ agreementId }).lean();
  if (!agreement) return null;
  const [request, geneEdit, certificate, requesterUser, ownerUser] = await Promise.all([
    LicenseRequest.findById(agreement.licenseRequestId).lean().catch(() => null),
    GeneEdit.findById(agreement.geneEditId).lean().catch(() => null),
    RegistrationLicense.findOne({ geneEditId: agreement.geneEditId }).lean().catch(() => null),
    User.findOne({ walletAddress: agreement.requesterAddress }).lean().catch(() => null),
    User.findOne({ walletAddress: agreement.ownerAddress }).lean().catch(() => null),
  ]);
  return {
    agreement,
    license: request,
    requester: profile(requesterUser, agreement.requesterAddress),
    owner: profile(ownerUser, agreement.ownerAddress),
    geneEdit,
    certificate,
  };
}

function agreementChecks(payload) {
  if (!payload) return { result: "Invalid License", checks: [{ label: "License exists in MongoDB", passed: false }], verified: false };
  const { agreement, license, geneEdit, certificate } = payload;
  const expectedHash = verificationHash(agreement);
  const checks = [
    { label: "License exists in MongoDB", passed: Boolean(agreement) },
    { label: "Status is approved", passed: agreement.status === "approved" },
    { label: "Licensee wallet matches requester", passed: license ? String(license.requesterWallet).toLowerCase() === String(agreement.requesterAddress).toLowerCase() : true },
    { label: "Gene edit exists", passed: Boolean(geneEdit) },
    { label: "Gene edit certificate registered", passed: ["registered", "verified"].includes(certificate?.status) || geneEdit?.status === "registered" },
    { label: "On-chain approval transaction available", passed: Boolean(agreement.txHash || license?.txHash || license?.transactionHash), optional: true },
    { label: "Verification hash matches", passed: agreement.verificationHash === expectedHash },
  ];
  const requiredPassed = checks.filter((check) => !check.optional).every((check) => check.passed);
  const result = agreement.status !== "approved"
    ? "Revoked/Rejected License"
    : requiredPassed
      ? "Verified License"
      : agreement.verificationStatus === "pending_verification"
        ? "Pending Verification"
        : "Invalid License";
  return { checks, verified: requiredPassed && agreement.status === "approved", expectedHash, result };
}

router.get("/registration/my", verifyUser, async (req, res, next) => {
  try {
    const query = { ownerWallet: req.user.walletAddress };
    if (req.query.status) query.status = req.query.status;
    const items = await RegistrationLicense.find(query).sort({ updatedAt: -1 });
    res.json({ items, registrationLicenses: items, total: items.length });
  } catch (err) {
    next(err);
  }
});

router.get("/registration/:geneEditId", verifyUser, async (req, res, next) => {
  try {
    const item = await RegistrationLicense.findOne({ geneEditId: req.params.geneEditId });
    if (!item) return res.status(404).json({ error: "Registration license not found." });
    if (item.ownerWallet !== req.user.walletAddress) return res.status(403).json({ error: "Only the owner can view this registration license." });
    res.json(item);
  } catch (err) {
    next(err);
  }
});

router.post("/request", verifyUser, async (req, res, next) => {
  try {
    const { tokenId, geneEditId, purpose, transactionHash } = req.body;
    const edit = geneEditId
      ? await GeneEdit.findById(geneEditId)
      : await GeneEdit.findOne({ tokenId: Number(tokenId), status: "registered" });
    if (!edit) return res.status(404).json({ error: "Registered gene edit not found." });
    if (edit.authorWallet === req.user.walletAddress) return res.status(409).json({ error: "Owners cannot request their own license." });
    const cert = await RegistrationLicense.findOne({ geneEditId: edit._id });
    const id = formatAgreementId();
    const request = await LicenseRequest.create({
      agreementId: id,
      geneEditId: edit._id,
      tokenId: edit.tokenId,
      certificateId: cert?.certificateNumber || String(cert?._id || ""),
      geneEditTitle: edit.title,
      ownerWallet: req.body.ownerAddress?.toLowerCase() || edit.authorWallet,
      requesterWallet: req.user.walletAddress,
      requesterUsername: req.body.requesterUsername,
      purpose,
      intendedUse: req.body.intendedUse,
      duration: req.body.duration,
      attributionRequired: req.body.attributionRequired,
      commercialUseAllowed: req.body.commercialUseAllowed,
      redistributionAllowed: req.body.redistributionAllowed,
      derivativeUseAllowed: req.body.derivativeUseAllowed,
      organization: req.body.organization,
      notes: req.body.notes,
      requesterMessage: req.body.notes,
      paymentType: req.body.paymentType,
      fixedFee: req.body.fixedFee,
      royaltyPercent: req.body.royaltyPercent,
      customTerms: req.body.customTerms,
      agreementText: req.body.agreementText || agreementText(edit, cert, req.body, req.user.walletAddress),
      transactionHash,
      txHash: transactionHash,
    });
    await AuditLog.create({
      action: "license_requested",
      actor: req.user.walletAddress,
      actorWallet: req.user.walletAddress,
      actorRole: "researcher",
      targetType: "licenseAgreement",
      targetId: request.agreementId,
      targetTokenId: edit.tokenId,
      targetGeneEditId: String(edit._id),
    }).catch(() => {});
    res.status(201).json({ _id: request._id, status: request.status, licenseRequest: request });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "You already requested a license for this token." });
    next(err);
  }
});

router.get("/incoming/:walletAddress", verifyUser, async (req, res, next) => {
  try {
    const wallet = String(req.params.walletAddress || "").toLowerCase();
    if (wallet !== req.user.walletAddress) return res.status(403).json({ error: "Access denied." });
    const ownedEdits = await GeneEdit.find({ authorWallet: wallet }).select("_id tokenId").lean();
    const items = await LicenseRequest.find({
      $or: [
        { ownerWallet: wallet },
        { geneEditId: { $in: ownedEdits.map((edit) => edit._id) } },
        { tokenId: { $in: ownedEdits.map((edit) => edit.tokenId).filter(Boolean) } },
      ],
    }).sort({ requestedAt: -1 });
    res.json({ items: await hydrateRequests(items), total: items.length });
  } catch (err) {
    next(err);
  }
});

router.get("/outgoing/:walletAddress", verifyUser, async (req, res, next) => {
  try {
    const wallet = String(req.params.walletAddress || "").toLowerCase();
    if (wallet !== req.user.walletAddress) return res.status(403).json({ error: "Access denied." });
    const items = await LicenseRequest.find({ requesterWallet: wallet }).sort({ requestedAt: -1 });
    res.json({ items: await hydrateRequests(items), total: items.length });
  } catch (err) {
    next(err);
  }
});

router.get("/incoming", verifyUser, async (req, res, next) => {
  try {
    const query = { ownerWallet: req.user.walletAddress };
    if (req.query.status) query.status = req.query.status;
    const items = await LicenseRequest.find(query).sort({ requestedAt: -1 });
    res.json({ items: await hydrateRequests(items), licenseRequests: items, total: items.length });
  } catch (err) {
    next(err);
  }
});

router.get("/outgoing", verifyUser, async (req, res, next) => {
  try {
    const query = { requesterWallet: req.user.walletAddress };
    if (req.query.status) query.status = req.query.status;
    const items = await LicenseRequest.find(query).sort({ requestedAt: -1 });
    res.json({ items: await hydrateRequests(items), licenseRequests: items, total: items.length });
  } catch (err) {
    next(err);
  }
});

router.get("/user/:address", verifyUser, async (req, res, next) => {
  try {
    const address = String(req.params.address || "").toLowerCase();
    if (address !== req.user.walletAddress) return res.status(403).json({ error: "Access denied." });
    const items = await LicenseRequest.find({ $or: [{ ownerWallet: address }, { requesterWallet: address }] }).sort({ requestedAt: -1 });
    res.json({ items: await hydrateRequests(items), total: items.length });
  } catch (err) {
    next(err);
  }
});

router.get("/agreement/:agreementId", async (req, res, next) => {
  try {
    const payload = await getAgreementPayload(req.params.agreementId);
    if (!payload) return res.status(404).json({ error: "License agreement not found." });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.get("/verify/:agreementId", async (req, res, next) => {
  try {
    const payload = await getAgreementPayload(req.params.agreementId);
    const verification = agreementChecks(payload);
    if (!payload) return res.status(404).json({ error: "License agreement not found.", verification });
    res.json({ ...payload, verification });
  } catch (err) {
    next(err);
  }
});

router.patch("/verify/:agreementId", async (req, res, next) => {
  try {
    const payload = await getAgreementPayload(req.params.agreementId);
    const verification = agreementChecks(payload);
    if (!payload) return res.status(404).json({ error: "License agreement not found.", verification });
    if (!verification.verified) {
      await LicenseAgreement.updateOne({ agreementId: req.params.agreementId }, { $set: { verificationStatus: "invalid" } });
      return res.status(409).json({ ...payload, verification });
    }
    const agreement = await LicenseAgreement.findOneAndUpdate(
      { agreementId: req.params.agreementId },
      { $set: { verificationStatus: "verified", verifiedAt: new Date() } },
      { new: true }
    );
    await LicenseRequest.updateOne({ _id: agreement.licenseRequestId }, { $set: { verificationStatus: "verified", verifiedAt: agreement.verifiedAt } });
    await AuditLog.create({
      action: "license_verified",
      actor: req.body.actor || "public",
      actorRole: "public",
      targetType: "licenseAgreement",
      targetId: agreement.agreementId,
      targetTokenId: agreement.tokenId,
      targetGeneEditId: String(agreement.geneEditId),
      details: { verificationStatus: "verified" },
    }).catch(() => {});
    res.json({ ...(await getAgreementPayload(req.params.agreementId)), verification: { ...verification, result: "Verified License" } });
  } catch (err) {
    next(err);
  }
});

router.get("/:agreementId/access", verifyUser, async (req, res, next) => {
  try {
    const payload = await getAgreementPayload(req.params.agreementId);
    if (!payload) return res.status(404).json({ allowed: false, reason: "License agreement not found." });
    const { agreement, geneEdit, certificate } = payload;
    let allowed = true;
    let reason = "";
    if (agreement.requesterAddress !== req.user.walletAddress) {
      allowed = false; reason = "You are not the approved licensee.";
    } else if (agreement.status !== "approved") {
      allowed = false; reason = "License not approved.";
    } else if (agreement.verificationStatus !== "verified") {
      allowed = false; reason = "License verification required.";
    } else if (!(geneEdit?.status === "registered" || certificate?.status === "registered")) {
      allowed = false; reason = "Gene edit registration is not active.";
    }
    await AuditLog.create({
      action: allowed ? "license_access_granted" : "license_access_denied",
      actor: req.user.walletAddress,
      actorWallet: req.user.walletAddress,
      actorRole: "researcher",
      targetType: "licenseAgreement",
      targetId: agreement.agreementId,
      targetTokenId: agreement.tokenId,
      targetGeneEditId: String(agreement.geneEditId),
      details: { reason },
    }).catch(() => {});
    if (!allowed) return res.status(403).json({ allowed, reason, agreement, geneEdit: geneEdit ? { title: geneEdit.title, tokenId: geneEdit.tokenId } : null });
    res.json({
      allowed: true,
      agreement,
      geneEdit: {
        _id: geneEdit._id,
        title: geneEdit.title,
        tokenId: geneEdit.tokenId,
        ipfsCID: geneEdit.ipfsCID,
        metadataCID: geneEdit.metadataCID,
        sequenceHash: geneEdit.sequenceHash,
        licenseType: geneEdit.licenseType,
        status: geneEdit.status,
      },
      licensedFile: agreement.licensedFileEncrypted ? {
        fileName: agreement.licensedFileName || `${geneEdit.title || "licensed-gene"}.txt`,
        encryptedContent: agreement.licensedFileEncrypted,
        providedAt: agreement.licensedFileProvidedAt,
      } : null,
      message: "Encrypted gene payload available. Decryption key sharing is prototype-level and handled by the owner/license flow.",
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:agreementId/approval-upload", verifyUser, async (req, res, next) => {
  try {
    const payload = await getAgreementPayload(req.params.agreementId);
    if (!payload) return res.status(404).json({ verifiedUpload: false, reason: "License agreement not found." });
    const { agreement, geneEdit, certificate } = payload;
    const certificateText = String(req.body.certificateText || "");
    let allowed = true;
    let reason = "";
    if (agreement.requesterAddress !== req.user.walletAddress) {
      allowed = false; reason = "You are not the approved licensee.";
    } else if (agreement.status !== "approved") {
      allowed = false; reason = "License not approved.";
    } else if (agreement.verificationStatus !== "verified") {
      allowed = false; reason = "License verification required before uploading approval.";
    } else if (!(geneEdit?.status === "registered" || certificate?.status === "registered")) {
      allowed = false; reason = "Original gene edit registration is not active.";
    } else if (!certificateText.includes(agreement.agreementId) || !certificateText.includes(agreement.verificationHash)) {
      allowed = false; reason = "Uploaded approval certificate does not match this license agreement.";
    }

    await AuditLog.create({
      action: allowed ? "license_approval_upload_verified" : "license_approval_upload_denied",
      actor: req.user.walletAddress,
      actorWallet: req.user.walletAddress,
      actorRole: "researcher",
      targetType: "licenseAgreement",
      targetId: agreement.agreementId,
      targetTokenId: agreement.tokenId,
      targetGeneEditId: String(agreement.geneEditId),
      details: { fileName: req.body.fileName, reason },
    }).catch(() => {});

    if (!allowed) return res.status(403).json({ verifiedUpload: false, reason });
    res.json({
      verifiedUpload: true,
      allowed: true,
      agreement,
      geneEdit: {
        _id: geneEdit._id,
        title: geneEdit.title,
        tokenId: geneEdit.tokenId,
        ipfsCID: geneEdit.ipfsCID,
        metadataCID: geneEdit.metadataCID,
        sequenceHash: geneEdit.sequenceHash,
        licenseType: geneEdit.licenseType,
        status: geneEdit.status,
      },
      licensedFile: agreement.licensedFileEncrypted ? {
        fileName: agreement.licensedFileName || `${geneEdit.title || "licensed-gene"}.txt`,
        encryptedContent: agreement.licensedFileEncrypted,
        providedAt: agreement.licensedFileProvidedAt,
      } : null,
      message: agreement.licensedFileEncrypted
        ? "License approval uploaded and verified. Decrypted gene file download is now available."
        : "License approval uploaded and verified, but the owner has not provided the licensed gene file yet.",
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:agreementId/provide-file", verifyUser, async (req, res, next) => {
  try {
    const payload = await getAgreementPayload(req.params.agreementId);
    if (!payload) return res.status(404).json({ error: "License agreement not found." });
    const { agreement } = payload;
    if (agreement.ownerAddress !== req.user.walletAddress) return res.status(403).json({ error: "Only the gene owner can provide the licensed gene file." });
    if (agreement.status !== "approved") return res.status(409).json({ error: "License must be approved before providing the file." });
    if (!req.body.encryptedContent || !req.body.fileName) return res.status(400).json({ error: "Encrypted file content and filename are required." });
    const updated = await LicenseAgreement.findOneAndUpdate(
      { agreementId: req.params.agreementId },
      {
        $set: {
          licensedFileName: req.body.fileName,
          licensedFileEncrypted: req.body.encryptedContent,
          licensedFileProvidedAt: new Date(),
          licensedFileProvidedBy: req.user.walletAddress,
        },
      },
      { new: true }
    );
    await AuditLog.create({
      action: "licensed_gene_file_provided",
      actor: req.user.walletAddress,
      actorWallet: req.user.walletAddress,
      actorRole: "researcher",
      targetType: "licenseAgreement",
      targetId: agreement.agreementId,
      targetTokenId: agreement.tokenId,
      targetGeneEditId: String(agreement.geneEditId),
      details: { fileName: req.body.fileName },
    }).catch(() => {});
    res.json({ agreement: updated });
  } catch (err) {
    next(err);
  }
});

router.post("/:agreementId/certificate-downloaded", async (req, res, next) => {
  try {
    const agreement = await LicenseAgreement.findOne({ agreementId: req.params.agreementId }).lean();
    if (!agreement) return res.status(404).json({ error: "License agreement not found." });
    await AuditLog.create({
      action: "license_certificate_downloaded",
      actor: req.body.actor || "public",
      actorRole: req.body.actorRole || "public",
      targetType: "licenseAgreement",
      targetId: agreement.agreementId,
      targetTokenId: agreement.tokenId,
      targetGeneEditId: String(agreement.geneEditId),
    }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/approve", verifyUser, async (req, res, next) => {
  try {
    const request = await LicenseRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: "License request not found." });
    if (request.ownerWallet !== req.user.walletAddress) return res.status(403).json({ error: "Only token owner can approve this request." });
    request.status = "approved";
    request.transactionHash = req.body.transactionHash;
    request.txHash = req.body.transactionHash || request.txHash;
    request.ownerFeedback = req.body.feedback || req.body.ownerFeedback || request.ownerFeedback;
    request.resolvedAt = new Date();
    request.approvedAt = new Date();
    const edit = await GeneEdit.findOne({ tokenId: request.tokenId });
    const cert = edit ? await RegistrationLicense.findOne({ geneEditId: edit._id }) : null;
    const issuedAt = new Date();
    const id = request.agreementId || formatAgreementId(issuedAt);
    const hash = verificationHash({ agreementId: id, tokenId: request.tokenId, ownerAddress: request.ownerWallet, requesterAddress: request.requesterWallet, issuedAt });
    const [ownerUser, requesterUser] = await Promise.all([
      User.findOne({ walletAddress: request.ownerWallet }),
      User.findOne({ walletAddress: request.requesterWallet }),
    ]);
    const agreement = await LicenseAgreement.findOneAndUpdate(
      { licenseRequestId: request._id },
      {
        $set: {
          agreementId: id,
          licenseRequestId: request._id,
          geneEditId: edit?._id,
          tokenId: request.tokenId,
          certificateId: cert?.certificateNumber || String(cert?._id || ""),
          licensorUserId: ownerUser?._id,
          ownerAddress: request.ownerWallet,
          licenseeUserId: requesterUser?._id,
          requesterAddress: request.requesterWallet,
          purpose: request.purpose,
          intendedUse: request.intendedUse,
          duration: request.duration,
          attributionRequired: request.attributionRequired,
          commercialUseAllowed: request.commercialUseAllowed,
          redistributionAllowed: request.redistributionAllowed,
          derivativeUseAllowed: request.derivativeUseAllowed,
          organization: request.organization,
          paymentType: request.paymentType,
          customTerms: request.customTerms,
          agreementText: request.agreementText || agreementText(edit || {}, cert, request, request.requesterWallet),
          status: "approved",
          verificationStatus: "pending_verification",
          issuedAt,
          approvedAt: request.approvedAt,
          txHash: request.txHash || request.transactionHash,
          verificationHash: hash,
          verificationLink: `${process.env.FRONTEND_URL || "http://localhost:5173"}/licenses/verify/${id}`,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    request.agreementId = agreement.agreementId;
    request.licenseAgreementId = agreement._id;
    request.verificationHash = agreement.verificationHash;
    request.verificationLink = agreement.verificationLink;
    await request.save();
    await AuditLog.create({ action: "license_approved", actor: req.user.walletAddress, actorWallet: req.user.walletAddress, actorRole: "researcher", targetType: "licenseRequest", targetId: String(request._id), targetTokenId: request.tokenId, note: `Approved license for ${request.requesterWallet}` });
    await AuditLog.create({ action: "license_agreement_generated", actor: req.user.walletAddress, actorWallet: req.user.walletAddress, actorRole: "researcher", targetType: "licenseAgreement", targetId: agreement.agreementId, targetTokenId: request.tokenId, targetGeneEditId: edit?._id?.toString() });
    res.json({ status: "approved", transactionHash: request.transactionHash, licenseRequest: request, agreement });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/reject", verifyUser, async (req, res, next) => {
  try {
    const request = await LicenseRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: "License request not found." });
    if (request.ownerWallet !== req.user.walletAddress) return res.status(403).json({ error: "Only token owner can reject this request." });
    if (!req.body.rejectionReason && !req.body.feedback && !req.body.ownerFeedback) return res.status(400).json({ error: "Rejection reason is required." });
    request.status = "rejected";
    request.rejectionReason = req.body.rejectionReason || req.body.feedback || req.body.ownerFeedback;
    request.ownerFeedback = request.rejectionReason;
    request.resolvedAt = new Date();
    request.rejectedAt = new Date();
    await request.save();
    await AuditLog.create({ action: "license_rejected", actor: req.user.walletAddress, actorWallet: req.user.walletAddress, actorRole: "researcher", targetType: "licenseRequest", targetId: String(request._id), targetTokenId: request.tokenId, note: request.rejectionReason }).catch(() => {});
    res.json({ status: "rejected", licenseRequest: request });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
