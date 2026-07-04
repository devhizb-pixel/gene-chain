const express = require("express");
const router = express.Router();
const multer = require("multer");
const FormData = require("form-data");

// Store file in memory (not disk) — safer for proxying
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
});

const PINATA_API = "https://api.pinata.cloud";

/**
 * POST /api/upload
 * Proxies encrypted file upload to Pinata — keeps JWT server-side
 * Body: multipart/form-data with field 'file'
 * Returns: { cid, size }
 */
router.post("/", upload.single("file"), async (req, res) => {
  try {
    const jwt = process.env.PINATA_JWT;
    if (!jwt || jwt === "your_pinata_jwt_here") {
      return res.status(503).json({ error: "Pinata JWT not configured on server. Set PINATA_JWT in backend/.env" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file provided. Send file as multipart/form-data with field name 'file'." });
    }

    const filename = req.file.originalname || `gene_edit_${Date.now()}.enc`;

    // Build form data for Pinata
    const form = new FormData();
    form.append("file", req.file.buffer, { filename, contentType: req.file.mimetype || "text/plain" });
    form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
    form.append("pinataMetadata", JSON.stringify({
      name: filename,
      keyvalues: { type: "gene-edit-sequence", uploadedAt: new Date().toISOString() },
    }));

    const { default: fetch } = await import("node-fetch");
    const response = await fetch(`${PINATA_API}/pinning/pinFileToIPFS`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    const text = await response.text();
    if (!response.ok) {
      console.error("[upload] Pinata error:", text);
      return res.status(response.status).json({ error: `Pinata upload failed: ${text}` });
    }

    const result = JSON.parse(text);
    res.json({ cid: result.IpfsHash, size: result.PinSize, timestamp: result.Timestamp });
  } catch (err) {
    console.error("[upload] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/upload/json
 * Proxies JSON metadata upload to Pinata
 * Body: { metadata: object }
 * Returns: { cid }
 */
router.post("/json", async (req, res) => {
  try {
    const jwt = process.env.PINATA_JWT;
    if (!jwt || jwt === "your_pinata_jwt_here") {
      return res.status(503).json({ error: "Pinata JWT not configured on server." });
    }

    const { metadata } = req.body;
    if (!metadata || typeof metadata !== "object") {
      return res.status(400).json({ error: "Request body must contain a 'metadata' object." });
    }

    const body = {
      pinataContent: metadata,
      pinataMetadata: { name: `metadata-${Date.now()}.json` },
      pinataOptions: { cidVersion: 1 },
    };

    const { default: fetch } = await import("node-fetch");
    const response = await fetch(`${PINATA_API}/pinning/pinJSONToIPFS`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: `Pinata JSON upload failed: ${text}` });
    }

    const result = JSON.parse(text);
    res.json({ cid: result.IpfsHash });
  } catch (err) {
    console.error("[upload/json] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
