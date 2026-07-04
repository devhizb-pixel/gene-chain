const express = require("express");
const User = require("../models/User");
const GeneEdit = require("../models/GeneEdit");
const usersRouter = require("./users");

const router = express.Router();

router.get("/", async (_req, res, next) => {
  try {
    const users = await User.find({ walletAddress: { $exists: true, $ne: null }, isActive: true })
      .select("-email")
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    const items = await Promise.all(users.map(async (user) => {
      const [totalGeneEdits, approvedGeneEdits] = await Promise.all([
        GeneEdit.countDocuments({ authorWallet: user.walletAddress }),
        GeneEdit.countDocuments({ authorWallet: user.walletAddress, status: "approved" }),
      ]);
      return {
        walletAddress: user.walletAddress,
        displayName: user.displayName || user.username,
        username: user.username,
        institution: user.institution,
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
        stats: { totalGeneEdits, approvedGeneEdits },
      };
    }));
    res.json({ items, researchers: items, total: items.length });
  } catch (err) {
    next(err);
  }
});

router.use("/", usersRouter);

module.exports = router;
