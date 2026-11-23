#!/usr/bin/env bash
set -euo pipefail

root=/opt/holool-bot
repo="$root/repo.git"
service=holool-bot.service
sha=${SSH_ORIGINAL_COMMAND:-}
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full commit SHA.' >&2; exit 2; }

exec 9>"$root/deploy.lock"
flock 9

if [[ ! -d $repo ]]; then
    git init --quiet --bare "$repo"
fi
git --git-dir="$repo" fetch --no-tags https://github.com/MohamedFadlala/holool-bot.git +refs/heads/main:refs/heads/main
if [[ $(git --git-dir="$repo" rev-parse refs/heads/main) != "$sha" ]]; then
    echo 'This run was superseded by a newer commit on main.'
    exit 0
fi

release="$root/releases/$sha"
if [[ ! -d $release ]]; then
    stage=$(mktemp -d "$root/releases/.build-XXXXXXXX")
    trap 'rm -rf -- "$stage"' EXIT
    git --git-dir="$repo" archive "$sha" | tar -x -C "$stage"
    (
        cd "$stage"
        export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf
        export GIT_CONFIG_VALUE_0=ssh://git@github.com/
        npm ci --no-audit
        npm run build
        node --check public/dashboard.js
    )
    mv -T "$stage" "$release"
    trap - EXIT
fi

switch_release() {
    ln -sfn "$1" "$root/current.next"
    mv -Tf "$root/current.next" "$root/current"
}

old=$(readlink "$root/current" || true)
switch_release "$release"
if sudo -n /usr/bin/systemctl restart "$service"; then
    for attempt in {1..20}; do
        if curl --fail --silent --max-time 2 http://127.0.0.1:3500/ >/dev/null; then
            echo "Deployed $sha."
            exit 0
        fi
        sleep 1
    done
fi

echo "Health check failed for $sha." >&2
if [[ -n $old && $old != "$release" ]]; then
    switch_release "$old"
    sudo -n /usr/bin/systemctl restart "$service"
    echo "Restored the previous release." >&2
fi
exit 1
