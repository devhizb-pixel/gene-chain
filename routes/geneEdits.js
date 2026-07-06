const express = require("express");
const GeneEdit = require("../models/GeneEdit");
const RegistrationLicense = require("../models/RegistrationLicense");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { ethers } = require("ethers");
const path = require("path");
const { verifyUser, verifyAny } = require("../middleware/authMiddleware");

const router = express.Router();

function maskWallet(wallet) {
  return wallet ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : null;
}

function publicDuplicate(edit, req) {
  const certificateId = edit.registrationLicense?.certificateNumber || null;
  return {
    geneEditId: String(edit._id),
    certificateId,
    tokenId: edit.tokenId ?? null,
    ownerWallet: maskWallet(edit.authorWallet),
    registrationDate: edit.registeredAt || edit.submittedAt || edit.createdAt,
    transactionHash: edit.transactionHash || null,
    publicVerificationUrl: certificateId
      ? `${req.protocol}://${req.get("host")}/api/certificates/${certificateId}`
      : null,
  };
}

async function contractHashExists(sequenceHash) {
  try {
    const network = process.env.NETWORK || "localhost";
    const deployment = require(path.join(__dirname, `../deployments/${network}.json`));
    const rpcUrl = network === "localhost" ? "http://127.0.0.1:8545" : process.env.SEPOLIA_RPC_URL;
    if (!rpcUrl) return false;
    const contract = new ethers.Contract(deployment.address, deployment.abi, new ethers.JsonRpcProvider(rpcUrl));
    return Boolean(await contract.hashExists(sequenceHash));
  } catch (error) {
    console.warn("[duplicate-check] Contract check unavailable:", error.message);
    return false;
  }
}

router.post("/check-duplicate", async (req, res, next) => {
  try {
    const sequenceHash = String(req.body.sequenceHash || "").trim().toLowerCase();
    if (!/^0x[a-f0-9]{64}$/.test(sequenceHash)) {
      return res.status(400).json({ error: "sequenceHash must be a 0x-prefixed 32-byte hash." });
    }
    const edit = await GeneEdit.findOne({ sequenceHash }).lean();
    if (edit) {
      const registrationLicense = await RegistrationLicense.findOne({ geneEditId: edit._id }).lean();
      await AuditLog.create({ action: "duplicate_check_blocked", actor: "public", actorRole: "public", targetGeneEditId: String(edit._id), targetTokenId: edit.tokenId, details: { sequenceHash } }).catch(() => {});
      return res.json({ exists: true, source: "mongodb", ...publicDuplicate({ ...edit, registrationLicense }, req) });
    }
    const onChain = await contractHashExists(sequenceHash);
    if (onChain) await AuditLog.create({ action: "duplicate_check_blocked", actor: "public", actorRole: "public", details: { sequenceHash, source: "blockchain" } }).catch(() => {});
    res.json({ exists: onChain, source: onChain ? "blockchain" : null });
  } catch (err) { next(err); }
});

function pagination(req) {
  const page = Math.max(parseInt(req.query.page || "1", 10), 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || "12", 10), 1), 100);
  return { page, limit, skip: (page - 1) * limit };
}

