## Application

P.S.Mail is a webmail client with a minimal and clean interface, to receive, read, send and manage emails. It is designed to be fast, lightweight and easy to use. It is built with Bun, React, TypeScript and shadcn/Tailwind CSS.

## Runtime Environment


Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Context menus

When adding a context menu, give each item an icon, and show the existing keyboard shortcut for that action (if one exists) as a trailing shortcut hint.

## Desktop app (Electron)

Everything for the native desktop wrapper lives under `electronapp/` — its own `package.json`/lockfile/`node_modules`, never mixed into the root project's dependencies. It packages the *existing* psmail server as its sidecar (`bun build --compile`, see `electronapp/scripts/build-sidecar.ts` — uses the `Bun.build()` JS API with the `bun-plugin-tailwind` plugin, **not** the `bun build --compile` CLI, which silently drops every Tailwind `@theme`/`@utility` at-rule instead of erroring) and points a plain `BrowserWindow` at it; it doesn't have, or need, any frontend code of its own — external links (`target="_blank"` in message HTML) are redirected to the system browser entirely on the Electron side (`setWindowOpenHandler`/`will-navigate` in `main.js`), no `@tauri-apps/plugin-opener`-style JS bridge required. `bun run electron:dev` / `bun run electron:build` from the repo root. Its version is synced from the root `package.json` before every build (`electronapp/scripts/sync-version.ts`) — never hand-edit the version in `electronapp/package.json`. The window loads `http://localhost:<port>`, not `127.0.0.1` — WebAuthn's relying-party ID must be a real domain string, so passkey unlock would otherwise fail with a domain error even though the server itself still binds to `127.0.0.1`.

Passkey unlock ("Remember on this device") is unavailable on macOS in this app, on purpose: `passkeysAvailable()` in `src/lib/passkeyVault.ts` returns `false` when `isElectron() && isMac()` (`src/lib/platform.ts`). Electron's built-in Chromium Touch ID authenticator has no PRF extension support (required to derive the vault's encryption key), and a native fix (e.g. `electron-webauthn-mac`) doesn't remove the real blocker: macOS requires `rpId` to be a domain Apple can verify the app owns (Associated Domains entitlement + a hosted `apple-app-site-association` file + a paid Developer account + provisioning profile) — impossible for this local, no-domain app. So the option is simply hidden and the user types their password, same as any browser without WebAuthn.

## Changelog

`changelog.txt` records the summary given after each piece of work. After every git commit, add the summary you write for the user (what changed and why, in the same words) to `changelog.txt` as a new entry at the top, headed `YYYY-MM-DD - <short title> (<commit hash>)`, and include the changelog update in a follow-up commit (do not amend the commit the summary describes).
