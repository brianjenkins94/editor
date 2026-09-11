/** @jsxImportSource preact */
import types from "editor:types";
import moduleVersions from "editor:versions";
import workspace from "editor:workspace";
import { ensureCrossOriginIsolated } from "./coi";
import { hostLog } from "./logging";
import { createVscodeWindow } from "./vscode";

// Gain cross-origin isolation (SharedArrayBuffer) before booting. A dev server already sends the COOP/COEP
// headers; on a static host (GitHub Pages) the coi service worker supplies them after one reload. On the
// un-isolated first load this returns false and schedules that reload, so we skip booting until the page
// comes back isolated.
if (ensureCrossOriginIsolated()) {
	// The workbench opens on the bundled demo workspace (snapshot.ts bakes `demo/` in at build time as
	// `editor:workspace`). The dependency type surface (`editor:types`) is seeded alongside so the
	// in-browser TS server resolves the demo's imports, and `editor:versions` drives the CDN node_modules
	// overlay for go-to-definition into real dependency source. A real on-disk folder (File System Access)
	// becomes an additional source mode later.
	const files = [...workspace, ...types];

	createVscodeWindow({
		"workspaceFolder": "/workspace",
		"files": files,
		"moduleVersions": moduleVersions,
		"openEditors": ["/workspace/index.ts"],
		"onSave": (path: string, contents: string) => { hostLog.info("saved", { "path": path, "bytes": contents.length }); }
	});
}
