'use strict';

const PORT        = process.env.PORT || 3000;
const JWT_SECRET  = process.env.JWT_SECRET || 'change-me-in-production-please';
const USERNAME    = process.env.PANEL_USERNAME || 'admin';

// Default password is "admin" — override via PANEL_PASSWORD_HASH (bcrypt hash)
// Docker Compose interpolates $ in .env files, so users must write $$ for literal $.
// We normalise here so both escaped ($$2a$$12$$…) and raw ($2a$12$…) forms work.
const rawHash     = process.env.PANEL_PASSWORD_HASH || '';
const PASS_HASH   = rawHash ? rawHash.replace(/\$\$/g, '$') : '$2a$12$KIXLz6H7j5/m.Cz.7Ij3OubqO3pDyL4W2Q8Q6P6zYfKk5hFcgGa2';

module.exports = {
  PORT,
  JWT_SECRET,
  USERNAME,
  PASS_HASH
};
