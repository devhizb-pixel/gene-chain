const mongoose = require("mongoose");

async function connectDB() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/genechain";
  try {
    mongoose.set("strictQuery", true);
    await mongoose.connect(uri);
    console.log(`[MongoDB] connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
  } catch (err) {
    console.error("[MongoDB] connection failed:", err.message);
    throw err;
  }
}

module.exports = connectDB;
