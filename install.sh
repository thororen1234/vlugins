#!/bin/bash

set -e

die() {
	echo "$@" >&2
	exit 1
}

action=$1
destination=$2

[[ $action == install || $action == uninstall || $action == update ]] || die "Usage: $0 <install | uninstall | update> <Vencord Location>"

[[ -d "$destination/src" ]] || die "Not a valid Vencord install: $2"

target=$destination/src/userplugins
mkdir -p "$target"

if [[ $action == update ]]; then
	git pull
fi

for plugin in *; do
	[[ -d "$plugin" ]] || continue
	[[ $plugin == kettu ]] && continue

	if [[ $action == uninstall || $action == update ]]; then
		# target shouldn't ever be blank here but still use :? to avoid STEAMROOTing
		rm -rf "${target:?}/$plugin"
		echo "Removed $plugin"
	fi
	if [[ $action == install || $action == update ]]; then
		cp -r "$PWD/$plugin" "$target"
		echo "Added $plugin"
	fi
done
