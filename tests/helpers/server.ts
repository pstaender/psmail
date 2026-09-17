import type { Database } from "bun:sqlite";
import { authRoutes } from "../../src/server/routes/auth";
import { usersRoutes } from "../../src/server/routes/users";
import { accountsRoutes } from "../../src/server/routes/accounts";
import { emailsRoutes } from "../../src/server/routes/emails";
import { downloadsRoutes } from "../../src/server/routes/downloads";

/** Boots the real route handlers (same wiring as src/server/main.ts) against a test db on an ephemeral port. */
export function startTestServer(db: Database) {
  const routes = {
    ...authRoutes(db),
    ...usersRoutes(db),
    ...accountsRoutes(db),
    ...emailsRoutes(db),
    ...downloadsRoutes(db),
  };

  return Bun.serve({ port: 0, routes });
}
