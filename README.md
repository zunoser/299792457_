# 299792457_ archive

An image archive of [@299792457_](https://x.com/299792457_), rendered with
[twitter-snap](https://github.com/fa0311/twitter-snap).

## How it works

GitHub Actions runs hourly. It uses [`@yuta/bird`](https://git.yutakobayashi.com/yuta/bird)
through Twitter Safe Relay to enumerate post IDs, renders each new status with
twitter-snap's guest session, and commits PNG files to
`snapshots/YYYY/MM/<tweet-id>.png`.

Only ID enumeration is authenticated by the home relay. Rendering uses a guest
token, so X cookies are never copied into GitHub Actions. The collector stops
after five consecutive existing IDs and renders at most 40 new posts per run.

## Setup

Add the repository Actions secrets `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET`.
The OAuth client must allow `tag:ci` nodes to join the tailnet and reach
`tw.home.yutakobayashi.com`.

Run a snapshot locally with:

```sh
pnpm install --frozen-lockfile
pnpm snapshot
```

You can also start the `Archive X snapshots` workflow manually from the Actions
tab. Scheduled and manual runs operate only on the default branch.

## Contributing

Keep both dependencies pinned. Before opening a pull request, run
`pnpm install --frozen-lockfile` and verify that `pnpm snapshot` creates at least
one non-empty PNG. Update this README when the schedule, target, output layout,
or required secret changes.
