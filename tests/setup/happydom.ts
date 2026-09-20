import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Must run as a --preload, before any test file (and therefore before
// @testing-library/react) is imported, since testing-library's `screen`
// binds to `globalThis.document` at module-evaluation time.
GlobalRegistrator.register({ url: "http://localhost:3001/" }); // a real origin, so history.pushState / location.pathname work

// The app imports audio files (src/sounds/*.mp3) and the logo (logo/*.svg); the bundler turns those into URLs, but Bun's test
// runtime has no loader for them and would try to parse the bytes as JavaScript. Stand in with the
// same shape: a module whose default export is the file's path.
import { plugin } from "bun";

plugin({
  name: "assets-as-url",
  setup(build) {
    build.onLoad({ filter: /\.(mp3|svg)$/ }, args => ({
      contents: `export default ${JSON.stringify(args.path)};`,
      loader: "js",
    }));
  },
});
