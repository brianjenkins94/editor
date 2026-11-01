/**
 * The fs capability surface: which node `fs` methods read and which write — the ONE table the runtime gate (fs.ts,
 * `beforeFs`) and the editor's static view of it (capability squiggles, the canary's stand-ins, the decider) share, so
 * a method the runtime asks about is never one the editor's static checks don't know. A method's op is what it does at
 * its first path; FS_DESTINATION, what one with a second path does there.
 */

/** Synchronous and stream-creating methods on `fs`. */
export const FS_SYNC: Readonly<Record<string, "read" | "write">> = {
	"readFileSync": "read", "existsSync": "read", "statSync": "read", "lstatSync": "read", "readdirSync": "read", "realpathSync": "read", "accessSync": "read", "createReadStream": "read", "copyFileSync": "read", "cpSync": "read",
	"writeFileSync": "write", "appendFileSync": "write", "mkdirSync": "write", "unlinkSync": "write", "rmSync": "write", "rmdirSync": "write", "renameSync": "write", "createWriteStream": "write", "truncateSync": "write", "mkdtempSync": "write"
};

/** Asynchronous methods — `fs.promises`'s (the callback API's share the names). */
export const FS_ASYNC: Readonly<Record<string, "read" | "write">> = {
	"readFile": "read", "stat": "read", "lstat": "read", "readdir": "read", "realpath": "read", "access": "read", "readlink": "read", "copyFile": "read", "cp": "read",
	"writeFile": "write", "appendFile": "write", "mkdir": "write", "unlink": "write", "rm": "write", "rmdir": "write", "rename": "write", "truncate": "write", "mkdtemp": "write", "symlink": "write"
};

/** The methods with a second path, and what they do there: a copy reads its source and writes where it lands; a rename
 *  takes its source away (a write) and writes where it lands. */
export const FS_DESTINATION: Readonly<Record<string, "write">> = {
	"copyFileSync": "write", "cpSync": "write", "renameSync": "write",
	"copyFile": "write", "cp": "write", "rename": "write"
};
