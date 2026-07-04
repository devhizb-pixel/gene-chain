function errorHandler(err, req, res, _next) {
  const statusCode = err.status || err.statusCode || 500;
  if (process.env.NODE_ENV === "development") {
    console.error(err.stack || err);
  } else {
    console.error("[ERROR]", err.message);
  }
  res.status(statusCode).json({ error: err.message || "Internal server error", code: statusCode });
}

module.exports = errorHandler;
