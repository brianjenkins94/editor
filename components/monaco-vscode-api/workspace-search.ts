/**
 * File and text search over the workspace's `file:` files, honouring the query's include and exclude globs.
 *
 * The search service override answers `file:` searches with its own WorkspaceSearchProvider, which matches each file
 * against the query's `filePattern` alone (Quick Open's fuzzy text) and ignores its `includePattern` /
 * `excludePattern` — where `vscode.workspace.findFiles` puts its glob, and the search view its "files to include" and
 * "files to exclude". So `findFiles("**\/package.json")` came back with every file in the workspace. This replaces it
 * for `file:` (`registerSearchResultProvider` keeps the last one registered): it walks each folder of the query through
 * the file service, and decides what's in with VS Code's own QueryGlobTester — the include and exclude expressions
 * (the query's and each folder's), against paths relative to the folder, the way the desktop's local search does —
 * pruning excluded folders rather than walking them. Text search reads what's in and matches it as the override did.
 */
import type { IFileService } from "@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files.service";
import type { IFileMatch, IFileQuery, IFolderQuery, ISearchComplete, ISearchProgressItem, ISearchResultProvider, ITextQuery, ITextSearchResult } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search";
import type { CancellationToken } from "@codingame/monaco-vscode-api/vscode/vs/base/common/cancellation";
import type { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { getService } from "@codingame/monaco-vscode-api";
import { createRegExp, fuzzyContains } from "@codingame/monaco-vscode-api/vscode/vs/base/common/strings";
import { IFileService as IFileServiceId } from "@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files.service";
import { QueryGlobTester, SearchCompletionExitCode, SearchError, SearchErrorCode, SearchProviderType, SearchRange, TextSearchMatch } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search";
import { ISearchService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search.service";

/** A file bigger than this isn't searched for text (a bundle, a lockfile): the override's limit too, in effect. */
const MAX_TEXT_BYTES = 1024 * 1024;

/** Every file under `folderQuery`'s folder that `query` includes, in walk order, each with its path relative to the
 *  folder — stopping once `limit` are found or `token` is cancelled. Excluded folders aren't walked into. */
async function filesOf(fileService: IFileService, query: IFileQuery | ITextQuery, folderQuery: IFolderQuery, limit: number, token: CancellationToken | undefined): Promise<{ "uri": URI; "path": string }[]> {
	const tester = new QueryGlobTester(query, folderQuery);
	const found: { "uri": URI; "path": string }[] = [];
	const walk = async (folder: URI, prefix: string): Promise<void> => {
		const stat = await fileService.resolve(folder).catch(() => undefined);

		for (const child of stat?.children ?? []) {
			if (found.length >= limit || token?.isCancellationRequested === true) {
				return;
			}

			const path = prefix + child.name;

			if (child.isDirectory) {
				if (!tester.matchesExcludesSync(path, child.name)) {
					await walk(child.resource, path + "/");
				}
			} else if (child.isFile && tester.includedInQuerySync(path, child.name)) {
				found.push({ "uri": child.resource, "path": path });
			}
		}
	};

	await walk(folderQuery.folder, "");

	return found;
}

/** `text`'s matches for `regexp`, as the search view shows them: each with its line and its range, 0-based. */
function matchesIn(text: string, regexp: RegExp, query: ITextQuery, limit: number): ITextSearchResult[] {
	const lineStarts = [0];

	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
		lineStarts.push(index + 1);
	}

	const position = (offset: number): [number, number] => {
		let line = lineStarts.length - 1;

		while (line > 0 && lineStarts[line] > offset) {
			line -= 1;
		}

		return [line, offset - lineStarts[line]];
	};
	const results: ITextSearchResult[] = [];

	regexp.lastIndex = 0;

	for (let match = regexp.exec(text); match !== null && results.length < limit; match = regexp.exec(text)) {
		const [startLine, startColumn] = position(match.index);
		const [endLine, endColumn] = position(match.index + match[0].length);
		const lineText = text.slice(lineStarts[startLine], (lineStarts[startLine + 1] ?? text.length + 1) - 1);

		results.push(new TextSearchMatch(lineText, new SearchRange(startLine, startColumn, endLine, endColumn), query.previewOptions));

		if (match[0].length === 0) {
			regexp.lastIndex += 1;
		}
	}

	return results;
}

class WorkspaceSearch implements ISearchResultProvider {
	private readonly fileService: IFileService;

	public constructor(fileService: IFileService) {
		this.fileService = fileService;
	}

	public async getAIName(): Promise<string | undefined> {
		return undefined;
	}

	public async fileSearch(query: IFileQuery, token?: CancellationToken): Promise<ISearchComplete> {
		const limit = query.maxResults ?? Number.MAX_SAFE_INTEGER;
		const results: IFileMatch[] = [];

		for (const folderQuery of query.folderQueries) {
			for (const { uri, path } of await filesOf(this.fileService, query, folderQuery, limit + 1 - results.length, token)) {
				// Quick Open's typed text, fuzzily, against the path in the folder.
				if (query.filePattern === undefined || query.filePattern === "" || fuzzyContains(path, query.filePattern)) {
					results.push({ "resource": uri });
				}
			}
		}

		return { "results": results.slice(0, limit), "limitHit": results.length > limit, "messages": [], "stats": { "type": "fileSearchProvider", "fromCache": false, "resultCount": Math.min(results.length, limit) }, "exit": SearchCompletionExitCode.Normal } as ISearchComplete;
	}

	public async textSearch(query: ITextQuery, onProgress?: (item: ISearchProgressItem) => void, token?: CancellationToken): Promise<ISearchComplete> {
		const { contentPattern } = query;
		let regexp: RegExp;

		try {
			regexp = createRegExp(contentPattern.pattern, contentPattern.isRegExp === true, { "wholeWord": contentPattern.isWordMatch, "global": true, "matchCase": contentPattern.isCaseSensitive, "multiline": contentPattern.isMultiline, "unicode": contentPattern.isUnicode });
		} catch {
			throw new SearchError(`Invalid search pattern: ${contentPattern.pattern}`, SearchErrorCode.regexParseError);
		}

		const limit = query.maxResults ?? 20_000;
		const results: IFileMatch[] = [];
		let found = 0;

		for (const folderQuery of query.folderQueries) {
			for (const { uri } of await filesOf(this.fileService, query, folderQuery, Number.MAX_SAFE_INTEGER, token)) {
				if (found >= limit || token?.isCancellationRequested === true) {
					break;
				}

				const content = await this.fileService.readFile(uri, { "limits": { "size": MAX_TEXT_BYTES } }).catch(() => undefined);
				const matches = content === undefined ? [] : matchesIn(content.value.toString(), regexp, query, limit - found);

				if (matches.length > 0) {
					const fileMatch: IFileMatch = { "resource": uri, "results": matches };

					found += matches.length;
					results.push(fileMatch);
					onProgress?.(fileMatch);
				}
			}
		}

		return { "results": results, "limitHit": found >= limit, "messages": [], "stats": { "type": "textSearchProvider" }, "exit": SearchCompletionExitCode.Normal } as ISearchComplete;
	}

	public async clearCache(): Promise<void> { /* nothing cached: each search walks the folders as they are */ }
}

/** Answer `file:` file and text searches with WorkspaceSearch (in place of the override's). Call once the services are up. */
export async function registerWorkspaceSearch(): Promise<void> {
	const search = await getService(ISearchService);
	const provider = new WorkspaceSearch(await getService(IFileServiceId));

	search.registerSearchResultProvider("file", SearchProviderType.file, provider);
	search.registerSearchResultProvider("file", SearchProviderType.text, provider);
}
