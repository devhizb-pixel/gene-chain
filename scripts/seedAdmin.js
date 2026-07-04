require("dotenv").config();
const bcrypt = require("bcryptjs");
const connectDB = require("../config/db");
const Admin = require("../models/Admin");

async function seedAdmin() {
  await connectDB();
  const email = process.env.ADMIN_EMAIL || "admin@genechain.com";
  const exists = await Admin.findOne({ email });
  if (!exists) {
    const passwordHash = await bcrypt.hash("Admin@12345", 10);
    await Admin.create({ email, passwordHash, name: "Admin" });
    console.log("Admin seeded: admin@genechain.com / Admin@12345");
  } else {
    console.log(`Admin already exists: ${email}`);
  }
  process.exit(0);
}

seedAdmin().catch((err) => {
  console.error(err);
  process.exit(1);
});
