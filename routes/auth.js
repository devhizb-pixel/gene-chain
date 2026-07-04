const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { ethers } = require("ethers");
const Admin = require("../models/Admin");
const User = require("../models/User");
const { verifyAny, verifyUser } = require("../middleware/authMiddleware");
const { OAuth2Client } = require("google-auth-library");
const AuditLog = require("../models/AuditLog");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "genechain_super_secret_jwt_2024";
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function embeddedWalletFor(subject) {
  const secret = process.env.EMBEDDED_WALLET_SECRET;
  if (!secret || secret.length < 32) throw new Error("EMBEDDED_WALLET_SECRET must contain at least 32 characters.");
  return new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(`${secret}:${subject}`)));
}

function sign(payload, expiresIn) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

router.post("/admin/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
    const admin = await Admin.findOne({ email: String(email).toLowerCase() });
    if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) {
      return res.status(401).json({ error: "Invalid credentials." });
    }
    admin.lastLogin = new Date();
    await admin.save();
    const token = sign({ role: "admin", email: admin.email, name: admin.name }, "24h");
    res.json({ token, role: "admin", email: admin.email, name: admin.name });
  } catch (err) {
    next(err);
  }
});

router.post("/user/login", async (req, res, next) => {
  try {
    const { walletAddress, signature, message } = req.body;
    if (!walletAddress || !signature || !message) {
      return res.status(400).json({ error: "walletAddress, signature, and message are required." });
    }
    const recovered = ethers.verifyMessage(message, signature);
    if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(401).json({ error: "Signature does not match wallet address." });
    }
    const address = walletAddress.toLowerCase();
    const username = `Researcher ${walletAddress.slice(0, 6)}`;
    const user = await User.findOneAndUpdate(
      { walletAddress: address },
      { $setOnInsert: { walletAddress: address, username, did: `did:ethr:${address}`, authProvider: "metamask", walletType: "metamask" }, $set: { lastLogin: new Date(), lastLoginAt: new Date() } },
      { new: true, upsert: true }
    );
    const token = sign({ role: "researcher", walletAddress: user.walletAddress }, "7d");
    await AuditLog.create({ action: "metamask_connected", actor: user.did, actorWallet: address, actorRole: "researcher" }).catch(() => {});
    res.json({ token, role: "researcher", walletAddress: user.walletAddress, username: user.username, did: user.did, authProvider: user.authProvider, walletType: user.walletType });
  } catch (err) {
    next(err);
  }
});

router.post("/google", async (req, res, next) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).json({ error: "Google login is not configured." });
    const ticket = await googleClient.verifyIdToken({ idToken: req.body.credential, audience: process.env.GOOGLE_CLIENT_ID });
    const profile = ticket.getPayload();
    if (!profile?.sub || !profile.email || !profile.email_verified) return res.status(401).json({ error: "A verified Google account is required." });
    let user = await User.findOne({ googleSubject: profile.sub });
    let created = false;
    if (!user) {
      const embeddedWallet = embeddedWalletFor(profile.sub);
      const identityId = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(`${profile.sub}:${process.env.JWT_SECRET}`))).address.slice(2).toLowerCase();
      user = await User.create({
        googleSubject: profile.sub,
        email: profile.email,
        username: profile.name || profile.email.split("@")[0],
        displayName: profile.name,
        profilePicture: profile.picture,
        authProvider: "google",
        did: `did:genechain:${identityId}`,
        walletAddress: embeddedWallet.address.toLowerCase(),
        walletType: "embedded",
        lastLogin: new Date(),
        lastLoginAt: new Date(),
      });
      created = true;
      await AuditLog.insertMany([
        { action: "did_created", actor: user.did, actorWallet: user.walletAddress, actorRole: "researcher" },
        { action: "embedded_wallet_created", actor: user.did, actorWallet: user.walletAddress, actorRole: "researcher", note: "Address-only demo wallet; no private key persisted." },
      ]);
    } else {
      user.lastLogin = new Date();
      user.lastLoginAt = new Date();
      await user.save();
    }
    await AuditLog.create({ action: "google_login", actor: user.did, actorWallet: user.walletAddress, actorRole: "researcher", details: { created } });
    const token = sign({ role: "researcher", userId: String(user._id), walletAddress: user.walletAddress, did: user.did, authProvider: "google", walletType: "embedded" }, "7d");
    res.json({ token, role: "researcher", userId: user._id, email: user.email, name: user.displayName, username: user.username, walletAddress: user.walletAddress, did: user.did, authProvider: "google", walletType: "embedded" });
  } catch (err) {
    const message = String(err.message || "");
    console.error("[google-auth] Credential verification failed:", message);
    if (message.includes("Wrong recipient")) {
      return res.status(401).json({
        error: "Google client ID mismatch. Restart both servers after updating the environment files.",
        code: "GOOGLE_AUDIENCE_MISMATCH",
      });
    }
    if (message.includes("Token used too late") || message.includes("Token used too early")) {
      return res.status(401).json({
        error: "Google credential timing check failed. Refresh the login page and verify that Windows date/time synchronization is enabled.",
        code: "GOOGLE_TOKEN_TIME_INVALID",
      });
    }
    if (message.includes("Invalid token signature") || message.includes("No pem found")) {
      return res.status(401).json({ error: "Google could not verify this credential. Please sign in again.", code: "GOOGLE_TOKEN_INVALID" });
    }
    next(err);
  }
});

router.get("/me", verifyAny, async (req, res, next) => {
  try {
    if (req.actor.role === "admin") {
      const admin = await Admin.findOne({ email: req.actor.email }).select("-passwordHash");
      return res.json({ role: "admin", ...admin?.toObject(), email: req.actor.email });
    }
    const user = await User.findOne({ walletAddress: req.actor.walletAddress });
    res.json({ role: "researcher", ...user?.toObject() });
  } catch (err) {
    next(err);
  }
});

router.patch("/profile", verifyUser, async (req, res, next) => {
  try {
    const allowed = (({ username, institution, bio }) => ({ username, institution, bio }))(req.body);
    const user = await User.findOneAndUpdate(
      { walletAddress: req.user.walletAddress },
      { $set: allowed },
      { new: true }
    );
    res.json(user);
  } catch (err) {
    next(err);
  }
});

router.post("/verify", (req, res) => {
  try {
    const decoded = jwt.verify(req.body.token, JWT_SECRET);
    res.json({ valid: true, ...decoded });
  } catch {
    res.json({ valid: false });
  }
});

module.exports = router;
