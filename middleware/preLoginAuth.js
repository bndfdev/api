// Middleware to check for a custom header (e.g., x-api-key) for pre-login APIs
module.exports = function (req, res, next) {
  const apiKey = req.header('x-api-key');
  // You can store this in .env or config for better security
  const validKey = process.env.PRE_LOGIN_API_KEY || 'bondfire-prelogin-key';
  if (!apiKey || apiKey !== validKey) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing x-api-key header' });
  }
  next();
};
