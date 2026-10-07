#!/bin/bash

CWD=$(pwd)

REPO=https://github.com/CodinGame/monaco-vscode-api.git

# The latest version PUBLISHED to npm (its `latest`), not the newest tag: a release is tagged before it's published, and
# installing a tagged-but-unpublished version fails (ETARGET) — the demo's dependencies are installed from npm.
VERSION=$(npm view @codingame/monaco-vscode-api version 2>/dev/null)

[ -n "$VERSION" ] || { echo "install.sh: could not resolve the latest published @codingame/monaco-vscode-api" >&2; exit 1; }

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
