import {readFile, readdir, stat, unlink, writeFile} from 'node:fs/promises'
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

async function findArchiveIds(directory, extensions) {
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
      for (const id of await findArchiveIds(path, extensions)) ids.add(id)
    } else if (entry.isFile()) {
      const match = entry.name.match(/^(\d+)\.(png|mp4|json)$/)
      if (match && extensions.has(match[2])) ids.add(match[1])
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

async function renderPost(postId, {jsonOnly = false} = {}) {
  const results = await snap({
    url: `https://x.com/i/status/${postId}`,
    allowAppName: ['twitter'],
    cachePath: snapCache,
    sessionType: 'guest',
    limit: 1,
    callback: async (run) => {
      const media = jsonOnly ? undefined : await run({
        width: 1300,
        scale: 2,
        theme: 'RenderOceanBlueColor',
        output: join(snapshotsRoot, '{time-yyyy}', '{time-mm}', '{id}.{if-type:png:mp4:json:}'),
      })
      const json = await run({
        theme: 'Json',
        output: join(snapshotsRoot, '{time-yyyy}', '{time-mm}', '{id}.json'),
      })
      await media?.file.tempCleanup()
      await json.file.tempCleanup()
      return {
        mediaPath: media?.file.path.toString(),
        jsonPath: json.file.path.toString(),
      }
    },
  })
  if (results.length !== 1) throw new Error(`twitter-snap rendered ${results.length} records for ${postId}`)
  const [{mediaPath, jsonPath}] = results
  if (!jsonPath.endsWith('.json')) throw new Error(`twitter-snap returned an invalid JSON output for ${postId}`)
  const json = JSON.parse(await readFile(jsonPath, 'utf8'))
  if (json.tweet?.restId !== postId) throw new Error(`twitter-snap returned JSON for the wrong post: ${postId}`)
  await writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`)
  if (!jsonOnly && !/\.(?:png|mp4)$/.test(mediaPath)) throw new Error(`twitter-snap returned an invalid media output for ${postId}`)
  return {mediaPath, jsonPath}
}

const args = process.argv.slice(2).filter((argument) => argument !== '--')
if (args.some((argument) => !['--rebuild', '--backfill', '--backfill-json'].includes(argument))) {
  throw new Error('Usage: pnpm snapshot [--rebuild|--backfill|--backfill-json]')
}
const rebuild = args.includes('--rebuild')
const backfill = args.includes('--backfill')
const backfillJson = args.includes('--backfill-json')
if ([rebuild, backfill, backfillJson].filter(Boolean).length > 1) throw new Error('Snapshot modes are mutually exclusive')
const mediaIds = await findArchiveIds(snapshotsRoot, new Set(['png', 'mp4']))
const jsonIds = await findArchiveIds(snapshotsRoot, new Set(['json']))
const completeIds = new Set([...mediaIds].filter((id) => jsonIds.has(id)))
const postIds = rebuild
  ? [...mediaIds].sort().reverse()
  : backfillJson
    ? [...mediaIds].filter((id) => !jsonIds.has(id)).sort().reverse()
    : await collectNewPostIds(completeIds, {backfill})

if (postIds.length === 0) {
  console.log(rebuild ? 'No snapshots to rebuild.' : backfill ? 'No missing historical posts.' : backfillJson ? 'No missing JSON records.' : 'No new posts.')
  process.exit(0)
}

let completed = 0
let unavailable = 0
for (const postId of postIds) {
  let output
  try {
    output = await renderPost(postId, {jsonOnly: backfillJson})
  } catch (error) {
    if (!backfillJson) throw error
    unavailable += 1
    console.warn(`JSON unavailable for ${postId}; keeping the existing snapshot.`)
    continue
  }
  const {mediaPath, jsonPath} = output
  if ((await stat(jsonPath)).size === 0) throw new Error(`twitter-snap produced empty JSON for ${postId}`)

  if (mediaPath) {
    if ((await stat(mediaPath)).size === 0) throw new Error(`twitter-snap produced an empty file for ${postId}`)
    const paths = await findSnapshotPaths(snapshotsRoot, postId)
    for (const path of paths) {
      if (path !== mediaPath) await unlink(path)
    }
    const currentPaths = await findSnapshotPaths(snapshotsRoot, postId)
    if (currentPaths.length !== 1 || currentPaths[0] !== mediaPath) throw new Error(`Invalid archive output for ${postId}`)
  }

  completed += 1
  if (backfillJson && completed >= MAX_NEW_POSTS) break
  if (completed + unavailable >= postIds.length) break
  await sleep(randomDelay(1_000, 3_000))
}

const action = rebuild ? 'Rebuilt' : backfill || backfillJson ? 'Backfilled' : 'Archived'
const detail = rebuild ? 'posts with media and JSON' : backfill ? 'historical posts' : backfillJson ? 'JSON records' : 'new posts with media and JSON'
console.log(`${action} ${completed} ${detail}${unavailable > 0 ? `; ${unavailable} currently unavailable` : ''}.`)

async function findSnapshotPaths(directory, postId) {
  const paths = []
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await findSnapshotPaths(path, postId))
    else if (entry.isFile() && (entry.name === `${postId}.png` || entry.name === `${postId}.mp4`)) paths.push(path)
  }
  return paths
}
