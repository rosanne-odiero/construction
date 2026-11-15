import { z } from "zod";

// Zod 4 probes `new Function` once to decide whether to compile fast parsers. The production CSP
// (no 'unsafe-eval', src/lib/security-headers.ts) blocks it and the browser reports a violation on
// every page, so the browser bundle parses without that JIT (D-150).
z.config({ jitless: true });
