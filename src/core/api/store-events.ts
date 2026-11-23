/**
 * The Store <-> Chat envelope (contract v1.6) now lives in the shared foundation (`contracts/wa-v1`), vendored in foundation/; this file only
 * re-exports it so every importer keeps its path. Never edit the vendored copy: a contract change is a foundation PR + release + re-vendor.
 * Replaces the manual sha pin (Ruling WA-CONTRACT-1): foundation-parity pins the vendored file.
 */
export * from '../../../foundation/contracts/wa-v1';
