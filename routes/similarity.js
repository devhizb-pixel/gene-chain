const express = require("express");
const router = express.Router();
const path = require("path");
const crypto = require("crypto");
const GeneEdit = require("../models/GeneEdit");
const RegistrationLicense = require("../models/RegistrationLicense");
const SimilarityReport = require("../models/SimilarityReport");
const AuditLog = require("../models/AuditLog");

// Simple in-memory cache for IPFS sequence data (avoids re-fetching)
const sequenceCache = new Map();
let lastCacheTime = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute

/**
 * K-mer similarity (Jaccard) — mirrors frontend utility
 */
function getKmers(sequence, k = 5) {
  const kmers = new Set();
  if (!sequence || sequence.length < k) return kmers;
  for (let i = 0; i <= sequence.length - k; i++) {
    kmers.add(sequence.slice(i, i + k));
  }
  return kmers;
}

function kmerSimilarity(seq1, seq2, k = 5) {
  if (!seq1 || !seq2) return 0;
  const k1 = getKmers(seq1, k);
  const k2 = getKmers(seq2, k);
  if (k1.size === 0 || k2.size === 0) return 0;
  let intersection = 0;
  for (const kmer of k1) { if (k2.has(kmer)) intersection++; }
  const union = k1.size + k2.size - intersection;
  return union === 0 ? 0 : Math.round((intersection / union) * 100);
}

function kmerStats(seq1, seq2, k = 5) {
  const k1 = getKmers(seq1, k);
  const k2 = getKmers(seq2, k);
  let intersection = 0;
  for (const kmer of k1) { if (k2.has(kmer)) intersection++; }
  const union = k1.size + k2.size - intersection;
  const jaccard = union === 0 ? 0 : intersection / union;
  return { totalKmers: k1.size, matchingKmers: intersection, jaccard, score: Math.round(jaccard * 100) };
}

function riskLevel(score) {
  if (score >= 90) return "Potential Infringement";
  if (score >= 70) return "Possible Derivative Work";
  return "Likely Novel";
}

function parseFasta(content) {
  return content
    .split("\n")
    .filter((l) => !l.startsWith(">") && l.trim().length > 0)
    .map((l) => l.trim().toUpperCase().replace(/[^ATGCN]/g, ""))
    .join("");
}

/**
 * Load contract and get all edits with their sequence previews
 * Uses metadata.sequencePreview stored on-chain for similarity comparison
 * Falls back to database if blockchain is unavailable
 */
async function getAllEditsWithSequences() {
  const now = Date.now();
  if (sequenceCache.size > 0 && now - lastCacheTime < CACHE_TTL_MS) {
    return Array.from(sequenceCache.values());
  }

  // Try blockchain first
  try {
    const network = process.env.NETWORK || "localhost";
    const deployPath = path.join(__dirname, `../../deployments/${network}.json`);

    let deployment;
    try {
      deployment = require(deployPath);
      // Clear module cache so changes to the file are picked up
      delete require.cache[require.resolve(deployPath)];
    } catch {
      console.warn(`[similarity] Deployment file not found for network '${network}', falling back to database`);
      return getAllEditsFromDatabase();
    }

    const { ethers } = require("ethers");
    const rpcUrl = network === "localhost" ? "http://127.0.0.1:8545" : (process.env.SEPOLIA_RPC_URL || "");
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(deployment.address, deployment.abi, provider);

    const tokenIds = await contract.getAllTokenIds();
    const edits = [];

    for (const id of tokenIds) {
      try {
        const details = await contract.getEditDetails(id);
        let metadata = {};
        try { metadata = JSON.parse(details.metadata); } catch { metadata = {}; }

        const entry = {
          tokenId: id.toString(),
          title: metadata.title || `Token #${id}`,
          author: details.author,
          licenseType: details.licenseType,
          isActive: details.isActive,
          ipfsCID: details.ipfsCID,
          timestamp: Number(details.timestamp),
          sequence: metadata.sequencePreview || "",
        };
        sequenceCache.set(id.toString(), entry);
        edits.push(entry);
      } catch (err) {
        console.warn(`Failed to fetch token ${id}:`, err.message);
      }
    }

    lastCacheTime = now;
    return edits.length > 0 ? edits : getAllEditsFromDatabase();
  } catch (err) {
    console.warn(`[similarity] Blockchain fetch failed (${err.message}), falling back to database`);
    return getAllEditsFromDatabase();
  }
}

/**
 * Fallback: Get all gene edits from database
 */
async function getAllEditsFromDatabase() {
  try {
    const edits = await GeneEdit.find({ status: "approved" }).lean().catch(() => []);
    return edits.map(e => ({
      tokenId: e.tokenId || e._id.toString(),
      title: e.title,
      author: e.authorWallet,
      licenseType: e.licenseType,
      isActive: true,
      ipfsCID: e.ipfsCID,
      timestamp: new Date(e.createdAt).getTime() / 1000,
      sequence: "", // Database doesn't store full sequence, only blockchain does
      geneEditId: e._id.toString(),
    }));
  } catch (err) {
    console.error("[similarity] Failed to fetch from database:", err.message);
    return [];
  }
}

/**
 * POST /api/similarity
 * Body: { sequence: string }
 * Returns: [{ tokenId, title, similarity, author }]
 */
