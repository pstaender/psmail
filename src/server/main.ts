import index from "../index.html";
import { getDb } from "./db/client";
import { loadSettings } from "./config/settings";
import { ensureDefaultUser } from "./models/users";
import { failInterruptedDownloadJobs } from "./models/downloads";
import { authRoutes } from "./routes/auth";
import { usersRoutes } from "./routes/users";
import { accountsRoutes } from "./routes/accounts";
import { emailsRoutes } from "./routes/emails";
import { downloadsRoutes } from "./routes/downloads";
import { foldersRoutes } from "./routes/folders";
import { searchRoutes } from "./routes/search";
import { contactsRoutes } from "./routes/contacts";
import { settingsRoutes } from "./routes/settings";
import { aiRoutes } from "./routes/ai";

export async function startServer() {
  const settings = await loadSettings();
  const db = getDb();
  await ensureDefaultUser(db);
  failInterruptedDownloadJobs(db);

  const routes = {
    ...authRoutes(db),
    ...usersRoutes(db),
    ...accountsRoutes(db),
    ...emailsRoutes(db),
    ...downloadsRoutes(db),
    ...foldersRoutes(db),
    ...searchRoutes(db),
    ...contactsRoutes(db),
    ...settingsRoutes(db),
    ...aiRoutes(db),

    "/api/health": {
      GET: () => Response.json({ ok: true }),
    },

    // Serve the webclient for everything else.
    "/*": index,
  };

  const server = Bun.serve({
    port: settings.port,
    routes,
    // Bun closes a connection whose response hasn't started after 10 s — silently, so the client just sees an
    // empty reply. Requests that talk to IMAP (folder lists, capability checks, bulk actions on a big mailbox) can
    // take longer than that, so allow much more; the IMAP calls have their own, shorter timeouts.
    idleTimeout: 120,
    development: process.env.NODE_ENV !== "production" && {
      hmr: true,
      console: true,
    },
  });

  console.log(`P.S.Mail server running at ${server.url}`);
  return server;
}

if (import.meta.main) {
  startServer();
}
