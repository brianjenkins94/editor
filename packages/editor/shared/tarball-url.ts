/** `name`@`version`'s published tarball: a lockfile's `resolved`, else npm's registry's — what the debugger installs a
 *  package from (workbench/tarballs.ts) and the baseline reads it from (the capabilities extension's package worker). */
export const tarballUrl = (name: string, version: string, resolved?: string): string => resolved ?? `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