router.post("/", async (req, res) => {
  try {
    const { sequence } = req.body;
    if (!sequence || typeof sequence !== "string" || sequence.trim().length < 5) {
      return res.status(400).json({ error: "Sequence must be at least 5 characters." });
    }

    const normalized = parseFasta(sequence) || sequence.toUpperCase().replace(/[^ATGCN]/g, "");
    if (normalized.length < 5) {
      return res.status(400).json({ error: "No valid DNA bases (ATGCN) found in sequence." });
    }

    let edits;
    try {
      edits = await getAllEditsWithSequences();
    } catch (err) {
      console.error("[similarity] Error loading edits:", err.message);
      return res.status(503).json({ error: "Similarity database unavailable. Please try again later." });
    }

    if (!edits || edits.length === 0) {
      return res.json({ results: [], totalCompared: 0, queryLength: normalized.length });
    }

    const results = edits
      .filter((e) => e.sequence && e.sequence.length >= 5)
      .map((e) => ({
        tokenId: e.tokenId,
        title: e.title,
        author: e.author,
        licenseType: e.licenseType,
        similarity: kmerSimilarity(normalized, e.sequence),
        isActive: e.isActive,
      }))
      .sort((a, b) => b.similarity - a.similarity);

    res.json({ results, totalCompared: edits.length, queryLength: normalized.length });
  } catch (err) {
    console.error("[similarity] Error:", err.message, err.stack);
    res.status(500).json({ error: "Similarity check failed. Please try again later." });
  }
});

router.post("/report", async (req, res) => {
  try {
    const { sequence, excludeGeneEditId, geneEditId } = req.body;
    if (!sequence || typeof sequence !== "string" || sequence.trim().length < 5) {
      return res.status(400).json({ error: "Sequence must be at least 5 characters." });
    }
    const kmerSize = Number(req.body.kmerSize || 5);
    const normalized = parseFasta(sequence) || sequence.toUpperCase().replace(/[^ATGCN]/g, "");
    if (normalized.length < kmerSize) return res.status(400).json({ error: "No valid DNA bases found in sequence." });
    
    let edits;
    try {
      edits = await getAllEditsWithSequences();
    } catch (err) {
      console.error("[similarity/report] Error loading edits:", err.message);
      edits = [];
    }

    const rows = await Promise.all((edits || [])
      .filter((e) => e.sequence && e.sequence.length >= kmerSize && String(e.geneEditId || "") !== String(excludeGeneEditId || ""))
      .map(async (e) => {
        const stats = kmerStats(normalized, e.sequence, kmerSize);
        const db = await GeneEdit.findOne({ tokenId: Number(e.tokenId) }).lean().catch(() => null);
        const cert = db ? await RegistrationLicense.findOne({ geneEditId: db._id }).lean().catch(() => null) : null;
        return {
          geneEditId: db?._id?.toString(),
          tokenId: Number(e.tokenId),
          title: db?.title || e.title,
          owner: db?.authorWallet || e.author,
          organism: db?.organism,
          matchPercentage: stats.score,
          certificateId: cert?.certificateNumber || (cert?._id ? String(cert._id) : undefined),
          certificateStatus: cert?.status,
          _stats: stats,
        };
      }));
    const matches = rows.sort((a, b) => b.matchPercentage - a.matchPercentage).slice(0, 5);
    const top = matches[0]?._stats || { totalKmers: getKmers(normalized, kmerSize).size, matchingKmers: 0, jaccard: 0, score: 0 };
    const cleanMatches = matches.map(({ _stats, ...match }) => match);
    const report = {
      score: top.score,
      riskLevel: riskLevel(top.score),
      kmerSize,
      totalKmers: top.totalKmers,
      matchingKmers: top.matchingKmers,
      jaccard: Number(top.jaccard.toFixed(4)),
      matches: cleanMatches,
    };
    const sequenceHash = crypto.createHash("sha256").update(normalized).digest("hex");
    const saved = await SimilarityReport.create({
      geneEditId: geneEditId || excludeGeneEditId || undefined,
      sequenceHash,
      ...report,
    }).catch(() => null);
    await AuditLog.create({
      action: "similarity_report_generated",
      actor: "system",
      actorRole: "system",
      targetType: "similarityReport",
      targetId: saved ? String(saved._id) : sequenceHash,
      targetGeneEditId: geneEditId || excludeGeneEditId,
      details: { score: report.score, riskLevel: report.riskLevel },
    }).catch(() => {});
    res.json({ ...report, sequenceHash, reportId: saved?._id });
  } catch (err) {
    console.error("[similarity/report] Error:", err.message, err.stack);
    res.status(500).json({ error: "Similarity report generation failed. Please try again later." });
  }
});

router.get("/report/:geneEditId", async (req, res) => {
  try {
    const report = await SimilarityReport.findOne({ geneEditId: req.params.geneEditId }).sort({ createdAt: -1 }).lean();
    const edit = await GeneEdit.findById(req.params.geneEditId).lean().catch(() => null);
    if (!report && !edit) return res.status(404).json({ error: "Similarity report not found." });
    res.json(report || {
      geneEditId: req.params.geneEditId,
      sequenceHash: edit.sequenceHash,
      score: edit.similarityScore || 0,
      riskLevel: riskLevel(edit.similarityScore || 0),
      kmerSize: 5,
      totalKmers: 0,
      matchingKmers: 0,
      jaccard: Number(((edit.similarityScore || 0) / 100).toFixed(4)),
      matches: (edit.similarityMatches || []).map((m) => ({ tokenId: m.tokenId, title: m.title, matchPercentage: m.similarity })),
      createdAt: edit.updatedAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/reports/recent", async (_req, res) => {
  try {
    const items = await SimilarityReport.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json({ items, reports: items, total: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/similarity/cache — Clear the sequence cache
 */
router.delete("/cache", (req, res) => {
  sequenceCache.clear();
  lastCacheTime = 0;
  res.json({ message: "Cache cleared." });
});

module.exports = router;
