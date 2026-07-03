# domains/identity/ -- MIGRATED

Owns authentication, sessions, JWT. auth.middleware.js, auth.model.js.
Moved 2026-07-02. 13 external files import auth.middleware.js directly;
all other admin routes get it transitively via _adminShared.js.

Full domain map: see ../README.md.
