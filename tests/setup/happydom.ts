import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Must run as a --preload, before any test file (and therefore before
// @testing-library/react) is imported, since testing-library's `screen`
// binds to `globalThis.document` at module-evaluation time.
GlobalRegistrator.register();
