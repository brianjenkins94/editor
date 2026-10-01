/**
 * The fs capability surface: which node `fs` methods read and which write — the ONE table the runtime gate (fs.ts,
 * `beforeFs`) and the editor's static view of it (capability squiggles, the canary's stand-ins, the decider) share, so
 * a method the runtime asks about is never one the editor's static checks don't know.
 */

/** Synchronous and stream-creating methods on `fs`. */
export const FS_SYNC: Readonly<Record<string, "read" | "write">> = {
	"readFileSync": "read", "existsSync": "read", "statSync": "read", "lstatSync": "read", "readdirSync": "read", "realpathSync": "read", "accessSync": "read", "createReadStream": "read",
	"writeFileSync": "write", "appendFileSync": "write", "mkdirSync": "write", "unlinkSync": "write", "rmSync": "write", "rmdirSync": "write", "renameSync": "write", "copyFileSync": "write", "createWriteStream": "write", "truncateSync": "write"
};

/** Asynchronous methods — `fs.promises`'s (the callback API's share the names). */
export const FS_ASYNC: Readonly<Record<string, "read" | "write">> = {
	"readFile": "read", "stat": "read", "lstat": "read", "readdir": "read", "realpath": "read", "access": "read",
	"writeFile": "write", "appendFile": "write", "mkdir": "write", "unlink": "write", "rm": "write", "rmdir": "write", "rename": "write", "copyFile": "write", "truncate": "write"
};
