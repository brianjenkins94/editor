// The `vscode` module, as policy.test.mjs stands it in: what the test put on globalThis.
export const { Uri, workspace } = globalThis.__vscodeStandIn;
