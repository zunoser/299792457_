# 299792457_ archive

An image archive of [@299792457_](https://x.com/299792457_), rendered with
[twitter-snap](https://github.com/fa0311/twitter-snap).

## How it works

GitHub Actions runs hourly. It uses [`@yuta/bird`](https://git.yutakobayashi.com/yuta/bird)
through Twitter Safe Relay to enumerate post IDs, renders each new status with
twitter-snap's exported `getSnapAppRenderWithCache` API and guest session, and
commits 2x-resolution files to `snapshots/YYYY/MM/<tweet-id>.<png|mp4>`. Image
posts remain PNGs and video posts are rendered as MP4s. Posts and authored
replies are both collected from `UserTweetsAndReplies`, including replies to
other accounts and continuations of a self-thread. Each status in a thread is
archived as its own addressable snapshot; twitter-snap does not combine an
entire conversation into one image. The library API reuses the guest session
and font cache across posts in one run.

Only ID enumeration is authenticated by the home relay. Rendering uses a guest
token, so X cookies are never copied into GitHub Actions. The collector stops
after five consecutive existing authored IDs and renders at most 40 new posts
or replies per run.

## Setup

Add the repository Actions secrets `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET`.
The OAuth client must allow `tag:ci` nodes to join the tailnet and reach
`tw.home.yutakobayashi.com`.

Run a snapshot locally with:

```sh
pnpm install --frozen-lockfile
pnpm snapshot
```

Rebuild every existing PNG or MP4 at 2x resolution with:

```sh
pnpm snapshot -- --rebuild
```

Backfill every missing authored post, including replies, through Safe Relay's
paginated `UserTweetsAndReplies` timeline with:

```sh
pnpm snapshot -- --backfill
```

You can also start the `Archive X snapshots` workflow manually from the Actions
tab. Scheduled and manual runs operate only on the default branch.

## Contributing

Keep both dependencies pinned. Before opening a pull request, run
`pnpm install --frozen-lockfile` and verify that `pnpm snapshot` creates a
non-empty PNG or MP4. Update this README when the schedule, target, output layout,
or required secret changes.
