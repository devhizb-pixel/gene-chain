const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "genechain_super_secret_jwt_2024";

function readToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

function verifyToken(req, res) {
  const token = readToken(req);
  if (!token) {
    res.status(401).json({ error: "No token provided." });
    return null;
  }
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    res.status(401).json({ error: "Invalid or expired token." });
    return null;
  }
}

function verifyAdmin(req, res, next) {
  const decoded = verifyToken(req, res);
  if (!decoded) return;
  if (decoded.role !== "admin") return res.status(403).json({ error: "Admin access required." });
  req.admin = decoded;
  req.actor = decoded;
  next();
}

function verifyUser(req, res, next) {
  const decoded = verifyToken(req, res);
  if (!decoded) return;
  if (decoded.role !== "researcher") return res.status(403).json({ error: "Researcher access required." });
  req.user = decoded;
  req.actor = decoded;
  next();
}

function verifyAny(req, res, next) {
  const decoded = verifyToken(req, res);
  if (!decoded) return;
  req.actor = decoded;
  if (decoded.role === "admin") req.admin = decoded;
  if (decoded.role === "researcher") req.user = decoded;
  next();
}

module.exports = { verifyAdmin, verifyUser, verifyAny };
