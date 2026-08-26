import {readdir, stat, unlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {TwitterClient} from '@yuta/bird'
import {buildUserTweetsFeatures} from '@yuta/bird/dist/lib/twitter-client-features.js'
import {extractCursorFromInstructions, parseTweetsFromInstructions} from '@yuta/bird/dist/lib/twitter-client-utils.js'
import {getSnapAppRenderWithCache} from 'twitter-snap'

const USERNAME = '299792457_'
const RELAY_BASE_URL = 'https://tw.home.yutakobayashi.com'
const RELAY_PROFILE = 'account2'
const USER_TWEETS_AND_REPLIES_QUERY_ID = 'EqtpEwt0CoQXmDfq5DKH0A'
const PAGE_SIZE = 20
const MAX_NEW_POSTS = 40
const EMPTY_AUTHORED_PAGE_THRESHOLD = 3
const CONSECUTIVE_EXISTING_THRESHOLD = 5
const MAX_BACKFILL_PAGES = 50
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const snapshotsRoot = join(repositoryRoot, 'snapshots')
const snapCache = join(tmpdir(), '299792457-twitter-snap-cache')
const snap = getSnapAppRenderWithCache({})

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const randomDelay = (minimum, maximum) => Math.floor(Math.random() * (maximum - minimum) + minimum)

async function findSnapshotIds(directory) {
  const ids = new Set()
  let entries
  try {
    entries = await readdir(directory, {withFileTypes: true})
  } catch (error) {
    if (error.code === 'ENOENT') return ids
    throw error
  }

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      for (const id of await findSnapshotIds(path)) ids.add(id)
    } else if (entry.isFile()) {
      const match = entry.name.match(/^(\d+)\.(?:png|mp4)$/)
      if (match) ids.add(match[1])
    }
  }
  return ids
}

async function fetchAuthoredPage(userId, cursor) {
  const variables = {
    userId,
    count: PAGE_SIZE,
    includePromotedContent: true,
    withCommunity: true,
    withVoice: true,
    ...(cursor ? {cursor} : {}),
  }
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(buildUserTweetsFeatures()),
    fieldToggles: JSON.stringify({withArticlePlainText: false}),
  })
  const response = await fetch(`${RELAY_BASE_URL}/i/api/graphql/${USER_TWEETS_AND_REPLIES_QUERY_ID}/UserTweetsAndReplies?${params}`, {
    headers: {'x-profile-name': RELAY_PROFILE},
  })
  const body = await response.json()
  const instructions = body.data?.user?.result?.timeline?.timeline?.instructions
  if (!response.ok || !instructions) {
    const message = body.errors?.map((error) => error.message).join(', ')
    throw new Error(message || `UserTweetsAndReplies returned HTTP ${response.status}`)
  }
  return {
    success: true,
    tweets: parseTweetsFromInstructions(instructions, {quoteDepth: 0, includeRaw: false}),
    nextCursor: extractCursorFromInstructions(instructions),
  }
}

