const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");

const email = "admin@genechain.com";
const password = "Admin@12345";
const hash = bcrypt.hashSync(password, 10);

const admins = [{ email, passwordHash: hash }];
const outPath = path.join(__dirname, "../data/admins.json");

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(admins, null, 2), "utf8");

console.log("✅ admins.json created!");
console.log("   Email:", email);
console.log("   Password: Admin@12345");
console.log("   Hash:", hash);