function cleanKeywords(value) {
  if (Array.isArray(value)) return value.map(String).map((x) => x.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((x) => x.trim()).filter(Boolean);
  return [];
}

async function upsertRegistrationLicense(edit, status, history) {
  const current = await RegistrationLicense.findOne({ geneEditId: edit._id });
  if (current) {
    current.title = edit.title;
    current.ownerWallet = edit.authorWallet;
    current.ownerUsername = edit.authorUsername;
    current.licenseType = edit.licenseType || current.licenseType;
    current.customLicenseText = edit.customLicenseText;
    current.tokenId = edit.tokenId;
    current.transactionHash = edit.transactionHash;
    current.contractAddress = edit.contractAddress;
    if (status) current.status = status;
    if (history) current.addHistory(history);
    await current.save();
    return current;
  }
  const license = new RegistrationLicense({
    geneEditId: edit._id,
    title: edit.title,
    ownerWallet: edit.authorWallet,
    ownerUsername: edit.authorUsername,
    licenseType: edit.licenseType || "CC-BY",
    customLicenseText: edit.customLicenseText,
    tokenId: edit.tokenId,
    transactionHash: edit.transactionHash,
    contractAddress: edit.contractAddress,
    status: status || "draft",
    provenance: history ? [history] : [],
  });
  await license.save();
  return license;
}

async function attachAuthorProfiles(items) {
  const rows = items.map((item) => (typeof item.toObject === "function" ? item.toObject() : item));
  const wallets = [...new Set(rows.map((item) => item.authorWallet).filter(Boolean))];
  const users = await User.find({ walletAddress: { $in: wallets } }).lean();
  const userMap = Object.fromEntries(users.map((user) => [user.walletAddress, user]));
  return rows.map((item) => {
    const profile = userMap[item.authorWallet];
    if (!profile) return item;
    return {
      ...item,
      authorUsername: profile.displayName || profile.username || item.authorUsername,
      authorInstitution: profile.institution,
      authorProfile: {
        displayName: profile.displayName || profile.username,
        institution: profile.institution,
        title: profile.title,
        verifiedResearcher: profile.verifiedResearcher,
      },
    };
  });
}

router.post("/", verifyUser, async (req, res, next) => {
  try {
    const user = await User.findOne({ walletAddress: req.user.walletAddress });
    const edit = await GeneEdit.create({
      ...req.body,
      keywords: cleanKeywords(req.body.keywords),
      status: "draft",
      authorWallet: req.user.walletAddress,
      authorUsername: user?.username,
    });
    await upsertRegistrationLicense(edit, "draft", {
      action: "draft_created",
      actor: req.user.walletAddress,
      actorRole: "researcher",
      note: "Registration license draft generated with gene edit draft.",
    });
    res.status(201).json({ _id: edit._id, status: edit.status, message: "Saved as draft", geneEdit: edit });
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const { page, limit, skip } = pagination(req);
    const query = { status: "registered" };
    if (req.query.license && req.query.license !== "All") query.licenseType = req.query.license;
    if (req.query.search) query.$text = { $search: req.query.search };
    const sort = req.query.sort === "oldest" ? { createdAt: 1 } : { createdAt: -1 };
    const [items, total] = await Promise.all([
      GeneEdit.find(query).sort(sort).skip(skip).limit(limit),
      GeneEdit.countDocuments(query),
    ]);
    const enriched = await attachAuthorProfiles(items);
    res.json({ items: enriched, geneEdits: enriched, total, page, pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    next(err);
  }
});

router.get("/my", verifyUser, async (req, res, next) => {
  try {
    const items = await GeneEdit.find({ authorWallet: req.user.walletAddress }).sort({ createdAt: -1 });
    const enriched = await attachAuthorProfiles(items);
    res.json({ items: enriched, geneEdits: enriched, total: enriched.length });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const edit = await GeneEdit.findById(req.params.id);
    if (!edit) return res.status(404).json({ error: "Gene edit not found." });
    if (edit.status === "registered") return res.json((await attachAuthorProfiles([edit]))[0]);
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: "Authentication required." });
    return verifyAny(req, res, () => {
      const actor = req.actor;
      const isAuthor = actor.role === "researcher" && actor.walletAddress === edit.authorWallet;
      const isAdmin = actor.role === "admin";
      if (!isAuthor && !isAdmin) return res.status(403).json({ error: "Access denied." });
      res.json(edit);
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", verifyUser, async (req, res, next) => {
  try {
    const edit = await GeneEdit.findById(req.params.id);
    if (!edit) return res.status(404).json({ error: "Gene edit not found." });
    if (edit.authorWallet !== req.user.walletAddress) return res.status(403).json({ error: "Only the author can edit this draft." });
    if (edit.status !== "draft") return res.status(409).json({ error: "Only draft submissions can be edited." });
    Object.assign(edit, req.body, { keywords: req.body.keywords ? cleanKeywords(req.body.keywords) : edit.keywords });
    await edit.save();
    await upsertRegistrationLicense(edit, edit.status === "draft" ? "draft" : undefined, {
      action: "metadata_updated",
      actor: req.user.walletAddress,
      actorRole: "researcher",
      note: "Gene edit metadata or blockchain registration details updated.",
      transactionHash: edit.transactionHash,
    });
    res.json(edit);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/register", verifyUser, async (req, res, next) => {
  try {
    const edit = await GeneEdit.findById(req.params.id);
    if (!edit) return res.status(404).json({ error: "Gene edit not found." });
    if (edit.authorWallet !== req.user.walletAddress) return res.status(403).json({ error: "Only the author can submit this edit." });
    if (edit.status !== "draft") return res.status(409).json({ error: "Only drafts can be registered." });
    if (!edit.sequenceHash || !edit.tokenId || !edit.transactionHash || !edit.ipfsCID) {
      return res.status(400).json({ error: "Successful IPFS upload and blockchain mint details are required." });
    }
    const duplicate = await GeneEdit.findOne({ sequenceHash: edit.sequenceHash, _id: { $ne: edit._id } });
    if (duplicate) return res.status(409).json({ error: "Duplicate sequence hash is already registered.", code: "DUPLICATE_HASH" });
    if (!(await contractHashExists(edit.sequenceHash))) {
      return res.status(409).json({ error: "The sequence hash was not found in the configured smart contract." });
    }
    edit.status = "registered";
    edit.submittedAt = new Date();
    await edit.save();
    const registrationLicense = await upsertRegistrationLicense(edit, "registered", {
      action: "registration_completed",
      actor: req.user.walletAddress,
      actorRole: "researcher",
      note: "Registration automatically completed after IPFS upload and on-chain mint.",
      transactionHash: edit.transactionHash,
    });
    registrationLicense.certificateNumber ||= `GC-${new Date().getFullYear()}-${String(edit.tokenId).padStart(6, "0")}`;
    registrationLicense.verifiedAt ||= new Date();
    await registrationLicense.save();
    await AuditLog.create({ action: "gene_edit_registered", actorWallet: req.user.walletAddress, actorRole: "researcher", targetTokenId: edit.tokenId, targetGeneEditId: String(edit._id), transactionHash: edit.transactionHash });
    await AuditLog.create({ action: "certificate_generated", actor: req.user.did, actorWallet: req.user.walletAddress, actorRole: "researcher", targetTokenId: edit.tokenId, targetGeneEditId: String(edit._id), targetId: registrationLicense.certificateNumber });
    res.json({ status: edit.status, message: "Gene edit registered successfully.", certificateId: registrationLicense.certificateNumber, geneEdit: edit, registrationLicense });
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ error: "Duplicate sequence hash is already registered.", code: "DUPLICATE_HASH" });
    next(err);
  }
});

router.delete("/:id", verifyUser, async (req, res, next) => {
  try {
    const edit = await GeneEdit.findById(req.params.id);
    if (!edit) return res.status(404).json({ error: "Gene edit not found." });
    if (edit.authorWallet !== req.user.walletAddress) return res.status(403).json({ error: "Only the author can delete this draft." });
    if (edit.status !== "draft") return res.status(409).json({ error: "Only drafts can be deleted." });
    await edit.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