async function collectNewPostIds(existingIds, {backfill = false} = {}) {
  const client = new TwitterClient({relayBaseUrl: RELAY_BASE_URL, profileName: RELAY_PROFILE})
  const user = await client.getUserIdByUsername(USERNAME)
  if (!user.success || !user.userId) throw new Error(user.error ?? 'User lookup failed')

  const collected = []
  const seenPostIds = new Set()
  const seenCursors = new Set()
  let cursor
  let consecutiveExisting = 0
  let pages = 0
  let emptyAuthoredPages = 0

  while (backfill || collected.length < MAX_NEW_POSTS) {
    const result = await fetchAuthoredPage(user.userId, cursor)
    if (!result.success) throw new Error(result.error)
    pages += 1
    let pageAuthored = 0

    for (const post of result.tweets) {
      if (!/^\d+$/.test(post.id)) throw new Error('Bird returned an invalid post ID')
      if (post.authorId !== user.userId && post.author?.username?.toLowerCase() !== USERNAME.toLowerCase()) continue
      pageAuthored += 1
      if (seenPostIds.has(post.id)) continue
      seenPostIds.add(post.id)
      if (existingIds.has(post.id)) {
        consecutiveExisting += 1
        if (!backfill && consecutiveExisting >= CONSECUTIVE_EXISTING_THRESHOLD) return collected
        continue
      }

      consecutiveExisting = 0
      collected.push(post.id)
      if (!backfill && collected.length >= MAX_NEW_POSTS) return collected
    }

    emptyAuthoredPages = pageAuthored === 0 ? emptyAuthoredPages + 1 : 0
    console.log(`Fetched authored timeline page ${pages} (${pageAuthored} authored posts)`)
    if (emptyAuthoredPages >= EMPTY_AUTHORED_PAGE_THRESHOLD) return collected
    if (!result.nextCursor) return collected
    if (seenCursors.has(result.nextCursor)) throw new Error('Bird returned a repeated cursor')
    seenCursors.add(result.nextCursor)
    cursor = result.nextCursor
    if (backfill && pages >= MAX_BACKFILL_PAGES) throw new Error(`Backfill exceeded the ${MAX_BACKFILL_PAGES}-page safety limit`)
    await sleep(randomDelay(2_000, 5_000))
  }

  return collected
}

async function renderPost(postId) {
  const results = await snap({
    url: `https://x.com/i/status/${postId}`,
    allowAppName: ['twitter'],
    cachePath: snapCache,
    sessionType: 'guest',
    limit: 1,
    callback: async (run) => {
      const result = await run({
        width: 1300,
        scale: 2,
        theme: 'RenderOceanBlueColor',
        output: join(snapshotsRoot, '{time-yyyy}', '{time-mm}', '{id}.{if-type:png:mp4:json:}'),
      })
      const output = result.file.path.toString()
      await result.file.tempCleanup()
      return output
    },
  })
  if (results.length !== 1) throw new Error(`twitter-snap rendered ${results.length} files for ${postId}`)
  if (!/\.(?:png|mp4)$/.test(results[0])) throw new Error(`twitter-snap returned an invalid output for ${postId}`)
  return results[0]
}

const args = process.argv.slice(2).filter((argument) => argument !== '--')
if (args.some((argument) => argument !== '--rebuild' && argument !== '--backfill')) throw new Error('Usage: pnpm snapshot [--rebuild|--backfill]')
const rebuild = args.includes('--rebuild')
const backfill = args.includes('--backfill')
if (rebuild && backfill) throw new Error('--rebuild and --backfill are mutually exclusive')
const existingIds = await findSnapshotIds(snapshotsRoot)
const postIds = rebuild ? [...existingIds].sort().reverse() : await collectNewPostIds(existingIds, {backfill})

if (postIds.length === 0) {
  console.log(rebuild ? 'No snapshots to rebuild.' : backfill ? 'No missing historical posts.' : 'No new posts.')
  process.exit(0)
}

for (const [index, postId] of postIds.entries()) {
  const outputPath = await renderPost(postId)
  if ((await stat(outputPath)).size === 0) throw new Error(`twitter-snap produced an empty file for ${postId}`)

  const paths = await findSnapshotPaths(snapshotsRoot, postId)
  for (const path of paths) {
    if (path !== outputPath) await unlink(path)
  }
  const currentPaths = await findSnapshotPaths(snapshotsRoot, postId)
  if (currentPaths.length !== 1 || currentPaths[0] !== outputPath) throw new Error(`Invalid archive output for ${postId}`)

  if (index + 1 < postIds.length) await sleep(randomDelay(1_000, 3_000))
}

const action = rebuild ? 'Rebuilt' : backfill ? 'Backfilled' : 'Archived'
const detail = rebuild ? 'posts at 2x resolution' : backfill ? 'historical posts' : 'new posts'
console.log(`${action} ${postIds.length} ${detail}.`)

async function findSnapshotPaths(directory, postId) {
  const paths = []
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await findSnapshotPaths(path, postId))
    else if (entry.isFile() && (entry.name === `${postId}.png` || entry.name === `${postId}.mp4`)) paths.push(path)
  }
  return paths
}
