/**
 * The only place the server reaches into the storage core. The repo lives on exFAT (no
 * symlinks → no npm workspaces), so the built core is imported by relative path; if the
 * repo moves to NTFS this becomes a package import in this one file.
 */
export * from '../../../packages/core/dist/index.js';
