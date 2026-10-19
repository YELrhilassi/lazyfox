// Teaches Node's ESM resolver about this project's extensionless TS imports.
//
// src/ uses `import { esc } from "../../shared/dom"` — no extension — because
// esbuild bundles it. Node's type-stripping loader resolves specifiers
// literally, so a test that imports a src/ module has to help it along.
//
// This is deliberately a RESOLVE hook and not a source transform: the code
// under test is read exactly as it is written, which is the point of testing
// it. Anything cleverer would mean the test exercises something other than the
// shipped source.
//
// Only .ts is added, and only when the literal specifier does not resolve, so
// a real file always wins and a typo still fails loudly.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) throw err;
    const base = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : process.cwd();
    for (const ext of [".ts", "/index.ts"]) {
      const candidate = resolvePath(base, specifier + ext);
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true, format: "module-typescript" };
      }
    }
    throw err;
  }
}
