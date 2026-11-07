#!/bin/bash

CWD=$(pwd)

REPO=https://github.com/CodinGame/monaco-vscode-api.git

# The newest release that's been PUBLISHED a day — not the newest tag, nor npm's latest: a release is tagged before it's
# published, and published package by package (a couple of hundred), so mid-publish its core is out while others aren't
# (ETARGET). A day on, all of it is — unless a package skipped that version altogether (language-pack-cs has no 38.1.1):
# then the next older one is tried, every package still at one version. MONACO_VSCODE_API_VERSION names one instead (to
# try a release, or go back to one).
VERSIONS=${MONACO_VSCODE_API_VERSION:-$(npm view @codingame/monaco-vscode-api time --json 2>/dev/null | node -e '
	const times = JSON.parse(require("fs").readFileSync(0, "utf8"));
	const settled = Object.entries(times).filter(([version, at]) => /^\d+\.\d+\.\d+$/.test(version) && Date.now() - Date.parse(at) > 24 * 60 * 60 * 1000);

	process.stdout.write(settled.sort(([, a], [, b]) => Date.parse(b) - Date.parse(a)).slice(0, 5).map(([version]) => version).join(" "));
')}

[ -n "$VERSIONS" ] || { echo "install.sh: could not resolve a published @codingame/monaco-vscode-api release" >&2; exit 1; }

# The demo's package.json at release `$1`, every @codingame package at that one version, installed. Fails (ETARGET) when
# a package hasn't that version.
install_version() {
	local VERSION=$1

	git ls-remote --exit-code --tags "$REPO" "v$VERSION" > /dev/null || { echo "install.sh: @codingame/monaco-vscode-api $VERSION has no v$VERSION tag" >&2; return 1; }

	cd "$CWD" || return 1
	rm -rf demo/ monaco-vscode-api/

	git clone --no-checkout --depth 1 --filter=tree:0 --sparse --branch "v$VERSION" "$REPO" || return 1

	cd monaco-vscode-api/ || return 1

	git sparse-checkout set demo/

	git checkout

	cd ..

	cp -rf monaco-vscode-api/demo/ demo/

	rm -rf monaco-vscode-api/

	cd demo || return 1

	# Every @codingame package at that one version, not each one's latest: a release is published package by package,
	# so mid-publish some are a version ahead of the rest — and want a core that isn't out yet.
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
}

INSTALLED=
for VERSION in $VERSIONS; do
	if install_version "$VERSION"; then
		INSTALLED=$VERSION
		break
	fi

	echo "install.sh: @codingame/monaco-vscode-api $VERSION didn't install whole; trying the release before it" >&2
done

[ -n "$INSTALLED" ] || { echo "install.sh: none of $VERSIONS installed whole" >&2; exit 1; }

echo "install.sh: @codingame/monaco-vscode-api $INSTALLED"

cd "$CWD"

mkdir node_modules

for pkg in "@codingame" "monaco-editor" "vscode" "ansi-colors"; do
	ln -sfn "../demo/node_modules/$pkg" "node_modules/$pkg"
done
