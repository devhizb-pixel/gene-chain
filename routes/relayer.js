const express = require("express");
const path = require("path");
const { ethers } = require("ethers");
const { verifyUser } = require("../middleware/authMiddleware");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const LicenseRequest = require("../models/LicenseRequest");

const router = express.Router();

function contractWithRelayer() {
  const network = process.env.NETWORK || "sepolia";
  const deployment = require(path.join(__dirname, `../deployments/${network}.json`));
  if (!process.env.PRIVATE_KEY || !process.env.SEPOLIA_RPC_URL) throw new Error("Relayer is not configured.");
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  return new ethers.Contract(process.env.CONTRACT_ADDRESS || deployment.address, deployment.abi, signer);
}

function embeddedWalletFor(user, provider) {
  const secret = process.env.EMBEDDED_WALLET_SECRET;
  if (!secret || secret.length < 32 || !user.googleSubject) throw new Error("Embedded wallet configuration is incomplete.");
  return new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(`${secret}:${user.googleSubject}`)), provider);
}

router.post("/mint", verifyUser, async (req, res, next) => {
  try {
    if (req.user.authProvider !== "google" || req.user.walletType !== "embedded") {
      return res.status(403).json({ error: "Assisted minting is available only to Google DID sessions." });
    }
    const { ipfsCID, sequenceHash, licenseType, metadata } = req.body;
    if (!ipfsCID || !/^0x[a-fA-F0-9]{64}$/.test(sequenceHash || "") || !licenseType) {
      return res.status(400).json({ error: "ipfsCID, bytes32 sequenceHash, and licenseType are required." });
    }
    const user = await User.findById(req.user.userId);
    if (!user || user.walletAddress !== req.user.walletAddress) return res.status(401).json({ error: "DID identity could not be verified." });
    await AuditLog.create({ action: "relayer_transaction_submitted", actor: user.did, actorWallet: user.walletAddress, actorRole: "researcher", details: { sequenceHash } });
    const contract = contractWithRelayer();
    if (await contract.hashExists(sequenceHash)) return res.status(409).json({ error: "Duplicate sequence hash already registered.", code: "DUPLICATE_HASH" });
    const tx = await contract.mintGeneEditFor(user.walletAddress, ipfsCID, sequenceHash, licenseType, typeof metadata === "string" ? metadata : JSON.stringify(metadata || {}));
    const receipt = await tx.wait(1);
    const event = receipt.logs.map((log) => { try { return contract.interface.parseLog(log); } catch { return null; } }).find((item) => item?.name === "EditRegistered");
    const tokenId = event?.args?.[0]?.toString();
    await AuditLog.insertMany([
      { action: "relayer_transaction_confirmed", actor: user.did, actorWallet: user.walletAddress, actorRole: "researcher", targetTokenId: Number(tokenId), details: { transactionHash: receipt.hash } },
      { action: "nft_minted_for_did", actor: user.did, actorWallet: user.walletAddress, actorRole: "researcher", targetTokenId: Number(tokenId), details: { transactionHash: receipt.hash } },
    ]);
    res.json({ tokenId, transactionHash: receipt.hash, ownerWallet: user.walletAddress, ownerDid: user.did, transactionMode: "did_assisted" });
  } catch (err) {
    await AuditLog.create({ action: "relayer_transaction_failed", actor: req.user?.did, actorWallet: req.user?.walletAddress, actorRole: "researcher", details: { message: err.message } }).catch(() => {});
    next(err);
  }
});

router.post("/license/:id/:decision", verifyUser, async (req, res, next) => {
  try {
    if (req.user.authProvider !== "google" || req.user.walletType !== "embedded") {
      return res.status(403).json({ error: "Assisted license decisions require a Google DID session." });
    }
    const decision = req.params.decision;
    if (!["approve", "reject"].includes(decision)) return res.status(400).json({ error: "Invalid license decision." });
    const [user, request] = await Promise.all([
      User.findById(req.user.userId),
      LicenseRequest.findById(req.params.id),
    ]);
    if (!user || !request) return res.status(404).json({ error: "DID identity or license request not found." });
    if (request.ownerWallet !== user.walletAddress || request.ownerWallet !== req.user.walletAddress) {
      return res.status(403).json({ error: "Only the DID-linked token owner can make this decision." });
    }
    if (!["pending", "requested"].includes(request.status)) return res.status(409).json({ error: "This license request is already resolved." });
    const relayerContract = contractWithRelayer();
    const provider = relayerContract.runner.provider;
    const chainOwner = await relayerContract.ownerOf(request.tokenId);
    if (chainOwner.toLowerCase() !== user.walletAddress) return res.status(409).json({ error: "Embedded wallet is not the current on-chain token owner." });
    await AuditLog.create({ action: "relayer_license_decision_submitted", actor: user.did, actorWallet: user.walletAddress, actorRole: "researcher", targetId: String(request._id), targetTokenId: request.tokenId, details: { decision } });
    const embeddedWallet = embeddedWalletFor(user, provider);
    if (embeddedWallet.address.toLowerCase() !== user.walletAddress) throw new Error("Derived embedded wallet does not match the DID profile.");
    const feeData = await provider.getFeeData();
    const gasLimit = 250000n;
    const requiredBalance = gasLimit * (feeData.maxFeePerGas || feeData.gasPrice || 2000000000n);
    const currentBalance = await provider.getBalance(embeddedWallet.address);
    if (currentBalance < requiredBalance) {
      const fundTx = await relayerContract.runner.sendTransaction({ to: embeddedWallet.address, value: requiredBalance - currentBalance });
      await fundTx.wait(1);
      await AuditLog.create({ action: "embedded_wallet_gas_funded", actor: user.did, actorWallet: user.walletAddress, actorRole: "researcher", targetTokenId: request.tokenId, details: { transactionHash: fundTx.hash } });
    }
    const ownerContract = relayerContract.connect(embeddedWallet);
    const tx = decision === "approve"
      ? await ownerContract.approveLicense(request.tokenId, request.requesterWallet)
      : await ownerContract.rejectLicense(request.tokenId, request.requesterWallet);
    const receipt = await tx.wait(1);
    await AuditLog.create({ action: "relayer_license_decision_confirmed", actor: user.did, actorWallet: user.walletAddress, actorRole: "researcher", targetId: String(request._id), targetTokenId: request.tokenId, details: { decision, transactionHash: receipt.hash } });
    res.json({ decision, transactionHash: receipt.hash, tokenId: request.tokenId, ownerWallet: user.walletAddress });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
