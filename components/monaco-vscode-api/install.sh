#!/bin/bash

CWD=$(pwd)

REPO=https://github.com/CodinGame/monaco-vscode-api.git

# The newest release that's been PUBLISHED a day — not the newest tag, nor npm's latest: a release is tagged before it's
# published, and published package by package (a couple of hundred), so mid-publish its core is out while others aren't
# (ETARGET). A day on, all of it is. MONACO_VSCODE_API_VERSION names one instead (to try a release, or go back to one).
# TEMPORARY (2026-10-20): 38.0.0 hangs in its boot() (fixed upstream in 38.0.1, a day old only at 22:32 UTC). Remove this
# line after then: the default takes 38.0.1, and 38.0.2 from 2026-10-21 11:16 UTC.
MONACO_VSCODE_API_VERSION=${MONACO_VSCODE_API_VERSION:-38.0.2}
VERSION=${MONACO_VSCODE_API_VERSION:-$(npm view @codingame/monaco-vscode-api time --json 2>/dev/null | node -e '
	const times = JSON.parse(require("fs").readFileSync(0, "utf8"));
	const settled = Object.entries(times).filter(([version, at]) => /^\d+\.\d+\.\d+$/.test(version) && Date.now() - Date.parse(at) > 24 * 60 * 60 * 1000);
	const newest = settled.sort(([, a], [, b]) => Date.parse(b) - Date.parse(a))[0];

	process.stdout.write(newest === undefined ? "" : newest[0]);
')}

[ -n "$VERSION" ] || { echo "install.sh: could not resolve a published @codingame/monaco-vscode-api release" >&2; exit 1; }

git ls-remote --exit-code --tags "$REPO" "v$VERSION" > /dev/null || { echo "install.sh: @codingame/monaco-vscode-api $VERSION has no v$VERSION tag" >&2; exit 1; }

rm -rf demo/ monaco-vscode-api/

git clone --no-checkout --depth 1 --filter=tree:0 --sparse --branch "v$VERSION" "$REPO" || exit 1

cd monaco-vscode-api/

git sparse-checkout set demo/

git checkout

cd ..

cp -rf monaco-vscode-api/demo/ demo/

rm -rf monaco-vscode-api/

cd demo

# Every @codingame package at that one version, not each one's latest: a release is published package by package, so
# mid-publish some are a version ahead of the rest — and want a core that isn't out yet.
if [[ "$(uname -s)" == Darwin* ]]; then
	sed -i "" "s/file:[^\"]*/$VERSION/g" package.json
else
	sed -i "s/file:[^\"]*/$VERSION/g" package.json
fi

npm pkg delete dependencies["@codingame/monaco-vscode-server"]
npm pkg delete dependencies["dockerode"]
npm pkg delete dependencies["express"]
npm pkg delete dependencies["ws"]

#npm pkg set overrides["@xterm/xterm"]="5.4.0-beta.20"

npm install "@codingame/monaco-vscode-api@$VERSION" "vscode@npm:@codingame/monaco-vscode-extension-api@$VERSION" "monaco-editor@npm:@codingame/monaco-vscode-editor-api@$VERSION"

cd "$CWD"

mkdir node_modules

for pkg in "@codingame" "monaco-editor" "vscode" "ansi-colors"; do
	ln -sfn "../demo/node_modules/$pkg" "node_modules/$pkg"
done
