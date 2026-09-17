import { getDb } from "./db/client";
import { loadSettings } from "./config/settings";
import { ensureDefaultUser } from "./models/users";
import { authRoutes } from "./routes/auth";
import { usersRoutes } from "./routes/users";
import { accountsRoutes } from "./routes/accounts";
import { emailsRoutes } from "./routes/emails";
import { downloadsRoutes } from "./routes/downloads";

export async function startServer() {
  const settings = await loadSettings();
  const db = getDb();
  await ensureDefaultUser(db);

  const routes = {
    ...authRoutes(db),
    ...usersRoutes(db),
    ...accountsRoutes(db),
    ...emailsRoutes(db),
    ...downloadsRoutes(db),

    "/api/health": {
      GET: () => Response.json({ ok: true }),
    },
  };

  const server = Bun.serve({
    port: settings.port,
    routes,
    development: process.env.NODE_ENV !== "production",
  });

  console.log(`P.S.Mail API server running at ${server.url}`);
  return server;
}

if (import.meta.main) {
  startServer();
}
