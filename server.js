require("dotenv").config();
// Reuse root Hardhat/Sepolia variables such as PRIVATE_KEY without duplicating secrets.
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const express = require("express");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose");
const { ethers } = require("ethers");
const connectDB = require("./config/db");
const errorHandler = require("./middleware/errorHandler");

const similarityRouter = require("./routes/similarity");
const uploadRouter = require("./routes/upload");
const registrationsRouter = require("./routes/registrations");
const authRouter = require("./routes/auth");
const geneEditsRouter = require("./routes/geneEdits");
const licensesRouter = require("./routes/licenses");
const adminRouter = require("./routes/admin");
const certificatesRouter = require("./routes/certificates");
const integrityRouter = require("./routes/integrity");
const usersRouter = require("./routes/users");
const researchersRouter = require("./routes/researchers");
const institutionsRouter = require("./routes/institutions");
const supportRouter = require("./routes/support");
const relayerRouter = require("./routes/relayer");

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173")
  .split(",").map((value) => value.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS."));
  },
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.use("/api/auth", authRouter);
app.use("/api/gene-edits", geneEditsRouter);
app.use("/api/licenses", licensesRouter);
app.use("/api/admin", adminRouter);
app.use("/api/similarity", similarityRouter);
app.use("/api/upload", uploadRouter);
app.use("/api/registrations", registrationsRouter);
app.use("/api/certificates", certificatesRouter);
app.use("/api/integrity", integrityRouter);
app.use("/api/users", usersRouter);
app.use("/api/researchers", researchersRouter);
app.use("/api/institutions", institutionsRouter);
app.use("/api/support", supportRouter);
app.use("/api/relayer", relayerRouter);

app.get("/api/health", async (_req, res) => {
  const network = process.env.NETWORK || "localhost";
  let deploymentInfo = null;
  try {
    deploymentInfo = require(path.join(__dirname, `../deployments/${network}.json`));
  } catch { /* optional */ }
  let rpc = { status: "unavailable", blockNumber: null };
  try {
    const rpcUrl = network === "localhost" ? "http://127.0.0.1:8545" : process.env.SEPOLIA_RPC_URL;
    if (rpcUrl) rpc = { status: "connected", blockNumber: await new ethers.JsonRpcProvider(rpcUrl).getBlockNumber() };
  } catch { /* reflected in response */ }
  res.json({
    status: mongoose.connection.readyState === 1 ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    network,
    contractAddress: process.env.CONTRACT_ADDRESS || deploymentInfo?.address || null,
    pinataConfigured: Boolean(process.env.PINATA_JWT && process.env.PINATA_JWT !== "your_pinata_jwt_here"),
    jwtConfigured: Boolean(process.env.JWT_SECRET),
    mongoConfigured: Boolean(process.env.MONGODB_URI || true),
    mongodb: { status: mongoose.connection.readyState === 1 ? "connected" : "disconnected", database: mongoose.connection.name || null },
    sepolia: rpc,
    relayerConfigured: Boolean(process.env.PRIVATE_KEY),
    googleLoginConfigured: Boolean(process.env.GOOGLE_CLIENT_ID),
  });
});

app.use((req, res) => res.status(404).json({ error: "Route not found", path: req.path }));
app.use(errorHandler);

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`GeneChain Backend API listening on http://localhost:${PORT}`);
      console.log(`Network: ${process.env.NETWORK || "localhost"}`);
    });
  })
  .catch(() => process.exit(1));

module.exports = app;
