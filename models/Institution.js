const mongoose = require("mongoose");

const institutionSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, unique: true },
  type: {
    type: String,
    enum: ["University", "Research Lab", "Biotech Startup", "Hospital", "Other"],
    default: "Other",
  },
  country: { type: String },
  website: { type: String },
  verifiedInstitution: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

institutionSchema.pre("save", function updateTimestamp(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("Institution", institutionSchema);
