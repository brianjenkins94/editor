#!/bin/bash

CWD=$(pwd)

REPO=https://github.com/CodinGame/monaco-vscode-api.git

# TEMPORARY (2026-09-17): pinned to 36.2.7. CodinGame tagged v37.0.0 on GitHub, but its @codingame/* npm packages
# are only partially published for 37.0.0 — the anchor `@codingame/monaco-vscode-api` is on npm at 37.0.0, but
# default-extension packages like `@codingame/monaco-vscode-theme-monokai-default-extension` have no 37.x, so the
# latest-git-tag resolution below installs 37.0.0 and dies with ETARGET (breaking local builds AND CI). Resolving
# from npm's `latest` dist-tag doesn't help (it's inconsistent across the packages). Revert to the git-tag line
# once 37.x is fully published on npm (`npm view @codingame/monaco-vscode-theme-monokai-default-extension version`).
VERSION=36.2.7
# VERSION=$(git ls-remote --tags --refs --sort=-v:refname "$REPO" 'v[0-9]*' | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
# VERSION=${VERSION#v}

[ -n "$VERSION" ] || { echo "install.sh: could not resolve CodinGame/monaco-vscode-api release version" >&2; exit 1; }

rm -rf demo/ monaco-vscode-api/

git clone --no-checkout --depth 1 --filter=tree:0 --sparse --branch "v$VERSION" "$REPO" || exit 1

cd monaco-vscode-api/

git sparse-checkout set demo/

git checkout

cd ..

cp -rf monaco-vscode-api/demo/ demo/

rm -rf monaco-vscode-api/

cd demo

# Pin every vendored (file:) @codingame dep to $VERSION rather than `latest`, so the whole set resolves to one
# consistently-published release (see the VERSION note above). `latest` would drag in the partially-published
# 37.0.0 and ETARGET.
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
