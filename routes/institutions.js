const express = require("express");
const Institution = require("../models/Institution");
const User = require("../models/User");
const GeneEdit = require("../models/GeneEdit");
const RegistrationLicense = require("../models/RegistrationLicense");

const router = express.Router();

async function enrich(institution) {
  const id = institution._id;
  const researchers = await User.find({ $or: [{ institutionId: id }, { institution: institution.name }] }).select("-email").lean();
  const wallets = researchers.map((r) => r.walletAddress).filter(Boolean);
  const [totalGeneEdits, approvedCertificates] = await Promise.all([
    GeneEdit.countDocuments({ authorWallet: { $in: wallets } }),
    RegistrationLicense.countDocuments({ ownerWallet: { $in: wallets }, status: "verified" }),
  ]);
  return {
    ...institution,
    researchers,
    stats: { researchers: researchers.length, totalGeneEdits, approvedCertificates, licensesGranted: 0 },
  };
}

router.get("/", async (_req, res, next) => {
  try {
    let items = await Institution.find().sort({ verifiedInstitution: -1, name: 1 }).lean();
    if (!items.length) {
      const names = await User.distinct("institution", { institution: { $exists: true, $nin: [null, ""] } });
      items = names.map((name) => ({
        _id: `profile-${encodeURIComponent(name)}`,
        name,
        type: "Other",
        country: "",
        website: "",
        verifiedInstitution: false,
        fromProfiles: true,
      }));
    }
    const enriched = await Promise.all(items.map(async (item) => {
      if (!item.fromProfiles) return enrich(item);
      const researchers = await User.find({ institution: item.name }).select("-email").lean();
      const wallets = researchers.map((r) => r.walletAddress).filter(Boolean);
      const [totalGeneEdits, approvedCertificates] = await Promise.all([
        GeneEdit.countDocuments({ authorWallet: { $in: wallets } }),
        RegistrationLicense.countDocuments({ ownerWallet: { $in: wallets }, status: "verified" }),
      ]);
      return { ...item, researchers, stats: { researchers: researchers.length, totalGeneEdits, approvedCertificates, licensesGranted: 0 } };
    }));
    res.json({ items: enriched, institutions: enriched, total: enriched.length });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    if (req.params.id.startsWith("profile-")) {
      const name = decodeURIComponent(req.params.id.replace("profile-", ""));
      const researchers = await User.find({ institution: name }).select("-email").lean();
      const wallets = researchers.map((r) => r.walletAddress).filter(Boolean);
      const [totalGeneEdits, approvedCertificates] = await Promise.all([
        GeneEdit.countDocuments({ authorWallet: { $in: wallets } }),
        RegistrationLicense.countDocuments({ ownerWallet: { $in: wallets }, status: "verified" }),
      ]);
      return res.json({ _id: req.params.id, name, type: "Other", verifiedInstitution: false, fromProfiles: true, researchers, stats: { researchers: researchers.length, totalGeneEdits, approvedCertificates, licensesGranted: 0 } });
    }
    const institution = await Institution.findById(req.params.id).lean();
    if (!institution) return res.status(404).json({ error: "Institution not found." });
    res.json(await enrich(institution));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
