const express = require("express");
const GeneEdit = require("../models/GeneEdit");
const RegistrationLicense = require("../models/RegistrationLicense");
const AuditLog = require("../models/AuditLog");
const { ethers } = require("ethers");
const path = require("path");

const router = express.Router();

function cidFromUri(value) {
  if (!value) return "";
  return String(value).replace("ipfs://", "").replace(/^https?:\/\/[^/]+\/ipfs\//, "").split(/[/?#]/)[0];
}

function same(a, b) {
  if (!a || !b) return null;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

async function fetchIpfsMetadata(cid) {
  if (!cid || typeof fetch !== "function") return { unavailable: true };
  const url = `https://gateway.pinata.cloud/ipfs/${cid}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return { unavailable: true, status: response.status };
    const text = await response.text();
    try { return JSON.parse(text); } catch { return { raw: text.slice(0, 500) }; }
  } catch {
    clearTimeout(timer);
    return { unavailable: true };
  }
}

router.get("/gene-edit/:id", async (req, res, next) => {
  try {
    const edit = await GeneEdit.findById(req.params.id).lean();
    if (!edit) return res.status(404).json({ error: "Gene edit not found." });
    const cert = await RegistrationLicense.findOne({ geneEditId: edit._id }).lean();
    const ipfs = await fetchIpfsMetadata(edit.metadataCID || edit.ipfsCID);
    const onChain = {
      contractAddress: edit.contractAddress,
      network: "Sepolia",
      tokenId: edit.tokenId,
      owner: edit.authorWallet,
      sequenceHash: edit.sequenceHash,
      metadataURI: edit.metadataCID ? `ipfs://${edit.metadataCID}` : edit.ipfsCID ? `ipfs://${edit.ipfsCID}` : null,
      ipfsCID: edit.ipfsCID,
      transactionHash: edit.transactionHash,
      blockNumber: edit.blockNumber,
      mintTimestamp: edit.submittedAt || edit.createdAt,
    };
    if (edit.tokenId) {
      try {
        const network = process.env.NETWORK || "localhost";
        const deployment = require(path.join(__dirname, `../../deployments/${network}.json`));
        const rpcUrl = network === "localhost" ? "http://127.0.0.1:8545" : process.env.SEPOLIA_RPC_URL;
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS || deployment.address, deployment.abi, provider);
        const [details, owner, receipt] = await Promise.all([
          contract.getEditDetails(edit.tokenId),
          contract.ownerOf(edit.tokenId),
          edit.transactionHash ? provider.getTransactionReceipt(edit.transactionHash) : null,
        ]);
        onChain.owner = owner;
        onChain.sequenceHash = details.sequenceHash;
        onChain.ipfsCID = details.ipfsCID;
        onChain.metadataURI = `ipfs://${details.ipfsCID}`;
        onChain.blockNumber = receipt?.blockNumber || null;
        onChain.transactionVerified = Boolean(receipt?.status === 1);
      } catch (error) {
        onChain.unavailable = true;
        onChain.error = error.message;
      }
    }
    const database = {
      mongoId: String(edit._id),
      certificateId: cert?.certificateNumber || String(cert?._id || ""),
      geneTitle: edit.title,
      ownerAddress: edit.authorWallet,
      reviewStatus: edit.status,
      certificateStatus: cert?.status,
      sequenceHash: edit.sequenceHash,
      ipfsCID: edit.ipfsCID,
      metadataCID: edit.metadataCID,
      createdAt: edit.createdAt,
      updatedAt: edit.updatedAt,
    };
    const checks = [
      { key: "tokenId", label: "Token ID", expected: database.tokenId || edit.tokenId, actual: onChain.tokenId, passed: same(edit.tokenId, onChain.tokenId) },
      { key: "owner", label: "Owner wallet", expected: database.ownerAddress, actual: onChain.owner, passed: same(database.ownerAddress, onChain.owner) },
      { key: "sequenceHash", label: "Sequence hash", expected: database.sequenceHash, actual: onChain.sequenceHash, passed: same(database.sequenceHash, onChain.sequenceHash) },
      { key: "ipfsCID", label: "IPFS CID", expected: database.ipfsCID || database.metadataCID, actual: cidFromUri(onChain.metadataURI) || onChain.ipfsCID, passed: same(database.ipfsCID || database.metadataCID, cidFromUri(onChain.metadataURI) || onChain.ipfsCID) },
      { key: "title", label: "IPFS title", expected: database.geneTitle, actual: ipfs.title || ipfs.name, passed: ipfs.unavailable ? null : same(database.geneTitle, ipfs.title || ipfs.name) },
      { key: "certificate", label: "Certificate reference", expected: String(edit._id), actual: String(cert?.geneEditId || ""), passed: cert ? same(edit._id, cert.geneEditId) : null },
      { key: "transaction", label: "Transaction receipt", expected: "Successful receipt", actual: onChain.transactionVerified ? "Successful receipt" : "Unavailable", passed: onChain.unavailable ? null : onChain.transactionVerified },
    ];
    const verified = checks.every((check) => check.passed !== false);
    await AuditLog.create({
      action: "integrity_verification_performed",
      actor: "public_or_session",
      actorRole: "public",
      targetType: "geneEdit",
      targetId: String(edit._id),
      targetTokenId: edit.tokenId,
      targetGeneEditId: String(edit._id),
      details: { verified },
    }).catch(() => {});
    res.json({ onChain, database, ipfs, checks, verified });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
