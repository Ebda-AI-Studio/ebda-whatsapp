# Ruling FDN-VENDOR-1

**Decision:** the shared Ebda foundation (`Whisky-11/ebda-foundation`, tag v0.1.0) is vendored at `foundation/` and imported by relative path (`../../foundation/phone`), pinned by `foundation.lock.json` and proved by `test/foundation-parity.test.ts`. `src/core/phone.ts` and `src/core/buyer-key.ts` re-export it. The package is not wired as an npm `file:` dependency.

**Evidence:** the production Worker bundle (`wrangler deploy --dry-run --outdir`) is byte for byte the same size before and after (2474856 bytes) and differs only in two comment lines; `phone`, `phone-vectors`, `buyer-key-vector` and `guards` tests pass unchanged apart from the guard regexes now coming from the foundation (`brand`). A `file:` link would need a lockfile edit and a node_modules symlink in every worktree for no runtime gain (Ruling FDN-VENDOR-1 in the foundation repo).

**Cost if wrong:** moving to a workspace or registry later is a lock `dir` change plus an import-path rewrite in two files.
