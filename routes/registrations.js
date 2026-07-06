const express = require("express");
const router = express.Router();
const path = require("path");
const { ethers } = require("ethers");

function getContractInstance() {
  const network = process.env.NETWORK || "localhost";
  const deployPath = path.join(__dirname, `../deployments/${network}.json`);

  let deployment;
  try {
    delete require.cache[require.resolve(deployPath)];
    deployment = require(deployPath);
  } catch {
    throw new Error(`Deployment not found for network '${network}'. Run npm run deploy:local first.`);
  }

  const rpcUrl = network === "localhost"
    ? "http://127.0.0.1:8545"
    : (process.env.SEPOLIA_RPC_URL || "");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return new ethers.Contract(deployment.address, deployment.abi, provider);
}

function safeParseMetadata(str) {
  try { return JSON.parse(str); } catch { return { title: str || "Untitled" }; }
}

/**
 * GET /api/registrations
 * Returns all EditRegistered events from the contract
 */
router.get("/", async (req, res) => {
  try {
    const contract = getContractInstance();
    const tokenIds = await contract.getAllTokenIds();

    const registrations = [];
    for (const id of tokenIds) {
      try {
        const details = await contract.getEditDetails(id);
        const owner = await contract.ownerOf(id);
        const metadata = safeParseMetadata(details.metadata);
        registrations.push({
          tokenId: id.toString(),
          ipfsCID: details.ipfsCID,
          sequenceHash: details.sequenceHash,
          licenseType: details.licenseType,
          metadata,
          timestamp: Number(details.timestamp),
          author: details.author,
          owner,
          isActive: details.isActive,
        });
      } catch (err) {
        console.warn(`Failed to fetch token ${id}:`, err.message);
      }
    }

    res.json({ registrations, total: registrations.length });
  } catch (err) {
    console.error("[registrations] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/registrations/events
 * Returns raw EditRegistered events (last 100 blocks scanned)
 */
router.get("/events", async (req, res) => {
  try {
    const contract = getContractInstance();
    const provider = contract.runner;

    const latestBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latestBlock - 50000);

    const filter = contract.filters.EditRegistered();
    const events = await contract.queryFilter(filter, fromBlock, "latest");

    const formatted = events.map((e) => ({
      tokenId: e.args[0].toString(),
      author: e.args[1],
      sequenceHash: e.args[2],
      licenseType: e.args[3],
      timestamp: Number(e.args[4]),
      txHash: e.transactionHash,
      blockNumber: e.blockNumber,
    }));

    res.json({ events: formatted.reverse(), total: formatted.length });
  } catch (err) {
    console.error("[registrations/events] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/registrations/token/:id
 * Returns full details for a specific token ID
 */
router.get("/token/:id", async (req, res) => {
  try {
    const tokenId = parseInt(req.params.id);
    if (isNaN(tokenId) || tokenId < 1) {
      return res.status(400).json({ error: "Invalid token ID." });
    }

    const contract = getContractInstance();
    const details = await contract.getEditDetails(tokenId);
    const owner = await contract.ownerOf(tokenId);
    const pendingRequests = await contract.getPendingRequests(tokenId);
    const approvedLicensees = await contract.getApprovedLicensees(tokenId);
    const allRequests = await contract.getAllLicenseRequests(tokenId);

    const metadata = safeParseMetadata(details.metadata);

    res.json({
      tokenId: tokenId.toString(),
      ipfsCID: details.ipfsCID,
      sequenceHash: details.sequenceHash,
      licenseType: details.licenseType,
      metadata,
      timestamp: Number(details.timestamp),
      author: details.author,
      owner,
      isActive: details.isActive,
      pendingRequests: pendingRequests.map((r) => ({
        requester: r.requester,
        requestTime: Number(r.requestTime),
        purpose: r.purpose,
        isPending: r.isPending,
      })),
      approvedLicensees,
      allRequests: allRequests.map((r) => ({
        requester: r.requester,
        requestTime: Number(r.requestTime),
        purpose: r.purpose,
        isPending: r.isPending,
      })),
    });
  } catch (err) {
    console.error(`[registrations/token/${req.params.id}] Error:`, err.message);
    if (err.message.includes("does not exist")) {
      return res.status(404).json({ error: `Token #${req.params.id} not found.` });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/registrations/user/:address
 * Returns all token IDs and details for a wallet address
 */
router.get("/user/:address", async (req, res) => {
  try {
    const { address } = req.params;
    if (!ethers.isAddress(address)) {
      return res.status(400).json({ error: "Invalid Ethereum address." });
    }

    const contract = getContractInstance();
    const tokenIds = await contract.getUserTokenIds(address);

    const tokens = [];
    for (const id of tokenIds) {
      try {
        const details = await contract.getEditDetails(id);
        tokens.push({
          tokenId: id.toString(),
          licenseType: details.licenseType,
          metadata: safeParseMetadata(details.metadata),
          timestamp: Number(details.timestamp),
          isActive: details.isActive,
        });
      } catch { /* skip */ }
    }

    res.json({ address, tokens, total: tokens.length });
  } catch (err) {
    console.error("[registrations/user] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
